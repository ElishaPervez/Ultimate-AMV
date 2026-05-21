use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        mpsc::{self, Sender},
        Mutex, OnceLock,
    },
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

use crate::{log_error, log_info, log_warn};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaCandidate {
    pub url: String,
    pub kind: String,
    /// Referer URL that should be used when fetching this candidate.
    /// Populated from the most recent embed/player iframe host observed by
    /// the sniffer (see `LATEST_EMBED_REFERER`). `None` means "use the
    /// browser's current top-level page URL" — frontend falls back to that.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub referer: Option<String>,
}

#[derive(Clone, Serialize)]
pub(crate) struct MediaRequestDebug {
    pub url: String,
    pub count: usize,
    pub interesting: bool,
}

#[derive(Clone, Serialize)]
pub(crate) struct ProviderNavigation {
    pub url: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderPageIdentity {
    pub anime_title: Option<String>,
    pub episode_number: Option<String>,
    pub episode_label: Option<String>,
    pub source_page: Option<String>,
}

#[derive(Deserialize)]
struct AnikaiSyncData {
    name: Option<String>,
    series_url: Option<String>,
}

pub(crate) static SEEN_MEDIA_URLS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
pub(crate) static MEDIA_REQUEST_COUNT: AtomicUsize = AtomicUsize::new(0);

/// Most recently observed "embed-like" origin (e.g. `https://megaplay.buzz/`).
/// Set when the sniffer sees a sub-resource request whose path contains an
/// embed/player marker and whose host differs from the current top-level page
/// host. Consumed by `emit_media_candidate` so the referer header used for
/// yt-dlp / inspection / download matches the CDN's hot-link protection
/// expectation. Reset on every top-level navigation via
/// `clear_media_sniffer_state`.
pub(crate) static LATEST_EMBED_REFERER: OnceLock<Mutex<Option<String>>> = OnceLock::new();

/// Host of the current top-level navigation (e.g. `animesuge.cz`). Set by the
/// `NavigationStarting` handler before each accepted top-level document load.
/// Used by `is_embed_like_url` to distinguish "the page's own host" (an
/// uninteresting same-origin iframe) from "a third-party embed host" (which
/// is the referer the CDN actually wants). Unlike `LATEST_EMBED_REFERER`,
/// this is NOT cleared on navigation reset — it outlives the per-page
/// resource set and tracks the browser's address bar.
pub(crate) static CURRENT_PAGE_HOST: OnceLock<Mutex<Option<String>>> = OnceLock::new();
pub(crate) static IDENTITY_GENERATION: AtomicU64 = AtomicU64::new(0);
pub(crate) static IDENTITY_RESOLVED_GEN: AtomicU64 = AtomicU64::new(0);
pub(crate) const IDENTITY_WATCHDOG_SECS: u64 = 12;

/// Per-URL dedup set scoped to the firehose disk log only. The user-visible
/// `media-request-debug` Tauri event (which drives the "Requests seen: N"
/// counter in the UI) is intentionally NOT deduped — only the
/// `browser.media.request.full` log line is suppressed for repeat URLs.
/// Reset on navigation via `clear_media_sniffer_state`.
pub(crate) static SEEN_FIREHOSE_URLS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

/// Soft cap on the firehose dedup set's size. Modern provider SPAs do not
/// fire `NavigationStarting` between episodes (which is what would normally
/// reset the set), so a long-running session would otherwise accumulate the
/// set without bound. When the cap is exceeded we clear the entire set and
/// re-seed it with the current URL — a "forget everything when full" sliding
/// window. Crude, but acceptable for diagnostic-only logging where the only
/// observable consequence of a flush is an occasional re-logged repeat URL.
pub(crate) const FIREHOSE_DEDUP_SOFT_CAP: usize = 5000;

/// Payload for one firehose disk-log entry handed off to the background
/// writer thread so the WebView2 callback never blocks on file I/O.
struct FirehoseLogEntry {
    url: String,
    host: String,
    kind: &'static str,
    interesting: bool,
    matched_substring: Option<&'static str>,
}

/// Sender end of the firehose log channel. Lazily initialized on first send,
/// at which point a dedicated background thread is spawned to drain the
/// receiver and write each entry to disk via `log_info`. The thread lives for
/// the rest of the process — no graceful shutdown.
///
/// Wrapped in `Option<Sender<_>>` so a failed spawn (OS thread limit, low
/// memory, RLIMIT_NPROC, etc.) can install `None` and let downstream callers
/// silently skip the firehose log entry. Returning `Err` from inside the
/// `OnceLock::get_or_init` closure isn't an option, and panicking on the
/// WebView2 callback thread would unwind into a C++ COM caller (UB), so the
/// fallback path has to be representable as a value.
static FIREHOSE_LOG_SENDER: OnceLock<Option<Sender<FirehoseLogEntry>>> = OnceLock::new();

pub(crate) fn clear_media_sniffer_state() {
    if let Some(seen) = SEEN_MEDIA_URLS.get() {
        if let Ok(mut urls) = seen.lock() {
            urls.clear();
        }
    }
    if let Some(seen) = SEEN_FIREHOSE_URLS.get() {
        if let Ok(mut urls) = seen.lock() {
            urls.clear();
        }
    }
    if let Some(referer) = LATEST_EMBED_REFERER.get() {
        if let Ok(mut value) = referer.lock() {
            *value = None;
        }
    }
    MEDIA_REQUEST_COUNT.store(0, Ordering::Relaxed);
}

/// Returns `true` if `url` had not yet been seen by the firehose dedup set
/// in this session (and inserts it), `false` if it was already present.
/// Defensive: if the mutex is poisoned, allow the log through rather than
/// silently dropping diagnostic output.
///
/// Applies `FIREHOSE_DEDUP_SOFT_CAP` after a successful insert: if the set
/// has grown past the cap, it is cleared and re-seeded with the URL just
/// inserted. This bounds memory growth on long-running sessions whose
/// provider SPA never fires `NavigationStarting` (the normal reset path).
fn firehose_should_log(url: &str) -> bool {
    let seen = SEEN_FIREHOSE_URLS.get_or_init(|| Mutex::new(HashSet::new()));
    match seen.lock() {
        Ok(mut urls) => {
            if !urls.insert(url.to_string()) {
                return false;
            }
            if urls.len() > FIREHOSE_DEDUP_SOFT_CAP {
                urls.clear();
                urls.insert(url.to_string());
            }
            true
        }
        Err(_) => true,
    }
}

/// Lazily initialize the background firehose log writer thread and return
/// its channel sender. Spawning is done exactly once via
/// `OnceLock::get_or_init`. Returns `None` (cached for the rest of the
/// process) if `thread::Builder::spawn` fails — callers must treat the
/// missing sender as "firehose logging unavailable" and skip the log entry
/// rather than panicking, because this function is reached from the
/// WebView2 callback thread, where any unwind crosses a C++ COM frame.
fn firehose_sender() -> Option<&'static Sender<FirehoseLogEntry>> {
    FIREHOSE_LOG_SENDER
        .get_or_init(|| {
            let (tx, rx) = mpsc::channel::<FirehoseLogEntry>();
            match thread::Builder::new()
                .name("amv-firehose-log".into())
                .spawn(move || {
                    while let Ok(entry) = rx.recv() {
                        log_info(
                            "browser.media.request.full",
                            "Sniffer observed WebView2 request",
                            json!({
                                "url": entry.url,
                                "host": entry.host,
                                "mediaKind": entry.kind,
                                "interesting": entry.interesting,
                                "matchedSubstring": entry.matched_substring,
                            }),
                        );
                    }
                }) {
                Ok(_handle) => Some(tx),
                Err(error) => {
                    log_error(
                        "browser.firehose.spawn",
                        "Could not spawn firehose log thread",
                        json!({ "error": error.to_string() }),
                    );
                    None
                }
            }
        })
        .as_ref()
}

