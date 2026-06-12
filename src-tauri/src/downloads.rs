use std::{
    collections::{HashSet, VecDeque},
    fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
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

/// curl_cffi impersonation target passed to `yt-dlp --impersonate`. Used by
/// the anime flow to bypass Cloudflare's TLS-fingerprint anti-bot. Kept as a
/// single constant so future updates (e.g. Chrome-117, ...) touch one spot.
/// NOT applied to the YouTube flow — YouTube does not need it and the
/// impersonation pathway can subtly degrade other callers.
const YTDLP_IMPERSONATE_TARGET: &str = "Chrome-116:Windows-10";

/// Progress line format handed to `yt-dlp --progress-template`. The first six
/// fields are yt-dlp's pre-formatted display strings. The trailing three raw
/// numeric fields (downloaded/total/estimated bytes) exist because yt-dlp's
/// own `_speed_str` is per-thread and collapses to a few B/s at fragment
/// boundaries when `--concurrent-fragments` is active — we recompute the real
/// aggregate speed in `SpeedTracker` from the raw byte counter instead.
/// Unknown raw fields render as "NA" and parse to `None`.
const AMV_PROGRESS_TEMPLATE: &str = "download:AMV_PROGRESS|%(progress.status)s|%(progress._percent_str)s|%(progress._downloaded_bytes_str)s|%(progress._total_bytes_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress.downloaded_bytes)d|%(progress.total_bytes)d|%(progress.total_bytes_estimate)d";

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
#[serde(rename_all = "camelCase")]
pub(crate) struct StreamQuality {
    pub id: String,
    pub label: String,
    pub url: String,
    pub width: Option<u64>,
    pub height: Option<u64>,
    pub bitrate: Option<f64>,
    pub codec: Option<String>,
    /// Referer header that worked for this candidate during inspection.
    /// Echoed back from `inspect_stream`'s input so the frontend can pass
    /// the same value to the eventual yt-dlp download. `None` means the
    /// caller did not supply one — fall back to the page URL.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub referer: Option<String>,
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

/// Anime-flow variant: adds `--impersonate` so curl_cffi mimics a real Chrome
/// TLS handshake. Required for the providers we scrape (Cloudflare anti-bot,
/// JA3-fingerprint walls). YouTube callers must use the plain
/// `ytdlp_command` — impersonation is unnecessary there and has caused
/// subtle degradations on other sites in the past.
fn ytdlp_command_with_impersonate(root: &Path, url: &str) -> Command {
    let mut command = ytdlp_command(root, url);
    command.arg("--impersonate").arg(YTDLP_IMPERSONATE_TARGET);
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
    let mut command = ytdlp_command_with_impersonate(&root, &url);
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
                referer: if referer.trim().is_empty() {
                    None
                } else {
                    Some(referer.clone())
                },
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
            referer: if referer.trim().is_empty() {
                None
            } else {
                Some(referer.clone())
            },
        });
    }

    // Sniffed HLS URLs are often variant (media) playlists, not the master —
    // those carry zero resolution metadata, so yt-dlp returns formats with no
    // height and the label falls back to "Detected stream". Probe the actual
    // video stream with ffprobe (reads the first segment) to recover the real
    // resolution so the quality picker shows "1080p" instead of three
    // indistinguishable entries.
    let probed_count = enrich_qualities_with_ffprobe(&root, &mut qualities, &referer);

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
        json!({ "url": &url, "qualityCount": qualities.len(), "ffprobeEnriched": probed_count }),
    );
    Ok(qualities)
}

struct ProbedVideoInfo {
    width: Option<u64>,
    height: Option<u64>,
    codec: Option<String>,
    bitrate_kbps: Option<f64>,
}

