use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::Duration,
};

use chrono::Local;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Emitter, Manager};
use tauri::async_runtime::Mutex as AsyncMutex;
use tokio::process::{Child as AsyncChild, Command as AsyncCommand};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader as AsyncBufReader};

#[derive(Clone, Serialize)]
struct MediaCandidate {
    url: String,
    kind: String,
}

#[derive(Clone, Serialize)]
struct MediaRequestDebug {
    url: String,
    count: usize,
    interesting: bool,
}

#[derive(Clone, Serialize)]
struct ProviderNavigation {
    url: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderPageIdentity {
    anime_title: Option<String>,
    episode_number: Option<String>,
    episode_label: Option<String>,
    source_page: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    job_id: Option<String>,
    stage: String,
    percent: Option<f32>,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    warning: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversionProgress {
    stage: String,
    percent: Option<f32>,
    message: String,
    fps: Option<String>,
    speed: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversionDone {
    r#type: String,
    input: String,
    output: String,
    archived_original: Option<String>,
    preset: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoGpuStatus {
    compatible: bool,
    gpu_name: Option<String>,
    has_nvidia_gpu: bool,
    has_ffmpeg: bool,
    has_ffprobe: bool,
    has_h264_cuvid: bool,
    has_hevc_cuvid: bool,
    has_hevc_nvenc: bool,
    has_h264_nvenc: bool,
    has_av1_nvenc: bool,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClipPreviewDone {
    r#type: String,
    scene_id: String,
    path: String,
    duration: f64,
    cached: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClipPreviewRequest {
    scene_id: String,
    source_path: String,
    start: f64,
    end: f64,
    fps: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClipPreviewBatchDone {
    r#type: String,
    items: Vec<ClipPreviewBatchItem>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClipPreviewBatchItem {
    scene_id: String,
    path: Option<String>,
    duration: f64,
    cached: bool,
    error: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct ExportClip {
    pub source: String,
    pub start: f64,
    pub end: f64,
    pub index: usize,
    pub fps: Option<f64>,
}

#[derive(Clone, Serialize)]
struct StreamQuality {
    id: String,
    label: String,
    url: String,
    width: Option<u64>,
    height: Option<u64>,
    bitrate: Option<f64>,
    codec: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadFormat {
    id: String,
    label: String,
    ext: Option<String>,
    resolution: Option<String>,
    width: Option<u64>,
    height: Option<u64>,
    bitrate: Option<f64>,
    filesize: Option<u64>,
    vcodec: Option<String>,
    acodec: Option<String>,
    audio_only: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadHistoryItem {
    id: String,
    created_at: String,
    kind: String,
    title: String,
    subtitle: Option<String>,
    quality_label: Option<String>,
    url: String,
    referer: Option<String>,
    format_id: Option<String>,
    output_path: String,
    source_page: Option<String>,
}

struct DownloadMetadata {
    anime_title: Option<String>,
    episode_number: Option<String>,
    episode_label: Option<String>,
    quality_label: Option<String>,
    source_page: Option<String>,
}

struct MediaDownloadMetadata {
    kind: String,
    title: Option<String>,
    subtitle: Option<String>,
    quality_label: Option<String>,
    source_page: Option<String>,
    format_id: Option<String>,
    folder_name: Option<String>,
    clip_start_seconds: Option<f64>,
    clip_end_seconds: Option<f64>,
    force_keyframes_at_cuts: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadFormatInspection {
    duration_seconds: Option<f64>,
    is_live: bool,
    video_id: Option<String>,
    preview_url: Option<String>,
    formats: Vec<DownloadFormat>,
}

struct DownloadIdentity {
    anime_folder: String,
    file_stem: String,
}

#[derive(Deserialize)]
struct AnikaiSyncData {
    name: Option<String>,
    series_url: Option<String>,
}

static SEEN_MEDIA_URLS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static MEDIA_REQUEST_COUNT: AtomicUsize = AtomicUsize::new(0);
static IDENTITY_GENERATION: AtomicU64 = AtomicU64::new(0);
static IDENTITY_RESOLVED_GEN: AtomicU64 = AtomicU64::new(0);
const IDENTITY_WATCHDOG_SECS: u64 = 12;
static AUDIO_CHILD_PID: OnceLock<Mutex<Option<u32>>> = OnceLock::new();
static CLIP_CHILD_PID: OnceLock<Mutex<Option<u32>>> = OnceLock::new();
static DOWNLOAD_CHILD_PID: OnceLock<Mutex<Option<u32>>> = OnceLock::new();
static VIDEO_CHILD_PID: OnceLock<Mutex<Option<u32>>> = OnceLock::new();
static H264_NVENC_AVAILABLE: OnceLock<bool> = OnceLock::new();
static CLIP_SERVER: OnceLock<AsyncMutex<Option<AsyncChild>>> = OnceLock::new();

const GPU_INTRA_SOURCE_CODECS: &str = "H.264 or HEVC";

fn truncate_log_text(value: impl AsRef<str>) -> String {
    const MAX_LEN: usize = 12 * 1024;
    let value = value.as_ref();
    if value.len() <= MAX_LEN {
        return value.to_string();
    }
    let keep_from = value.len().saturating_sub(MAX_LEN);
    format!("[truncated]\n{}", &value[keep_from..])
}

fn app_state_dir() -> PathBuf {
    if let Ok(path) = std::env::var("ULTIMATE_AMV_STATE_DIR") {
        return PathBuf::from(path);
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(path) = std::env::var("APPDATA") {
            return PathBuf::from(path).join("com.elishapervez.ultimateamv");
        }
        if let Ok(path) = std::env::var("LOCALAPPDATA") {
            return PathBuf::from(path).join("com.elishapervez.ultimateamv");
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(path) = std::env::var("XDG_DATA_HOME") {
            return PathBuf::from(path).join("ultimate-amv");
        }
        if let Ok(path) = std::env::var("HOME") {
            return PathBuf::from(path).join(".local").join("share").join("ultimate-amv");
        }
    }

    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".ultimate-amv-state")
}

fn append_app_log(level: &str, event: &str, message: &str, details: Value) {
    let path = app_state_dir().join("logs").join("ultimate-amv.log");
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let created_at = Local::now().format("%Y-%m-%dT%H:%M:%S%.3f%:z");
    let detail_text = if details.is_null() {
        String::new()
    } else {
        format!(
            "\n    details: {}",
            truncate_log_text(serde_json::to_string(&details).unwrap_or_else(|_| "{}".to_string()))
        )
    };
    let line = format!(
        "[{created_at}] [{}] {event}: {}{detail_text}\n",
        level.to_ascii_uppercase(),
        truncate_log_text(message)
    );

    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(line.as_bytes());
    }
}

fn reset_app_logs() {
    let state_dir = app_state_dir();
    let text_path = state_dir.join("logs").join("ultimate-amv.log");
    if let Some(parent) = text_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(text_path);
    let _ = fs::create_dir_all(&state_dir);
    let _ = fs::write(state_dir.join("app_logs.json"), "[]\n");
}

fn log_info(event: &str, message: &str, details: Value) {
    append_app_log("info", event, message, details);
}

fn log_warn(event: &str, message: &str, details: Value) {
    append_app_log("warn", event, message, details);
}

fn log_error(event: &str, message: &str, details: Value) {
    append_app_log("error", event, message, details);
}

fn clear_media_sniffer_state() {
    if let Some(seen) = SEEN_MEDIA_URLS.get() {
        if let Ok(mut urls) = seen.lock() {
            urls.clear();
        }
    }
    MEDIA_REQUEST_COUNT.store(0, Ordering::Relaxed);
}

fn app_root() -> Result<PathBuf, String> {
    if let Some(exe_dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
    {
        if exe_dir.join("backend").is_dir() {
            return Ok(exe_dir);
        }
    }
    let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    if cwd.file_name().and_then(|name| name.to_str()) == Some("src-tauri") {
        return cwd
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "Could not resolve project root".to_string());
    }
    Ok(cwd)
}

fn python_exe(root: &Path) -> PathBuf {
    root.join("python").join("python.exe")
}

fn find_tool(root: &Path, name: &str) -> PathBuf {
    root.join("tools").join(format!("{name}.exe"))
}

fn cmd(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut c = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    c
}

fn store_child_pid(slot: &OnceLock<Mutex<Option<u32>>>, pid: u32) {
    if let Ok(mut g) = slot.get_or_init(|| Mutex::new(None)).lock() {
        *g = Some(pid);
    }
}

fn clear_child_pid(slot: &OnceLock<Mutex<Option<u32>>>) {
    if let Some(m) = slot.get() {
        if let Ok(mut g) = m.lock() {
            *g = None;
        }
    }
}

fn kill_child_pid(slot: &OnceLock<Mutex<Option<u32>>>) {
    let Some(m) = slot.get() else { return };
    let Ok(g) = m.lock() else { return };
    if let Some(pid) = *g {
        let _ = cmd("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .output();
    }
}

fn audio_cli_path(root: &Path) -> PathBuf {
    root.join("backend").join("audio_cli.py")
}

fn clip_cli_path(root: &Path) -> PathBuf {
    root.join("backend").join("clip_cli.py")
}

fn run_audio_cli(args: &[&str]) -> Result<String, String> {
    let root = app_root()?;
    if args.first().copied() != Some("logs") {
        log_info(
            "audio.bridge.start",
            "Starting audio bridge command",
            json!({ "args": args }),
        );
    }
    let output = cmd(python_exe(&root))
        .arg("-I")
        .arg(audio_cli_path(&root))
        .args(args)
        .env("ULTIMATE_AMV_STATE_DIR", app_state_dir())
        .current_dir(root)
        .output()
        .map_err(|error| format!("Could not start Python audio bridge: {error}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if output.status.success() {
        if args.first().copied() != Some("logs") {
            log_info(
                "audio.bridge.complete",
                "Audio bridge command completed",
                json!({ "args": args }),
            );
        }
        Ok(stdout)
    } else if !stdout.is_empty() {
        log_error(
            "audio.bridge.error",
            "Audio bridge command failed",
            json!({
                "args": args,
                "code": output.status.code(),
                "stdout": truncate_log_text(&stdout),
                "stderr": truncate_log_text(&stderr),
            }),
        );
        Err(stdout)
    } else {
        log_error(
            "audio.bridge.error",
            "Audio bridge command failed",
            json!({
                "args": args,
                "code": output.status.code(),
                "stderr": truncate_log_text(&stderr),
            }),
        );
        Err(stderr)
    }
}

fn media_kind(url: &str) -> Option<&'static str> {
    let lower = url.to_ascii_lowercase();
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

    log_info(
        "browser.media.candidate",
        "Captured playable media candidate",
        json!({ "kind": kind, "url": url }),
    );
    let _ = app.emit(
        "media-candidate",
        MediaCandidate {
            url,
            kind: kind.to_string(),
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

fn clean_detected_episode(value: &str) -> Option<String> {
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

fn is_anikai_identity_request(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    if !(lower.contains("anikai.to") || lower.contains("aniwaves.ru") || lower.contains("aniwave.ru")) {
        return false;
    }
    if media_kind(url).is_some() {
        return false;
    }
    lower.contains("ajax")
        || lower.contains("api")
        || lower.contains("episode")
        || lower.contains("server")
        || lower.contains("source")
        || lower.contains("player")
        || lower.contains("embed")
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

fn parse_anikai_identity_payload(source: &str, fallback_url: &str) -> Option<ProviderPageIdentity> {
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

fn is_anikai_watch_document_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    (lower.contains("aniwaves.ru/watch/") || lower.contains("aniwave.ru/watch/") || lower.contains("anikai.to/watch/"))
        && !lower.contains(".m3u8")
        && !lower.contains(".mp4")
}

fn is_allowed_anikai_navigation(url: &str) -> bool {
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
    host == "aniwaves.ru" || host.ends_with(".aniwaves.ru") || host == "anikai.to" || host.ends_with(".anikai.to") || host == "aniwave.ru" || host.ends_with(".aniwave.ru")
}

fn parse_anikai_sync_data(source: &str, fallback_url: &str) -> Option<ProviderPageIdentity> {
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
                        let should_read_watch_document = is_anikai_watch_document_url(&request_url);
                        let should_read_identity_api = is_anikai_identity_request(&request_url);
                        if !should_read_watch_document && !should_read_identity_api {
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
                                        let identity = if should_read_watch_document {
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
            let navigation_handler =
                NavigationStartingEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    clear_media_sniffer_state();
                    let mut raw_uri = PWSTR::null();
                    args.Uri(&mut raw_uri)?;
                    if let Ok(url) = raw_uri.to_string() {
                        if !is_allowed_anikai_navigation(&url) {
                            let _ = args.SetCancel(true);
                            log_warn(
                                "browser.navigation.blocked",
                                "Blocked provider navigation outside allowlist",
                                json!({ "url": url }),
                            );
                            let _ = app_for_navigation.emit(
                                "media-sniffer-error",
                                format!("Blocked navigation outside AniKai: {url}"),
                            );
                            return Ok(());
                        }
                        log_info(
                            "browser.navigation",
                            "Provider WebView navigation started",
                            json!({ "url": url }),
                        );
                        if is_anikai_watch_document_url(&url) {
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
) -> Result<(), String> {
    Err("Media sniffing is currently Windows/WebView2-only.".to_string())
}

#[tauri::command]
async fn audio_status() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run_audio_cli(&["status"]))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn audio_setup_plan(mode: String) -> Result<String, String> {
    if mode != "cpu" && mode != "gpu" {
        return Err("Setup mode must be cpu or gpu".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || run_audio_cli(&["setup-plan", mode.as_str()]))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn audio_history() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run_audio_cli(&["history"]))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn app_logs() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run_audio_cli(&["logs"]))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn clear_app_logs() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(reset_app_logs)
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[derive(Serialize)]
struct ClearCacheReport {
    files_removed: u64,
    bytes_freed: u64,
}

fn dir_file_stats(dir: &Path) -> (u64, u64) {
    let mut files: u64 = 0;
    let mut bytes: u64 = 0;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Ok(meta) = entry.metadata() {
                if meta.is_dir() {
                    let (sub_files, sub_bytes) = dir_file_stats(&path);
                    files += sub_files;
                    bytes += sub_bytes;
                } else {
                    files += 1;
                    bytes += meta.len();
                }
            }
        }
    }
    (files, bytes)
}

#[tauri::command]
async fn clear_app_cache(window: tauri::Window) -> Result<ClearCacheReport, String> {
    let app_data_dir = window
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?;

    log_info(
        "cache.clear.start",
        "Clearing preview cache",
        json!({ "app_data_dir": app_data_dir.display().to_string() }),
    );

    let report = tauri::async_runtime::spawn_blocking(move || -> Result<ClearCacheReport, String> {
        let cache_dir = app_data_dir.join("clip_previews");
        if !cache_dir.exists() {
            return Ok(ClearCacheReport { files_removed: 0, bytes_freed: 0 });
        }
        let (files_removed, bytes_freed) = dir_file_stats(&cache_dir);
        fs::remove_dir_all(&cache_dir)
            .map_err(|error| format!("Could not remove preview cache: {error}"))?;
        Ok(ClearCacheReport { files_removed, bytes_freed })
    })
    .await
    .map_err(|error| error.to_string())??;

    log_info(
        "cache.clear.complete",
        "Preview cache cleared",
        json!({
            "files_removed": report.files_removed,
            "bytes_freed": report.bytes_freed,
        }),
    );

    Ok(report)
}

#[tauri::command]
async fn frontend_log(
    level: String,
    event: String,
    message: String,
    details: Option<Value>,
) -> Result<(), String> {
    let level = match level.as_str() {
        "debug" | "info" | "warn" | "error" => level,
        _ => "info".to_string(),
    };
    append_app_log(&level, &event, &message, details.unwrap_or(Value::Null));
    Ok(())
}

#[tauri::command]
async fn install_media_sniffer(app: tauri::AppHandle, label: String) -> Result<(), String> {
    log_info(
        "browser.sniffer.install.start",
        "Installing media sniffer",
        json!({ "label": label }),
    );
    clear_media_sniffer_state();
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Could not find AniKai WebView '{label}'"))?;
    let result = install_webview2_media_sniffer(app, webview);
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

#[tauri::command]
async fn download_stream(
    window: tauri::Window,
    job_id: Option<String>,
    url: String,
    referer: String,
    anime_title: Option<String>,
    episode_number: Option<String>,
    episode_label: Option<String>,
    quality_label: Option<String>,
    source_page: Option<String>,
    download_dir: Option<String>,
) -> Result<String, String> {
    log_info(
        "download.stream.start",
        "Starting episode stream download",
        json!({
            "url": &url,
            "jobId": &job_id,
            "referer": &referer,
            "animeTitle": &anime_title,
            "episodeNumber": &episode_number,
            "episodeLabel": &episode_label,
            "qualityLabel": &quality_label,
            "sourcePage": &source_page,
            "downloadDir": &download_dir,
        }),
    );
    let metadata = DownloadMetadata {
        anime_title,
        episode_number,
        episode_label,
        quality_label,
        source_page,
    };
    tauri::async_runtime::spawn_blocking(move || {
        run_stream_download(window, job_id, url, referer, metadata, download_dir)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn inspect_stream(url: String, referer: String) -> Result<Vec<StreamQuality>, String> {
    log_info(
        "download.inspect.start",
        "Inspecting captured stream formats",
        json!({ "url": &url, "referer": &referer }),
    );
    tauri::async_runtime::spawn_blocking(move || inspect_stream_formats(url, referer))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn inspect_download_formats(
    url: String,
    referer: Option<String>,
) -> Result<DownloadFormatInspection, String> {
    let referer = referer.unwrap_or_default();
    log_info(
        "download.formats.start",
        "Inspecting downloadable formats",
        json!({ "url": &url, "referer": &referer }),
    );
    tauri::async_runtime::spawn_blocking(move || inspect_download_format_list(url, referer))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
fn download_history() -> Result<Vec<DownloadHistoryItem>, String> {
    read_download_history()
}

#[tauri::command]
async fn download_media(
    window: tauri::Window,
    job_id: Option<String>,
    url: String,
    referer: Option<String>,
    format_id: Option<String>,
    title: Option<String>,
    subtitle: Option<String>,
    quality_label: Option<String>,
    source_page: Option<String>,
    download_dir: Option<String>,
    kind: Option<String>,
    folder_name: Option<String>,
    clip_start_seconds: Option<f64>,
    clip_end_seconds: Option<f64>,
    force_keyframes_at_cuts: Option<bool>,
) -> Result<String, String> {
    let metadata = MediaDownloadMetadata {
        kind: kind.unwrap_or_else(|| "youtube".to_string()),
        title,
        subtitle,
        quality_label,
        source_page,
        format_id,
        folder_name,
        clip_start_seconds,
        clip_end_seconds,
        force_keyframes_at_cuts: force_keyframes_at_cuts.unwrap_or(false),
    };
    let referer = referer.unwrap_or_default();
    log_info(
        "download.media.start",
        "Starting media download",
        json!({
            "jobId": &job_id,
            "url": &url,
            "referer": &referer,
            "kind": &metadata.kind,
            "formatId": &metadata.format_id,
            "title": &metadata.title,
            "qualityLabel": &metadata.quality_label,
            "downloadDir": &download_dir,
            "clipStart": metadata.clip_start_seconds,
            "clipEnd": metadata.clip_end_seconds,
            "forceKeyframes": metadata.force_keyframes_at_cuts,
        }),
    );
    tauri::async_runtime::spawn_blocking(move || {
        run_media_download(window, job_id, url, referer, metadata, download_dir)
    })
    .await
    .map_err(|error| error.to_string())?
}

const BROWSER_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

fn normalized_referer(referer: &str) -> String {
    if referer.trim().is_empty() {
        "https://aniwaves.ru".to_string()
    } else {
        referer.trim().to_string()
    }
}

fn ytdlp_command(root: &Path, url: &str) -> Command {
    let mut command = cmd(root.join("tools").join("yt-dlp.exe"));
    command.env("PYTHONUNBUFFERED", "1");
    command.arg("--js-runtimes").arg("node");
    command.arg(url);
    command
}

fn add_browser_headers(command: &mut Command, referer: &str) {
    command
        .arg("--user-agent")
        .arg(BROWSER_USER_AGENT)
        .arg("--referer")
        .arg(normalized_referer(referer));
}

fn inspect_stream_formats(url: String, referer: String) -> Result<Vec<StreamQuality>, String> {
    let root = app_root()?;
    let mut command = ytdlp_command(&root, &url);
    command
        .arg("--dump-single-json")
        .arg("--no-warnings")
        .arg("--no-playlist")
        .arg("--no-check-formats")
        .arg("--socket-timeout")
        .arg("12")
        .current_dir(&root);
    add_browser_headers(&mut command, &referer);

    let output = command
        .output()
        .map_err(|error| format!("Could not inspect stream with yt-dlp: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        log_error(
            "download.inspect.error",
            "yt-dlp stream inspection failed",
            json!({
                "url": &url,
                "referer": &referer,
                "code": output.status.code(),
                "stderr": truncate_log_text(&stderr),
            }),
        );
        return Err(if stderr.trim().is_empty() {
            format!(
                "yt-dlp could not inspect this stream. Exit code {}",
                output.status.code().unwrap_or(-1)
            )
        } else {
            stderr.trim().to_string()
        });
    }

    let payload: Value = serde_json::from_str(stdout.trim())
        .map_err(|error| format!("Could not parse yt-dlp stream metadata: {error}"))?;
    let mut qualities = Vec::new();
    if let Some(formats) = payload.get("formats").and_then(Value::as_array) {
        let mut seen_urls = HashSet::new();
        for format in formats {
            let Some(format_url) = format.get("url").and_then(Value::as_str) else {
                continue;
            };
            if !seen_urls.insert(format_url.to_string()) {
                continue;
            }

            let vcodec = format.get("vcodec").and_then(Value::as_str).unwrap_or("");
            let protocol = format.get("protocol").and_then(Value::as_str).unwrap_or("");
            if vcodec == "none" && !protocol.contains("m3u8") {
                continue;
            }

            let id = format
                .get("format_id")
                .and_then(Value::as_str)
                .unwrap_or("stream")
                .to_string();
            let width = format.get("width").and_then(Value::as_u64);
            let height = format.get("height").and_then(Value::as_u64);
            let bitrate = format
                .get("tbr")
                .and_then(Value::as_f64)
                .or_else(|| format.get("vbr").and_then(Value::as_f64));
            let codec = if vcodec.is_empty() || vcodec == "none" {
                None
            } else {
                Some(vcodec.to_string())
            };
            qualities.push(StreamQuality {
                label: stream_quality_label(format, height, bitrate),
                id,
                url: format_url.to_string(),
                width,
                height,
                bitrate,
                codec,
            });
        }
    }

    if qualities.is_empty() {
        qualities.push(StreamQuality {
            id: "captured".to_string(),
            label: "Captured playback stream".to_string(),
            url: url.clone(),
            width: None,
            height: None,
            bitrate: None,
            codec: None,
        });
    }

    qualities.sort_by(|a, b| {
        b.height.cmp(&a.height).then_with(|| {
            b.bitrate
                .partial_cmp(&a.bitrate)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    });

    log_info(
        "download.inspect.complete",
        "Stream inspection completed",
        json!({ "url": &url, "qualityCount": qualities.len() }),
    );
    Ok(qualities)
}

fn inspect_download_format_list(
    url: String,
    referer: String,
) -> Result<DownloadFormatInspection, String> {
    let root = app_root()?;
    let mut command = ytdlp_command(&root, &url);
    command
        .arg("--dump-single-json")
        .arg("--no-warnings")
        .arg("--no-playlist")
        .arg("--socket-timeout")
        .arg("12")
        .current_dir(&root);
    if !referer.trim().is_empty() {
        add_browser_headers(&mut command, &referer);
    }

    let output = command
        .output()
        .map_err(|error| format!("Could not inspect formats with yt-dlp: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        log_error(
            "download.formats.error",
            "yt-dlp format inspection failed",
            json!({
                "url": &url,
                "code": output.status.code(),
                "stderr": truncate_log_text(&stderr),
            }),
        );
        return Err(if stderr.trim().is_empty() {
            format!(
                "yt-dlp could not inspect formats. Exit code {}",
                output.status.code().unwrap_or(-1)
            )
        } else {
            stderr.trim().to_string()
        });
    }

    let payload: Value = serde_json::from_str(stdout.trim())
        .map_err(|error| format!("Could not parse yt-dlp format metadata: {error}"))?;
    let duration_seconds = payload.get("duration").and_then(Value::as_f64);
    let is_live = payload
        .get("is_live")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || payload
            .get("live_status")
            .and_then(Value::as_str)
            .map(|status| matches!(status, "is_live" | "is_upcoming"))
            .unwrap_or(false);
    let video_id = payload
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let preview_url = pick_progressive_preview_url(&payload);
    let mut formats = Vec::new();
    if let Some(items) = payload.get("formats").and_then(Value::as_array) {
        let mut seen = HashSet::new();
        for format in items {
            let id = format
                .get("format_id")
                .and_then(Value::as_str)
                .unwrap_or("best")
                .to_string();
            if !seen.insert(id.clone()) {
                continue;
            }

            let vcodec = format.get("vcodec").and_then(Value::as_str).unwrap_or("");
            let acodec = format.get("acodec").and_then(Value::as_str).unwrap_or("");
            let audio_only = vcodec == "none" && acodec != "none" && !acodec.is_empty();
            let has_video = vcodec != "none" && !vcodec.is_empty();
            if !audio_only && !has_video {
                continue;
            }

            let ext = format.get("ext").and_then(Value::as_str).map(ToString::to_string);
            let width = format.get("width").and_then(Value::as_u64);
            let height = format.get("height").and_then(Value::as_u64);
            let bitrate = format
                .get("tbr")
                .and_then(Value::as_f64)
                .or_else(|| format.get("abr").and_then(Value::as_f64))
                .or_else(|| format.get("vbr").and_then(Value::as_f64));
            let filesize = format
                .get("filesize")
                .and_then(Value::as_u64)
                .or_else(|| format.get("filesize_approx").and_then(Value::as_u64));
            let resolution = format
                .get("resolution")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty() && *value != "audio only")
                .map(ToString::to_string);

            formats.push(DownloadFormat {
                label: download_format_label(format, audio_only),
                id,
                ext,
                resolution,
                width,
                height,
                bitrate,
                filesize,
                vcodec: if vcodec.is_empty() || vcodec == "none" { None } else { Some(vcodec.to_string()) },
                acodec: if acodec.is_empty() || acodec == "none" { None } else { Some(acodec.to_string()) },
                audio_only,
            });
        }
    }

    if formats.is_empty() {
        formats.push(DownloadFormat {
            id: "best".to_string(),
            label: "Best available".to_string(),
            ext: None,
            resolution: None,
            width: None,
            height: None,
            bitrate: None,
            filesize: None,
            vcodec: None,
            acodec: None,
            audio_only: false,
        });
    }

    formats.sort_by(|a, b| {
        a.audio_only.cmp(&b.audio_only).then_with(|| {
            b.height.cmp(&a.height).then_with(|| {
                b.bitrate
                    .partial_cmp(&a.bitrate)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
        })
    });

    log_info(
        "download.formats.complete",
        "Download format inspection completed",
        json!({
            "url": &url,
            "formatCount": formats.len(),
            "durationSeconds": duration_seconds,
            "isLive": is_live,
        }),
    );
    Ok(DownloadFormatInspection {
        duration_seconds,
        is_live,
        video_id,
        preview_url,
        formats,
    })
}

fn pick_progressive_preview_url(payload: &Value) -> Option<String> {
    let items = payload.get("formats").and_then(Value::as_array)?;
    let mut best: Option<(u64, String)> = None;
    for format in items {
        let vcodec = format.get("vcodec").and_then(Value::as_str).unwrap_or("");
        let acodec = format.get("acodec").and_then(Value::as_str).unwrap_or("");
        if vcodec.is_empty() || vcodec == "none" || acodec.is_empty() || acodec == "none" {
            continue;
        }
        let protocol = format.get("protocol").and_then(Value::as_str).unwrap_or("");
        if !protocol.starts_with("http") || protocol.contains("m3u8") || protocol.contains("dash") {
            continue;
        }
        let ext = format.get("ext").and_then(Value::as_str).unwrap_or("");
        if ext != "mp4" && ext != "webm" {
            continue;
        }
        let url = format.get("url").and_then(Value::as_str).unwrap_or("");
        if url.is_empty() {
            continue;
        }
        let height = format.get("height").and_then(Value::as_u64).unwrap_or(0);
        if best.as_ref().map_or(true, |(h, _)| height > *h) {
            best = Some((height, url.to_string()));
        }
    }
    best.map(|(_, url)| url)
}

fn stream_quality_label(format: &Value, height: Option<u64>, bitrate: Option<f64>) -> String {
    let resolution = format.get("resolution").and_then(Value::as_str);
    let format_note = format.get("format_note").and_then(Value::as_str);
    let base = height
        .map(|value| format!("{value}p"))
        .or_else(|| {
            resolution
                .filter(|value| !value.is_empty() && *value != "audio only")
                .map(ToString::to_string)
        })
        .or_else(|| {
            format_note
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| "Detected stream".to_string());

    match bitrate {
        Some(value) if value > 0.0 => format!("{base} - {:.0} kbps", value),
        _ => base,
    }
}

fn download_format_label(format: &Value, audio_only: bool) -> String {
    let ext = format.get("ext").and_then(Value::as_str).unwrap_or("");
    let format_note = format.get("format_note").and_then(Value::as_str).unwrap_or("");
    let resolution = format.get("resolution").and_then(Value::as_str).unwrap_or("");
    let height = format.get("height").and_then(Value::as_u64);
    let bitrate = format
        .get("tbr")
        .and_then(Value::as_f64)
        .or_else(|| format.get("abr").and_then(Value::as_f64))
        .or_else(|| format.get("vbr").and_then(Value::as_f64));

    let base = if audio_only {
        if format_note.is_empty() {
            "Audio only".to_string()
        } else {
            format!("Audio - {format_note}")
        }
    } else if let Some(value) = height {
        format!("{value}p")
    } else if !resolution.is_empty() && resolution != "audio only" {
        resolution.to_string()
    } else if !format_note.is_empty() {
        format_note.to_string()
    } else {
        "Video".to_string()
    };

    let mut parts = vec![base];
    if !ext.is_empty() {
        parts.push(ext.to_uppercase());
    }
    if let Some(value) = bitrate.filter(|value| *value > 0.0) {
        parts.push(format!("{value:.0} kbps"));
    }
    parts.join(" - ")
}

fn resolve_download_root(download_dir: Option<&str>) -> PathBuf {
    if let Some(dir) = download_dir.filter(|s| !s.trim().is_empty()) {
        return PathBuf::from(dir);
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        return PathBuf::from(profile)
            .join("Videos")
            .join("Ultimate AMV")
            .join("anime downloads");
    }
    PathBuf::from("anime downloads")
}

fn download_history_path() -> PathBuf {
    app_state_dir().join("download-history.json")
}

fn read_download_history() -> Result<Vec<DownloadHistoryItem>, String> {
    let path = download_history_path();
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(&path)
        .map_err(|error| format!("Could not read download history: {error}"))?;
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&text).map_err(|error| format!("Could not parse download history: {error}"))
}

fn write_download_history(items: &[DownloadHistoryItem]) -> Result<(), String> {
    let path = download_history_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("Could not create download history folder: {error}"))?;
    }
    let text = serde_json::to_string_pretty(items)
        .map_err(|error| format!("Could not serialize download history: {error}"))?;
    fs::write(path, text).map_err(|error| format!("Could not save download history: {error}"))
}

fn add_download_history_item(item: DownloadHistoryItem) {
    let mut items = read_download_history().unwrap_or_default();
    items.retain(|existing| existing.id != item.id);
    items.insert(0, item);
    items.truncate(80);
    if let Err(error) = write_download_history(&items) {
        log_warn(
            "download.history.write.error",
            "Could not write download history",
            json!({ "error": error }),
        );
    }
}

fn run_stream_download(
    window: tauri::Window,
    job_id: Option<String>,
    url: String,
    referer: String,
    metadata: DownloadMetadata,
    download_dir: Option<String>,
) -> Result<String, String> {
    let root = app_root()?;
    let identity = build_download_identity(&url, &referer, &metadata);
    let output_dir = resolve_download_root(download_dir.as_deref()).join(&identity.anime_folder);
    std::fs::create_dir_all(&output_dir).map_err(|error| error.to_string())?;
    log_info(
        "download.stream.prepared",
        "Prepared downloader output location",
        json!({
            "outputDir": output_dir.to_string_lossy(),
            "animeFolder": &identity.anime_folder,
            "fileStem": &identity.file_stem,
        }),
    );

    let mut command = ytdlp_command(&root, &url);

    command
        .arg("--newline")
        .arg("--progress")
        .arg("--progress-template")
        .arg("download:AMV_PROGRESS|%(progress.status)s|%(progress._percent_str)s|%(progress._downloaded_bytes_str)s|%(progress._total_bytes_str)s|%(progress._speed_str)s|%(progress._eta_str)s")
        .arg("--print")
        .arg("after_move:AMV_FILE|%(filepath)s")
        .arg("--concurrent-fragments")
        .arg("16")
        .arg("--retries")
        .arg("10")
        .arg("--fragment-retries")
        .arg("10")
        .arg("--restrict-filenames")
        .arg("-o")
        .arg(output_dir.join(format!("{}.%(ext)s", identity.file_stem)))
        .current_dir(&root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    add_browser_headers(&mut command, &referer);

    let mut child = command.spawn().map_err(|error| {
        log_error(
            "download.stream.spawn.error",
            "Could not start bundled yt-dlp",
            json!({ "error": error.to_string(), "url": &url }),
        );
        format!("Could not start bundled yt-dlp: {error}")
    })?;
    store_child_pid(&DOWNLOAD_CHILD_PID, child.id());

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not read downloader output".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Could not read downloader errors".to_string())?;

    let last_destination = Arc::new(Mutex::new(String::new()));
    let last_output_file = Arc::new(Mutex::new(String::new()));
    let stderr_destination = Arc::clone(&last_destination);
    let stderr_output_file = Arc::clone(&last_output_file);
    let stderr_window = window.clone();
    let stderr_job_id = job_id.clone();
    let stderr_handle = thread::spawn(move || -> String {
        let mut tail = String::new();
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            handle_downloader_line(
                &stderr_window,
                stderr_job_id.as_deref(),
                &stderr_destination,
                &stderr_output_file,
                &line,
            );
            tail.push_str(&line);
            tail.push('\n');
            if tail.len() > 16 * 1024 {
                let cut = tail.len() - 16 * 1024;
                tail.drain(..cut);
            }
        }
        tail
    });

    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        handle_downloader_line(&window, job_id.as_deref(), &last_destination, &last_output_file, &line);
    }

    let status = child.wait().map_err(|error| error.to_string())?;
    clear_child_pid(&DOWNLOAD_CHILD_PID);
    let stderr_tail = stderr_handle.join().unwrap_or_default();
    if status.success() {
        let saved_file = last_output_file
            .lock()
            .ok()
            .map(|value| value.clone())
            .filter(|value| !value.is_empty())
            .or_else(|| {
                last_destination
                    .lock()
                    .ok()
                    .map(|value| value.clone())
                    .filter(|value| !value.is_empty())
            })
            .and_then(|value| resolve_downloaded_file(&output_dir, &value));

        let Some(saved_file) = saved_file else {
            let destination = last_destination
                .lock()
                .ok()
                .map(|value| value.clone())
                .unwrap_or_default();
            let tail = stderr_tail.trim();
            let error = if tail.is_empty() {
                format!(
                    "Downloader exited successfully, but no completed file was found. Last destination: {}",
                    if destination.is_empty() {
                        output_dir.display().to_string()
                    } else {
                        destination.clone()
                    }
                )
            } else {
                format!(
                    "Downloader exited successfully, but no completed file was found. Last destination: {}. {tail}",
                    if destination.is_empty() {
                        output_dir.display().to_string()
                    } else {
                        destination.clone()
                    }
                )
            };
            log_error(
                "download.stream.error",
                "Downloader finished but no completed file was found",
                json!({
                    "url": &url,
                    "outputDir": output_dir.to_string_lossy(),
                    "lastDestination": destination,
                    "stderr": truncate_log_text(tail),
                }),
            );
            return Err(error);
        };

        let message = saved_file.display().to_string();
        log_info(
            "download.stream.complete",
            "Episode stream download completed",
            json!({ "savedFile": &message, "url": &url }),
        );
        let warning = audio_warning_for_download(&saved_file, false);
        let _ = window.emit(
            "download-progress",
            DownloadProgress {
                job_id: job_id.clone(),
                stage: "done".to_string(),
                percent: Some(100.0),
                message: message.clone(),
                warning,
            },
        );
        add_download_history_item(DownloadHistoryItem {
            id: short_stable_id(&[&url, metadata.source_page.as_deref().unwrap_or(&referer), &identity.file_stem]),
            created_at: Local::now().format("%Y-%m-%dT%H:%M:%S%.3f%:z").to_string(),
            kind: "anime".to_string(),
            title: metadata.anime_title.clone().unwrap_or_else(|| identity.anime_folder.clone()),
            subtitle: metadata.episode_label.clone(),
            quality_label: metadata.quality_label.clone(),
            url: url.clone(),
            referer: Some(referer.clone()).filter(|value| !value.trim().is_empty()),
            format_id: None,
            output_path: message.clone(),
            source_page: metadata.source_page.clone(),
        });
        Ok(message)
    } else {
        let error = stderr_tail.trim().to_string();
        let cancelled = status.code().is_none() || status.code() == Some(1) && error.trim().is_empty();
        log_error(
            "download.stream.error",
            "Episode stream download failed",
            json!({
                "url": &url,
                "referer": &referer,
                "code": status.code(),
                "stderr": truncate_log_text(&error),
            }),
        );
        if cancelled {
            Err("Download cancelled.".to_string())
        } else {
            Err(error)
        }
    }
}

fn resolve_clip_range(
    start: Option<f64>,
    end: Option<f64>,
) -> Result<Option<(f64, f64)>, String> {
    match (start, end) {
        (None, None) => Ok(None),
        (start_opt, end_opt) => {
            let start = start_opt.unwrap_or(0.0);
            let end = end_opt.ok_or_else(|| {
                "Clip end timestamp is required when a clip start is set.".to_string()
            })?;
            if !start.is_finite() || !end.is_finite() {
                return Err("Clip timestamps must be finite numbers.".to_string());
            }
            if start < 0.0 {
                return Err("Clip start cannot be negative.".to_string());
            }
            if end <= start + 0.05 {
                return Err(
                    "Clip end must be at least 50ms after the clip start.".to_string()
                );
            }
            Ok(Some((start, end)))
        }
    }
}

fn run_media_download(
    window: tauri::Window,
    job_id: Option<String>,
    url: String,
    referer: String,
    metadata: MediaDownloadMetadata,
    download_dir: Option<String>,
) -> Result<String, String> {
    let root = app_root()?;
    let base_root = resolve_download_root(download_dir.as_deref());
    let folder = metadata
        .folder_name
        .as_deref()
        .or(Some(if metadata.kind == "anime" { "anime downloads" } else { "youtube downloads" }))
        .unwrap_or("downloads");
    let output_dir = base_root.join(sanitize_path_segment(folder, "downloads", 96));
    std::fs::create_dir_all(&output_dir).map_err(|error| error.to_string())?;
    let title = metadata
        .title
        .as_deref()
        .map(|value| sanitize_path_segment(value, "download", 96))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "download".to_string());
    let quality = metadata
        .quality_label
        .as_deref()
        .map(|value| sanitize_path_segment(value, "selected format", 48))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "selected format".to_string());
    let clip_range = resolve_clip_range(
        metadata.clip_start_seconds,
        metadata.clip_end_seconds,
    )?;
    let clip_suffix = clip_range
        .as_ref()
        .map(|(start, end)| format!("clip-{}-{}s", start.round() as i64, end.round() as i64));
    let clip_section_spec = clip_range
        .as_ref()
        .map(|(start, end)| format!("*{:.3}-{:.3}", start, end));
    let stable_id_clip_part = clip_suffix.clone().unwrap_or_default();
    let stable_id = short_stable_id(&[
        &url,
        metadata.format_id.as_deref().unwrap_or("best"),
        &stable_id_clip_part,
    ]);
    let file_stem_base = if let Some(suffix) = clip_suffix.as_deref() {
        format!("{title} - {quality} - {suffix} - {stable_id}")
    } else {
        format!("{title} - {quality} - {stable_id}")
    };
    let file_stem = sanitize_path_segment(&file_stem_base, &stable_id, 150);

    let mut command = ytdlp_command(&root, &url);
    command
        .arg("--newline")
        .arg("--progress")
        .arg("--progress-template")
        .arg("download:AMV_PROGRESS|%(progress.status)s|%(progress._percent_str)s|%(progress._downloaded_bytes_str)s|%(progress._total_bytes_str)s|%(progress._speed_str)s|%(progress._eta_str)s")
        .arg("--print")
        .arg("after_move:AMV_FILE|%(filepath)s")
        .arg("--no-playlist")
        .arg("--concurrent-fragments")
        .arg("16")
        .arg("--retries")
        .arg("10")
        .arg("--fragment-retries")
        .arg("10")
        .arg("--restrict-filenames");
    if let Some(format_id) = metadata.format_id.as_deref().filter(|value| !value.trim().is_empty()) {
        command.arg("-f").arg(format_id);
        if format_id.contains('+') {
            command.arg("--merge-output-format").arg("mp4");
        }
    }
    if let Some(spec) = clip_section_spec.as_deref() {
        command.arg("--download-sections").arg(spec);
        if metadata.force_keyframes_at_cuts {
            command.arg("--force-keyframes-at-cuts");
        }
    }
    command
        .arg("-o")
        .arg(output_dir.join(format!("{file_stem}.%(ext)s")))
        .current_dir(&root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if !referer.trim().is_empty() {
        add_browser_headers(&mut command, &referer);
    }

    let mut child = command.spawn().map_err(|error| {
        log_error(
            "download.media.spawn.error",
            "Could not start bundled yt-dlp",
            json!({ "error": error.to_string(), "url": &url }),
        );
        format!("Could not start bundled yt-dlp: {error}")
    })?;
    store_child_pid(&DOWNLOAD_CHILD_PID, child.id());

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not read downloader output".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Could not read downloader errors".to_string())?;

    let last_destination = Arc::new(Mutex::new(String::new()));
    let last_output_file = Arc::new(Mutex::new(String::new()));
    let stderr_destination = Arc::clone(&last_destination);
    let stderr_output_file = Arc::clone(&last_output_file);
    let stderr_window = window.clone();
    let stderr_job_id = job_id.clone();
    let stderr_handle = thread::spawn(move || -> String {
        let mut tail = String::new();
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            handle_downloader_line(
                &stderr_window,
                stderr_job_id.as_deref(),
                &stderr_destination,
                &stderr_output_file,
                &line,
            );
            tail.push_str(&line);
            tail.push('\n');
            if tail.len() > 16 * 1024 {
                let cut = tail.len() - 16 * 1024;
                tail.drain(..cut);
            }
        }
        tail
    });

    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        handle_downloader_line(&window, job_id.as_deref(), &last_destination, &last_output_file, &line);
    }

    let status = child.wait().map_err(|error| error.to_string())?;
    clear_child_pid(&DOWNLOAD_CHILD_PID);
    let stderr_tail = stderr_handle.join().unwrap_or_default();
    if status.success() {
        let saved_file = last_output_file
            .lock()
            .ok()
            .map(|value| value.clone())
            .filter(|value| !value.is_empty())
            .or_else(|| {
                last_destination
                    .lock()
                    .ok()
                    .map(|value| value.clone())
                    .filter(|value| !value.is_empty())
            })
            .and_then(|value| resolve_downloaded_file(&output_dir, &value));

        let Some(saved_file) = saved_file else {
            let tail = stderr_tail.trim();
            return Err(if tail.is_empty() {
                "Downloader exited successfully, but no completed file was found.".to_string()
            } else {
                format!("Downloader exited successfully, but no completed file was found. {tail}")
            });
        };

        let message = saved_file.display().to_string();
        let format_spec = metadata.format_id.as_deref().unwrap_or("");
        let user_picked_audio_only = format_spec_is_audio_only(format_spec);
        let warning = audio_warning_for_download(&saved_file, user_picked_audio_only);
        let _ = window.emit(
            "download-progress",
            DownloadProgress {
                job_id: job_id.clone(),
                stage: "done".to_string(),
                percent: Some(100.0),
                message: message.clone(),
                warning,
            },
        );
        add_download_history_item(DownloadHistoryItem {
            id: short_stable_id(&[&url, metadata.format_id.as_deref().unwrap_or("best"), &file_stem]),
            created_at: Local::now().format("%Y-%m-%dT%H:%M:%S%.3f%:z").to_string(),
            kind: metadata.kind.clone(),
            title: metadata.title.clone().unwrap_or(title),
            subtitle: metadata.subtitle.clone(),
            quality_label: metadata.quality_label.clone(),
            url: url.clone(),
            referer: Some(referer.clone()).filter(|value| !value.trim().is_empty()),
            format_id: metadata.format_id.clone(),
            output_path: message.clone(),
            source_page: metadata.source_page.clone(),
        });
        Ok(message)
    } else {
        let error = stderr_tail.trim().to_string();
        let cancelled = status.code().is_none() || status.code() == Some(1) && error.trim().is_empty();
        if cancelled {
            Err("Download cancelled.".to_string())
        } else {
            Err(error)
        }
    }
}

fn build_download_identity(
    url: &str,
    referer: &str,
    metadata: &DownloadMetadata,
) -> DownloadIdentity {
    let source_page = metadata
        .source_page
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(referer);
    let stable_id = short_stable_id(&[source_page, url]);
    let anime_folder = metadata
        .anime_title
        .as_deref()
        .map(|value| sanitize_path_segment(value, "Unknown anime", 96))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| sanitize_path_segment("Unknown anime", "Unknown anime", 96));
    let episode_part = metadata
        .episode_number
        .as_deref()
        .and_then(normalize_episode_number)
        .map(|value| format!("Episode {value}"))
        .or_else(|| {
            metadata
                .episode_label
                .as_deref()
                .map(|value| sanitize_path_segment(value, "Episode unknown", 64))
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Episode unknown".to_string());
    let quality_part = metadata
        .quality_label
        .as_deref()
        .map(|value| sanitize_path_segment(value, "Stream", 48))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Stream".to_string());
    let file_stem = sanitize_path_segment(
        &format!("{episode_part} - {quality_part} - {stable_id}"),
        &format!("Episode unknown - {stable_id}"),
        150,
    );

    DownloadIdentity {
        anime_folder,
        file_stem,
    }
}

fn normalize_episode_number(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || !trimmed
            .chars()
            .all(|character| character.is_ascii_digit() || character == '.')
    {
        return None;
    }

    if let Ok(number) = trimmed.parse::<u32>() {
        return Some(format!("{number:02}"));
    }

    Some(trimmed.to_string())
}

fn short_stable_id(parts: &[&str]) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for part in parts {
        for byte in part.as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
        hash ^= 0xff;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")[..10].to_string()
}

fn sanitize_path_segment(value: &str, fallback: &str, max_len: usize) -> String {
    let mut sanitized = String::with_capacity(value.len());
    let mut last_was_space = false;
    for character in value.trim().chars() {
        let replacement = match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => ' ',
            character if character.is_control() => ' ',
            character => character,
        };

        if replacement.is_whitespace() {
            if !last_was_space {
                sanitized.push(' ');
                last_was_space = true;
            }
        } else {
            sanitized.push(replacement);
            last_was_space = false;
        }
    }

    let mut sanitized = sanitized.trim_matches([' ', '.']).to_string();
    if sanitized.is_empty() {
        sanitized = fallback.to_string();
    }
    if sanitized.len() > max_len {
        sanitized.truncate(max_len);
        sanitized = sanitized.trim_matches([' ', '.']).to_string();
    }
    if sanitized.is_empty() {
        fallback.to_string()
    } else {
        sanitized
    }
}

fn resolve_downloaded_file(output_dir: &Path, value: &str) -> Option<PathBuf> {
    let trimmed = value.trim().trim_matches('"');
    if trimmed.is_empty() {
        return None;
    }

    let path = PathBuf::from(trimmed);
    let candidate = if path.is_absolute() {
        path
    } else {
        output_dir.join(path)
    };

    if candidate.is_file()
        && candidate
            .metadata()
            .map(|metadata| metadata.len() > 1_048_576)
            .unwrap_or(false)
    {
        return Some(candidate);
    }

    if candidate.extension().and_then(|ext| ext.to_str()) == Some("part") {
        return None;
    }

    None
}

fn update_download_path(slot: &Arc<Mutex<String>>, value: &str) {
    if let Ok(mut destination) = slot.lock() {
        *destination = value.trim().to_string();
    }
}

fn parse_already_downloaded_path(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("[download] ")?;
    rest.strip_suffix(" has already been downloaded")
}

fn handle_downloader_line(
    window: &tauri::Window,
    job_id: Option<&str>,
    last_destination: &Arc<Mutex<String>>,
    last_output_file: &Arc<Mutex<String>>,
    line: &str,
) {
    if let Some(file) = line.strip_prefix("AMV_FILE|") {
        update_download_path(last_output_file, file);
    } else if let Some(dest) = line.strip_prefix("[download] Destination:") {
        update_download_path(last_destination, dest);
    } else if let Some(dest) = line.strip_prefix("[download] Destination ") {
        update_download_path(last_destination, dest);
    } else if let Some(dest) = parse_already_downloaded_path(line) {
        update_download_path(last_destination, dest);
        update_download_path(last_output_file, dest);
    }

    let (stage, percent, message) = if let Some(progress) = parse_amv_progress(line) {
        progress
    } else if let Some(file) = line.strip_prefix("AMV_FILE|") {
        (
            "finalizing".to_string(),
            Some(100.0),
            file.trim().to_string(),
        )
    } else if line.starts_with("[Merger]")
        || line.starts_with("[Fixup]")
        || line.starts_with("[MoveFiles]")
        || line.starts_with("[ExtractAudio]")
        || line.starts_with("[VideoConvertor]")
        || line.starts_with("[VideoRemuxer]")
        || line.starts_with("[ffmpeg]")
    {
        ("finalizing".to_string(), None, line.to_string())
    } else if line.contains("has already been downloaded") {
        ("done".to_string(), Some(100.0), line.to_string())
    } else if line.starts_with("[download]") || line.starts_with("[hlsnative]") {
        (
            "downloading".to_string(),
            regex_like_percent(line),
            line.to_string(),
        )
    } else if line.starts_with("[youtube]") || line.starts_with("[info]") || line.starts_with("[generic]") {
        ("preparing".to_string(), None, line.to_string())
    } else if line.starts_with("WARNING:") {
        ("preparing".to_string(), None, line.to_string())
    } else if line.starts_with("ERROR:") {
        ("error".to_string(), None, line.to_string())
    } else {
        return;
    };

    let _ = window.emit(
        "download-progress",
        DownloadProgress {
            job_id: job_id.map(ToString::to_string),
            stage,
            percent,
            message,
            warning: None,
        },
    );
}

fn parse_amv_progress(line: &str) -> Option<(String, Option<f32>, String)> {
    let rest = line.strip_prefix("AMV_PROGRESS|")?;
    let mut parts = rest.split('|');
    let status = parts.next().unwrap_or("downloading").trim();
    let percent = parts.next().and_then(parse_percent_text);
    let downloaded = parts.next().unwrap_or("").trim();
    let total = parts.next().unwrap_or("").trim();
    let speed = parts.next().unwrap_or("").trim();
    let eta = parts.next().unwrap_or("").trim();

    let mut details = Vec::new();
    if !downloaded.is_empty() && downloaded != "N/A" {
        if !total.is_empty() && total != "N/A" {
            details.push(format!("{downloaded} of {total}"));
        } else {
            details.push(downloaded.to_string());
        }
    }
    if !speed.is_empty() && speed != "N/A" {
        details.push(speed.to_string());
    }
    if !eta.is_empty() && eta != "N/A" {
        details.push(format!("ETA {eta}"));
    }
    let message = if details.is_empty() {
        "Downloading stream...".to_string()
    } else {
        details.join(" - ")
    };
    let stage = match status {
        "finished" => "finalizing",
        _ => "downloading",
    }
    .to_string();
    Some((stage, percent, message))
}

fn parse_percent_text(value: &str) -> Option<f32> {
    value
        .trim()
        .trim_end_matches('%')
        .trim()
        .parse::<f32>()
        .ok()
}

fn regex_like_percent(line: &str) -> Option<f32> {
    let percent_index = line.find('%')?;
    let before_percent = &line[..percent_index];
    let number_start = before_percent
        .rfind(|character: char| !(character.is_ascii_digit() || character == '.'))
        .map_or(0, |index| index + 1);
    before_percent[number_start..].parse::<f32>().ok()
}

#[tauri::command]
async fn media_to_audio(
    window: tauri::Window,
    input_path: String,
    output_format: String,
) -> Result<String, String> {
    if output_format != "wav" && output_format != "mp3" {
        return Err("Audio output format must be wav or mp3".to_string());
    }
    log_info(
        "audio.convert.start",
        "Starting media to audio conversion",
        json!({ "input": &input_path, "outputFormat": &output_format }),
    );
    let log_input = input_path.clone();
    let log_format = output_format.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_media_to_audio(window, input_path, output_format)
    })
    .await
    .map_err(|error| error.to_string())?;
    match &result {
        Ok(payload) => log_info(
            "audio.convert.complete",
            "Media to audio conversion completed",
            json!({ "input": log_input, "outputFormat": log_format, "result": payload }),
        ),
        Err(error) => log_error(
            "audio.convert.error",
            "Media to audio conversion failed",
            json!({ "input": log_input, "outputFormat": log_format, "error": error }),
        ),
    }
    result
}

#[tauri::command]
async fn video_transcode(
    window: tauri::Window,
    input_path: String,
    preset: String,
    quality_value: Option<u32>,
) -> Result<String, String> {
    if !matches!(preset.as_str(), "gpu-intra" | "prores-lt" | "prores-hq") {
        return Err("Video preset must be gpu-intra, prores-lt, or prores-hq".to_string());
    }
    log_info(
        "video.transcode.start",
        "Starting video transcode",
        json!({ "input": &input_path, "preset": &preset, "qualityValue": quality_value }),
    );
    let log_input = input_path.clone();
    let log_preset = preset.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_video_transcode(window, input_path, preset, quality_value)
    })
    .await
    .map_err(|error| error.to_string())?;
    match &result {
        Ok(payload) => log_info(
            "video.transcode.complete",
            "Video transcode completed",
            json!({ "input": log_input, "preset": log_preset, "qualityValue": quality_value, "result": payload }),
        ),
        Err(error) => log_error(
            "video.transcode.error",
            "Video transcode failed",
            json!({ "input": log_input, "preset": log_preset, "qualityValue": quality_value, "error": error }),
        ),
    }
    result
}

#[tauri::command]
async fn clip_export(
    window: tauri::Window,
    clips: Vec<ExportClip>,
    output_dir: String,
    preset: String,
) -> Result<String, String> {
    if !matches!(preset.as_str(), "gpu-intra" | "prores-lt" | "prores-hq" | "h264-nvenc" | "av1-nvenc" | "h264-cpu" | "hevc-cpu") {
        return Err("Video preset must be gpu-intra, prores-lt, prores-hq, h264-nvenc, av1-nvenc, h264-cpu, or hevc-cpu".to_string());
    }
    log_info(
        "clip.export.start",
        "Starting clip export",
        json!({ "clipCount": clips.len(), "outputDir": &output_dir, "preset": &preset }),
    );
    let log_clip_count = clips.len();
    let log_output_dir = output_dir.clone();
    let log_preset = preset.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_clip_export(window, clips, output_dir, preset)
    })
    .await
    .map_err(|error| error.to_string())?;
    match &result {
        Ok(payload) => log_info(
            "clip.export.complete",
            "Clip export completed",
            json!({ "clipCount": log_clip_count, "outputDir": log_output_dir, "preset": log_preset, "result": payload }),
        ),
        Err(error) => log_error(
            "clip.export.error",
            "Clip export failed",
            json!({ "clipCount": log_clip_count, "outputDir": log_output_dir, "preset": log_preset, "error": error }),
        ),
    }
    result
}

fn run_clip_export(
    window: tauri::Window,
    clips: Vec<ExportClip>,
    output_dir: String,
    preset: String,
) -> Result<String, String> {
    let root = app_root()?;
    let ffmpeg = find_tool(&root, "ffmpeg");
    let ffprobe = find_tool(&root, "ffprobe");
    ensure_tool(&ffmpeg)?;
    ensure_tool(&ffprobe)?;

    let out_dir = PathBuf::from(&output_dir);
    fs::create_dir_all(&out_dir).map_err(|e| format!("Could not create output directory: {e}"))?;

    let mut file_index = 1;

    for (i, clip) in clips.iter().enumerate() {
        let input = canonical_input_path(&clip.source)?;
        
        let output = loop {
            let candidate = out_dir.join(format!("{file_index}.mov"));
            if !candidate.exists() {
                break candidate;
            }
            file_index += 1;
        };
        file_index += 1;

        let mut args = vec![
            "-y".to_string(),
            "-hide_banner".to_string(),
            "-nostdin".to_string(),
        ];

        let fps = clip.fps.filter(|f| *f > 0.0).unwrap_or(24.0);
        let offset = 1.5 / fps;
        // The offset guarantees we skip the last frame of the previous clip
        // which is often included due to exact-boundary floating-point rounding.
        let export_start = clip.start + offset;
        let raw_duration = (clip.end - export_start).max(0.0);
        let export_duration = if raw_duration > 0.05 {
            raw_duration - 0.015
        } else {
            raw_duration
        };

        let message = match preset.as_str() {
            "gpu-intra" => {
                args.extend([
                    "-ss".to_string(),
                    format!("{export_start:.3}"),
                    "-i".to_string(),
                    input.to_string_lossy().to_string(),
                    "-t".to_string(),
                    format!("{export_duration:.3}"),
                    "-c:v".to_string(),
                    "hevc_nvenc".to_string(),
                    "-preset".to_string(),
                    "p1".to_string(),
                    "-rc".to_string(),
                    "constqp".to_string(),
                    "-qp".to_string(),
                    "16".to_string(),
                    "-g".to_string(),
                    "1".to_string(),
                    "-bf".to_string(),
                    "0".to_string(),
                    "-profile:v".to_string(),
                    "main10".to_string(),
                    "-highbitdepth".to_string(),
                    "1".to_string(),
                    "-c:a".to_string(),
                    "copy".to_string(),
                ]);
                format!("Encoding GPU Intra clip {}/{}", i + 1, clips.len())
            }
            "prores-lt" | "prores-hq" => {
                let profile = if preset == "prores-lt" { "1" } else { "3" };
                args.extend([
                    "-ss".to_string(),
                    format!("{export_start:.3}"),
                    "-t".to_string(),
                    format!("{export_duration:.3}"),
                    "-i".to_string(),
                    input.to_string_lossy().to_string(),
                    "-c:v".to_string(),
                    "prores_ks".to_string(),
                    "-profile:v".to_string(),
                    profile.to_string(),
                    "-pix_fmt".to_string(),
                    "yuv422p10le".to_string(),
                    "-c:a".to_string(),
                    "pcm_s16le".to_string(),
                ]);
                format!("Encoding ProRes clip {}/{}", i + 1, clips.len())
            }
            "h264-nvenc" => {
                args.extend([
                    "-ss".to_string(),
                    format!("{export_start:.3}"),
                    "-i".to_string(),
                    input.to_string_lossy().to_string(),
                    "-t".to_string(),
                    format!("{export_duration:.3}"),
                    "-c:v".to_string(),
                    "h264_nvenc".to_string(),
                    "-preset".to_string(),
                    "p4".to_string(),
                    "-cq".to_string(),
                    "18".to_string(),
                    "-c:a".to_string(),
                    "aac".to_string(),
                    "-b:a".to_string(),
                    "320k".to_string(),
                ]);
                format!("Encoding H.264 (NVENC) clip {}/{}", i + 1, clips.len())
            }
            "av1-nvenc" => {
                args.extend([
                    "-ss".to_string(),
                    format!("{export_start:.3}"),
                    "-i".to_string(),
                    input.to_string_lossy().to_string(),
                    "-t".to_string(),
                    format!("{export_duration:.3}"),
                    "-c:v".to_string(),
                    "av1_nvenc".to_string(),
                    "-preset".to_string(),
                    "p4".to_string(),
                    "-cq".to_string(),
                    "24".to_string(),
                    "-c:a".to_string(),
                    "aac".to_string(),
                    "-b:a".to_string(),
                    "320k".to_string(),
                ]);
                format!("Encoding AV1 (NVENC) clip {}/{}", i + 1, clips.len())
            }
            "h264-cpu" => {
                args.extend([
                    "-ss".to_string(),
                    format!("{export_start:.3}"),
                    "-i".to_string(),
                    input.to_string_lossy().to_string(),
                    "-t".to_string(),
                    format!("{export_duration:.3}"),
                    "-c:v".to_string(),
                    "libx264".to_string(),
                    "-preset".to_string(),
                    "fast".to_string(),
                    "-crf".to_string(),
                    "18".to_string(),
                    "-c:a".to_string(),
                    "aac".to_string(),
                    "-b:a".to_string(),
                    "320k".to_string(),
                ]);
                format!("Encoding H.264 (CPU) clip {}/{}", i + 1, clips.len())
            }
            "hevc-cpu" => {
                args.extend([
                    "-ss".to_string(),
                    format!("{export_start:.3}"),
                    "-i".to_string(),
                    input.to_string_lossy().to_string(),
                    "-t".to_string(),
                    format!("{export_duration:.3}"),
                    "-c:v".to_string(),
                    "libx265".to_string(),
                    "-preset".to_string(),
                    "fast".to_string(),
                    "-crf".to_string(),
                    "18".to_string(),
                    "-c:a".to_string(),
                    "aac".to_string(),
                    "-b:a".to_string(),
                    "320k".to_string(),
                ]);
                format!("Encoding HEVC (CPU) clip {}/{}", i + 1, clips.len())
            }
            _ => unreachable!(),
        };

        args.extend([
            "-progress".to_string(),
            "pipe:1".to_string(),
            "-stats_period".to_string(),
            "0.5".to_string(),
            output.to_string_lossy().to_string(),
        ]);

        let duration = export_duration;
        emit_conversion_progress(&window, "starting", Some(0.0), message, None, None);
        run_ffmpeg_with_progress(&window, &ffmpeg, args, duration, "Exporting clip", Some(&CLIP_CHILD_PID))?;
    }

    let done = ConversionDone {
        r#type: "done".to_string(),
        input: format!("{} clips", clips.len()),
        output: output_dir,
        archived_original: None,
        preset,
    };
    serde_json::to_string(&done).map_err(|error| error.to_string())
}

#[tauri::command]
async fn clip_export_merged(
    window: tauri::Window,
    clips: Vec<ExportClip>,
    output_dir: String,
    preset: String,
) -> Result<String, String> {
    if clips.len() < 2 {
        return Err("Merge requires at least 2 clips".to_string());
    }
    if !matches!(preset.as_str(), "gpu-intra" | "prores-lt" | "prores-hq" | "h264-nvenc" | "av1-nvenc" | "h264-cpu" | "hevc-cpu") {
        return Err("Video preset must be gpu-intra, prores-lt, prores-hq, h264-nvenc, av1-nvenc, h264-cpu, or hevc-cpu".to_string());
    }
    log_info(
        "clip.export_merged.start",
        "Starting merged clip export",
        json!({ "clipCount": clips.len(), "outputDir": &output_dir, "preset": &preset }),
    );
    let log_clip_count = clips.len();
    let log_output_dir = output_dir.clone();
    let log_preset = preset.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_clip_export_merged(window, clips, output_dir, preset)
    })
    .await
    .map_err(|error| error.to_string())?;
    match &result {
        Ok(payload) => log_info(
            "clip.export_merged.complete",
            "Merged clip export completed",
            json!({ "clipCount": log_clip_count, "outputDir": log_output_dir, "preset": log_preset, "result": payload }),
        ),
        Err(error) => log_error(
            "clip.export_merged.error",
            "Merged clip export failed",
            json!({ "clipCount": log_clip_count, "outputDir": log_output_dir, "preset": log_preset, "error": error }),
        ),
    }
    result
}

fn run_clip_export_merged(
    window: tauri::Window,
    clips: Vec<ExportClip>,
    output_dir: String,
    preset: String,
) -> Result<String, String> {
    let root = app_root()?;
    let ffmpeg = find_tool(&root, "ffmpeg");
    ensure_tool(&ffmpeg)?;

    let out_dir = PathBuf::from(&output_dir);
    fs::create_dir_all(&out_dir).map_err(|e| format!("Could not create output directory: {e}"))?;

    let base_name = clips
        .iter()
        .map(|c| (c.index + 1).to_string())
        .collect::<Vec<_>>()
        .join("+");
    let mut output = out_dir.join(format!("{base_name}.mov"));
    let mut suffix = 1;
    while output.exists() {
        output = out_dir.join(format!("{base_name} ({suffix}).mov"));
        suffix += 1;
    }

    let mut input_paths: Vec<PathBuf> = Vec::new();
    let mut input_index_for_clip: Vec<usize> = Vec::with_capacity(clips.len());
    for clip in clips.iter() {
        let canonical = canonical_input_path(&clip.source)?;
        let idx = match input_paths.iter().position(|p| p == &canonical) {
            Some(i) => i,
            None => {
                input_paths.push(canonical);
                input_paths.len() - 1
            }
        };
        input_index_for_clip.push(idx);
    }

    let mut args: Vec<String> = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-nostdin".to_string(),
    ];
    for path in &input_paths {
        args.push("-i".to_string());
        args.push(path.to_string_lossy().to_string());
    }

    let mut filter_parts: Vec<String> = Vec::new();
    let mut concat_inputs = String::new();
    let mut total_duration = 0.0_f64;
    for (i, clip) in clips.iter().enumerate() {
        let input_idx = input_index_for_clip[i];
        let fps = clip.fps.filter(|f| *f > 0.0).unwrap_or(24.0);
        let offset = 1.5 / fps;
        let start = clip.start + offset;
        let raw_duration = (clip.end - start).max(0.0);
        let duration = if raw_duration > 0.05 { raw_duration - 0.015 } else { raw_duration };
        total_duration += duration;
        filter_parts.push(format!(
            "[{input_idx}:v]trim=start={start:.3}:duration={duration:.3},setpts=PTS-STARTPTS[v{i}]"
        ));
        filter_parts.push(format!(
            "[{input_idx}:a]atrim=start={start:.3}:duration={duration:.3},asetpts=PTS-STARTPTS[a{i}]"
        ));
        concat_inputs.push_str(&format!("[v{i}][a{i}]"));
    }
    let n = clips.len();
    filter_parts.push(format!(
        "{concat_inputs}concat=n={n}:v=1:a=1[outv][outa]"
    ));
    args.push("-filter_complex".to_string());
    args.push(filter_parts.join(";"));
    args.push("-map".to_string());
    args.push("[outv]".to_string());
    args.push("-map".to_string());
    args.push("[outa]".to_string());

    match preset.as_str() {
        "gpu-intra" => args.extend([
            "-c:v".to_string(), "hevc_nvenc".to_string(),
            "-preset".to_string(), "p1".to_string(),
            "-rc".to_string(), "constqp".to_string(),
            "-qp".to_string(), "16".to_string(),
            "-g".to_string(), "1".to_string(),
            "-bf".to_string(), "0".to_string(),
            "-profile:v".to_string(), "main10".to_string(),
            "-highbitdepth".to_string(), "1".to_string(),
            "-c:a".to_string(), "aac".to_string(),
            "-b:a".to_string(), "320k".to_string(),
        ]),
        "prores-lt" | "prores-hq" => {
            let profile = if preset == "prores-lt" { "1" } else { "3" };
            args.extend([
                "-c:v".to_string(), "prores_ks".to_string(),
                "-profile:v".to_string(), profile.to_string(),
                "-pix_fmt".to_string(), "yuv422p10le".to_string(),
                "-c:a".to_string(), "pcm_s16le".to_string(),
            ]);
        }
        "h264-nvenc" => args.extend([
            "-c:v".to_string(), "h264_nvenc".to_string(),
            "-preset".to_string(), "p4".to_string(),
            "-cq".to_string(), "18".to_string(),
            "-c:a".to_string(), "aac".to_string(),
            "-b:a".to_string(), "320k".to_string(),
        ]),
        "av1-nvenc" => args.extend([
            "-c:v".to_string(), "av1_nvenc".to_string(),
            "-preset".to_string(), "p4".to_string(),
            "-cq".to_string(), "24".to_string(),
            "-c:a".to_string(), "aac".to_string(),
            "-b:a".to_string(), "320k".to_string(),
        ]),
        "h264-cpu" => args.extend([
            "-c:v".to_string(), "libx264".to_string(),
            "-preset".to_string(), "fast".to_string(),
            "-crf".to_string(), "18".to_string(),
            "-c:a".to_string(), "aac".to_string(),
            "-b:a".to_string(), "320k".to_string(),
        ]),
        "hevc-cpu" => args.extend([
            "-c:v".to_string(), "libx265".to_string(),
            "-preset".to_string(), "fast".to_string(),
            "-crf".to_string(), "18".to_string(),
            "-c:a".to_string(), "aac".to_string(),
            "-b:a".to_string(), "320k".to_string(),
        ]),
        _ => unreachable!(),
    }

    args.extend([
        "-progress".to_string(),
        "pipe:1".to_string(),
        "-stats_period".to_string(),
        "0.5".to_string(),
        output.to_string_lossy().to_string(),
    ]);

    let output_name = output
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| base_name.clone());
    emit_conversion_progress(
        &window,
        "starting",
        Some(0.0),
        format!("Merging {} clips into {output_name}", clips.len()),
        None,
        None,
    );
    run_ffmpeg_with_progress(&window, &ffmpeg, args, total_duration, "Merging clips", Some(&CLIP_CHILD_PID))?;

    let done = ConversionDone {
        r#type: "done".to_string(),
        input: format!("{} clips merged", clips.len()),
        output: output.to_string_lossy().to_string(),
        archived_original: None,
        preset,
    };
    serde_json::to_string(&done).map_err(|error| error.to_string())
}

#[tauri::command]
async fn video_gpu_status() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let status = collect_video_gpu_status();
        serde_json::to_string(&status).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn video_source_codec(input_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = app_root()?;
        let ffprobe = find_tool(&root, "ffprobe");
        ensure_tool(&ffprobe)?;
        let input = canonical_input_path(&input_path)?;
        probe_video_codec(&ffprobe, &input)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn clip_preview_generate(
    window: tauri::Window,
    scene_id: String,
    source_path: String,
    start: f64,
    end: f64,
    fps: f64,
) -> Result<String, String> {
    log_info(
        "clip.preview.start",
        "Starting clip preview generation",
        json!({ "sceneId": &scene_id, "source": &source_path, "start": start, "end": end, "fps": fps }),
    );
    let app_data_dir = window
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not get app data directory: {error}"))?;

    let log_scene_id = scene_id.clone();
    let log_source = source_path.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        generate_clip_preview(app_data_dir, scene_id, source_path, start, end, fps)
    })
    .await
    .map_err(|error| error.to_string())?;
    match &result {
        Ok(payload) => log_info(
            "clip.preview.complete",
            "Clip preview generation completed",
            json!({ "sceneId": log_scene_id, "source": log_source, "result": payload }),
        ),
        Err(error) => log_error(
            "clip.preview.error",
            "Clip preview generation failed",
            json!({ "sceneId": log_scene_id, "source": log_source, "error": error }),
        ),
    }
    result
}

#[tauri::command]
async fn clip_preview_generate_batch(
    window: tauri::Window,
    jobs: Vec<ClipPreviewRequest>,
) -> Result<String, String> {
    log_info(
        "clip.preview.batch.start",
        "Starting batched clip preview generation",
        json!({ "count": jobs.len() }),
    );
    let app_data_dir = window
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not get app data directory: {error}"))?;

    let count = jobs.len();
    let result = tauri::async_runtime::spawn_blocking(move || {
        generate_clip_preview_batch(app_data_dir, jobs)
    })
    .await
    .map_err(|error| error.to_string())?;

    match &result {
        Ok(payload) => log_info(
            "clip.preview.batch.complete",
            "Batched clip preview generation completed",
            json!({ "count": count, "result": payload }),
        ),
        Err(error) => log_error(
            "clip.preview.batch.error",
            "Batched clip preview generation failed",
            json!({ "count": count, "error": error }),
        ),
    }
    result
}

fn run_media_to_audio(
    window: tauri::Window,
    input_path: String,
    output_format: String,
) -> Result<String, String> {
    let root = app_root()?;
    let ffmpeg = find_tool(&root, "ffmpeg");
    let ffprobe = find_tool(&root, "ffprobe");
    let input = canonical_input_path(&input_path)?;
    ensure_tool(&ffmpeg)?;
    ensure_tool(&ffprobe)?;

    let duration = probe_duration(&ffprobe, &input).unwrap_or(0.0);
    let output = resolve_audio_output_path(&input, &output_format)?;
    let is_audio_input = is_audio_extension(input.extension().and_then(|ext| ext.to_str()));
    let final_output = input.with_extension(&output_format);

    let mut args = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-nostdin".to_string(),
        "-i".to_string(),
        input.to_string_lossy().to_string(),
        "-vn".to_string(),
    ];

    if output_format == "wav" {
        args.extend([
            "-acodec".to_string(),
            "pcm_s16le".to_string(),
            "-ar".to_string(),
            "44100".to_string(),
            "-ac".to_string(),
            "2".to_string(),
        ]);
    } else {
        args.extend([
            "-codec:a".to_string(),
            "libmp3lame".to_string(),
            "-q:a".to_string(),
            "0".to_string(),
            "-ar".to_string(),
            "44100".to_string(),
            "-ac".to_string(),
            "2".to_string(),
        ]);
    }

    args.extend([
        "-progress".to_string(),
        "pipe:1".to_string(),
        "-stats_period".to_string(),
        "0.5".to_string(),
        output.to_string_lossy().to_string(),
    ]);

    emit_conversion_progress(
        &window,
        "starting",
        Some(0.0),
        format!("Creating {} audio...", output_format.to_uppercase()),
        None,
        None,
    );
    run_ffmpeg_with_progress(&window, &ffmpeg, args, duration, "Converting audio", None)?;

    let archived_original = if is_audio_input {
        let archived = archive_original(&input)?;
        if !same_path_rs(&output, &final_output) {
            fs::rename(&output, &final_output)
                .map_err(|error| format!("Could not move converted audio into place: {error}"))?;
        }
        Some(archived)
    } else {
        None
    };

    let done = ConversionDone {
        r#type: "done".to_string(),
        input: input.to_string_lossy().to_string(),
        output: final_output.to_string_lossy().to_string(),
        archived_original: archived_original.map(|path| path.to_string_lossy().to_string()),
        preset: output_format,
    };
    serde_json::to_string(&done).map_err(|error| error.to_string())
}

fn run_video_transcode(
    window: tauri::Window,
    input_path: String,
    preset: String,
    quality_value: Option<u32>,
) -> Result<String, String> {
    let root = app_root()?;
    let ffmpeg = find_tool(&root, "ffmpeg");
    let ffprobe = find_tool(&root, "ffprobe");
    let input = canonical_input_path(&input_path)?;
    ensure_tool(&ffmpeg)?;
    ensure_tool(&ffprobe)?;

    let duration = probe_duration(&ffprobe, &input).unwrap_or(0.0);
    let output_suffix = match preset.as_str() {
        "gpu-intra" => "intra",
        "prores-lt" => "prores_lt",
        "prores-hq" => "prores_hq",
        _ => unreachable!(),
    };
    let output = unique_sibling_path(&input, output_suffix, "mov");

    let mut args = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-nostdin".to_string(),
    ];

    let message = match preset.as_str() {
        "gpu-intra" => {
            let qp = quality_value.unwrap_or(16).clamp(10, 28);
            let codec = probe_video_codec(&ffprobe, &input)?;
            let decoder = match codec.as_str() {
                "h264" => "h264_cuvid",
                "hevc" => "hevc_cuvid",
                _ => {
                    return Err(format!(
                        "GPU Intra cannot decode this source. It supports {GPU_INTRA_SOURCE_CODECS} sources only because it uses NVIDIA NVDEC. Input codec: {codec}. Choose ProRes LT or ProRes HQ for this file, or convert from a H.264/HEVC source."
                    ))
                }
            };
            args.extend([
                "-loglevel".to_string(),
                "error".to_string(),
                "-hwaccel".to_string(),
                "cuda".to_string(),
                "-hwaccel_output_format".to_string(),
                "cuda".to_string(),
                "-c:v".to_string(),
                decoder.to_string(),
                "-i".to_string(),
                input.to_string_lossy().to_string(),
                "-c:v".to_string(),
                "hevc_nvenc".to_string(),
                "-preset".to_string(),
                "p1".to_string(),
                "-rc".to_string(),
                "constqp".to_string(),
                "-qp".to_string(),
                qp.to_string(),
                "-g".to_string(),
                "0".to_string(),
                "-bf".to_string(),
                "0".to_string(),
                "-profile:v".to_string(),
                "main10".to_string(),
                "-highbitdepth".to_string(),
                "1".to_string(),
                "-c:a".to_string(),
                "copy".to_string(),
            ]);
            format!("NVDEC to HEVC NVENC Main10 all-intra, QP {qp}")
        }
        "prores-lt" | "prores-hq" => {
            let profile = if preset == "prores-lt" { "1" } else { "3" };
            let bits_per_mb = if preset == "prores-lt" {
                quality_value.unwrap_or(360).clamp(180, 700)
            } else {
                quality_value.unwrap_or(800).clamp(400, 1400)
            };
            args.extend([
                "-i".to_string(),
                input.to_string_lossy().to_string(),
                "-c:v".to_string(),
                "prores_ks".to_string(),
                "-profile:v".to_string(),
                profile.to_string(),
                "-bits_per_mb".to_string(),
                bits_per_mb.to_string(),
                "-pix_fmt".to_string(),
                "yuv422p10le".to_string(),
                "-c:a".to_string(),
                "pcm_s16le".to_string(),
            ]);
            if preset == "prores-lt" {
                format!("Encoding ProRes 422 LT, density {bits_per_mb}")
            } else {
                format!("Encoding ProRes 422 HQ, density {bits_per_mb}")
            }
        }
        _ => unreachable!(),
    };

    args.extend([
        "-progress".to_string(),
        "pipe:1".to_string(),
        "-stats_period".to_string(),
        "0.5".to_string(),
        output.to_string_lossy().to_string(),
    ]);

    emit_conversion_progress(&window, "starting", Some(0.0), message, None, None);
    run_ffmpeg_with_progress(&window, &ffmpeg, args, duration, "Transcoding video", Some(&VIDEO_CHILD_PID))?;

    let done = ConversionDone {
        r#type: "done".to_string(),
        input: input.to_string_lossy().to_string(),
        output: output.to_string_lossy().to_string(),
        archived_original: None,
        preset,
    };
    serde_json::to_string(&done).map_err(|error| error.to_string())
}

fn collect_video_gpu_status() -> VideoGpuStatus {
    let root = app_root().unwrap_or_else(|_| PathBuf::from("."));
    let ffmpeg = find_tool(&root, "ffmpeg");
    let ffprobe = find_tool(&root, "ffprobe");
    let gpu_name = detect_nvidia_gpu_name();
    let has_nvidia_gpu = gpu_name.is_some();
    let has_ffmpeg = command_available(&ffmpeg);
    let has_ffprobe = command_available(&ffprobe);
    let decoders = if has_ffmpeg {
        ffmpeg_listing(&ffmpeg, "-decoders")
    } else {
        String::new()
    };
    let encoders = if has_ffmpeg {
        ffmpeg_listing(&ffmpeg, "-encoders")
    } else {
        String::new()
    };
    let has_h264_cuvid = decoders.contains("h264_cuvid");
    let has_hevc_cuvid = decoders.contains("hevc_cuvid");
    let has_hevc_nvenc = encoders.contains("hevc_nvenc");
    let has_h264_nvenc = encoders.contains("h264_nvenc");
    let has_av1_nvenc = encoders.contains("av1_nvenc");
    let compatible =
        has_nvidia_gpu && has_ffmpeg && has_ffprobe && has_h264_cuvid && has_hevc_cuvid && has_hevc_nvenc;

    let message = if compatible {
        format!(
            "GPU Intra ready on {}",
            gpu_name.as_deref().unwrap_or("NVIDIA GPU")
        )
    } else if !has_nvidia_gpu {
        "Compatible GPU not found. GPU Intra needs an NVIDIA GPU with NVENC/NVDEC.".to_string()
    } else if !has_ffmpeg || !has_ffprobe {
        "Bundled ffmpeg/ffprobe not found. GPU Intra needs the app's bundled media tools.".to_string()
    } else if !has_h264_cuvid || !has_hevc_cuvid {
        "ffmpeg is missing CUVID decoders. GPU Intra needs h264_cuvid and hevc_cuvid.".to_string()
    } else if !has_hevc_nvenc {
        "ffmpeg is missing HEVC NVENC. GPU Intra needs hevc_nvenc.".to_string()
    } else {
        "GPU Intra requirements are incomplete.".to_string()
    };

    VideoGpuStatus {
        compatible,
        gpu_name,
        has_nvidia_gpu,
        has_ffmpeg,
        has_ffprobe,
        has_h264_cuvid,
        has_hevc_cuvid,
        has_hevc_nvenc,
        has_h264_nvenc,
        has_av1_nvenc,
        message,
    }
}

fn detect_nvidia_gpu_name() -> Option<String> {
    let output = cmd("nvidia-smi")
        .args(["--query-gpu=name", "--format=csv,noheader,nounits"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToString::to_string)
}

fn command_available(path: &Path) -> bool {
    cmd(path)
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn ffmpeg_listing(ffmpeg: &Path, kind: &str) -> String {
    let output = cmd(ffmpeg)
        .args(["-hide_banner", kind])
        .output();
    match output {
        Ok(output) if output.status.success() => {
            let mut combined = String::from_utf8_lossy(&output.stdout).to_string();
            combined.push_str(&String::from_utf8_lossy(&output.stderr));
            combined
        }
        _ => String::new(),
    }
}

fn canonical_input_path(input_path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(input_path.trim().trim_matches(['"', '\'']));
    if !path.is_file() {
        return Err(format!("Input file not found: {}", path.to_string_lossy()));
    }
    path.canonicalize()
        .map_err(|error| format!("Could not read input path: {error}"))
}

fn ensure_tool(path: &Path) -> Result<(), String> {
    let tool_name = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("tool");
    cmd(path)
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| format!("{tool_name} was not found. Install a current ffmpeg build and make sure ffmpeg/bin is in PATH."))?
        .success()
        .then_some(())
        .ok_or_else(|| format!("{tool_name} is installed but did not run successfully."))
}

fn probe_duration(ffprobe: &Path, input: &Path) -> Result<f64, String> {
    let output = cmd(ffprobe)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=nokey=1:noprint_wrappers=1",
        ])
        .arg(input)
        .output()
        .map_err(|error| format!("Could not start ffprobe: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| line.trim().parse::<f64>().ok())
        .ok_or_else(|| "ffprobe could not read duration".to_string())
}

fn probe_video_codec(ffprobe: &Path, input: &Path) -> Result<String, String> {
    let output = cmd(ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_name",
            "-of",
            "default=nokey=1:noprint_wrappers=1",
        ])
        .arg(input)
        .output()
        .map_err(|error| format!("Could not start ffprobe: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.to_ascii_lowercase())
        .ok_or_else(|| "ffprobe could not read the input video codec".to_string())
}

fn probe_has_audio_stream(ffprobe: &Path, input: &Path) -> Result<bool, String> {
    let output = cmd(ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "a",
            "-show_entries",
            "stream=codec_type",
            "-of",
            "default=nokey=1:noprint_wrappers=1",
        ])
        .arg(input)
        .output()
        .map_err(|error| format!("Could not start ffprobe: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .any(|line| line.trim().eq_ignore_ascii_case("audio")))
}

fn format_spec_is_audio_only(spec: &str) -> bool {
    let lower = spec.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return false;
    }
    if lower == "bestaudio" || lower.starts_with("bestaudio[") || lower.starts_with("bestaudio/") {
        return true;
    }
    if lower.contains('+') || lower.contains("bestvideo") {
        return false;
    }
    lower.split('/').all(|alt| {
        let alt = alt.trim();
        alt == "bestaudio" || alt.starts_with("bestaudio[") || alt.starts_with("audio")
    })
}

fn audio_warning_for_download(saved_file: &Path, user_picked_audio_only: bool) -> Option<String> {
    if user_picked_audio_only {
        return None;
    }
    let root = match app_root() {
        Ok(value) => value,
        Err(_) => return None,
    };
    let ffprobe = find_tool(&root, "ffprobe");
    if !command_available(&ffprobe) {
        return None;
    }
    match probe_has_audio_stream(&ffprobe, saved_file) {
        Ok(true) => None,
        Ok(false) => {
            log_warn(
                "download.audio.missing",
                "Downloaded file has no audio stream",
                json!({ "savedFile": saved_file.display().to_string() }),
            );
            Some("Downloaded file has no audio stream. Try selecting 'Best (auto-merge)' or a 'Video + Audio' format.".to_string())
        }
        Err(error) => {
            log_warn(
                "download.audio.probe.error",
                "Could not probe downloaded file for audio",
                json!({ "savedFile": saved_file.display().to_string(), "error": error }),
            );
            None
        }
    }
}

fn generate_clip_preview(
    app_data_dir: PathBuf,
    scene_id: String,
    source_path: String,
    start: f64,
    end: f64,
    fps: f64,
) -> Result<String, String> {
    let root = app_root()?;
    let ffmpeg = find_tool(&root, "ffmpeg");
    ensure_tool(&ffmpeg)?;

    let request = ClipPreviewRequest {
        scene_id,
        source_path,
        start,
        end,
        fps,
    };
    let job = resolve_clip_preview_job(&app_data_dir, request)?;

    if job.output
        .metadata()
        .map(|metadata| metadata.len() > 1024)
        .unwrap_or(false)
    {
        return serialize_clip_preview_done(job.scene_id, job.output, job.duration, true);
    }

    let use_gpu = *H264_NVENC_AVAILABLE
        .get_or_init(|| ffmpeg_listing(&ffmpeg, "-encoders").contains("h264_nvenc"));
    render_single_preview_job(&ffmpeg, &job, use_gpu)?;

    serialize_clip_preview_done(job.scene_id, job.output, job.duration, false)
}

struct ResolvedClipPreviewJob {
    scene_id: String,
    input: PathBuf,
    output: PathBuf,
    temp_output: PathBuf,
    start: f64,
    duration: f64,
}

fn resolve_clip_preview_job(
    app_data_dir: &Path,
    request: ClipPreviewRequest,
) -> Result<ResolvedClipPreviewJob, String> {
    if !request.start.is_finite() || !request.end.is_finite() || request.end <= request.start {
        return Err("Preview range must have a valid start and end time.".to_string());
    }

    let input = canonical_input_path(&request.source_path)?;
    let metadata = input
        .metadata()
        .map_err(|error| format!("Could not read source metadata: {error}"))?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    let input_key = input.to_string_lossy().to_string();
    let size_key = metadata.len().to_string();
    let source_key = short_stable_id(&[&input_key, &size_key, &modified]);
    let source_name = sanitize_path_segment(
        input
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("episode"),
        "episode",
        56,
    );
    let cache_dir = app_data_dir
        .join("clip_previews")
        .join(format!("{source_name}-{source_key}"));
    fs::create_dir_all(&cache_dir)
        .map_err(|error| format!("Could not create preview cache folder: {error}"))?;

    let start_key = format!("{:.3}", request.start);
    let end_key = format!("{:.3}", request.end);
    let fps_key = format!("{:.3}", request.fps);
    let range_key = short_stable_id(&[
        &request.scene_id,
        &start_key,
        &end_key,
        &fps_key,
        "preview-webp-v1",
    ]);
    let safe_scene_id = sanitize_path_segment(&request.scene_id, "scene", 48).replace(' ', "_");
    let output = cache_dir.join(format!("{safe_scene_id}-{range_key}.webp"));
    let temp_output = output.with_extension("tmp.webp");
    let duration = preview_proxy_duration(request.start, request.end, request.fps);

    Ok(ResolvedClipPreviewJob {
        scene_id: request.scene_id,
        input,
        output,
        temp_output,
        start: request.start,
        duration,
    })
}

fn generate_clip_preview_batch(
    app_data_dir: PathBuf,
    jobs: Vec<ClipPreviewRequest>,
) -> Result<String, String> {
    let root = app_root()?;
    let ffmpeg = find_tool(&root, "ffmpeg");
    ensure_tool(&ffmpeg)?;

    let use_gpu = *H264_NVENC_AVAILABLE
        .get_or_init(|| ffmpeg_listing(&ffmpeg, "-encoders").contains("h264_nvenc"));
    let mut items = Vec::with_capacity(jobs.len());
    let mut pending: Vec<ResolvedClipPreviewJob> = Vec::new();

    for request in jobs {
        let scene_id = request.scene_id.clone();
        match resolve_clip_preview_job(&app_data_dir, request) {
            Ok(job) => {
                if job
                    .output
                    .metadata()
                    .map(|metadata| metadata.len() > 1024)
                    .unwrap_or(false)
                {
                    items.push(ClipPreviewBatchItem {
                        scene_id: job.scene_id,
                        path: Some(job.output.to_string_lossy().to_string()),
                        duration: job.duration,
                        cached: true,
                        error: None,
                    });
                } else {
                    pending.push(job);
                }
            }
            Err(error) => items.push(ClipPreviewBatchItem {
                scene_id,
                path: None,
                duration: 0.0,
                cached: false,
                error: Some(error),
            }),
        }
    }

    const PARALLELISM: usize = 4;
    let ffmpeg_path = ffmpeg.as_path();
    for chunk in pending.chunks(PARALLELISM) {
        let rendered: Vec<ClipPreviewBatchItem> = thread::scope(|scope| {
            let handles: Vec<_> = chunk
                .iter()
                .map(|job| {
                    scope.spawn(move || match render_single_preview_job(ffmpeg_path, job, use_gpu) {
                        Ok(()) => ClipPreviewBatchItem {
                            scene_id: job.scene_id.clone(),
                            path: Some(job.output.to_string_lossy().to_string()),
                            duration: job.duration,
                            cached: false,
                            error: None,
                        },
                        Err(error) => ClipPreviewBatchItem {
                            scene_id: job.scene_id.clone(),
                            path: None,
                            duration: job.duration,
                            cached: false,
                            error: Some(error),
                        },
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap_or_else(|_| ClipPreviewBatchItem {
                    scene_id: String::new(),
                    path: None,
                    duration: 0.0,
                    cached: false,
                    error: Some("Preview worker thread panicked.".to_string()),
                }))
                .collect()
        });
        items.extend(rendered);
    }

    serde_json::to_string(&ClipPreviewBatchDone {
        r#type: "done".to_string(),
        items,
    })
    .map_err(|error| error.to_string())
}

fn render_single_preview_job(
    ffmpeg: &Path,
    job: &ResolvedClipPreviewJob,
    use_gpu: bool,
) -> Result<(), String> {
    let _ = fs::remove_file(&job.temp_output);

    if let Err(error) = run_preview_ffmpeg(
        ffmpeg,
        &job.input,
        &job.temp_output,
        job.start,
        job.duration,
        use_gpu,
    ) {
        if !use_gpu {
            return Err(error);
        }
        let _ = fs::remove_file(&job.temp_output);
        run_preview_ffmpeg(
            ffmpeg,
            &job.input,
            &job.temp_output,
            job.start,
            job.duration,
            false,
        )?;
    }

    finalize_preview_output(&job.temp_output, &job.output)
}

fn finalize_preview_output(temp_output: &Path, output: &Path) -> Result<(), String> {
    if !temp_output
        .metadata()
        .map(|metadata| metadata.len() > 1024)
        .unwrap_or(false)
    {
        let _ = fs::remove_file(temp_output);
        return Err("Preview renderer did not create a valid cache file.".to_string());
    }
    if output.exists() {
        let _ = fs::remove_file(output);
    }
    fs::rename(temp_output, output)
        .map_err(|error| format!("Could not finalize preview clip: {error}"))
}

fn preview_proxy_duration(start: f64, end: f64, fps: f64) -> f64 {
    let duration = (end - start).max(0.0);
    let frame_guard = if fps.is_finite() && fps > 1.0 {
        (2.0 / fps).clamp(0.04, 0.12)
    } else {
        0.08
    };
    let guarded = if duration > 0.24 {
        (duration - frame_guard).max(0.18)
    } else {
        duration
    };
    round_seconds(guarded.max(0.08).min(duration.max(0.08)))
}

fn round_seconds(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

fn run_preview_ffmpeg(
    ffmpeg: &Path,
    input: &Path,
    output: &Path,
    start: f64,
    duration: f64,
    use_gpu: bool,
) -> Result<(), String> {
    let mut args = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-nostdin".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
    ];

    if use_gpu {
        args.extend([
            "-hwaccel".to_string(),
            "cuda".to_string(),
            "-hwaccel_output_format".to_string(),
            "cuda".to_string(),
        ]);
    }

    args.extend([
        "-ss".to_string(),
        format!("{:.3}", start.max(0.0)),
        "-i".to_string(),
        input.to_string_lossy().to_string(),
        "-t".to_string(),
        format!("{duration:.3}"),
        "-an".to_string(),
        "-sn".to_string(),
        "-dn".to_string(),
        "-vf".to_string(),
    ]);

    if use_gpu {
        args.push("scale_cuda=426:240,hwdownload,format=nv12,fps=12".to_string());
    } else {
        args.push("fps=12,scale=426:240:force_original_aspect_ratio=increase,crop=426:240".to_string());
    }

    args.extend([
        "-vcodec".to_string(),
        "libwebp".to_string(),
        "-lossless".to_string(),
        "0".to_string(),
        "-q:v".to_string(),
        "80".to_string(),
        "-loop".to_string(),
        "0".to_string(),
        output.to_string_lossy().to_string(),
    ]);

    let result = cmd(ffmpeg)
        .args(args)
        .output()
        .map_err(|error| format!("Could not start ffmpeg preview renderer: {error}"))?;
    if result.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&result.stderr).trim().to_string();
    if stderr.is_empty() {
        Err(format!(
            "Preview renderer exited with code {}",
            result.status.code().unwrap_or(-1)
        ))
    } else {
        Err(stderr)
    }
}

fn serialize_clip_preview_done(
    scene_id: String,
    path: PathBuf,
    duration: f64,
    cached: bool,
) -> Result<String, String> {
    serde_json::to_string(&ClipPreviewDone {
        r#type: "done".to_string(),
        scene_id,
        path: path.to_string_lossy().to_string(),
        duration,
        cached,
    })
    .map_err(|error| error.to_string())
}

fn resolve_audio_output_path(input: &Path, output_format: &str) -> Result<PathBuf, String> {
    let final_output = input.with_extension(output_format);
    if same_path_rs(input, &final_output) {
        let stem = input
            .file_stem()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "Input file needs a valid filename".to_string())?;
        return Ok(input.with_file_name(format!("{stem}.tmp.{output_format}")));
    }
    Ok(final_output)
}

fn unique_sibling_path(input: &Path, suffix: &str, extension: &str) -> PathBuf {
    let stem = input
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("output");
    let dir = input.parent().unwrap_or_else(|| Path::new("."));
    let base = dir.join(format!("{stem}_{suffix}"));
    let mut candidate = base.with_extension(extension);
    let mut index = 1;
    while candidate.exists() {
        candidate = dir
            .join(format!("{stem}_{suffix}_{index}"))
            .with_extension(extension);
        index += 1;
    }
    candidate
}

fn archive_original(input: &Path) -> Result<PathBuf, String> {
    let file_name = input
        .file_name()
        .ok_or_else(|| "Input file needs a valid filename".to_string())?;
    let archive_dir = input
        .parent()
        .ok_or_else(|| "Input file needs a parent folder".to_string())?
        .join("old");
    fs::create_dir_all(&archive_dir)
        .map_err(|error| format!("Could not create old folder: {error}"))?;

    let mut archive = archive_dir.join(file_name);
    if archive.exists() {
        let stem = input.file_stem().and_then(|value| value.to_str()).unwrap_or("original");
        let ext = input.extension().and_then(|value| value.to_str()).unwrap_or("");
        let mut index = 1;
        loop {
            let name = if ext.is_empty() {
                format!("{stem}_{index}")
            } else {
                format!("{stem}_{index}.{ext}")
            };
            archive = archive_dir.join(name);
            if !archive.exists() {
                break;
            }
            index += 1;
        }
    }

    fs::rename(input, &archive).map_err(|error| format!("Could not archive original file: {error}"))?;
    Ok(archive)
}

fn is_audio_extension(extension: Option<&str>) -> bool {
    matches!(
        extension.map(|value| value.to_ascii_lowercase()).as_deref(),
        Some("wav" | "mp3" | "flac" | "m4a" | "ogg" | "aac" | "opus" | "wma")
    )
}

fn same_path_rs(left: &Path, right: &Path) -> bool {
    left.to_string_lossy()
        .eq_ignore_ascii_case(&right.to_string_lossy())
}

fn run_ffmpeg_with_progress(
    window: &tauri::Window,
    ffmpeg: &Path,
    args: Vec<String>,
    duration: f64,
    label: &str,
    pid_slot: Option<&OnceLock<Mutex<Option<u32>>>>,
) -> Result<(), String> {
    log_info(
        "ffmpeg.start",
        "Starting FFmpeg job",
        json!({ "label": label, "ffmpeg": ffmpeg.to_string_lossy(), "args": &args, "duration": duration }),
    );
    let mut child = cmd(ffmpeg)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            log_error(
                "ffmpeg.spawn.error",
                "Could not start FFmpeg job",
                json!({ "label": label, "error": error.to_string(), "args": &args }),
            );
            format!("Could not start ffmpeg: {error}")
        })?;
    if let Some(slot) = pid_slot {
        store_child_pid(slot, child.id());
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not read ffmpeg progress stream".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Could not read ffmpeg error stream".to_string())?;

    let stderr_handle = thread::spawn(move || -> String {
        const MAX_TAIL: usize = 24 * 1024;
        let mut tail = String::new();
        for line in BufReader::new(stderr).lines() {
            let Ok(line) = line else { break };
            tail.push_str(&line);
            tail.push('\n');
            if tail.len() > MAX_TAIL {
                let cut = tail.len() - MAX_TAIL;
                tail.drain(..cut);
            }
        }
        tail
    });

    let mut fps: Option<String> = None;
    let mut speed: Option<String> = None;
    for line in BufReader::new(stdout).lines() {
        let line = line.map_err(|error| error.to_string())?;
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key {
            "fps" => fps = Some(value.trim().to_string()),
            "speed" => speed = Some(value.trim().to_string()),
            "out_time_ms" | "out_time_us" => {
                if duration > 0.0 {
                    if let Ok(raw) = value.trim().parse::<f64>() {
                        let done = raw / 1_000_000.0;
                        let percent = ((done / duration) * 100.0).clamp(0.0, 99.0) as f32;
                        let message = format!(
                            "{label}: {} / {}",
                            format_seconds(done),
                            format_seconds(duration)
                        );
                        emit_conversion_progress(
                            window,
                            "processing",
                            Some(percent),
                            message,
                            fps.clone(),
                            speed.clone(),
                        );
                    }
                }
            }
            "progress" if value.trim() == "end" => {
                emit_conversion_progress(
                    window,
                    "finalizing",
                    Some(100.0),
                    "Finalizing output...".to_string(),
                    fps.clone(),
                    speed.clone(),
                );
            }
            _ => {}
        }
    }

    let status = child.wait().map_err(|error| error.to_string())?;
    if let Some(slot) = pid_slot {
        clear_child_pid(slot);
    }
    let stderr_tail = stderr_handle.join().unwrap_or_default();
    if status.success() {
        log_info(
            "ffmpeg.complete",
            "FFmpeg job completed",
            json!({ "label": label }),
        );
        emit_conversion_progress(
            window,
            "complete",
            Some(100.0),
            "Conversion complete".to_string(),
            fps,
            speed,
        );
        Ok(())
    } else {
        if status.code().is_none() {
            log_warn(
                "ffmpeg.cancelled",
                "FFmpeg job was cancelled",
                json!({ "label": label }),
            );
            return Err(format!("{label} cancelled."));
        }
        let tail = stderr_tail.trim();
        if tail.is_empty() {
            let error = format!("ffmpeg exited with code {}", status.code().unwrap_or(-1));
            log_error(
                "ffmpeg.error",
                "FFmpeg job failed",
                json!({ "label": label, "code": status.code(), "error": &error }),
            );
            Err(error)
        } else {
            log_error(
                "ffmpeg.error",
                "FFmpeg job failed",
                json!({ "label": label, "code": status.code(), "stderr": truncate_log_text(tail) }),
            );
            Err(tail.to_string())
        }
    }
}

fn emit_conversion_progress(
    window: &tauri::Window,
    stage: &str,
    percent: Option<f32>,
    message: String,
    fps: Option<String>,
    speed: Option<String>,
) {
    let _ = window.emit(
        "conversion-progress",
        ConversionProgress {
            stage: stage.to_string(),
            percent,
            message,
            fps,
            speed,
        },
    );
}

fn format_seconds(seconds: f64) -> String {
    let total = seconds.max(0.0).round() as u64;
    let hours = total / 3600;
    let minutes = (total % 3600) / 60;
    let secs = total % 60;
    if hours > 0 {
        format!("{hours:02}:{minutes:02}:{secs:02}")
    } else {
        format!("{minutes:02}:{secs:02}")
    }
}

#[tauri::command]
async fn audio_extract(window: tauri::Window, input_path: String) -> Result<String, String> {
    log_info(
        "audio.extract.invoke.start",
        "Starting audio extraction command",
        json!({ "input": &input_path }),
    );
    let log_input = input_path.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_streaming_audio_cli(
            window,
            vec!["separate".to_string(), input_path],
            "audio-progress",
        )
    })
    .await
    .map_err(|error| error.to_string())?;
    match &result {
        Ok(payload) => log_info(
            "audio.extract.invoke.complete",
            "Audio extraction command completed",
            json!({ "input": log_input, "result": payload }),
        ),
        Err(error) => log_error(
            "audio.extract.invoke.error",
            "Audio extraction command failed",
            json!({ "input": log_input, "error": error }),
        ),
    }
    result
}

#[tauri::command]
async fn audio_setup(window: tauri::Window, mode: String) -> Result<String, String> {
    if mode != "cpu" && mode != "gpu" {
        return Err("Setup mode must be cpu or gpu".to_string());
    }
    stop_clip_processes_for_dependency_setup(&window).await;
    log_info(
        "audio.setup.invoke.start",
        "Starting audio dependency setup command",
        json!({ "mode": &mode }),
    );
    let log_mode = mode.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_streaming_audio_cli(
            window,
            vec!["setup".to_string(), mode],
            "audio-setup-progress",
        )
    })
    .await
    .map_err(|error| error.to_string())?;
    match &result {
        Ok(payload) => log_info(
            "audio.setup.invoke.complete",
            "Audio dependency setup command completed",
            json!({ "mode": log_mode, "result": payload }),
        ),
        Err(error) => log_error(
            "audio.setup.invoke.error",
            "Audio dependency setup command failed",
            json!({ "mode": log_mode, "error": error }),
        ),
    }
    result
}

async fn stop_clip_processes_for_dependency_setup(window: &tauri::Window) {
    kill_child_pid(&CLIP_CHILD_PID);

    let Some(mutex) = CLIP_SERVER.get() else {
        return;
    };
    let mut guard = mutex.lock().await;
    let Some(mut child) = guard.take() else {
        return;
    };

    log_info(
        "clip.server.kill",
        "Stopping clip server before dependency setup",
        Value::Null,
    );
    let _ = window.emit(
        "clip-server-event",
        serde_json::json!({ "type": "stopped", "reason": "dependency-setup" }),
    );

    if let Err(error) = child.start_kill() {
        log_warn(
            "clip.server.kill.warning",
            "Could not request clip server stop before dependency setup",
            json!({ "error": error.to_string() }),
        );
        return;
    }

    match tokio::time::timeout(std::time::Duration::from_secs(5), child.wait()).await {
        Ok(Ok(status)) => log_info(
            "clip.server.kill.complete",
            "Clip server stopped before dependency setup",
            json!({ "status": status.code() }),
        ),
        Ok(Err(error)) => log_warn(
            "clip.server.kill.warning",
            "Could not wait for clip server stop before dependency setup",
            json!({ "error": error.to_string() }),
        ),
        Err(_) => log_warn(
            "clip.server.kill.timeout",
            "Timed out waiting for clip server to stop before dependency setup",
            Value::Null,
        ),
    }
}

fn background_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?
        .join("backgrounds");
    if !dir.exists() {
        fs::create_dir_all(&dir)
            .map_err(|error| format!("Could not create backgrounds directory: {error}"))?;
    }
    Ok(dir)
}

fn purge_background_files(dir: &Path) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if name.starts_with("bg_") {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    }
}

#[tauri::command]
async fn save_background_image(
    app: tauri::AppHandle,
    source: String,
) -> Result<String, String> {
    let dir = background_dir(&app)?;
    let source_path = PathBuf::from(&source);
    if !source_path.is_file() {
        return Err(format!("Image not found: {source}"));
    }
    let extension = source_path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("img")
        .to_lowercase();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let target = dir.join(format!("bg_{stamp}.{extension}"));

    let target_for_blocking = target.clone();
    let dir_for_blocking = dir.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        purge_background_files(&dir_for_blocking);
        fs::copy(&source_path, &target_for_blocking)
            .map_err(|error| format!("Could not copy background image: {error}"))?;
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())??;

