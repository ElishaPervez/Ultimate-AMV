use std::{
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Mutex, OnceLock},
    thread,
};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

use crate::{
    app_root, clear_child_pid, cmd, ensure_tool, find_tool, kill_child_pid, log_error, log_info,
    log_warn, sanitize_path_segment, short_stable_id, store_child_pid, H264_NVENC_AVAILABLE,
};

pub(crate) static WALLPAPER_CHILD_PID: OnceLock<Mutex<Option<u32>>> = OnceLock::new();

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WallpaperProgress {
    stage: String,
    percent: Option<f32>,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WallpaperTranscodeResult {
    pub path: String,
    pub source: String,
    pub cached: bool,
    pub fps: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WallpaperProbeResult {
    pub source_fps: f64,
    pub duration_seconds: f64,
}

fn wallpaper_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?
        .join("wallpapers");
    if !dir.exists() {
        fs::create_dir_all(&dir)
            .map_err(|error| format!("Could not create wallpapers directory: {error}"))?;
    }
    Ok(dir)
}

fn emit_progress(window: &tauri::Window, stage: &str, percent: Option<f32>, message: &str) {
    let _ = window.emit(
        "wallpaper-transcode-progress",
        WallpaperProgress {
            stage: stage.to_string(),
            percent,
            message: message.to_string(),
        },
    );
}

fn probe_video_metadata(ffmpeg: &Path, input: &Path) -> (Option<f64>, Option<f64>) {
    // ffmpeg -i emits "Duration: HH:MM:SS.xx" and a "Stream #0:0 ... Video:
    // ... , <fps> fps, ..." line on stderr. Both come from the same probe so
    // we extract them in one shot instead of running ffprobe separately.
    let output = match cmd(ffmpeg)
        .args(["-hide_banner", "-i"])
        .arg(input)
        .output()
    {
        Ok(value) => value,
        Err(_) => return (None, None),
    };
    let text = String::from_utf8_lossy(&output.stderr);
    let mut duration: Option<f64> = None;
    let mut fps: Option<f64> = None;
    for line in text.lines() {
        let trimmed = line.trim();
        if duration.is_none() {
            if let Some(rest) = trimmed.strip_prefix("Duration:") {
                let head = rest.trim().split(',').next().map(str::trim).unwrap_or("");
                let mut parts = head.split(':');
                if let (Some(h), Some(m), Some(s)) = (parts.next(), parts.next(), parts.next()) {
                    if let (Ok(h), Ok(m), Ok(s)) = (h.parse::<f64>(), m.parse::<f64>(), s.parse::<f64>()) {
                        duration = Some(h * 3600.0 + m * 60.0 + s);
                    }
                }
            }
        }
        if fps.is_none() && trimmed.contains("Video:") {
            for chunk in trimmed.split(',') {
                let token = chunk.trim();
                if let Some(num) = token.strip_suffix(" fps") {
                    if let Ok(value) = num.trim().parse::<f64>() {
                        fps = Some(value);
                        break;
                    }
                }
            }
        }
        if duration.is_some() && fps.is_some() {
            break;
        }
    }
    (fps, duration)
}

fn probe_duration_seconds(ffmpeg: &Path, input: &Path) -> Option<f64> {
    probe_video_metadata(ffmpeg, input).1
}

fn cache_key(source: &Path, fps: u32) -> Result<(String, String), String> {
    let metadata = source
        .metadata()
        .map_err(|error| format!("Could not read source video: {error}"))?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    let size = metadata.len().to_string();
    let input_key = source.to_string_lossy().to_string();
    let fps_key = fps.to_string();
    let id = short_stable_id(&[&input_key, &size, &modified, &fps_key, "wallpaper-v1"]);
    let stem = sanitize_path_segment(
        source
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("wallpaper"),
        "wallpaper",
        40,
    );
    Ok((stem, id))
}

fn purge_old_wallpapers(dir: &Path, keep: &Path) {
    // Compare on canonical form so Windows path-casing differences (AppData
    // vs Appdata, etc) don't make us mistake the keep file for a sibling.
    // file_name() comparison is the belt-and-suspenders: the wallpaper dir
    // is flat, so name equality is sufficient and immune to path quirks.
    let keep_name = keep.file_name().map(|n| n.to_os_string());
    let keep_canonical = keep.canonicalize().ok();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let same_by_name = keep_name
                .as_deref()
                .and_then(|k| path.file_name().map(|p| p == k))
                .unwrap_or(false);
            let same_by_canonical = keep_canonical
                .as_ref()
                .and_then(|k| path.canonicalize().ok().map(|p| p == *k))
                .unwrap_or(false);
            if same_by_name || same_by_canonical {
                continue;
            }
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if name.starts_with("wp_") && name.ends_with(".mp4") {
                    let _ = fs::remove_file(&path);
                }
            }
        }
    }
}