/// Fill in width/height (and codec/bitrate when available) for qualities that
/// yt-dlp could not size, by probing the stream itself with the bundled
/// ffprobe. Returns how many entries were successfully enriched. Probes run
/// in parallel (capped) and any failure leaves the entry untouched — this is
/// best-effort labeling, never a gate on downloading.
fn enrich_qualities_with_ffprobe(
    root: &Path,
    qualities: &mut [StreamQuality],
    fallback_referer: &str,
) -> usize {
    const MAX_PROBES: usize = 4;
    let targets: Vec<usize> = qualities
        .iter()
        .enumerate()
        .filter(|(_, quality)| quality.height.is_none())
        .map(|(index, _)| index)
        .take(MAX_PROBES)
        .collect();
    if targets.is_empty() {
        return 0;
    }
    let ffprobe = find_tool(root, "ffprobe");
    if !command_available(&ffprobe) {
        return 0;
    }

    let mut enriched = 0;
    thread::scope(|scope| {
        let handles: Vec<_> = targets
            .iter()
            .map(|&index| {
                let url = qualities[index].url.clone();
                let referer = qualities[index]
                    .referer
                    .clone()
                    .unwrap_or_else(|| fallback_referer.to_string());
                let ffprobe = &ffprobe;
                scope.spawn(move || (index, probe_stream_video_info(ffprobe, &url, &referer)))
            })
            .collect();
        for handle in handles {
            let Ok((index, Some(info))) = handle.join() else {
                continue;
            };
            let quality = &mut qualities[index];
            quality.width = quality.width.or(info.width);
            quality.height = quality.height.or(info.height);
            if quality.codec.is_none() {
                quality.codec = info.codec;
            }
            if quality.bitrate.is_none() {
                quality.bitrate = info.bitrate_kbps;
            }
            if let Some(height) = quality.height {
                quality.label = quality_label_from_parts(height, quality.bitrate);
                enriched += 1;
            }
        }
    });
    enriched
}

/// Probe the first video stream of a URL with ffprobe, sending the same
/// browser UA + Referer the download will use (the HLS demuxer forwards both
/// to segment requests, so hot-link-protected CDNs answer). Bounded by an
/// I/O timeout, a probe-size cap, and a hard process timeout so a wedged CDN
/// can't hang the inspection step.
fn probe_stream_video_info(ffprobe: &Path, url: &str, referer: &str) -> Option<ProbedVideoInfo> {
    let mut command = cmd(ffprobe);
    command
        .arg("-v")
        .arg("error")
        .arg("-user_agent")
        .arg(BROWSER_USER_AGENT)
        .arg("-headers")
        .arg(format!("Referer: {}\r\n", normalized_referer(referer)))
        .arg("-rw_timeout")
        .arg("15000000")
        .arg("-probesize")
        .arg("4000000")
        .arg("-analyzeduration")
        .arg("4000000")
        .arg("-select_streams")
        .arg("v:0")
        .arg("-show_entries")
        .arg("stream=width,height,codec_name,bit_rate")
        .arg("-of")
        .arg("json")
        .arg(url)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let output = run_command_with_timeout(command, Duration::from_secs(20))?;
    if !output.status.success() {
        log_warn(
            "download.inspect.probe.error",
            "ffprobe could not size a stream candidate",
            json!({
                "url": url,
                "code": output.status.code(),
                "stderr": truncate_log_text(String::from_utf8_lossy(&output.stderr).trim()),
            }),
        );
        return None;
    }

    let payload: Value = serde_json::from_slice(&output.stdout).ok()?;
    let stream = payload.get("streams")?.as_array()?.first()?;
    let width = stream.get("width").and_then(Value::as_u64);
    let height = stream.get("height").and_then(Value::as_u64);
    let codec = stream
        .get("codec_name")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let bitrate_kbps = stream
        .get("bit_rate")
        .and_then(|value| {
            value
                .as_str()
                .and_then(|text| text.parse::<f64>().ok())
                .or_else(|| value.as_f64())
        })
        .filter(|value| *value > 0.0)
        .map(|bps| bps / 1000.0);
    height?;
    Some(ProbedVideoInfo {
        width,
        height,
        codec,
        bitrate_kbps,
    })
}