    log_info(
        "background.image.saved",
        "Background image saved",
        json!({ "path": target.display().to_string() }),
    );
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
async fn clear_background_image(app: tauri::AppHandle) -> Result<(), String> {
    let dir = background_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        purge_background_files(&dir);
    })
    .await
    .map_err(|error| error.to_string())?;
    log_info("background.image.cleared", "Background image cleared", Value::Null);
    Ok(())
}

#[tauri::command]
async fn get_config() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run_audio_cli(&["config"]))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn set_config(key: String, value: String) -> Result<String, String> {
    log_info(
        "config.set.start",
        "Updating app configuration",
        json!({ "key": &key, "value": &value }),
    );
    let log_key = key.clone();
    let result = tauri::async_runtime::spawn_blocking(move || run_audio_cli(&["set-config", &key, &value]))
        .await
        .map_err(|error| error.to_string())?;
    match &result {
        Ok(_) => log_info("config.set.complete", "App configuration updated", json!({ "key": log_key })),
        Err(error) => log_error("config.set.error", "App configuration update failed", json!({ "key": log_key, "error": error })),
    }
    result
}

#[tauri::command]
async fn warmup_clip_server(app: tauri::AppHandle) -> Result<(), String> {
    log_info("clip.server.warmup.start", "Starting clip server warmup", Value::Null);
    let mutex: &AsyncMutex<Option<AsyncChild>> = CLIP_SERVER.get_or_init(|| AsyncMutex::new(None));
    let mut guard = mutex.lock().await;

    if let Some(child) = guard.as_mut() {
        if child.try_wait().map(|status| status.is_none()).unwrap_or(false) {
            // Still running
            log_info("clip.server.warmup.skip", "Clip server is already running", Value::Null);
            let _ = app.emit("clip-server-event", serde_json::json!({"type": "ready"}));
            return Ok(());
        }
        // Process died, clear it
        log_warn("clip.server.dead", "Clip server process had exited before warmup", Value::Null);
        *guard = None;
    }

    let root = app_root()?;
    let mut command = AsyncCommand::new(python_exe(&root));
    command
        .arg("-I")
        .arg(clip_cli_path(&root))
        .arg("--server")
        .current_dir(&root)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        command.creation_flags(0x0800_0000);
    }

    let mut child = command.spawn().map_err(|e| {
        log_error(
            "clip.server.spawn.error",
            "Failed to spawn clip server",
            json!({ "error": e.to_string() }),
        );
        format!("Failed to spawn clip server: {e}")
    })?;
    let stdout = child.stdout.take().ok_or("Failed to take stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to take stderr")?;

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = AsyncBufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let line: &str = line.trim();
            if line.is_empty() {
                continue;
            }
            if line == "READY" {
                log_info("clip.server.ready", "Clip server reported ready", Value::Null);
                let _ = app_handle.emit("clip-server-event", serde_json::json!({"type": "ready"}));
                continue;
            }
            if let Ok(value) = serde_json::from_str::<Value>(line) {
                let is_progress = value.get("type").and_then(Value::as_str) == Some("progress");
                if matches!(value.get("type").and_then(Value::as_str), Some("log") | Some("error") | Some("done")) {
                    let level = if value.get("type").and_then(Value::as_str) == Some("error") {
                        "error"
                    } else {
                        "info"
                    };
                    append_app_log(level, "clip.server.event", "Clip server emitted event", value.clone());
                }
                let _ = app_handle.emit("clip-server-event", &value);
                // Also emit to clip-progress for backward compatibility if it's a progress event
                if is_progress {
                    let _ = app_handle.emit("clip-progress", &value);
                }
            }
        }
    });

    let app_handle_err = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = AsyncBufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            log_warn(
                "clip.server.stderr",
                "Clip server stderr",
                json!({ "line": &line }),
            );
            let _ = app_handle_err.emit("clip-server-event", serde_json::json!({"type": "log", "message": line}));
        }
    });

    *guard = Some(child);
    log_info("clip.server.spawn.complete", "Clip server spawned", Value::Null);
    Ok(())
}