fn run_transcode(
    window: &tauri::Window,
    ffmpeg: &Path,
    input: &Path,
    output: &Path,
    fps: u32,
    duration: Option<f64>,
    use_nvenc: bool,
    use_hwaccel: bool,
) -> Result<(), String> {
    let mut args: Vec<String> = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-nostdin".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-progress".to_string(),
        "pipe:1".to_string(),
    ];
    if use_hwaccel {
        // Universal HW decode (NVDEC / QSV / D3D11VA / sw fallback). Skipped
        // on the libx264 retry path so AV1 / HEVC-10 sources on GPUs that
        // can't HW-decode them fall all the way back to pure software,
        // instead of failing twice with the same decoder error.
        args.push("-hwaccel".to_string());
        args.push("auto".to_string());
    }
    args.extend([
        "-i".to_string(),
        input.to_string_lossy().to_string(),
        "-map".to_string(),
        "0:v:0".to_string(),
        "-an".to_string(),
        // Cap at 1080p (preserve aspect) and target the requested fps. The
        // min() guard keeps sub-1080p sources at native resolution so we
        // never upscale.
        "-vf".to_string(),
        format!("scale=-2:'min(1080,ih)',fps={fps}"),
        "-r".to_string(),
        fps.to_string(),
    ]);

    if use_nvenc {
        args.extend([
            "-c:v".to_string(), "h264_nvenc".to_string(),
            "-preset".to_string(), "p4".to_string(),
            "-tune".to_string(), "hq".to_string(),
            "-rc".to_string(), "vbr".to_string(),
            "-cq".to_string(), "28".to_string(),
            "-b:v".to_string(), "0".to_string(),
            "-pix_fmt".to_string(), "yuv420p".to_string(),
        ]);
    } else {
        args.extend([
            "-c:v".to_string(), "libx264".to_string(),
            "-preset".to_string(), "veryfast".to_string(),
            "-crf".to_string(), "26".to_string(),
            "-pix_fmt".to_string(), "yuv420p".to_string(),
        ]);
    }

    args.extend([
        "-movflags".to_string(), "+faststart".to_string(),
        output.to_string_lossy().to_string(),
    ]);

    let mut child = cmd(ffmpeg)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start ffmpeg: {error}"))?;
    store_child_pid(&WALLPAPER_CHILD_PID, child.id());

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not read ffmpeg progress stream".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Could not read ffmpeg error stream".to_string())?;

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

    let total = duration.unwrap_or(0.0);
    let window_clone = window.clone();
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key {
            "out_time_us" | "out_time_ms" => {
                if total > 0.0 {
                    if let Ok(raw) = value.trim().parse::<f64>() {
                        let done = raw / 1_000_000.0;
                        let percent = ((done / total) * 100.0).clamp(0.0, 99.0) as f32;
                        emit_progress(
                            &window_clone,
                            "encoding",
                            Some(percent),
                            &format!("Compressing wallpaper ({percent:.0}%)"),
                        );
                    }
                }
            }
            "progress" if value.trim() == "end" => {
                emit_progress(
                    &window_clone,
                    "finalizing",
                    Some(100.0),
                    "Finalizing wallpaper...",
                );
            }
            _ => {}
        }
    }

    let status = child.wait().map_err(|error| error.to_string())?;
    clear_child_pid(&WALLPAPER_CHILD_PID);
    let stderr_tail = stderr_handle.join().unwrap_or_default();
    if status.success() {
        return Ok(());
    }
    let trimmed = stderr_tail.trim();
    if trimmed.is_empty() {
        Err(format!(
            "ffmpeg exited with code {}",
            status.code().unwrap_or(-1)
        ))
    } else {
        Err(trimmed.to_string())
    }
}