/// Spawn `command` (stdout/stderr must already be piped) and wait at most
/// `timeout` for it to exit, killing it on overrun. Output pipes are drained
/// on background threads so a chatty child can't deadlock on a full pipe.
fn run_command_with_timeout(mut command: Command, timeout: Duration) -> Option<std::process::Output> {
    let mut child = command.spawn().ok()?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_handle = thread::spawn(move || {
        let mut buffer = Vec::new();
        if let Some(mut pipe) = stdout {
            let _ = pipe.read_to_end(&mut buffer);
        }
        buffer
    });
    let stderr_handle = thread::spawn(move || {
        let mut buffer = Vec::new();
        if let Some(mut pipe) = stderr {
            let _ = pipe.read_to_end(&mut buffer);
        }
        buffer
    });

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                thread::sleep(Duration::from_millis(100));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };

    Some(std::process::Output {
        status,
        stdout: stdout_handle.join().unwrap_or_default(),
        stderr: stderr_handle.join().unwrap_or_default(),
    })
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

fn quality_label_from_parts(height: u64, bitrate: Option<f64>) -> String {
    match bitrate {
        Some(value) if value > 0.0 => format!("{height}p - {value:.0} kbps"),
        _ => format!("{height}p"),
    }
}

fn stream_quality_label(format: &Value, height: Option<u64>, bitrate: Option<f64>) -> String {
    if let Some(height) = height {
        return quality_label_from_parts(height, bitrate);
    }
    let resolution = format.get("resolution").and_then(Value::as_str);
    let format_note = format.get("format_note").and_then(Value::as_str);
    let base = resolution
        .filter(|value| !value.is_empty() && *value != "audio only")
        .map(ToString::to_string)
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

    let mut command = ytdlp_command_with_impersonate(&root, &url);

    command
        .arg("--newline")
        .arg("--progress")
        .arg("--progress-template")
        .arg(AMV_PROGRESS_TEMPLATE)
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
    let speed_tracker = Arc::new(Mutex::new(SpeedTracker::default()));
    let stderr_destination = Arc::clone(&last_destination);
    let stderr_output_file = Arc::clone(&last_output_file);
    let stderr_speed_tracker = Arc::clone(&speed_tracker);
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
                &stderr_speed_tracker,
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
        handle_downloader_line(&window, job_id.as_deref(), &last_destination, &last_output_file, &speed_tracker, &line);
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
        .arg(AMV_PROGRESS_TEMPLATE)
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
    let speed_tracker = Arc::new(Mutex::new(SpeedTracker::default()));
    let stderr_destination = Arc::clone(&last_destination);
    let stderr_output_file = Arc::clone(&last_output_file);
    let stderr_speed_tracker = Arc::clone(&speed_tracker);
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
                &stderr_speed_tracker,
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
        handle_downloader_line(&window, job_id.as_deref(), &last_destination, &last_output_file, &speed_tracker, &line);
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

// Sampling content fingerprint — three 64 KB windows at head, middle, and
// tail of the file (plus the size as a salt), SHA-256'd together. ~192 KB
// of I/O total regardless of file size, sub-10 ms on SSD even for a 4 GB
// BD rip. Catches "looks identical by metadata but bytes differ" swaps
// and lets caches survive cross-rename / cross-copy of the same content.
// Adversarial collision crafting is out of scope. For files < 192 KB the
// whole file is hashed.
pub(crate) fn content_fingerprint(input: &std::path::Path) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    use sha2::{Digest, Sha256};
    const SAMPLE: u64 = 64 * 1024;

    let mut file = std::fs::File::open(input).ok()?;
    let size = file.metadata().ok()?.len();

    let mut hasher = Sha256::new();
    hasher.update(size.to_le_bytes());

    if size <= SAMPLE * 3 {
        let mut buf = Vec::with_capacity(size as usize);
        file.read_to_end(&mut buf).ok()?;
        hasher.update(&buf);
    } else {
        let mut buf = vec![0u8; SAMPLE as usize];
        for offset in [0u64, size / 2, size - SAMPLE] {
            file.seek(SeekFrom::Start(offset)).ok()?;
            file.read_exact(&mut buf).ok()?;
            hasher.update(&buf);
        }
    }

    Some(hex::encode(hasher.finalize()))
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
        let mut new_len = max_len;
        while new_len > 0 && !sanitized.is_char_boundary(new_len) {
            new_len -= 1;
        }
        sanitized.truncate(new_len);
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

/// Computes the real aggregate download speed from yt-dlp's raw
/// `downloaded_bytes` counter over a short sliding window of wall-clock
/// samples. yt-dlp's own `_speed_str` is per-fragment-thread and reads a few
/// B/s at fragment boundaries under `--concurrent-fragments`, which made the
/// queue show absurd speeds for HLS downloads.
#[derive(Default)]
struct SpeedTracker {
    samples: VecDeque<(Instant, u64)>,
}

impl SpeedTracker {
    const WINDOW: Duration = Duration::from_secs(6);
    const MIN_SPAN_SECS: f64 = 0.5;
    const MAX_SAMPLES: usize = 256;

    fn record(&mut self, bytes: u64) -> Option<f64> {
        self.record_at(Instant::now(), bytes)
    }

    fn record_at(&mut self, now: Instant, bytes: u64) -> Option<f64> {
        if let Some(&(_, last_bytes)) = self.samples.back() {
            // The counter went backwards: yt-dlp moved on to the next file of
            // the same job (e.g. separate audio after video). Start over.
            if bytes < last_bytes {
                self.samples.clear();
            }
        }
        self.samples.push_back((now, bytes));
        while self.samples.len() > 2 {
            let Some(&(oldest, _)) = self.samples.front() else {
                break;
            };
            if self.samples.len() > Self::MAX_SAMPLES
                || now.duration_since(oldest) > Self::WINDOW
            {
                self.samples.pop_front();
            } else {
                break;
            }
        }
        let &(first_at, first_bytes) = self.samples.front()?;
        let &(last_at, last_bytes) = self.samples.back()?;
        let span = last_at.duration_since(first_at).as_secs_f64();
        if span < Self::MIN_SPAN_SECS {
            return None;
        }
        Some(last_bytes.saturating_sub(first_bytes) as f64 / span)
    }
}

fn format_byte_size(bytes: f64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut value = bytes.max(0.0);
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{value:.0}{}", UNITS[unit])
    } else {
        format!("{value:.2}{}", UNITS[unit])
    }
}