#[tauri::command]
async fn clip_extract(window: tauri::Window, input_path: String, mode: String) -> Result<String, String> {
    if mode != "cpu" && mode != "gpu" {
        return Err("Clip extraction mode must be cpu or gpu".to_string());
    }
    log_info(
        "clip.extract.start",
        "Starting clip extraction",
        json!({ "input": &input_path, "mode": &mode }),
    );

    let input_path_buf = PathBuf::from(&input_path);
    if !input_path_buf.is_file() {
        return Err(format!("Clip source does not exist or is not a file: {input_path}"));
    }
    let source_path = input_path_buf.to_string_lossy().to_string();
    log_info(
        "clip.extract.source.ready",
        "Clip extraction source is ready",
        json!({ "input": &source_path }),
    );

    // Try to use persistent server first
    let server_mutex: &AsyncMutex<Option<AsyncChild>> = CLIP_SERVER.get_or_init(|| AsyncMutex::new(None));
    let mut guard = server_mutex.lock().await;
    
    if let Some(child) = guard.as_mut() {
        if let Some(stdin) = child.stdin.as_mut() {
            let command = serde_json::json!({
                "command": "extract",
                "input_file": source_path,
                "mode": mode,
                "threshold": 0.5,
                "cpu_threshold": 27.0,
                "min_clip_seconds": 0.35,
                "batch_frames": 100,
                "overlap": 50
            });
            
            let mut payload = serde_json::to_string(&command).map_err(|e| e.to_string())?;
            payload.push('\n');
            
            if stdin.write_all(payload.as_bytes()).await.is_ok() && stdin.flush().await.is_ok() {
                // Now we need to wait for the "done" or "error" event from this server.
                // Since the server emits events via `clip-server-event`, the frontend
                // should already be listening. However, the `invoke` expects a return value.
                // The existing `run_streaming_clip_cli` waits for the process to finish.
                // Here, the process keeps running.
                
                // We'll return a special status indicating it's handled by the server.
                // Or better, we can wait for the response here if we can correlate them.
                // But the current protocol doesn't have request IDs.
                
                // For now, let's keep it simple: return "SERVER_TASK_STARTED".
                // The frontend will handle the "done" event.
                log_info(
                    "clip.extract.server.start",
                    "Clip extraction dispatched to persistent server",
                    json!({ "input": &source_path, "mode": &mode }),
                );
                return Ok(serde_json::json!({"type": "server_task_started"}).to_string());
            }
        }
        // If stdin failed, server might be dead
        log_warn(
            "clip.extract.server.unavailable",
            "Clip server stdin was unavailable; falling back to one-shot extraction",
            Value::Null,
        );
        *guard = None;
    }

    // Fallback to one-shot
    let log_input_path = source_path.clone();
    let log_mode = mode.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_streaming_clip_cli(
            window,
            vec![
                "extract".to_string(),
                source_path,
                "--mode".to_string(),
                mode,
            ],
        )
    })
    .await
    .map_err(|error| error.to_string())?;
    match &result {
        Ok(payload) => log_info(
            "clip.extract.complete",
            "Clip extraction completed",
            json!({ "input": log_input_path, "mode": log_mode, "result": payload }),
        ),
        Err(error) => log_error(
            "clip.extract.error",
            "Clip extraction failed",
            json!({ "input": log_input_path, "mode": log_mode, "error": error }),
        ),
    }
    result
}