#[tauri::command]
pub(crate) async fn wallpaper_transcode(
    window: tauri::Window,
    source: String,
    fps: u32,
) -> Result<WallpaperTranscodeResult, String> {
    let fps = fps.clamp(15, 60);
    log_info(
        "wallpaper.transcode.start",
        "Starting wallpaper transcode",
        json!({ "source": &source, "fps": fps }),
    );
    let app_handle = window.app_handle().clone();
    let dir = wallpaper_dir(&app_handle)?;
    let window_clone = window.clone();
    let log_source = source.clone();

    let result = tauri::async_runtime::spawn_blocking(move || -> Result<WallpaperTranscodeResult, String> {
        let source_path = PathBuf::from(&source);
        if !source_path.is_file() {
            return Err(format!("Source video not found: {source}"));
        }

        let (stem, id) = cache_key(&source_path, fps)?;
        let output = dir.join(format!("wp_{stem}-{id}.mp4"));

        if output
            .metadata()
            .map(|m| m.len() > 1024)
            .unwrap_or(false)
        {
            // Cache hit - the user has already encoded at this source + fps.
            // We deliberately do NOT purge sibling files here: during a single
            // customize session the user may flip between fps values, and
            // keeping all transcodes on disk turns those flips into instant
            // cache hits. wallpaper_commit() is the one that prunes, called
            // when the user clicks Apply.
            return Ok(WallpaperTranscodeResult {
                path: output.to_string_lossy().to_string(),
                source: source.clone(),
                cached: true,
                fps,
            });
        }

        let root = app_root()?;
        let ffmpeg = find_tool(&root, "ffmpeg");
        ensure_tool(&ffmpeg)?;

        emit_progress(&window_clone, "probing", None, "Reading source video...");
        let duration = probe_duration_seconds(&ffmpeg, &source_path);
        emit_progress(&window_clone, "starting", Some(0.0), "Starting compression...");

        let use_nvenc = *H264_NVENC_AVAILABLE
            .get_or_init(|| crate::ffmpeg_listing(&ffmpeg, "-encoders").contains("h264_nvenc"));

        let primary = run_transcode(
            &window_clone,
            &ffmpeg,
            &source_path,
            &output,
            fps,
            duration,
            use_nvenc,
            true,
        );
        if let Err(error) = primary {
            // Retry without NVENC and without hwaccel decode. Some sources
            // (10-bit HEVC, AV1 on non-AV1-capable GPUs) fail on the
            // decoder side; retrying with the same -hwaccel auto would just
            // hit the same wall. Pure software-end-to-end is the universal
            // fallback.
            log_warn(
                "wallpaper.transcode.sw_fallback",
                "Hardware path failed, retrying with libx264 + software decode",
                json!({ "error": &error, "had_nvenc": use_nvenc }),
            );
            run_transcode(
                &window_clone,
                &ffmpeg,
                &source_path,
                &output,
                fps,
                duration,
                false,
                false,
            )?;
        }

        // No purge here - see the cache-hit comment above. wallpaper_commit()
        // is what prunes once the user picks a final fps.

        Ok(WallpaperTranscodeResult {
            path: output.to_string_lossy().to_string(),
            source: source.clone(),
            cached: false,
            fps,
        })
    })
    .await
    .map_err(|error| error.to_string())?;

    match &result {
        Ok(payload) => log_info(
            "wallpaper.transcode.complete",
            "Wallpaper transcode complete",
            json!({ "path": &payload.path, "cached": payload.cached, "fps": payload.fps }),
        ),
        Err(error) => log_error(
            "wallpaper.transcode.error",
            "Wallpaper transcode failed",
            json!({ "source": &log_source, "fps": fps, "error": error }),
        ),
    }
    if let Ok(payload) = &result {
        emit_progress(&window, "complete", Some(100.0), "Wallpaper ready");
        let _ = window.emit("wallpaper-transcode-done", payload.path.clone());
    }
    result
}

#[tauri::command]
pub(crate) fn wallpaper_cancel() {
    log_warn(
        "wallpaper.transcode.cancel",
        "Cancelling wallpaper transcode",
        Value::Null,
    );
    kill_child_pid(&WALLPAPER_CHILD_PID);
}

#[tauri::command]
pub(crate) async fn wallpaper_probe(source: String) -> Result<WallpaperProbeResult, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<WallpaperProbeResult, String> {
        let path = PathBuf::from(&source);
        if !path.is_file() {
            return Err(format!("Source video not found: {source}"));
        }
        let root = app_root()?;
        let ffmpeg = find_tool(&root, "ffmpeg");
        ensure_tool(&ffmpeg)?;
        let (fps, duration) = probe_video_metadata(&ffmpeg, &path);
        Ok(WallpaperProbeResult {
            source_fps: fps.unwrap_or(0.0),
            duration_seconds: duration.unwrap_or(0.0),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn wallpaper_commit(
    app: tauri::AppHandle,
    keep: String,
) -> Result<(), String> {
    let dir = wallpaper_dir(&app)?;
    let keep_path = PathBuf::from(&keep);
    // Refuse to prune if the file we are told to keep does not exist on disk.
    // Otherwise a stale or malformed path would silently delete every cached
    // wallpaper (every sibling is "not equal to keep" -> all get removed).
    if !keep_path.is_file() {
        log_warn(
            "wallpaper.commit.skip",
            "Refusing to prune: keep file does not exist",
            json!({ "keep": &keep }),
        );
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || {
        purge_old_wallpapers(&dir, &keep_path);
    })
    .await
    .map_err(|error| error.to_string())?;
    log_info(
        "wallpaper.commit",
        "Committed wallpaper - pruned sibling cache files",
        json!({ "keep": keep }),
    );
    Ok(())
}

#[tauri::command]
pub(crate) async fn wallpaper_clear(app: tauri::AppHandle) -> Result<(), String> {
    let dir = wallpaper_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if let Some(name) = entry.file_name().to_str() {
                    if name.starts_with("wp_") && name.ends_with(".mp4") {
                        let _ = fs::remove_file(entry.path());
                    }
                }
            }
        }
    })
    .await
    .map_err(|error| error.to_string())?;
    log_info("wallpaper.cleared", "Wallpaper cache cleared", Value::Null);
    Ok(())
}