/// Static-asset / non-video file extensions that must never be treated as
/// playable media, even if their query string happens to contain a substring
/// like ".m3u8" (the JWPlayer telemetry ping is the canonical example —
/// `prd.jwpltx.com/.../ping.gif?mu=https%3A//cdn/master.m3u8`).
const NON_MEDIA_PATH_EXTENSIONS: &[&str] = &[
    ".gif", ".png", ".jpg", ".jpeg", ".svg", ".ico", ".css", ".js", ".woff",
    ".woff2", ".ttf", ".json", ".xml", ".html", ".htm", ".txt",
];

/// Known telemetry/analytics hosts that occasionally embed media URLs in their
/// query strings. Matched against host as a suffix so `prd.jwpltx.com`
/// matches `jwpltx.com`.
const BLOCKED_TELEMETRY_HOSTS: &[&str] = &[
    "jwpltx.com",
    "googletagmanager.com",
    "google-analytics.com",
    "doubleclick.net",
    "googlesyndication.com",
];

fn host_from_url(url: &str) -> Option<&str> {
    let after_scheme = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    let host = after_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    if host.is_empty() {
        return None;
    }
    // Strip port if present
    let host = host.split(':').next().unwrap_or(host);
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

fn url_path_lower(url_lower: &str) -> &str {
    // Operates on already-lowercased URL. Returns the path portion (no scheme,
    // no host, no query, no fragment).
    let after_scheme = url_lower
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(url_lower);
    let path_with_query = match after_scheme.find('/') {
        Some(idx) => &after_scheme[idx..],
        None => "",
    };
    let path = path_with_query
        .split(['?', '#'])
        .next()
        .unwrap_or_default();
    path
}

fn is_blocked_telemetry_host(host: &str) -> bool {
    let host_lower = host.to_ascii_lowercase();
    BLOCKED_TELEMETRY_HOSTS.iter().any(|blocked| {
        host_lower == *blocked || host_lower.ends_with(&format!(".{}", blocked))
    })
}

fn path_has_non_media_extension(path_lower: &str) -> bool {
    NON_MEDIA_PATH_EXTENSIONS
        .iter()
        .any(|ext| path_lower.ends_with(ext))
}

fn media_kind(url: &str) -> Option<&'static str> {
    let lower = url.to_ascii_lowercase();

    // Early rejection: telemetry hosts never serve playable media.
    if let Some(host) = host_from_url(&lower) {
        if is_blocked_telemetry_host(host) {
            return None;
        }
    }

    // Early rejection: URLs whose path ends in a static-asset extension are
    // never video, even if their query string happens to mention .m3u8 etc.
    let path = url_path_lower(&lower);
    if path_has_non_media_extension(path) {
        return None;
    }

    if lower.contains(".m3u8") {
        Some("hls")
    } else if lower.contains(".mpd") {
        Some("dash")
    } else if lower.contains(".mp4") || lower.contains(".mkv") || lower.contains(".webm") {
        Some("video")
    } else if lower.contains(".m4s")
        || lower.contains(".ts?")
        || lower.ends_with(".ts")
        || lower.contains("/seg-")
        || lower.contains("/segment")
        || lower.contains("/fragment")
    {
        Some("segment")
    } else {
        None
    }
}

/// Identify which substring caused `media_kind` to match, for diagnostic
/// logging. Returns `None` if `media_kind(url)` is `None`.
fn matched_substring(url: &str) -> Option<&'static str> {
    media_kind(url)?;
    let lower = url.to_ascii_lowercase();
    if lower.contains(".m3u8") {
        Some(".m3u8")
    } else if lower.contains(".mpd") {
        Some(".mpd")
    } else if lower.contains(".mp4") {
        Some(".mp4")
    } else if lower.contains(".mkv") {
        Some(".mkv")
    } else if lower.contains(".webm") {
        Some(".webm")
    } else if lower.contains(".m4s") {
        Some(".m4s")
    } else if lower.contains(".ts?") {
        Some(".ts?")
    } else if lower.ends_with(".ts") {
        Some("endsWith .ts")
    } else if lower.contains("/seg-") {
        Some("/seg-")
    } else if lower.contains("/segment") {
        Some("/segment")
    } else if lower.contains("/fragment") {
        Some("/fragment")
    } else {
        None
    }
}

/// Path-only embed/player markers used by `is_embed_like_url`. Path-only
/// (not query string) on purpose — plenty of analytics URLs include things
/// like `?source=stream`, and we don't want those to register as an embed.
const EMBED_PATH_MARKERS: &[&str] = &[
    "/stream/", "/embed/", "/player/", "/play/", "/watch/",
];

/// Returns `true` if `url` looks like a player/embed iframe whose origin is
/// the right `Referer` for CDN hot-link protection. Iframe documents are HTML
/// — never a media manifest, never a static asset — so the function rejects
/// those two categories up front before checking path markers. After that the
/// remaining conditions are AND'd:
///   1. Its path contains an `EMBED_PATH_MARKERS` substring.
///   2. Its host differs from `page_host` (same-origin iframes are
///      uninteresting — they share the page's referer already).
///   3. Its host is NOT a blocked telemetry host (a jwpltx-style ping with
///      `/stream/` in the path must not pollute the embed referer).
///
/// If `page_host` is empty the host-mismatch check is skipped (we don't yet
/// know what the page is; treat any embed-shaped URL as a candidate rather
/// than silently dropping it).
fn is_embed_like_url(url: &str, page_host: &str) -> bool {
    // Iframe docs are HTML, never m3u8/mp4/etc. A manifest URL with `/stream/`
    // in its path (e.g. `https://cdn.example/stream/master.m3u8`) must not
    // latch itself as its own referer — that would 403 the very candidate
    // we're about to emit.
    if media_kind(url).is_some() {
        return false;
    }
    let lower = url.to_ascii_lowercase();
    let path = url_path_lower(&lower);
    // Iframe docs have no extension or `.html`/`.htm`. Static assets (.jpg,
    // .css, .js, .woff, ...) on an unrelated CDN with an embed-shaped path
    // segment (e.g. `/watch/poster.jpg` on a thumbnail CDN) must not register.
    // .html/.htm are in NON_MEDIA_PATH_EXTENSIONS (correct for media_kind) but
    // are the legitimate extension for iframe documents, so we exempt them
    // here before the static-asset rejection runs.
    if !path.ends_with(".html") && !path.ends_with(".htm")
        && path_has_non_media_extension(path)
    {
        return false;
    }
    // After the two filters above the `/play/` and `/watch/` markers earn
    // their keep — they catch real third-party players on those paths
    // without dragging in image/asset CDNs.
    if !EMBED_PATH_MARKERS.iter().any(|marker| path.contains(marker)) {
        return false;
    }
    let Some(host) = host_from_url(&lower) else {
        return false;
    };
    if is_blocked_telemetry_host(host) {
        return false;
    }
    if !page_host.is_empty() {
        let page_lower = page_host.to_ascii_lowercase();
        if host == page_lower {
            return false;
        }
    }
    true
}