fn format_transfer_speed(bytes_per_second: f64) -> String {
    format!("{}/s", format_byte_size(bytes_per_second))
}

fn format_eta_seconds(seconds: f64) -> String {
    let total = seconds.round().max(0.0) as u64;
    let hours = total / 3600;
    let minutes = (total % 3600) / 60;
    let secs = total % 60;
    if hours > 0 {
        format!("{hours}:{minutes:02}:{secs:02}")
    } else {
        format!("{minutes:02}:{secs:02}")
    }
}

fn handle_downloader_line(
    window: &tauri::Window,
    job_id: Option<&str>,
    last_destination: &Arc<Mutex<String>>,
    last_output_file: &Arc<Mutex<String>>,
    speed_tracker: &Arc<Mutex<SpeedTracker>>,
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

    let (stage, percent, message) = if let Some(progress) = parse_amv_progress(line, speed_tracker) {
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

fn parse_amv_progress(
    line: &str,
    speed_tracker: &Arc<Mutex<SpeedTracker>>,
) -> Option<(String, Option<f32>, String)> {
    let rest = line.strip_prefix("AMV_PROGRESS|")?;
    let mut parts = rest.split('|');
    let status = parts.next().unwrap_or("downloading").trim();
    let percent = parts.next().and_then(parse_percent_text);
    let downloaded = parts.next().unwrap_or("").trim();
    let total = parts.next().unwrap_or("").trim();
    let speed = parts.next().unwrap_or("").trim();
    let eta = parts.next().unwrap_or("").trim();
    // Raw numeric fields from AMV_PROGRESS_TEMPLATE; "NA" when unknown.
    let raw_downloaded = parts.next().and_then(parse_u64_text);
    let raw_total = parts
        .next()
        .and_then(parse_u64_text)
        .or_else(|| parts.next().and_then(parse_u64_text));

    let computed_speed = raw_downloaded.and_then(|bytes| {
        speed_tracker
            .lock()
            .ok()
            .and_then(|mut tracker| tracker.record(bytes))
    });

    let downloaded_text = nonempty_display(downloaded)
        .or_else(|| raw_downloaded.map(|bytes| format_byte_size(bytes as f64)));
    // total_bytes is unknown for HLS; fall back to yt-dlp's running
    // estimate, marked as approximate.
    let total_text = nonempty_display(total)
        .or_else(|| raw_total.map(|bytes| format!("~{}", format_byte_size(bytes as f64))));
    let speed_text = computed_speed
        .filter(|value| *value > 0.0)
        .map(format_transfer_speed)
        .or_else(|| nonempty_display(speed));
    let eta_text = match (computed_speed, raw_total, raw_downloaded) {
        (Some(speed), Some(total), Some(done)) if speed > 1.0 && total > done => {
            Some(format_eta_seconds((total - done) as f64 / speed))
        }
        _ => nonempty_display(eta),
    };

    let mut details = Vec::new();
    if let Some(downloaded) = downloaded_text {
        if let Some(total) = total_text {
            details.push(format!("{downloaded} of {total}"));
        } else {
            details.push(downloaded);
        }
    }
    if let Some(speed) = speed_text {
        details.push(speed);
    }
    if let Some(eta) = eta_text {
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

/// yt-dlp renders unknown pre-formatted fields as "N/A" and unknown template
/// fields as "NA" (the outtmpl placeholder) — treat both as absent.
fn nonempty_display(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed == "N/A" || trimmed == "NA" {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn parse_u64_text(value: &str) -> Option<u64> {
    let trimmed = value.trim();
    // yt-dlp renders missing template fields as "NA"; floats (e.g.
    // total_bytes_estimate) survive the %d conversion but be tolerant anyway.
    trimmed
        .parse::<u64>()
        .ok()
        .or_else(|| trimmed.parse::<f64>().ok().filter(|v| *v >= 0.0).map(|v| v as u64))
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

#[cfg(test)]
mod tests {
    use super::*;

    fn tracker() -> Arc<Mutex<SpeedTracker>> {
        Arc::new(Mutex::new(SpeedTracker::default()))
    }

    #[test]
    fn speed_tracker_computes_aggregate_speed() {
        let mut tracker = SpeedTracker::default();
        let base = Instant::now();
        assert_eq!(tracker.record_at(base, 0), None, "one sample is not a speed");
        let speed = tracker
            .record_at(base + Duration::from_secs(2), 4 * 1024 * 1024)
            .expect("two samples spanning 2s must produce a speed");
        assert!((speed - 2.0 * 1024.0 * 1024.0).abs() < 1.0, "expected ~2MiB/s, got {speed}");
    }

    #[test]
    fn speed_tracker_resets_when_counter_goes_backwards() {
        let mut tracker = SpeedTracker::default();
        let base = Instant::now();
        tracker.record_at(base, 10_000_000);
        tracker.record_at(base + Duration::from_secs(1), 20_000_000);
        // New file in the same job: counter restarts near zero. The window
        // must reset instead of reporting a huge negative/zero-clamped span.
        assert_eq!(tracker.record_at(base + Duration::from_secs(2), 1_000), None);
        let speed = tracker
            .record_at(base + Duration::from_secs(3), 1_001_000)
            .expect("speed after reset");
        assert!((speed - 1_000_000.0).abs() < 1.0, "expected ~1MB/s, got {speed}");
    }

    #[test]
    fn speed_tracker_ignores_samples_outside_window() {
        let mut tracker = SpeedTracker::default();
        let base = Instant::now();
        tracker.record_at(base, 0);
        tracker.record_at(base + Duration::from_secs(60), 1_000);
        // Old sample fell out of the 6s window, leaving a single fresh one.
        let speed = tracker.record_at(base + Duration::from_secs(61), 2_048_000);
        assert!(
            speed.is_some_and(|value| value > 1_000_000.0),
            "speed must reflect only the recent window, got {speed:?}"
        );
    }

    #[test]
    fn format_byte_size_picks_unit() {
        assert_eq!(format_byte_size(512.0), "512B");
        assert_eq!(format_byte_size(2.5 * 1024.0), "2.50KiB");
        assert_eq!(format_byte_size(246.78 * 1024.0 * 1024.0), "246.78MiB");
    }

    #[test]
    fn format_eta_rolls_over_to_hours() {
        assert_eq!(format_eta_seconds(35.0), "00:35");
        assert_eq!(format_eta_seconds(95.0), "01:35");
        assert_eq!(format_eta_seconds(3_700.0), "1:01:40");
    }

    #[test]
    fn parse_amv_progress_legacy_six_fields() {
        let line = "AMV_PROGRESS|downloading|  42.0%|246.78MiB|N/A|844.08B/s|00:00";
        let (stage, percent, message) = parse_amv_progress(line, &tracker()).expect("parsed");
        assert_eq!(stage, "downloading");
        assert_eq!(percent, Some(42.0));
        assert_eq!(message, "246.78MiB - 844.08B/s - ETA 00:00");
    }

    #[test]
    fn parse_amv_progress_uses_estimate_when_total_unknown() {
        let line = "AMV_PROGRESS|downloading|  50.0%|100.00MiB|N/A|844.08B/s|00:00|104857600|NA|209715200";
        let (_, _, message) = parse_amv_progress(line, &tracker()).expect("parsed");
        // Single sample -> no computed speed yet, falls back to yt-dlp's
        // string, but the total estimate is picked up.
        assert_eq!(message, "100.00MiB of ~200.00MiB - 844.08B/s - ETA 00:00");
    }

    #[test]
    fn parse_amv_progress_finished_maps_to_finalizing() {
        let line = "AMV_PROGRESS|finished|100%|246.78MiB|246.78MiB|N/A|N/A";
        let (stage, percent, message) = parse_amv_progress(line, &tracker()).expect("parsed");
        assert_eq!(stage, "finalizing");
        assert_eq!(percent, Some(100.0));
        assert_eq!(message, "246.78MiB of 246.78MiB");
    }

    #[test]
    fn parse_amv_progress_finished_line_recovers_bytes_from_raw_field() {
        // Exact shape emitted by the bundled yt-dlp on the final progress
        // tick: the pre-formatted downloaded string degrades to "NA" but the
        // raw counter is still present.
        let line = "AMV_PROGRESS|finished|100.0%|NA|   4.17MiB|8.22MiB/s|NA|4372373|4372373|NA";
        let (stage, _, message) = parse_amv_progress(line, &tracker()).expect("parsed");
        assert_eq!(stage, "finalizing");
        assert_eq!(message, "4.17MiB of 4.17MiB - 8.22MiB/s");
    }

    #[test]
    fn parse_u64_text_handles_na_and_floats() {
        assert_eq!(parse_u64_text("NA"), None);
        assert_eq!(parse_u64_text("N/A"), None);
        assert_eq!(parse_u64_text(" 12345 "), Some(12345));
        assert_eq!(parse_u64_text("12345.7"), Some(12345));
    }

    #[test]
    fn quality_label_prefers_height() {
        assert_eq!(quality_label_from_parts(1080, None), "1080p");
        assert_eq!(quality_label_from_parts(720, Some(1850.4)), "720p - 1850 kbps");
    }
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
