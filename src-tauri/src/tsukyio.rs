// Tsukyio Vault integration.
//
// Tsukyio (https://tsukyio.com) is an external, curated anime-clip asset vault.
// This module is the Rust side of the "Tsukyio Vault" panel: it proxies the
// vault's JSON API through reqwest (so the WebView never has to make
// cross-origin calls for data), and streams downloads to disk while emitting
// progress events the frontend can render.
//
// Auth is a per-user Bearer key (`tsk_...`) stored in the Python config under
// `tsukyio_api_key`. The key is never hardcoded here.
//
// Media playback/preview is NOT loaded directly from the remote stream URL:
// WebView2 refuses to play the cross-origin `https://tsukyio.com/api/stream`
// Range response (no `Access-Control-Allow-Origin`, app origin is
// `tauri.localhost`), failing with MEDIA_ERR_SRC_NOT_SUPPORTED even though the
// media itself is standard decodable H.264 mp4. Instead we register a custom
// `tsukyio://` URI scheme protocol (served from `http://tsukyio.localhost` on
// Windows) that proxies the upstream stream from the Rust side: it adds the
// Bearer auth server-side, forwards the incoming `Range` header upstream, and
// relays the 206/200 + Content-Range/Content-Type/Content-Length back to the
// webview. This keeps the API key out of the DOM (it lives in managed state,
// pushed via `tsukyio_set_session_key`) and lets `<video>`/`<audio>` seek.

use std::{
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Instant,
};

use futures_util::StreamExt;
use serde_json::{json, Value};
use tauri::{Emitter, Manager, UriSchemeContext, UriSchemeResponder, Window, Wry};

use crate::{log_error, log_info, log_warn, sanitize_path_segment};

const TSUKYIO_BASE: &str = "https://tsukyio.com/api";
const USER_AGENT: &str = "UltimateAMV-Tsukyio/1.0";

/// Custom URI scheme the preview media loads from. On Windows the webview maps
/// `tsukyio://stream/<id>` to `http://tsukyio.localhost/stream/<id>`; the CSP
/// `media-src` must allow both forms.
pub(crate) const TSUKYIO_PROTOCOL: &str = "tsukyio";

/// Upper bound on the body size returned for a single proxied Range request.
/// The async URI-scheme responder hands back a fully-buffered `Vec<u8>` (it is
/// not a true stream), so an open-ended `Range: bytes=0-` must be capped to keep
/// memory bounded for large raw files. The media element will issue follow-up
/// ranges as it plays/seeks. 4 MiB is a comfortable streaming chunk.
const PROXY_CHUNK_CAP: u64 = 4 * 1024 * 1024;

/// Hard ceiling for the rare degraded path where upstream answers `200` with no
/// `Content-Range` (no range support). In that case we cannot cap the body
/// without silently truncating the file (which breaks playback/seeking), so we
/// must buffer the whole thing — but refuse outright if upstream advertises a
/// `Content-Length` larger than this so a pathological body can't OOM us.
const PROXY_MAX_FULL_BODY: u64 = 256 * 1024 * 1024;

/// Holds the current Tsukyio Bearer key for the proxy protocol handler. The
/// frontend pushes the key here via `tsukyio_set_session_key` whenever it loads
/// the config / on the config-changed event, so the streaming handler never has
/// to shell out to the Python config CLI (too slow for per-Range requests) and
/// the key never appears in any URL the DOM can see.
#[derive(Default)]
pub(crate) struct TsukyioSession {
    key: Mutex<Option<String>>,
}

impl TsukyioSession {
    fn get(&self) -> Option<String> {
        self.key
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
            .map(|k| k.trim().to_string())
            .filter(|k| !k.is_empty())
    }

    fn set(&self, key: Option<String>) {
        if let Ok(mut guard) = self.key.lock() {
            *guard = key
                .map(|k| k.trim().to_string())
                .filter(|k| !k.is_empty());
        }
    }
}

/// Pushes the current Bearer key into managed session state so the `tsukyio://`
/// proxy can authenticate stream requests without the key ever touching the DOM.
/// Called by the panel whenever it reads the config / on the config-changed
/// event. An empty/whitespace key clears the stored key (so a removed key makes
/// the proxy reply 401 rather than serving stale media).
#[tauri::command]
pub(crate) fn tsukyio_set_session_key(
    state: tauri::State<'_, TsukyioSession>,
    key: Option<String>,
) {
    state.set(key);
}