/// Read the current top-level page host snapshot. Returns an empty string if
/// the host has not been set yet (initial app boot, or sniffer running ahead
/// of the first NavigationStarting event).
fn current_page_host() -> String {
    let Some(slot) = CURRENT_PAGE_HOST.get() else {
        return String::new();
    };
    match slot.lock() {
        Ok(value) => value.clone().unwrap_or_default(),
        Err(_) => String::new(),
    }
}

/// Update `LATEST_EMBED_REFERER` if `url` looks like an embed iframe whose
/// host differs from the current page host. The stored value is
/// `https://{host}/` — exactly what CDNs check against. Logs one
/// `browser.embed.detected` entry per accepted update so future debugging
/// can correlate "we picked up this embed host" with the resulting CDN
/// request.
fn maybe_update_embed_referer(url: &str) {
    let page_host = current_page_host();
    if !is_embed_like_url(url, &page_host) {
        return;
    }
    let lower = url.to_ascii_lowercase();
    let Some(host) = host_from_url(&lower) else {
        return;
    };
    let host_owned = host.to_string();
    let new_referer = format!("https://{}/", host_owned);

    let slot = LATEST_EMBED_REFERER.get_or_init(|| Mutex::new(None));
    let mut changed = false;
    if let Ok(mut current) = slot.lock() {
        if current.as_deref() != Some(new_referer.as_str()) {
            *current = Some(new_referer.clone());
            changed = true;
        }
    }
    if changed {
        log_info(
            "browser.embed.detected",
            "Captured player iframe host for CDN referer",
            json!({ "host": host_owned, "url": url }),
        );
    }
}

fn is_interesting_request(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    media_kind(url).is_some()
        || lower.contains("playlist")
        || lower.contains("manifest")
        || lower.contains("master")
        || lower.contains("source")
        || lower.contains("stream")
        || lower.contains("embed")
        || lower.contains("player")
        || lower.contains("episode")
}

fn emit_media_request_debug(app: &tauri::AppHandle, url: &str) {
    let count = MEDIA_REQUEST_COUNT.fetch_add(1, Ordering::Relaxed) + 1;
    let interesting = is_interesting_request(url);

    // Firehose log: every distinct URL observed, before any filtering. Useful
    // for diagnosing why a real stream URL is being missed or why a non-stream
    // URL (e.g. JWPlayer telemetry pings) is sneaking through as a candidate.
    //
    // Two safeguards keep this from stalling the WebView2 pipeline:
    //   1. Per-URL dedup (SEEN_FIREHOSE_URLS) — repeat hits on the same
    //      manifest/segment URL within a session are dropped here. Reset on
    //      navigation by `clear_media_sniffer_state`.
    //   2. Background writer thread — the actual `log_info` disk I/O runs on
    //      a dedicated thread fed via an mpsc channel, so the WebView2
    //      callback returns immediately. Channel send failures are silently
    //      dropped (only possible if the writer thread has died, in which
    //      case losing diagnostic output is preferable to panicking on the
    //      WebView2 worker thread).
    if firehose_should_log(url) {
        if let Some(sender) = firehose_sender() {
            let entry = FirehoseLogEntry {
                url: url.to_string(),
                host: host_from_url(url).unwrap_or("").to_string(),
                kind: media_kind(url).unwrap_or("none"),
                interesting,
                matched_substring: matched_substring(url),
            };
            let _ = sender.send(entry);
        }
    }

    if interesting || count % 25 == 0 {
        if interesting {
            log_info(
                "browser.media.request",
                "Observed interesting provider media request",
                json!({ "url": url, "count": count }),
            );
        }
        let _ = app.emit(
            "media-request-debug",
            MediaRequestDebug {
                url: url.to_string(),
                count,
                interesting,
            },
        );
    }
}

fn emit_media_candidate(app: &tauri::AppHandle, url: String) {
    let Some(kind) = media_kind(&url) else { return };
    if kind == "segment" {
        return;
    }

    let seen = SEEN_MEDIA_URLS.get_or_init(|| Mutex::new(HashSet::new()));
    if let Ok(mut urls) = seen.lock() {
        if !urls.insert(url.clone()) {
            return;
        }
    }

    let referer = LATEST_EMBED_REFERER
        .get()
        .and_then(|slot| slot.lock().ok().and_then(|guard| guard.clone()));

    log_info(
        "browser.media.candidate",
        "Captured playable media candidate",
        json!({ "kind": kind, "url": url, "referer": referer }),
    );
    let _ = app.emit(
        "media-candidate",
        MediaCandidate {
            url,
            kind: kind.to_string(),
            referer,
        },
    );
}

fn emit_provider_page_identity(app: &tauri::AppHandle, identity: ProviderPageIdentity) {
    if identity.anime_title.is_none() && identity.episode_number.is_none() {
        return;
    }
    if identity.episode_number.is_some() {
        let current = IDENTITY_GENERATION.load(Ordering::Relaxed);
        IDENTITY_RESOLVED_GEN.store(current, Ordering::Relaxed);
    }
    log_info(
        "browser.provider.identity",
        "Detected provider page identity",
        json!({
            "animeTitle": &identity.anime_title,
            "episodeNumber": &identity.episode_number,
            "episodeLabel": &identity.episode_label,
            "sourcePage": &identity.source_page,
        }),
    );
    let _ = app.emit("provider-page-identity", identity);
}

fn start_identity_watchdog(watch_url: String) {
    let generation = IDENTITY_GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(IDENTITY_WATCHDOG_SECS));
        if IDENTITY_GENERATION.load(Ordering::Relaxed) != generation {
            return;
        }
        if IDENTITY_RESOLVED_GEN.load(Ordering::Relaxed) >= generation {
            return;
        }
        log_warn(
            "browser.provider.identity.timeout",
            "Provider identity not detected within watchdog window",
            json!({
                "watchUrl": watch_url,
                "windowSecs": IDENTITY_WATCHDOG_SECS,
            }),
        );
    });
}

pub(crate) fn clean_detected_episode(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }

    let lower = trimmed.to_ascii_lowercase();
    for marker in ["episode", "ep"] {
        if let Some(index) = lower.find(marker) {
            let after = trimmed[index + marker.len()..].trim_start_matches([' ', ':', '#', '-', '_']);
            let number = after
                .chars()
                .take_while(|character| character.is_ascii_digit() || *character == '.')
                .collect::<String>();
            if number.chars().any(|character| character.is_ascii_digit()) {
                return Some(number);
            }
        }
    }

    if trimmed.chars().all(|character| character.is_ascii_digit() || character == '.')
        && trimmed.chars().any(|character| character.is_ascii_digit())
    {
        return Some(trimmed.to_string());
    }

    None
}

fn query_value(url: &str, key: &str) -> Option<String> {
    let query = url.split_once('?')?.1.split('#').next().unwrap_or_default();
    for pair in query.split('&') {
        let (raw_key, raw_value) = pair.split_once('=').unwrap_or((pair, ""));
        if raw_key.eq_ignore_ascii_case(key) {
            return Some(raw_value.replace('+', " "));
        }
    }
    None
}

fn extract_episode_from_provider_url(url: &str) -> Option<String> {
    for key in ["ep", "episode", "episode_number", "episodeNumber"] {
        if let Some(value) = query_value(url, key).and_then(|value| clean_detected_episode(&value)) {
            return Some(value);
        }
    }

    let lower = url.to_ascii_lowercase();
    for marker in ["/episode/", "/episodes/", "/ep/", "episode-", "episode_", "ep-", "ep_"] {
        if let Some(index) = lower.find(marker) {
            let after = &url[index + marker.len()..];
            let number = after
                .chars()
                .take_while(|character| character.is_ascii_digit() || *character == '.')
                .collect::<String>();
            if number.chars().any(|character| character.is_ascii_digit()) {
                return Some(number);
            }
        }
    }

    None
}