fn run_streaming_audio_cli(
    window: tauri::Window,
    args: Vec<String>,
    progress_event: &str,
) -> Result<String, String> {
    let root = app_root()?;
    log_info(
        "audio.streaming_bridge.start",
        "Starting streaming audio bridge",
        json!({ "args": &args, "progressEvent": progress_event }),
    );
    let mut child = cmd(python_exe(&root))
        .arg("-I")
        .arg(audio_cli_path(&root))
        .args(&args)
        .env("ULTIMATE_AMV_STATE_DIR", app_state_dir())
        .current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            log_error(
                "audio.streaming_bridge.spawn.error",
                "Could not start streaming audio bridge",
                json!({ "args": &args, "error": error.to_string() }),
            );
            format!("Could not start Python audio bridge: {error}")
        })?;
    store_child_pid(&AUDIO_CHILD_PID, child.id());

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not read audio extraction output".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Could not read audio extraction error stream".to_string())?;

    // Drain stderr on a separate thread so audio-separator's tqdm output cannot
    // fill the OS pipe buffer and stall the Python process. We keep only the
    // tail so a verbose log doesn't blow up memory.
    let stderr_handle = thread::spawn(move || -> String {
        const MAX_TAIL: usize = 16 * 1024;
        let mut tail = String::new();
        for line in BufReader::new(stderr).lines() {
            let Ok(line) = line else { break };
            tail.push_str(&line);
            tail.push('\n');
            if tail.len() > MAX_TAIL {
                let cut = tail.len() - MAX_TAIL;
                tail.drain(..cut);
            }
        }
        tail
    });

    let mut final_payload: Option<String> = None;
    for line in BufReader::new(stdout).lines() {
        let line = line.map_err(|error| error.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(&line) {
            match value.get("type").and_then(Value::as_str) {
                Some("progress") | Some("setup-progress") => {
                    let _ = window.emit(progress_event, value);
                }
                Some("done") | Some("error") | Some("setup-done") | Some("setup-error") => {
                    final_payload = Some(line);
                }
                _ => {}
            }
        }
    }

    let wait_result = child.wait();
    clear_child_pid(&AUDIO_CHILD_PID);
    let status = wait_result.map_err(|error| error.to_string())?;
    let stderr_tail = stderr_handle.join().unwrap_or_default();

    if status.success() {
        let result = final_payload.ok_or_else(|| {
            let tail = stderr_tail.trim();
            if tail.is_empty() {
                "Audio extraction finished without a result".to_string()
            } else {
                format!("Audio extraction finished without a result. {tail}")
            }
        });
        match &result {
            Ok(payload) => log_info(
                "audio.streaming_bridge.complete",
                "Streaming audio bridge completed",
                json!({ "args": &args, "result": payload }),
            ),
            Err(error) => log_error(
                "audio.streaming_bridge.error",
                "Streaming audio bridge finished without a result",
                json!({ "args": &args, "error": error, "stderr": truncate_log_text(stderr_tail.trim()) }),
            ),
        }
        result
    } else {
        let error = final_payload.unwrap_or_else(|| {
            let tail = stderr_tail.trim();
            if tail.is_empty() {
                format!(
                    "Python process exited with code {}",
                    status.code().unwrap_or(-1)
                )
            } else {
                tail.to_string()
            }
        });
        log_error(
            "audio.streaming_bridge.error",
            "Streaming audio bridge process failed",
            json!({
                "args": &args,
                "code": status.code(),
                "error": &error,
                "stderr": truncate_log_text(stderr_tail.trim()),
            }),
        );
        Err(error)
    }
}