/// Builds a reqwest client carrying the user's Bearer key. Mirrors the
/// construction style used in tools.rs / downloads.rs (a fresh client per
/// call is fine — these are infrequent, user-driven requests).
fn build_client(api_key: &str) -> Result<reqwest::Client, String> {
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        return Err("No Tsukyio API key set. Add your key in Settings.".to_string());
    }
    let mut headers = reqwest::header::HeaderMap::new();
    let bearer = format!("Bearer {trimmed}");
    let value = reqwest::header::HeaderValue::from_str(&bearer)
        .map_err(|_| "The Tsukyio API key contains invalid characters.".to_string())?;
    headers.insert(reqwest::header::AUTHORIZATION, value);
    headers.insert(
        reqwest::header::ACCEPT,
        reqwest::header::HeaderValue::from_static("application/json"),
    );
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .default_headers(headers)
        .build()
        .map_err(|error| format!("Could not build Tsukyio HTTP client: {error}"))
}

/// Maps an HTTP status to a friendly error. 401/403 → bad key, 429 → rate
/// limit (carrying retryAfter when the body has it), everything else → generic.
fn status_error(status: reqwest::StatusCode, body: &str) -> String {
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return "Tsukyio rejected the API key (HTTP 401/403). Check your key in Settings."
            .to_string();
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let retry = serde_json::from_str::<Value>(body)
            .ok()
            .and_then(|v| v.get("retryAfter").and_then(Value::as_u64));
        return match retry {
            Some(seconds) => format!("Tsukyio rate limit hit. Try again in {seconds}s."),
            None => "Tsukyio rate limit hit (HTTP 429). Wait a moment and try again.".to_string(),
        };
    }
    let snippet: String = body.chars().take(200).collect();
    if snippet.trim().is_empty() {
        format!("Tsukyio request failed: HTTP {status}")
    } else {
        format!("Tsukyio request failed: HTTP {status} — {snippet}")
    }
}