pub(crate) fn is_anikai_identity_request(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    let is_animesuge = lower.contains("animesuge.cz");
    let is_anikai_family = lower.contains("anikai.to")
        || lower.contains("aniwaves.ru")
        || lower.contains("aniwave.ru");
    if !is_anikai_family && !is_animesuge {
        return false;
    }
    if media_kind(url).is_some() {
        return false;
    }
    // AnimeSuge: /ep- alone is too lax — search results, browse pages,
    // and arbitrary slugs can contain that substring (e.g. /search/ep-3-foo).
    // Require both /anime/ and /ep- (or /ep/) together, matching the
    // watch-document gate.
    if is_animesuge && !is_anikai_family {
        return lower.contains("/anime/")
            && (lower.contains("/ep-") || lower.contains("/ep/"));
    }
    lower.contains("ajax")
        || lower.contains("api")
        || lower.contains("episode")
        || lower.contains("server")
        || lower.contains("source")
        || lower.contains("player")
        || lower.contains("embed")
        || lower.contains("/ep-")
}

fn provider_identity_from_request_url(url: &str) -> Option<ProviderPageIdentity> {
    let episode_number = extract_episode_from_provider_url(url)?;
    Some(ProviderPageIdentity {
        anime_title: None,
        episode_label: Some(format!("Episode {episode_number}")),
        episode_number: Some(episode_number),
        source_page: None,
    })
}

fn find_episode_in_json(value: &Value) -> Option<String> {
    match value {
        Value::Object(map) => {
            for key in ["episode", "episode_number", "episodeNumber", "ep", "number"] {
                if let Some(found) = map.get(key).and_then(value_to_episode_number) {
                    return Some(found);
                }
            }
            for nested in map.values() {
                if let Some(found) = find_episode_in_json(nested) {
                    return Some(found);
                }
            }
            None
        }
        Value::Array(items) => items.iter().find_map(find_episode_in_json),
        Value::String(text) => clean_detected_episode(text),
        _ => None,
    }
}

fn value_to_episode_number(value: &Value) -> Option<String> {
    match value {
        Value::Number(number) => Some(number.to_string()),
        Value::String(text) => clean_detected_episode(text),
        _ => None,
    }
}

fn find_title_in_json(value: &Value) -> Option<String> {
    match value {
        Value::Object(map) => {
            for key in ["anime_title", "animeTitle", "anime", "title", "name"] {
                if let Some(text) = map
                    .get(key)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|text| !text.is_empty() && clean_detected_episode(text).is_none())
                {
                    return Some(text.to_string());
                }
            }
            for nested in map.values() {
                if let Some(found) = find_title_in_json(nested) {
                    return Some(found);
                }
            }
            None
        }
        Value::Array(items) => items.iter().find_map(find_title_in_json),
        _ => None,
    }
}

pub(crate) fn parse_anikai_identity_payload(source: &str, fallback_url: &str) -> Option<ProviderPageIdentity> {
    let payload: Value = serde_json::from_str(source.trim()).ok()?;
    let episode_number = find_episode_in_json(&payload)
        .or_else(|| extract_episode_from_provider_url(fallback_url))?;
    Some(ProviderPageIdentity {
        anime_title: find_title_in_json(&payload),
        episode_label: Some(format!("Episode {episode_number}")),
        episode_number: Some(episode_number),
        source_page: None,
    })
}

pub(crate) fn is_anikai_watch_document_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    (lower.contains("aniwaves.ru/watch/") || lower.contains("aniwave.ru/watch/") || lower.contains("anikai.to/watch/"))
        && !lower.contains(".m3u8")
        && !lower.contains(".mp4")
}

/// AnimeSuge watch-page detector. Their URL shape is
/// `https://animesuge.cz/anime/<slug>-<5char-id>/ep-<N>` — fundamentally
/// different from the aniwave/anikai `/watch/<id>` layout, so it gets its
/// own gate rather than being stuffed into `is_anikai_watch_document_url`.
/// Conditions are AND'd: animesuge.cz host AND `/anime/` somewhere in the
/// path AND an `/ep-` (or `/ep/`) marker. Media-extension URLs are rejected
/// up front so a thumbnail or manifest under the same host shape doesn't
/// trigger a response-body read.
pub(crate) fn is_animesuge_watch_document_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    let Some(host) = host_from_url(&lower) else {
        return false;
    };
    if !(host == "animesuge.cz" || host.ends_with(".animesuge.cz")) {
        return false;
    }
    if media_kind(url).is_some() {
        return false;
    }
    let path = url_path_lower(&lower);
    if !path.contains("/anime/") {
        return false;
    }
    path.contains("/ep-") || path.contains("/ep/")
}

fn is_navigation_allowed(url: &str, allowed_hosts: &[String]) -> bool {
    let trimmed = url.trim();
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("about:") || lower.starts_with("data:") || lower.starts_with("blob:") {
        return true;
    }

    let without_scheme = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
        .unwrap_or(&lower);
    let host = without_scheme
        .split(['/', '?', '#', ':'])
        .next()
        .unwrap_or_default();
    allowed_hosts.iter().any(|allowed| {
        let allowed = allowed.trim().to_ascii_lowercase();
        if allowed.is_empty() {
            return false;
        }
        host == allowed || host.ends_with(&format!(".{}", allowed))
    })
}

pub(crate) fn parse_anikai_sync_data(source: &str, fallback_url: &str) -> Option<ProviderPageIdentity> {
    let marker_index = source
        .find("id=\"syncData\"")
        .or_else(|| source.find("id='syncData'"))?;
    let after_marker = &source[marker_index..];
    let content_start = after_marker.find('>')? + 1;
    let after_open = &after_marker[content_start..];
    let content_end = after_open.find("</script>")?;
    let json = after_open[..content_end].trim();
    let payload: AnikaiSyncData = serde_json::from_str(json).ok()?;
    // AniKai currently ships stale `syncData.episode` values on some watch
    // pages. The live WebView poller below is allowed to provide an episode
    // number, but the static document payload is only safe for the anime title.
    let episode_number = None;
    Some(ProviderPageIdentity {
        anime_title: payload
            .name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string),
        episode_label: episode_number
            .as_ref()
            .map(|value| format!("Episode {value}")),
        episode_number,
        source_page: payload
            .series_url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
            .or_else(|| Some(fallback_url.to_string())),
    })
}

fn extract_aniwave_identity(source: &str, fallback_url: &str) -> Option<ProviderPageIdentity> {
    let ep_marker = "You're watching <b>Episode ";
    let episode_number = if let Some(idx) = source.find(ep_marker) {
        let after = &source[idx + ep_marker.len()..];
        if let Some(end_idx) = after.find("</b>") {
            Some(after[..end_idx].trim().to_string())
        } else {
            None
        }
    } else {
        None
    };

    let title_marker = "<title>";
    let anime_title = if let Some(idx) = source.find(title_marker) {
        let after = &source[idx + title_marker.len()..];
        if let Some(end_idx) = after.find("</title>") {
            let mut t = after[..end_idx].trim();
            if t.starts_with("Watch ") { t = &t["Watch ".len()..]; }
            if let Some(ep_idx) = t.rfind(" Episode ") {
                t = &t[..ep_idx];
            } else if let Some(dash_idx) = t.rfind(" - ") {
                t = &t[..dash_idx];
            }
            Some(t.to_string())
        } else {
            None
        }
    } else {
        None
    };

    if episode_number.is_some() {
        Some(ProviderPageIdentity {
            anime_title,
            episode_label: episode_number.as_ref().map(|v| format!("Episode {v}")),
            episode_number,
            source_page: Some(fallback_url.to_string()),
        })
    } else {
        None
    }
}