fn run_streaming_clip_cli(window: tauri::Window, args: Vec<String>) -> Result<String, String> {
    let root = app_root()?;
    log_info(
        "clip.bridge.start",
        "Starting one-shot clip bridge",
        json!({ "args": &args }),
    );
    let mut child = cmd(python_exe(&root))
        .arg("-I")
        .arg(clip_cli_path(&root))
        .args(&args)
        .current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            log_error(
                "clip.bridge.spawn.error",
                "Could not start one-shot clip bridge",
                json!({ "args": &args, "error": error.to_string() }),
            );
            format!("Could not start Python clip bridge: {error}")
        })?;
    store_child_pid(&CLIP_CHILD_PID, child.id());

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not read clip extraction output".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Could not read clip extraction error stream".to_string())?;

    let stderr_handle = thread::spawn(move || -> String {
        const MAX_TAIL: usize = 16 * 1024;
        let mut tail = String::new();
        for line in BufReader::new(stderr).lines() {
            let Ok(line) = line else { break };
            tail.push_str(&line);
            tail.push('\n');
            if tail.len() > MAX_TAIL {
                let cut = tail.len() - MAX_TAIL;
                tail.drain(..cut);
            }
        }
        tail
    });

    let mut final_payload: Option<String> = None;
    for line in BufReader::new(stdout).lines() {
        let line = line.map_err(|error| error.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(&line) {
            match value.get("type").and_then(Value::as_str) {
                Some("progress") => {
                    let _ = window.emit("clip-progress", value);
                }
                Some("done") | Some("error") => {
                    final_payload = Some(line);
                }
                _ => {}
            }
        }
    }

    let wait_result = child.wait();
    clear_child_pid(&CLIP_CHILD_PID);
    let status = wait_result.map_err(|error| error.to_string())?;
    let stderr_tail = stderr_handle.join().unwrap_or_default();

    if status.success() {
        let result = final_payload.ok_or_else(|| {
            let tail = stderr_tail.trim();
            if tail.is_empty() {
                "Clip extraction finished without a result".to_string()
            } else {
                format!("Clip extraction finished without a result. {tail}")
            }
        });
        match &result {
            Ok(payload) => log_info(
                "clip.bridge.complete",
                "One-shot clip bridge completed",
                json!({ "args": &args, "result": payload }),
            ),
            Err(error) => log_error(
                "clip.bridge.error",
                "One-shot clip bridge finished without a result",
                json!({ "args": &args, "error": error, "stderr": truncate_log_text(stderr_tail.trim()) }),
            ),
        }
        result
    } else {
        let error = final_payload.unwrap_or_else(|| {
            let tail = stderr_tail.trim();
            if tail.is_empty() {
                format!(
                    "Python clip process exited with code {}",
                    status.code().unwrap_or(-1)
                )
            } else {
                tail.to_string()
            }
        });
        log_error(
            "clip.bridge.error",
            "One-shot clip bridge process failed",
            json!({
                "args": &args,
                "code": status.code(),
                "error": &error,
                "stderr": truncate_log_text(stderr_tail.trim()),
            }),
        );
        Err(error)
    }
}

