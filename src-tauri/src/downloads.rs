use std::{
    collections::HashSet,
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
};

use chrono::Local;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Emitter;

use crate::{
    app_root, app_state_dir, apply_python_env, clear_child_pid, cmd, command_available, find_tool,
    log_error, log_info, log_warn, probe_has_audio_stream, store_child_pid, tools_dir_path,
    truncate_log_text, DOWNLOAD_CHILD_PID,
};

const BROWSER_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadProgress {
    pub job_id: Option<String>,
    pub stage: String,
    pub percent: Option<f32>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Clone, Serialize)]
pub(crate) struct StreamQuality {
    pub id: String,
    pub label: String,
    pub url: String,
    pub width: Option<u64>,
    pub height: Option<u64>,
    pub bitrate: Option<f64>,
    pub codec: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadFormat {
    pub id: String,
    pub label: String,
    pub ext: Option<String>,
    pub resolution: Option<String>,
    pub width: Option<u64>,
    pub height: Option<u64>,
    pub bitrate: Option<f64>,
    pub filesize: Option<u64>,
    pub vcodec: Option<String>,
    pub acodec: Option<String>,
    pub audio_only: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadHistoryItem {
    pub id: String,
    pub created_at: String,
    pub kind: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub quality_label: Option<String>,
    pub url: String,
    pub referer: Option<String>,
    pub format_id: Option<String>,
    pub output_path: String,
    pub source_page: Option<String>,
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
pub(crate) struct DownloadFormatInspection {
    pub duration_seconds: Option<f64>,
    pub is_live: bool,
    pub video_id: Option<String>,
    pub preview_url: Option<String>,
    pub formats: Vec<DownloadFormat>,
}

struct DownloadIdentity {
    anime_folder: String,
    file_stem: String,
}

#[tauri::command]
pub(crate) async fn download_stream(
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
    custom_output_dir: Option<String>,
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
            "customOutputDir": &custom_output_dir,
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
        run_stream_download(window, job_id, url, referer, metadata, download_dir, custom_output_dir)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn inspect_stream(url: String, referer: String) -> Result<Vec<StreamQuality>, String> {
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
pub(crate) async fn inspect_download_formats(
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
pub(crate) fn download_history() -> Result<Vec<DownloadHistoryItem>, String> {
    read_download_history()
}

#[tauri::command]
pub(crate) async fn download_media(
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

#[tauri::command]
pub(crate) fn list_anime_folders(download_dir: Option<String>) -> Result<Vec<String>, String> {
    let root = resolve_download_root(download_dir.as_deref()).join("anime downloads");
    if !root.exists() {
        return Ok(Vec::new());
    }
    let entries = fs::read_dir(&root)
        .map_err(|error| format!("Could not list downloads folder: {error}"))?;
    let mut names: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| !name.starts_with('.') && !name.eq_ignore_ascii_case("pending"))
        .collect();
    names.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    Ok(names)
}

#[tauri::command]
pub(crate) fn cancel_download() {
    log_warn("download.cancel", "Cancelling active episode download", Value::Null);
    crate::kill_child_pid(&DOWNLOAD_CHILD_PID);
}

fn normalized_referer(referer: &str) -> String {
    if referer.trim().is_empty() {
        "https://aniwaves.ru".to_string()
    } else {
        referer.trim().to_string()
    }
}

fn ytdlp_command(root: &Path, url: &str) -> Command {
    let mut command = cmd(tools_dir_path(root).join("yt-dlp.exe"));
    command.env("PYTHONUNBUFFERED", "1");
    apply_python_env(&mut command);
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
            .join("Ultimate AMV");
    }
    PathBuf::from("Ultimate AMV")
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
    custom_output_dir: Option<String>,
) -> Result<String, String> {
    let root = app_root()?;
    let identity = build_download_identity(&url, &referer, &metadata);
    let custom_dir = custom_output_dir
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let output_dir = match custom_dir {
        Some(dir) => PathBuf::from(dir),
        None => resolve_download_root(download_dir.as_deref())
            .join("anime downloads")
            .join(&identity.anime_folder),
    };
    std::fs::create_dir_all(&output_dir).map_err(|error| error.to_string())?;
    log_info(
        "download.stream.prepared",
        "Prepared downloader output location",
        json!({
            "outputDir": output_dir.to_string_lossy(),
            "animeFolder": &identity.anime_folder,
            "fileStem": &identity.file_stem,
            "customOutputDir": custom_dir,
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

pub(crate) fn short_stable_id(parts: &[&str]) -> String {
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

pub(crate) fn sanitize_path_segment(value: &str, fallback: &str, max_len: usize) -> String {
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

pub(crate) fn format_spec_is_audio_only(spec: &str) -> bool {
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