/// Parse AnimeSuge's `<title>` tag for anime + episode metadata.
///
/// Confirmed page-title format:
/// `<Anime Title> Episode <N> – Watch Anime Online in HD | AnimeSuge`
///
/// The delimiter between the episode number and the trailing suffix is an
/// en-dash (U+2013), but some sites and CMS pipelines normalize it to an
/// ASCII hyphen. This parser tolerates either: it locates the ` Episode `
/// substring (case-insensitive, leading space so titles ending in
/// `?`/`!` don't get over-eaten) and reads the digit run that immediately
/// follows. Anything after that — en-dash, ASCII hyphen, pipe, nothing —
/// is treated as the suffix.
///
/// Defensive trims: a leading "Watch " prefix is stripped from the title
/// (some CMS variants ship `Watch X Episode N – ...`) and trailing
/// whitespace is collapsed.
///
/// Returns `None` when no `Episode <digits>` pattern is present, letting
/// `extract_episode_from_provider_url` fall back to the URL path.
pub(crate) fn parse_animesuge_identity(source: &str, fallback_url: &str) -> Option<ProviderPageIdentity> {
    let title_marker = "<title>";
    let title_start = source.find(title_marker)? + title_marker.len();
    let after_open = &source[title_start..];
    let title_end = after_open.find("</title>")?;
    let raw_title = after_open[..title_end].trim();
    if raw_title.is_empty() {
        return None;
    }

    // Case-insensitive search for the " Episode " delimiter. We lower-case
    // the title once and find the byte index in the lower-case copy; since
    // " Episode " is ASCII, the byte index aligns with the original string
    // (lowercasing ASCII never changes byte length). Use rfind so titles
    // whose own name contains "Episode" (e.g. "Re:Zero Episode From Hell
    // Episode 5") split at the actual episode marker, not the title.
    let lower_title = raw_title.to_ascii_lowercase();
    let delim = " episode ";
    let delim_idx = lower_title.rfind(delim)?;

    let mut title_part = raw_title[..delim_idx].trim();
    if let Some(stripped) = title_part.strip_prefix("Watch ") {
        title_part = stripped.trim();
    } else if let Some(stripped) = title_part.strip_prefix("watch ") {
        title_part = stripped.trim();
    }

    let after_delim = &raw_title[delim_idx + delim.len()..];
    let number: String = after_delim
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    if !number.chars().any(|c| c.is_ascii_digit()) {
        return None;
    }
    // Reject a stray trailing dot ("Episode 5." with no decimal part).
    let clean_number = number.trim_end_matches('.');
    if clean_number.is_empty() {
        return None;
    }

    let anime_title = if title_part.is_empty() {
        None
    } else {
        Some(title_part.to_string())
    };

    Some(ProviderPageIdentity {
        anime_title,
        episode_label: Some(format!("Episode {clean_number}")),
        episode_number: Some(clean_number.to_string()),
        source_page: Some(fallback_url.to_string()),
    })
}

#[cfg(windows)]
fn read_stream_to_string(content: &windows::Win32::System::Com::IStream) -> Option<String> {
    let mut body = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let mut bytes_read = 0u32;
        unsafe {
            content
                .Read(
                    buffer.as_mut_ptr().cast(),
                    buffer.len() as u32,
                    Some(&mut bytes_read),
                )
                .ok()
                .ok()?;
        }
        if bytes_read == 0 {
            break;
        }
        body.extend_from_slice(&buffer[..bytes_read as usize]);
        if body.len() > 2 * 1024 * 1024 {
            break;
        }
    }
    String::from_utf8(body).ok()
}