#[tauri::command]
fn cancel_audio() {
    log_warn("audio.cancel", "Cancelling active audio process", Value::Null);
    kill_child_pid(&AUDIO_CHILD_PID);
}

#[tauri::command]
fn cancel_clip() {
    log_warn("clip.cancel", "Cancelling active clip process", Value::Null);
    kill_child_pid(&CLIP_CHILD_PID);
}

#[tauri::command]
fn cancel_download() {
    log_warn("download.cancel", "Cancelling active episode download", Value::Null);
    kill_child_pid(&DOWNLOAD_CHILD_PID);
}

#[tauri::command]
fn cancel_video() {
    log_warn("video.cancel", "Cancelling active video transcode", Value::Null);
    kill_child_pid(&VIDEO_CHILD_PID);
}

#[tauri::command]
fn open_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    log_info("shell.open_path.start", "Opening path in shell", json!({ "path": &path }));
    let result = app.opener().open_path(path.clone(), None::<String>).map_err(|e| e.to_string());
    match &result {
        Ok(_) => log_info("shell.open_path.complete", "Path opened in shell", json!({ "path": path })),
        Err(error) => log_error("shell.open_path.error", "Could not open path in shell", json!({ "path": path, "error": error })),
    }
    result
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    reset_app_logs();
    log_info("app.start", "Ultimate AMV app starting", Value::Null);
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .on_window_event(|_window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                log_info("app.close", "Application close requested", Value::Null);
                kill_child_pid(&AUDIO_CHILD_PID);
                kill_child_pid(&CLIP_CHILD_PID);
                kill_child_pid(&DOWNLOAD_CHILD_PID);
                kill_child_pid(&VIDEO_CHILD_PID);

                // Kill persistent server
                if let Some(mutex) = CLIP_SERVER.get() {
                    let mut guard = mutex.blocking_lock();
                    if let Some(child) = guard.as_mut() {
                        log_info("clip.server.kill", "Stopping clip server during app close", Value::Null);
                        let _ = child.start_kill();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            audio_status,
            audio_history,
            app_logs,
            clear_app_logs,
            clear_app_cache,
            frontend_log,
            audio_extract,
            audio_setup_plan,
            audio_setup,
            media_to_audio,
            video_transcode,
            clip_export,
            clip_export_merged,
            video_gpu_status,
            video_source_codec,
            clip_preview_generate,
            clip_preview_generate_batch,
            get_config,
            set_config,
            save_background_image,
            clear_background_image,
            clip_extract,
            warmup_clip_server,
            install_media_sniffer,
            download_stream,
            download_media,
            download_history,
            inspect_stream,
            inspect_download_formats,
            cancel_audio,
            cancel_clip,
            cancel_download,
            cancel_video,
            open_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anikai_identity_request_recognizes_known_paths() {
        assert!(is_anikai_identity_request("https://aniwaves.ru/ajax/episode/list/123"));
        assert!(is_anikai_identity_request("https://anikai.to/api/source/abc"));
        assert!(is_anikai_identity_request("https://anikai.to/embed/iframe?id=42"));
        assert!(!is_anikai_identity_request("https://aniwaves.ru/static/main.js"));
        assert!(!is_anikai_identity_request("https://other-host.com/ajax/episode/1"));
    }

    #[test]
    fn anikai_watch_document_url_only_matches_html_pages() {
        assert!(is_anikai_watch_document_url("https://aniwaves.ru/watch/some-anime-123"));
        assert!(is_anikai_watch_document_url("https://anikai.to/watch/foo-9"));
        assert!(!is_anikai_watch_document_url("https://aniwaves.ru/watch/foo.m3u8"));
        assert!(!is_anikai_watch_document_url("https://aniwaves.ru/browse"));
    }

    #[test]
    fn parse_anikai_identity_payload_extracts_episode_from_object() {
        let payload = r#"{"data":{"episode":"7","anime_title":"Bleach"}}"#;
        let identity = parse_anikai_identity_payload(payload, "https://aniwaves.ru/ajax/list/abc")
            .expect("payload should parse");
        assert_eq!(identity.episode_number.as_deref(), Some("7"));
        assert_eq!(identity.episode_label.as_deref(), Some("Episode 7"));
        assert_eq!(identity.anime_title.as_deref(), Some("Bleach"));
    }

    #[test]
    fn parse_anikai_identity_payload_falls_back_to_url_episode() {
        let payload = r#"{"servers":[{"name":"vidstreaming"}]}"#;
        let identity = parse_anikai_identity_payload(
            payload,
            "https://anikai.to/ajax/episode/servers?ep=12",
        )
        .expect("URL fallback should yield identity");
        assert_eq!(identity.episode_number.as_deref(), Some("12"));
    }

    #[test]
    fn parse_anikai_sync_data_keeps_title_only() {
        let html = r#"<html><script id="syncData" type="application/json">{"name":"Bleach: TYBW","series_url":"/anime/bleach"}</script></html>"#;
        let identity = parse_anikai_sync_data(html, "https://aniwaves.ru/watch/bleach-tybw-1")
            .expect("syncData should parse");
        assert_eq!(identity.anime_title.as_deref(), Some("Bleach: TYBW"));
        assert!(identity.episode_number.is_none(), "syncData episode is intentionally ignored");
    }

    #[test]
    fn format_spec_audio_only_classification() {
        assert!(format_spec_is_audio_only("bestaudio"));
        assert!(format_spec_is_audio_only("bestaudio[ext=m4a]"));
        assert!(format_spec_is_audio_only("bestaudio/audio_only"));
        assert!(!format_spec_is_audio_only("bestvideo*+bestaudio/best"));
        assert!(!format_spec_is_audio_only("137+bestaudio/best"));
        assert!(!format_spec_is_audio_only("18"));
        assert!(!format_spec_is_audio_only(""));
    }
}