/// Performs an authenticated GET against a full Tsukyio URL and returns the
/// parsed JSON body. The vault always replies `{ "success": bool, "data": ... }`,
/// so callers get the whole object back and read `.data` on the frontend.
async fn get_json(api_key: &str, url: &str) -> Result<Value, String> {
    let client = build_client(api_key)?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("Could not reach Tsukyio: {error}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("Could not read Tsukyio response: {error}"))?;
    if !status.is_success() {
        return Err(status_error(status, &text));
    }
    serde_json::from_str::<Value>(&text)
        .map_err(|error| format!("Could not parse Tsukyio response: {error}"))
}

#[tauri::command]
pub(crate) async fn tsukyio_test_connection(api_key: String) -> Result<Value, String> {
    log_info("tsukyio.test.start", "Testing Tsukyio connection", Value::Null);
    let url = format!("{TSUKYIO_BASE}/stats/global");
    let result = get_json(&api_key, &url).await;
    match &result {
        Ok(_) => log_info("tsukyio.test.complete", "Tsukyio connection OK", Value::Null),
        Err(error) => log_warn(
            "tsukyio.test.error",
            "Tsukyio connection failed",
            json!({ "error": error }),
        ),
    }
    result
}

#[tauri::command]
pub(crate) async fn tsukyio_browse(
    api_key: String,
    category: Option<String>,
    path: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Value, String> {
    let limit = limit.unwrap_or(24);
    let offset = offset.unwrap_or(0);
    let client = build_client(&api_key)?;
    // Use reqwest's query builder so values are percent-encoded correctly
    // (relPaths carry spaces and slashes).
    let mut query: Vec<(&str, String)> = vec![
        ("limit", limit.to_string()),
        ("offset", offset.to_string()),
        ("includeDownloads", "true".to_string()),
    ];
    if let Some(cat) = category.as_deref().filter(|c| !c.trim().is_empty() && *c != "all") {
        query.push(("category", cat.to_string()));
    }
    if let Some(rel) = path.as_deref().filter(|p| !p.trim().is_empty()) {
        query.push(("path", rel.to_string()));
    }
    log_info(
        "tsukyio.browse.start",
        "Browsing Tsukyio vault",
        json!({ "category": &category, "path": &path, "limit": limit, "offset": offset }),
    );
    let response = client
        .get(format!("{TSUKYIO_BASE}/vault/all"))
        .query(&query)
        .send()
        .await
        .map_err(|error| format!("Could not reach Tsukyio: {error}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("Could not read Tsukyio response: {error}"))?;
    if !status.is_success() {
        return Err(status_error(status, &text));
    }
    serde_json::from_str::<Value>(&text)
        .map_err(|error| format!("Could not parse Tsukyio response: {error}"))
}

#[tauri::command]
pub(crate) async fn tsukyio_search(
    api_key: String,
    q: String,
    category: Option<String>,
) -> Result<Value, String> {
    let client = build_client(&api_key)?;
    let mut query: Vec<(&str, String)> = vec![("q", q.clone())];
    if let Some(cat) = category.as_deref().filter(|c| !c.trim().is_empty() && *c != "all") {
        query.push(("category", cat.to_string()));
    }
    log_info(
        "tsukyio.search.start",
        "Searching Tsukyio folders",
        json!({ "q": &q, "category": &category }),
    );
    let response = client
        .get(format!("{TSUKYIO_BASE}/vault/search"))
        .query(&query)
        .send()
        .await
        .map_err(|error| format!("Could not reach Tsukyio: {error}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("Could not read Tsukyio response: {error}"))?;
    if !status.is_success() {
        return Err(status_error(status, &text));
    }
    serde_json::from_str::<Value>(&text)
        .map_err(|error| format!("Could not parse Tsukyio response: {error}"))
}

#[tauri::command]
pub(crate) async fn tsukyio_deep_search(api_key: String, q: String) -> Result<Value, String> {
    let client = build_client(&api_key)?;
    log_info(
        "tsukyio.deep_search.start",
        "Deep-searching Tsukyio clips",
        json!({ "q": &q }),
    );
    let response = client
        .get(format!("{TSUKYIO_BASE}/vault/deep-search"))
        .query(&[("q", q.as_str())])
        .send()
        .await
        .map_err(|error| format!("Could not reach Tsukyio: {error}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("Could not read Tsukyio response: {error}"))?;
    if !status.is_success() {
        return Err(status_error(status, &text));
    }
    serde_json::from_str::<Value>(&text)
        .map_err(|error| format!("Could not parse Tsukyio response: {error}"))
}

/// Picks a sensible file extension for a downloaded asset. The vault encodes
/// the real extension in the item's `path`/`name`; default to .mp4 (video) so
/// the file is at least openable when no extension is present.
fn extension_for(name: &str, path_hint: &str) -> String {
    for source in [path_hint, name] {
        if let Some(ext) = Path::new(source).extension().and_then(|e| e.to_str()) {
            let ext = ext.trim().to_ascii_lowercase();
            if !ext.is_empty() && ext.len() <= 5 && ext.chars().all(|c| c.is_ascii_alphanumeric()) {
                return ext;
            }
        }
    }
    "mp4".to_string()
}

fn emit_progress(window: &Window, payload: Value) {
    let _ = window.emit("tsukyio-download-progress", payload);
}

/// Streams `GET /vault/download/{id}` (a plain authenticated GET) to disk under
/// `{dest}/tsukyio-vault/<Category>/<name>.<ext>`, emitting progress events.
/// Returns the saved file path on success.
#[tauri::command]
pub(crate) async fn tsukyio_download(
    window: Window,
    api_key: String,
    asset_id: String,
    name: String,
    category: Option<String>,
    path_hint: Option<String>,
    dest_dir: Option<String>,
) -> Result<String, String> {
    let client = build_client(&api_key)?;

    let base = resolve_vault_root(dest_dir.as_deref());
    let category_folder = category
        .as_deref()
        .map(|c| sanitize_path_segment(c, "vault", 48))
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| "vault".to_string());
    let output_dir = base.join("tsukyio-vault").join(&category_folder);
    fs::create_dir_all(&output_dir)
        .map_err(|error| format!("Could not create download folder: {error}"))?;

    let ext = extension_for(&name, path_hint.as_deref().unwrap_or(""));
    let stem = sanitize_path_segment(&name, &asset_id, 120);
    // Pick a non-colliding final path: two different assets can share the same
    // display name, and `File::create` truncates, so a naive `{stem}.{ext}`
    // would silently overwrite an existing different file.
    let dest = unique_dest(&output_dir, &stem, &ext);
    // Stream to a per-asset temp file keyed by the unique asset id (so two
    // concurrent downloads of same-named assets can't write to one shared temp)
    // and only rename to the final name once the full body is written, so a
    // crash mid-download never leaves a partial file under the real name.
    let temp = output_dir.join(format!("{stem}.{asset_id}.{ext}.part"));

    log_info(
        "tsukyio.download.start",
        "Starting Tsukyio download",
        json!({ "assetId": &asset_id, "dest": dest.display().to_string() }),
    );

    let url = format!("{TSUKYIO_BASE}/vault/download/{asset_id}");
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|error| format!("Could not start Tsukyio download: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let error = status_error(status, &body);
        log_error(
            "tsukyio.download.error",
            "Tsukyio download failed",
            json!({ "assetId": &asset_id, "error": &error }),
        );
        return Err(error);
    }

    let total = response.content_length();
    let mut file = File::create(&temp)
        .map_err(|error| format!("Could not create download file: {error}"))?;
    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_emit = Instant::now();

    emit_progress(
        &window,
        json!({
            "type": "start",
            "assetId": &asset_id,
            "totalBytes": total,
        }),
    );

    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(error) => {
                drop(file);
                let _ = fs::remove_file(&temp);
                let message = format!("Tsukyio download failed mid-stream: {error}");
                emit_progress(
                    &window,
                    json!({ "type": "error", "assetId": &asset_id, "message": &message }),
                );
                return Err(message);
            }
        };
        if let Err(error) = file.write_all(&chunk) {
            drop(file);
            let _ = fs::remove_file(&temp);
            let message = format!("Could not write download chunk: {error}");
            emit_progress(
                &window,
                json!({ "type": "error", "assetId": &asset_id, "message": &message }),
            );
            return Err(message);
        }
        downloaded += chunk.len() as u64;

        if last_emit.elapsed().as_millis() >= 100 {
            last_emit = Instant::now();
            emit_progress(
                &window,
                json!({
                    "type": "progress",
                    "assetId": &asset_id,
                    "downloadedBytes": downloaded,
                    "totalBytes": total,
                }),
            );
        }
    }

    file.flush().ok();
    drop(file);

    // Re-resolve the final name: a concurrent download of a same-named asset may
    // have claimed `dest` while we were streaming, so pick a fresh free name
    // before promoting the temp rather than clobbering it.
    let dest = if dest.exists() {
        unique_dest(&output_dir, &stem, &ext)
    } else {
        dest
    };

    // Atomically promote the completed temp file to its final name. On the rare
    // rename failure, drop the temp so we don't leave a stray `.part` behind.
    if let Err(error) = fs::rename(&temp, &dest) {
        let _ = fs::remove_file(&temp);
        let message = format!("Could not finalize download: {error}");
        emit_progress(
            &window,
            json!({ "type": "error", "assetId": &asset_id, "message": &message }),
        );
        return Err(message);
    }

    let saved = dest.display().to_string();
    log_info(
        "tsukyio.download.complete",
        "Tsukyio download completed",
        json!({ "assetId": &asset_id, "savedFile": &saved, "bytes": downloaded }),
    );
    emit_progress(
        &window,
        json!({
            "type": "done",
            "assetId": &asset_id,
            "path": &saved,
            "downloadedBytes": downloaded,
        }),
    );
    Ok(saved)
}

/// Builds a destination path under `dir` that does not collide with an existing
/// file. Tries `{stem}.{ext}` first, then `{stem} (1).{ext}`, `{stem} (2).{ext}`,
/// … until a free name is found. This keeps clean filenames while guaranteeing
/// a distinct-named asset never overwrites a different file already on disk.
fn unique_dest(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let first = dir.join(format!("{stem}.{ext}"));
    if !first.exists() {
        return first;
    }
    let mut n: u32 = 1;
    loop {
        let candidate = dir.join(format!("{stem} ({n}).{ext}"));
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}

/// Mirrors downloads.rs `resolve_download_root`: honor a caller-provided dir,
/// else fall back to the user's Videos\Ultimate AMV folder.
fn resolve_vault_root(dest_dir: Option<&str>) -> PathBuf {
    if let Some(dir) = dest_dir.filter(|s| !s.trim().is_empty()) {
        return PathBuf::from(dir);
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        return PathBuf::from(profile).join("Videos").join("Ultimate AMV");
    }
    PathBuf::from("Ultimate AMV")
}

// ---- Streaming proxy protocol (`tsukyio://stream/<assetId>`) ----------------

/// A bounded byte range to request upstream, derived from the incoming webview
/// `Range` header. `start` is inclusive; `end` is inclusive when `Some`.
struct RangeSpec {
    start: u64,
    end: Option<u64>,
}

/// Parses an HTTP `Range` header value of the form `bytes=<start>-<end>` (end
/// optional). Returns `None` for absent/unsupported/multi-range headers — the
/// caller then treats the request as an open-ended `bytes=0-`. Only the first
/// range of a (rare) multi-range request is honored; suffix ranges
/// (`bytes=-N`) are not used by `<video>` for normal playback so we ignore them
/// and fall back to `0-`.
fn parse_range_header(raw: Option<&str>) -> Option<RangeSpec> {
    let value = raw?.trim();
    let spec = value.strip_prefix("bytes=")?;
    // Take only the first range if a comma-separated list is sent.
    let first = spec.split(',').next()?.trim();
    let (start_str, end_str) = first.split_once('-')?;
    let start_str = start_str.trim();
    let end_str = end_str.trim();
    // Suffix range `bytes=-N` (empty start): fall back to open-ended.
    if start_str.is_empty() {
        return None;
    }
    let start: u64 = start_str.parse().ok()?;
    let end: Option<u64> = if end_str.is_empty() {
        None
    } else {
        Some(end_str.parse().ok()?)
    };
    // Reject inverted ranges.
    if let Some(e) = end {
        if e < start {
            return None;
        }
    }
    Some(RangeSpec { start, end })
}

/// Extracts the authoritative TOTAL size from an upstream `Content-Range`
/// response header of the form `bytes <start>-<end>/<total>` (or
/// `bytes */<total>`). Returns the value after the last `/`, or `None` when the
/// total is `*` (unknown) or the header is malformed. The served start/end are
/// deliberately ignored — only the total is trusted (upstream's echoed end can
/// exceed the file size for out-of-bounds requests).
fn parse_content_range_total(value: &str) -> Option<u64> {
    let total = value.trim().rsplit('/').next()?.trim();
    if total.is_empty() || total == "*" {
        return None;
    }
    total.parse().ok()
}

/// Extracts the asset id from the request URI. The webview can present this as
/// `tsukyio://stream/<id>` (here `stream` is the authority and `<id>` the path),
/// `tsukyio://localhost/stream/<id>`, or `http://tsukyio.localhost/stream/<id>`
/// (here `stream` is a path segment). Returns the percent-decoded id, or `None`
/// if no `stream` marker with a following id segment is present.
fn asset_id_from_uri(uri: &str) -> Option<String> {
    // Drop scheme and any query/fragment, then split on '/'. This yields the
    // authority + path segments uniformly regardless of where `stream` sits.
    let after_scheme = uri.splitn(2, "://").nth(1).unwrap_or(uri);
    let no_query = after_scheme
        .split(['?', '#'])
        .next()
        .unwrap_or(after_scheme);
    // Find the `stream` marker among the segments and take the segment after it.
    let mut segments = no_query.split('/').filter(|s| !s.is_empty());
    let mut id: Option<&str> = None;
    while let Some(seg) = segments.next() {
        if seg == "stream" {
            id = segments.next();
            break;
        }
    }
    let segment = id?;
    if segment.is_empty() {
        return None;
    }
    // Percent-decode the id (asset ids are normally plain, but be safe).
    Some(percent_decode(segment))
}

/// Minimal percent-decoder for a single path segment (we only need to undo the
/// encoding the webview applies to the id). Invalid escapes are passed through.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Builds a small error `http::Response` (no body) with the given status so the
/// `<video>`/`<audio>` `onerror` handler fires and the modal surfaces it.
fn proxy_error(status: u16) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header(tauri::http::header::CONTENT_TYPE, "text/plain")
        .body(Vec::new())
        .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}

/// Registered as `register_asynchronous_uri_scheme_protocol(TSUKYIO_PROTOCOL, ..)`.
/// Reads the asset id from the request URI and the `Range` header, fetches the
/// corresponding (bounded) byte range from the upstream Tsukyio stream endpoint
/// with the Bearer key from managed session state, and relays the upstream
/// status + range headers back to the webview. Runs the network work on Tauri's
/// async runtime and responds when done.
pub(crate) fn handle_stream_protocol(
    ctx: UriSchemeContext<'_, Wry>,
    request: tauri::http::Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();

    let uri = request.uri().to_string();
    let asset_id = match asset_id_from_uri(&uri) {
        Some(id) => id,
        None => {
            log_warn(
                "tsukyio.stream.bad_uri",
                "Tsukyio stream request had no asset id",
                json!({ "uri": &uri }),
            );
            responder.respond(proxy_error(404));
            return;
        }
    };

    let range_header = request
        .headers()
        .get(tauri::http::header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let key = match app.state::<TsukyioSession>().get() {
        Some(key) => key,
        None => {
            log_warn(
                "tsukyio.stream.no_key",
                "Tsukyio stream requested with no session key set",
                json!({ "assetId": &asset_id }),
            );
            responder.respond(proxy_error(401));
            return;
        }
    };

    tauri::async_runtime::spawn(async move {
        let response = proxy_stream(&key, &asset_id, range_header.as_deref()).await;
        let response = match response {
            Ok(response) => response,
            Err((status, message)) => {
                log_warn(
                    "tsukyio.stream.error",
                    "Tsukyio stream proxy failed",
                    json!({ "assetId": &asset_id, "status": status, "error": &message }),
                );
                proxy_error(status)
            }
        };
        responder.respond(response);
    });
}

/// Fetches a bounded byte range of the upstream stream and assembles the webview
/// response. Memory is bounded by reading at most `PROXY_CHUNK_CAP` bytes of the
/// body (then closing the connection), NOT by sending an invented explicit end
/// upstream — the upstream endpoint does not clamp an out-of-bounds Range end and
/// zero-pads/over-advertises the served range, which Chromium/WebView2 rejects.
///
/// Range translation:
///   - Open-ended caller range (`bytes=N-`) → open-ended upstream `bytes=N-`
///     (the common path; never invent an end). Body is read up to the cap.
///   - Bounded caller range (`bytes=N-M`) → upstream `bytes=N-min(M, N+CAP-1)`,
///     which is always in-bounds because players only request in-bounds ends.
///
/// The advertised `Content-Range` is rebuilt from the authoritative total (parsed
/// from upstream's `Content-Range`) plus the bytes we actually hold — upstream's
/// echoed served end is never trusted. The rare degraded `200` (no upstream
/// `Content-Range`) is relayed uncapped as `200` (capping a 200 would silently
/// truncate the file and break seeking), guarded by `PROXY_MAX_FULL_BODY`.
/// Errors map to an HTTP status the caller turns into an empty error response.
async fn proxy_stream(
    api_key: &str,
    asset_id: &str,
    range_header: Option<&str>,
) -> Result<tauri::http::Response<Vec<u8>>, (u16, String)> {
    // Resolve the requested range, defaulting to an open-ended read from 0.
    let requested = parse_range_header(range_header).unwrap_or(RangeSpec { start: 0, end: None });

    // Build the upstream Range. Crucially we NEVER send an explicit end that can
    // exceed the file size: an open-ended caller range stays open-ended upstream,
    // and a bounded caller range is clamped to start+CAP-1 (which is <= the
    // caller's in-bounds end, so it is always a valid in-bounds end too).
    let upstream_range = match requested.end {
        Some(end) => format!(
            "bytes={}-{}",
            requested.start,
            end.min(requested.start + PROXY_CHUNK_CAP - 1)
        ),
        None => format!("bytes={}-", requested.start),
    };

    let client = build_client(api_key).map_err(|e| (401u16, e))?;

    let response = client
        .get(format!("{TSUKYIO_BASE}/stream"))
        // Percent-encode the id correctly instead of splicing it raw into the URL.
        .query(&[("id", asset_id)])
        .header(reqwest::header::RANGE, &upstream_range)
        // The stream endpoint serves media; override the JSON Accept default.
        .header(reqwest::header::ACCEPT, "*/*")
        .send()
        .await
        .map_err(|e| (502u16, format!("Could not reach Tsukyio stream: {e}")))?;

    let status = response.status();
    if !status.is_success() {
        // 401/403/429/etc. Map to the upstream status so the webview sees a
        // failure rather than playing an error body.
        let code = status.as_u16();
        let body = response.text().await.unwrap_or_default();
        return Err((code, status_error(status, &body)));
    }

    // Capture the headers we need before consuming the body.
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "video/mp4".to_string());
    // Authoritative total file size, parsed from upstream's Content-Range. The
    // normal 206 always carries this; its absence signals a degraded 200.
    let upstream_total = response
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(parse_content_range_total);
    // Advertised body size for the degraded no-Content-Range path's OOM guard.
    let upstream_content_length = response.content_length();

    if upstream_total.is_none() {
        // Degraded path: upstream answered without a Content-Range (no range
        // support — does not happen against this endpoint in practice). We must
        // NOT cap here: a capped 200 silently truncates the file and breaks
        // playback/seeking. Read the ENTIRE body and relay it as a plain 200.
        // Guard against a pathological huge body using the advertised length.
        if let Some(len) = upstream_content_length {
            if len > PROXY_MAX_FULL_BODY {
                return Err((
                    502u16,
                    format!(
                        "Tsukyio stream too large to buffer without range support \
                         ({len} bytes, ceiling {PROXY_MAX_FULL_BODY})."
                    ),
                ));
            }
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|e| (502u16, format!("Could not read Tsukyio stream body: {e}")))?;
        let body: Vec<u8> = bytes.to_vec();
        let body_len = body.len() as u64;
        return tauri::http::Response::builder()
            .status(200)
            .header(tauri::http::header::CONTENT_TYPE, content_type)
            .header(tauri::http::header::ACCEPT_RANGES, "bytes")
            .header(tauri::http::header::CONTENT_LENGTH, body_len.to_string())
            .body(body)
            .map_err(|e| (500u16, format!("Could not build stream response: {e}")));
    }

    let total = upstream_total.expect("upstream_total checked Some above");

    // Read the body with a hard cap of PROXY_CHUNK_CAP. For a small file the
    // (correct) open-ended body fits entirely; for a large file we stop at the
    // cap and drop the stream so reqwest closes the upstream connection. This is
    // what bounds memory now that we no longer send an invented explicit end.
    let cap = PROXY_CHUNK_CAP as usize;
    let mut body: Vec<u8> = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk
            .map_err(|e| (502u16, format!("Could not read Tsukyio stream body: {e}")))?;
        let remaining = cap - body.len();
        if chunk.len() >= remaining {
            body.extend_from_slice(&chunk[..remaining]);
            break;
        }
        body.extend_from_slice(&chunk);
    }
    // Dropping `stream` (and thus the response) here closes the upstream
    // connection so an unread large-file tail is not transferred.
    drop(stream);

    let body_len = body.len() as u64;

    // Rebuild the served range from ONLY what we hold + the authoritative total.
    // Never reuse upstream's echoed end (it can exceed the file size).
    let served_end = if body_len == 0 {
        requested.start
    } else {
        requested.start + body_len - 1
    };

    tauri::http::Response::builder()
        .status(206)
        .header(tauri::http::header::CONTENT_TYPE, content_type)
        .header(tauri::http::header::ACCEPT_RANGES, "bytes")
        .header(tauri::http::header::CONTENT_LENGTH, body_len.to_string())
        .header(
            tauri::http::header::CONTENT_RANGE,
            format!("bytes {}-{}/{}", requested.start, served_end, total),
        )
        .body(body)
        .map_err(|e| (500u16, format!("Could not build stream response: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_falls_back_to_mp4() {
        assert_eq!(extension_for("clip", ""), "mp4");
        assert_eq!(extension_for("clip", "Naruto/Kakashi/video_01.webm"), "webm");
        assert_eq!(extension_for("song.mp3", ""), "mp3");
        // Reject junk that isn't really an extension.
        assert_eq!(extension_for("a.b.c.verylongext", ""), "mp4");
    }

    #[test]
    fn unique_dest_dedupes_collisions() {
        let dir = std::env::temp_dir().join(format!("tsukyio-unique-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        // No collision: returns the plain name.
        let first = unique_dest(&dir, "clip", "mp4");
        assert_eq!(first, dir.join("clip.mp4"));
        File::create(&first).unwrap();

        // First collision: appends " (1)".
        let second = unique_dest(&dir, "clip", "mp4");
        assert_eq!(second, dir.join("clip (1).mp4"));
        File::create(&second).unwrap();

        // Second collision: appends " (2)".
        let third = unique_dest(&dir, "clip", "mp4");
        assert_eq!(third, dir.join("clip (2).mp4"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn asset_id_parsed_from_various_uri_shapes() {
        assert_eq!(
            asset_id_from_uri("tsukyio://stream/abc123").as_deref(),
            Some("abc123")
        );
        assert_eq!(
            asset_id_from_uri("tsukyio://localhost/stream/abc123").as_deref(),
            Some("abc123")
        );
        assert_eq!(
            asset_id_from_uri("http://tsukyio.localhost/stream/abc123").as_deref(),
            Some("abc123")
        );
        // Query strings and fragments are stripped.
        assert_eq!(
            asset_id_from_uri("http://tsukyio.localhost/stream/abc123?t=1#x").as_deref(),
            Some("abc123")
        );
        // Trailing slash / extra segment: take only the id segment.
        assert_eq!(
            asset_id_from_uri("tsukyio://stream/abc123/extra").as_deref(),
            Some("abc123")
        );
        // Percent-encoded id is decoded.
        assert_eq!(
            asset_id_from_uri("tsukyio://stream/a%2Fb").as_deref(),
            Some("a/b")
        );
        // No /stream/ segment → None.
        assert_eq!(asset_id_from_uri("tsukyio://other/abc"), None);
        assert_eq!(asset_id_from_uri("tsukyio://stream/"), None);
    }

    #[test]
    fn range_header_parsing() {
        let bounded = parse_range_header(Some("bytes=100-200")).unwrap();
        assert_eq!(bounded.start, 100);
        assert_eq!(bounded.end, Some(200));

        let open = parse_range_header(Some("bytes=0-")).unwrap();
        assert_eq!(open.start, 0);
        assert_eq!(open.end, None);

        // Multi-range: only the first range is honored.
        let multi = parse_range_header(Some("bytes=0-99, 200-299")).unwrap();
        assert_eq!(multi.start, 0);
        assert_eq!(multi.end, Some(99));

        // Suffix range and malformed / absent headers fall back to None
        // (caller then treats as open-ended bytes=0-).
        assert!(parse_range_header(Some("bytes=-500")).is_none());
        assert!(parse_range_header(Some("bytes=abc-def")).is_none());
        assert!(parse_range_header(Some("bytes=200-100")).is_none());
        assert!(parse_range_header(None).is_none());
    }

    #[test]
    fn content_range_total_parsing() {
        // Normal in-bounds 206: total is after the last slash.
        assert_eq!(
            parse_content_range_total("bytes 0-1155596/1155597"),
            Some(1155597)
        );
        // Out-of-bounds echoed end: we parse the TOTAL, not the (bogus) end.
        assert_eq!(
            parse_content_range_total("bytes 0-4194303/1155597"),
            Some(1155597)
        );
        // Unsatisfied-range form `bytes */TOTAL` still yields the total.
        assert_eq!(parse_content_range_total("bytes */1155597"), Some(1155597));
        // Unknown total `*` → None.
        assert_eq!(parse_content_range_total("bytes 0-99/*"), None);
        // Malformed / empty → None.
        assert_eq!(parse_content_range_total(""), None);
        assert_eq!(parse_content_range_total("bytes 0-99"), None);
        assert_eq!(parse_content_range_total("bytes 0-99/"), None);
        assert_eq!(parse_content_range_total("garbage/notanumber"), None);
    }

    #[test]
    fn percent_decode_roundtrip() {
        assert_eq!(percent_decode("abc123"), "abc123");
        assert_eq!(percent_decode("a%2Fb"), "a/b");
        assert_eq!(percent_decode("space%20here"), "space here");
        // Invalid escape is passed through untouched.
        assert_eq!(percent_decode("100%"), "100%");
    }

    #[test]
    fn session_key_trims_and_clears() {
        let session = TsukyioSession::default();
        assert_eq!(session.get(), None);
        session.set(Some("  tsk_abc  ".to_string()));
        assert_eq!(session.get().as_deref(), Some("tsk_abc"));
        // Empty/whitespace clears.
        session.set(Some("   ".to_string()));
        assert_eq!(session.get(), None);
        session.set(Some("tsk_xyz".to_string()));
        assert_eq!(session.get().as_deref(), Some("tsk_xyz"));
        session.set(None);
        assert_eq!(session.get(), None);
    }
}