#[cfg(windows)]
fn install_webview2_media_sniffer(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    allowed_hosts: Vec<String>,
) -> Result<(), String> {
    webview
        .with_webview(move |platform| unsafe {
            use webview2_com::{
                Microsoft::Web::WebView2::Win32::*, NavigationStartingEventHandler,
                WebResourceRequestedEventHandler, WebResourceResponseReceivedEventHandler,
                WebResourceResponseViewGetContentCompletedHandler,
            };
            use windows::core::{Interface, HSTRING, PWSTR};
            use windows::Win32::System::Com::IStream;

            let controller = platform.controller();
            let core = match controller.CoreWebView2() {
                Ok(core) => core,
                Err(error) => {
                    let _ = app.emit(
                        "media-sniffer-error",
                        format!("Could not access WebView2 core: {error}"),
                    );
                    return;
                }
            };

            if let Ok(core_22) = core.cast::<ICoreWebView2_22>() {
                let _ = core_22.AddWebResourceRequestedFilterWithRequestSourceKinds(
                    &HSTRING::from("*"),
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                    COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
                );
            } else {
                let _ = core.AddWebResourceRequestedFilter(
                    &HSTRING::from("*"),
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                );
            }

            let script = r#"
                if (!window.__amv_identity_poller) {
                    window.__amv_last_identity = "";
                    window.__amv_identity_poller = setInterval(() => {
                        try {
                            function cleanEpisode(value) {
                                if (!value) return null;
                                let text = String(value).replace(/\s+/g, " ").trim();
                                let match = text.match(/\b(?:Episode|EP)\s*([0-9]+(?:\.[0-9]+)?)/i);
                                if (match) return match[1];
                                if (/^[0-9]+(?:\.[0-9]+)?$/.test(text)) return text;
                                return null;
                            }
                            let ep = null;
                            let selectors = [
                                '.tip b',
                                '.ep-num',
                                '[data-episode].active',
                                '[data-number].active',
                                '[data-ep].active',
                                '.episode-section .active',
                                '[class*="episode"] .active',
                                '[class*="episode"][class*="active"]'
                            ];
                            for (let selector of selectors) {
                                let epEl = document.querySelector(selector);
                                if (!epEl) continue;
                                ep = cleanEpisode(epEl.getAttribute('data-episode'))
                                    || cleanEpisode(epEl.getAttribute('data-number'))
                                    || cleanEpisode(epEl.getAttribute('data-ep'))
                                    || cleanEpisode(epEl.textContent);
                                if (ep) break;
                            }
                            if (!ep) {
                                let params = new URLSearchParams(window.location.search);
                                ep = cleanEpisode(params.get('ep') || params.get('episode') || params.get('e'));
                            }
                            let title = null;
                            let titleEl = document.querySelector('h1.title');
                            if (titleEl) {
                                title = titleEl.innerText.trim();
                            }
                            if ((ep || title) && window.__TAURI__ && window.__TAURI__.event) {
                                let current = ep + "|" + title;
                                if (current !== window.__amv_last_identity) {
                                    window.__amv_last_identity = current;
                                    window.__TAURI__.event.emit('provider-page-identity', {
                                        animeTitle: title,
                                        episodeNumber: ep,
                                        episodeLabel: ep ? "Episode " + ep : null,
                                        sourcePage: window.location.href
                                    });
                                }
                            }
                        } catch (e) {}
                    }, 1500);
                }
            "#;
            let _ = core.AddScriptToExecuteOnDocumentCreated(&HSTRING::from(script), None);

            let app_for_handler = app.clone();
            let handler = WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let request = args.Request()?;
                let mut raw_uri = PWSTR::null();
                request.Uri(&mut raw_uri)?;
                if let Ok(url) = raw_uri.to_string() {
                    emit_media_request_debug(&app_for_handler, &url);
                    maybe_update_embed_referer(&url);
                    if is_anikai_identity_request(&url) {
                        if let Some(identity) = provider_identity_from_request_url(&url) {
                            emit_provider_page_identity(&app_for_handler, identity);
                        }
                    }
                    emit_media_candidate(&app_for_handler, url);
                }
                Ok(())
            }));

            let mut token = 0;
            if let Err(error) = core.add_WebResourceRequested(&handler, &mut token) {
                log_error(
                    "browser.sniffer.error",
                    "WebView2 media sniffer failed",
                    json!({ "error": error.to_string() }),
                );
                let _ = app.emit("media-sniffer-error", format!("{error}"));
            } else {
                log_info("browser.sniffer.ready", "WebView2 media sniffer ready", Value::Null);
                let _ = app.emit("media-sniffer-ready", ());
            }

            if let Ok(core_2) = core.cast::<ICoreWebView2_2>() {
                let app_for_response = app.clone();
                let response_handler =
                    WebResourceResponseReceivedEventHandler::create(Box::new(move |_, args| {
                        let Some(args) = args else { return Ok(()) };
                        let request = args.Request()?;
                        let mut raw_uri = PWSTR::null();
                        request.Uri(&mut raw_uri)?;
                        let Ok(request_url) = raw_uri.to_string() else {
                            return Ok(());
                        };
                        let should_read_anikai_watch = is_anikai_watch_document_url(&request_url);
                        let should_read_animesuge_watch = is_animesuge_watch_document_url(&request_url);
                        let should_read_identity_api = is_anikai_identity_request(&request_url);
                        if !should_read_anikai_watch
                            && !should_read_animesuge_watch
                            && !should_read_identity_api
                        {
                            return Ok(());
                        }

                        let response = args.Response()?;
                        let mut status_code = 0;
                        if response.StatusCode(&mut status_code).is_err()
                            || !(200..400).contains(&status_code)
                        {
                            return Ok(());
                        }

                        let app_for_content = app_for_response.clone();
                        let response_url = request_url.clone();
                        let content_handler =
                            WebResourceResponseViewGetContentCompletedHandler::create(Box::new(
                                move |result, content: Option<IStream>| {
                                    if result.is_err() {
                                        return Ok(());
                                    }
                                    let Some(content) = content else {
                                        return Ok(());
                                    };
                                    if let Some(source) = read_stream_to_string(&content) {
                                        let identity = if should_read_animesuge_watch {
                                            parse_animesuge_identity(&source, &response_url)
                                                .or_else(|| {
                                                    extract_episode_from_provider_url(&response_url).map(|n| {
                                                        ProviderPageIdentity {
                                                            anime_title: None,
                                                            episode_label: Some(format!("Episode {n}")),
                                                            episode_number: Some(n),
                                                            source_page: Some(response_url.clone()),
                                                        }
                                                    })
                                                })
                                        } else if should_read_anikai_watch {
                                            parse_anikai_sync_data(&source, &response_url)
                                                .or_else(|| extract_aniwave_identity(&source, &response_url))
                                        } else {
                                            parse_anikai_identity_payload(&source, &response_url)
                                        };
                                        if let Some(identity) = identity {
                                            emit_provider_page_identity(&app_for_content, identity);
                                        }
                                    }
                                    Ok(())
                                },
                            ));
                        let _ = response.GetContent(&content_handler);
                        Ok(())
                    }));
                let mut response_token = 0;
                let _ =
                    core_2.add_WebResourceResponseReceived(&response_handler, &mut response_token);
            }

            let app_for_navigation = app.clone();
            let allowed_hosts_for_navigation = allowed_hosts.clone();
            let navigation_handler =
                NavigationStartingEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    clear_media_sniffer_state();
                    let mut raw_uri = PWSTR::null();
                    args.Uri(&mut raw_uri)?;
                    if let Ok(url) = raw_uri.to_string() {
                        if !allowed_hosts_for_navigation.is_empty()
                            && !is_navigation_allowed(&url, &allowed_hosts_for_navigation)
                        {
                            let _ = args.SetCancel(true);
                            log_warn(
                                "browser.navigation.blocked",
                                "Blocked provider navigation outside allowlist",
                                json!({ "url": url }),
                            );
                            let _ = app_for_navigation.emit(
                                "media-sniffer-error",
                                format!("Blocked navigation outside allowed hosts: {url}"),
                            );
                            return Ok(());
                        }
                        log_info(
                            "browser.navigation",
                            "Provider WebView navigation started",
                            json!({ "url": url }),
                        );
                        // Track the top-level page host so the sniffer can
                        // tell same-origin iframes apart from third-party
                        // embed/player iframes (whose host is the CDN's
                        // expected Referer). NOTE: this is updated on every
                        // accepted top-level navigation, NOT cleared in
                        // `clear_media_sniffer_state` — the host outlives
                        // the per-page resource set.
                        if let Some(host) = host_from_url(&url) {
                            let slot = CURRENT_PAGE_HOST
                                .get_or_init(|| Mutex::new(None));
                            if let Ok(mut value) = slot.lock() {
                                *value = Some(host.to_string());
                            }
                        }
                        if is_anikai_watch_document_url(&url) || is_animesuge_watch_document_url(&url) {
                            start_identity_watchdog(url.clone());
                        }
                        let _ = app_for_navigation
                            .emit("provider-navigation", ProviderNavigation { url });
                    }
                    Ok(())
                }));
            let mut navigation_token = 0;
            let _ = core.add_NavigationStarting(&navigation_handler, &mut navigation_token);
        })
        .map_err(|error| error.to_string())
}

#[cfg(not(windows))]
fn install_webview2_media_sniffer(
    _app: tauri::AppHandle,
    _webview: tauri::Webview,
    _allowed_hosts: Vec<String>,
) -> Result<(), String> {
    Err("Media sniffing is currently Windows/WebView2-only.".to_string())
}

#[tauri::command]
pub(crate) async fn install_media_sniffer(
    app: tauri::AppHandle,
    label: String,
    allowed_hosts: Option<Vec<String>>,
) -> Result<(), String> {
    let allowed_hosts = allowed_hosts.unwrap_or_default();
    log_info(
        "browser.sniffer.install.start",
        "Installing media sniffer",
        json!({ "label": label, "allowed_hosts": allowed_hosts }),
    );
    clear_media_sniffer_state();
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Could not find provider WebView '{label}'"))?;
    let result = install_webview2_media_sniffer(app, webview, allowed_hosts);
    match &result {
        Ok(_) => log_info(
            "browser.sniffer.install.complete",
            "Media sniffer installed",
            json!({ "label": label }),
        ),
        Err(error) => log_error(
            "browser.sniffer.install.error",
            "Media sniffer install failed",
            json!({ "label": label, "error": error }),
        ),
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jwplayer_ping_with_m3u8_in_query_is_rejected() {
        // The actual user-reported bug: JWPlayer telemetry ping with an
        // .m3u8 URL embedded in its query string slipped past the original
        // substring-only matcher and showed up as "Captured playback stream".
        let url = "https://prd.jwpltx.com/v1/jwplayer6/ping.gif?mu=https%3A//cdn/master.m3u8";
        assert_eq!(media_kind(url), None);
    }

    #[test]
    fn real_hls_manifest_still_detected() {
        let url = "https://cdn.example/master.m3u8?token=abc";
        assert_eq!(media_kind(url), Some("hls"));
    }

    #[test]
    fn real_mp4_still_detected() {
        let url = "https://cdn.example/video.mp4";
        assert_eq!(media_kind(url), Some("video"));
    }

    #[test]
    fn thumbnail_gif_is_rejected() {
        let url = "https://cdn.example/thumbnail.gif";
        assert_eq!(media_kind(url), None);
    }

    #[test]
    fn telemetry_host_blocked_even_with_mp4_in_query() {
        // Even if a real video extension appears in the query string, requests
        // to known analytics hosts must never be treated as candidates.
        let url = "https://www.google-analytics.com/collect?ec=foo.mp4";
        assert_eq!(media_kind(url), None);
    }

    #[test]
    fn host_from_url_strips_port_and_path() {
        assert_eq!(host_from_url("https://cdn.example.com:8443/path?q=1"), Some("cdn.example.com"));
        assert_eq!(host_from_url("http://localhost/foo"), Some("localhost"));
    }

    #[test]
    fn telemetry_host_suffix_match() {
        assert!(is_blocked_telemetry_host("prd.jwpltx.com"));
        assert!(is_blocked_telemetry_host("jwpltx.com"));
        assert!(is_blocked_telemetry_host("www.google-analytics.com"));
        assert!(!is_blocked_telemetry_host("cdn.example.com"));
        // A host that merely contains the blocked name as a substring
        // (not a suffix segment) must not match.
        assert!(!is_blocked_telemetry_host("notjwpltx.com.evil.com"));
    }

    #[test]
    fn url_path_strips_query_and_fragment() {
        assert_eq!(url_path_lower("https://x.com/a/b.gif?q=1#frag"), "/a/b.gif");
        assert_eq!(url_path_lower("https://x.com"), "");
    }

    #[test]
    fn matched_substring_reports_trigger() {
        assert_eq!(
            matched_substring("https://cdn.example/master.m3u8?token=abc"),
            Some(".m3u8")
        );
        assert_eq!(
            matched_substring("https://cdn.example/video.mp4"),
            Some(".mp4")
        );
        assert_eq!(
            matched_substring("https://prd.jwpltx.com/ping.gif?mu=foo.m3u8"),
            None
        );
    }

    /// Serialize firehose-dedup tests because they share the process-global
    /// `SEEN_FIREHOSE_URLS` set with each other (and with the rest of the
    /// suite indirectly via `clear_media_sniffer_state`).
    static FIREHOSE_TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn firehose_dedup_skips_repeat_urls() {
        let _guard = FIREHOSE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_media_sniffer_state();
        let url = "https://cdn.example/firehose-dedup-test/master.m3u8";
        assert!(firehose_should_log(url), "first call must log");
        assert!(
            !firehose_should_log(url),
            "second call for the same URL must be deduped"
        );
        assert!(
            !firehose_should_log(url),
            "third call still deduped within the same session"
        );
    }

    #[test]
    fn firehose_dedup_resets_on_clear_state() {
        let _guard = FIREHOSE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_media_sniffer_state();
        let url = "https://cdn.example/firehose-reset-test/master.m3u8";
        assert!(firehose_should_log(url), "first call must log");
        assert!(!firehose_should_log(url), "second call deduped");

        clear_media_sniffer_state();

        assert!(
            firehose_should_log(url),
            "after clear_media_sniffer_state, the same URL must log again"
        );
    }

    #[test]
    fn embed_like_url_detects_third_party_player_iframe() {
        // Canonical case: parent page is on `animesuge.cz`, the player iframe
        // it loads lives on `megaplay.buzz/stream/...`. This is the URL whose
        // origin we need to use as the Referer header for the CDN.
        let url = "https://megaplay.buzz/stream/s-2/57899/sub?autostart=true";
        assert!(is_embed_like_url(url, "animesuge.cz"));
    }

    #[test]
    fn embed_like_url_ignores_same_origin_iframe() {
        // A same-origin `/watch/` or `/stream/` iframe is uninteresting — it
        // shares the page's referer by default and is never the CDN's
        // expected Referer host.
        let url = "https://animesuge.cz/watch/abc/stream/foo";
        assert!(!is_embed_like_url(url, "animesuge.cz"));
    }

    #[test]
    fn embed_like_url_rejects_telemetry_hosts() {
        // A telemetry ping that happens to have `/stream/` in its path must
        // not pollute the embed referer — the resulting CDN request would
        // get a `https://prd.jwpltx.com/` referer and 403.
        let url = "https://prd.jwpltx.com/stream/foo?event=play";
        assert!(!is_embed_like_url(url, "animesuge.cz"));
    }

    #[test]
    fn embed_like_url_rejects_unrelated_paths() {
        // A generic article URL with no embed/player marker in the path
        // must not register.
        let url = "https://example.com/article/123";
        assert!(!is_embed_like_url(url, "animesuge.cz"));
    }

    #[test]
    fn embed_like_url_path_only_no_query_match() {
        // `/stream/` appearing only in the query string must not register —
        // analytics URLs commonly include `?source=stream`.
        let url = "https://example.com/article/123?source=stream";
        assert!(!is_embed_like_url(url, "animesuge.cz"));
    }

    #[test]
    fn embed_like_url_no_page_host_skips_host_check() {
        // When the top-level page host is unknown (initial boot, before
        // first NavigationStarting), we accept any embed-shaped URL rather
        // than silently dropping it.
        let url = "https://megaplay.buzz/stream/s-2/57899/sub";
        assert!(is_embed_like_url(url, ""));
    }

    #[test]
    fn embed_like_url_rejects_media_manifest_with_embed_marker() {
        // A manifest URL whose path contains `/stream/` is a *candidate*, not
        // an iframe document. If it were allowed to latch itself as the
        // embed referer, the resulting CDN request would carry its own
        // origin as Referer and get rejected with 403.
        let url = "https://cdn.example.com/stream/master.m3u8";
        assert!(!is_embed_like_url(url, "animesuge.cz"));
    }

    #[test]
    fn embed_like_url_rejects_static_asset_with_embed_marker() {
        // A thumbnail/asset CDN URL whose path contains `/watch/` is a
        // static asset (.jpg here), not an iframe document. Iframe docs are
        // HTML, never images.
        let url = "https://thumbs.cdn/watch/poster.jpg";
        assert!(!is_embed_like_url(url, "animesuge.cz"));
    }

    #[test]
    fn embed_like_url_accepts_html_iframe_document() {
        // Embed iframes are HTML. `.html`/`.htm` paths must not be rejected
        // by the static-asset filter even though those extensions live in
        // NON_MEDIA_PATH_EXTENSIONS (correct for media_kind, wrong here).
        assert!(is_embed_like_url(
            "https://megaplay.buzz/embed/player.html",
            "animesuge.cz",
        ));
        assert!(is_embed_like_url(
            "https://megaplay.buzz/stream/index.htm",
            "animesuge.cz",
        ));
    }

    #[test]
    fn animesuge_watch_document_url_matches_real_ep_path() {
        let url = "https://animesuge.cz/anime/attack-on-titan-chronicle-jvxv0/ep-1";
        assert!(is_animesuge_watch_document_url(url));
    }

    #[test]
    fn animesuge_watch_document_url_rejects_homepage() {
        assert!(!is_animesuge_watch_document_url("https://animesuge.cz/"));
        assert!(!is_animesuge_watch_document_url("https://animesuge.cz"));
    }

    #[test]
    fn animesuge_watch_document_url_rejects_anime_page_without_episode() {
        // /anime/<slug> with no /ep- segment is the series landing page,
        // not a watch page — must not trigger response-body reads.
        assert!(!is_animesuge_watch_document_url("https://animesuge.cz/anime/foo"));
        assert!(!is_animesuge_watch_document_url("https://animesuge.cz/anime/foo-bar-jvxv0"));
    }

    #[test]
    fn animesuge_watch_document_url_rejects_media_extension() {
        // A manifest URL under the same path shape must not be classified
        // as a watch document — the response-body reader would waste a
        // GetContent round-trip on a binary stream.
        let url = "https://animesuge.cz/anime/foo/ep-1.m3u8";
        assert!(!is_animesuge_watch_document_url(url));
    }

    #[test]
    fn animesuge_watch_document_url_rejects_wrong_host() {
        // The path shape alone is not enough — host must be animesuge.cz.
        let url = "https://example.com/anime/foo/ep-1";
        assert!(!is_animesuge_watch_document_url(url));
    }

    #[test]
    fn animesuge_watch_document_url_accepts_subdomain() {
        // Defensive: cdn / www / cn subdomains of animesuge.cz should still
        // match (host_from_url + endsWith ".animesuge.cz").
        let url = "https://www.animesuge.cz/anime/foo-bar-abc12/ep-3";
        assert!(is_animesuge_watch_document_url(url));
    }

    #[test]
    fn parse_animesuge_identity_extracts_title_and_episode() {
        let html = "<html><head><title>Attack on Titan: Chronicle Episode 1 \u{2013} Watch Anime Online in HD | AnimeSuge</title></head><body></body></html>";
        let identity = parse_animesuge_identity(
            html,
            "https://animesuge.cz/anime/attack-on-titan-chronicle-jvxv0/ep-1",
        )
        .expect("title pattern should match");
        assert_eq!(
            identity.anime_title.as_deref(),
            Some("Attack on Titan: Chronicle"),
        );
        assert_eq!(identity.episode_number.as_deref(), Some("1"));
        assert_eq!(identity.episode_label.as_deref(), Some("Episode 1"));
        assert_eq!(
            identity.source_page.as_deref(),
            Some("https://animesuge.cz/anime/attack-on-titan-chronicle-jvxv0/ep-1"),
        );
    }

    #[test]
    fn parse_animesuge_identity_handles_decimal_episode() {
        let html = "<title>Something Episode 5.5 \u{2013} Watch Anime Online in HD | AnimeSuge</title>";
        let identity = parse_animesuge_identity(html, "https://animesuge.cz/anime/foo/ep-5.5")
            .expect("decimal episode should parse");
        assert_eq!(identity.episode_number.as_deref(), Some("5.5"));
        assert_eq!(identity.episode_label.as_deref(), Some("Episode 5.5"));
        assert_eq!(identity.anime_title.as_deref(), Some("Something"));
    }

    #[test]
    fn parse_animesuge_identity_handles_ascii_hyphen_variant() {
        // Some CMS pipelines normalize the en-dash to an ASCII hyphen.
        // The parser splits on " Episode " regardless of suffix delimiter.
        let html = "<title>Naruto Episode 12 - Watch Anime Online in HD | AnimeSuge</title>";
        let identity = parse_animesuge_identity(html, "https://animesuge.cz/anime/naruto/ep-12")
            .expect("ASCII hyphen variant should still parse");
        assert_eq!(identity.anime_title.as_deref(), Some("Naruto"));
        assert_eq!(identity.episode_number.as_deref(), Some("12"));
    }

    #[test]
    fn parse_animesuge_identity_strips_leading_watch_prefix() {
        let html = "<title>Watch Bleach Episode 7 \u{2013} Watch Anime Online in HD | AnimeSuge</title>";
        let identity = parse_animesuge_identity(html, "https://animesuge.cz/anime/bleach/ep-7")
            .expect("'Watch ' prefix should be stripped");
        assert_eq!(identity.anime_title.as_deref(), Some("Bleach"));
        assert_eq!(identity.episode_number.as_deref(), Some("7"));
    }

    #[test]
    fn parse_animesuge_identity_returns_none_for_homepage_title() {
        let html = "<title>AnimeSuge - Watch Anime Online in HD</title>";
        assert!(parse_animesuge_identity(html, "https://animesuge.cz/").is_none());
    }

    #[test]
    fn parse_animesuge_identity_returns_none_for_missing_title() {
        let html = "<html><body>no title tag</body></html>";
        assert!(parse_animesuge_identity(html, "https://animesuge.cz/").is_none());
    }

    #[test]
    fn parse_animesuge_identity_splits_at_last_episode_marker() {
        // A series whose own title contains "Episode" must not break the
        // parser. find(" episode ") would split at "Re:Zero" (first match);
        // rfind splits at the last occurrence — the actual episode marker.
        let html = "<title>Re:Zero Episode From Hell Episode 5 \u{2013} Watch Anime Online in HD | AnimeSuge</title>";
        let identity = parse_animesuge_identity(html, "https://animesuge.cz/anime/rezero/ep-5")
            .expect("title containing the word Episode must still parse");
        assert_eq!(identity.anime_title.as_deref(), Some("Re:Zero Episode From Hell"));
        assert_eq!(identity.episode_number.as_deref(), Some("5"));
    }

    #[test]
    fn animesuge_identity_request_rejects_non_anime_paths() {
        // /ep- alone is too generic — the gate must require /anime/ for
        // AnimeSuge so search results and browse URLs that happen to contain
        // /ep- don't fire spurious identity events.
        assert!(!is_anikai_identity_request(
            "https://animesuge.cz/search/ep-3-favorites"
        ));
        assert!(!is_anikai_identity_request(
            "https://animesuge.cz/browse?filter=ep-1"
        ));
        // The real watch URL must still pass.
        assert!(is_anikai_identity_request(
            "https://animesuge.cz/anime/attack-on-titan-chronicle-jvxv0/ep-1"
        ));
    }

    #[test]
    fn animesuge_identity_request_host_is_allowed() {
        // The URL-based identity gate must accept animesuge.cz hosts so the
        // existing `provider_identity_from_request_url` can fire on `ep-N`
        // navigation URLs.
        assert!(is_anikai_identity_request(
            "https://animesuge.cz/anime/foo/ep-3"
        ));
    }

    #[test]
    fn firehose_dedup_soft_cap_bounds_set_size() {
        // Drive enough distinct URLs through `firehose_should_log` to exceed
        // the soft cap and confirm the set never grows past it (the flush
        // path keeps memory bounded on long-running SPA sessions that never
        // fire NavigationStarting between episodes).
        let _guard = FIREHOSE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_media_sniffer_state();

        let push_count = FIREHOSE_DEDUP_SOFT_CAP + 50;
        for i in 0..push_count {
            let url = format!("https://cdn.example/soft-cap-test/seg-{i}.m3u8");
            assert!(
                firehose_should_log(&url),
                "distinct URL #{i} should be logged at least once"
            );
        }

        let len = SEEN_FIREHOSE_URLS
            .get()
            .expect("dedup set initialized after first should_log call")
            .lock()
            .expect("dedup mutex not poisoned")
            .len();
        assert!(
            len <= FIREHOSE_DEDUP_SOFT_CAP,
            "dedup set grew past soft cap ({len} > {FIREHOSE_DEDUP_SOFT_CAP})"
        );

        clear_media_sniffer_state();
    }
}
