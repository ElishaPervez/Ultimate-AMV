use std::{
    fs,
    path::{Path, PathBuf},
    thread,
};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::Manager;

use crate::{
    app_root, canonical_input_path, cmd, content_fingerprint, ensure_tool, find_tool, log_error,
    log_info, short_stable_id,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClipPreviewDone {
    pub r#type: String,
    pub scene_id: String,
    pub path: String,
    pub duration: f64,
    pub cached: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClipPreviewRequest {
    pub scene_id: String,
    pub source_path: String,
    pub start: f64,
    pub end: f64,
    pub fps: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClipPreviewBatchDone {
    pub r#type: String,
    pub items: Vec<ClipPreviewBatchItem>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClipPreviewBatchItem {
    pub scene_id: String,
    pub path: Option<String>,
    pub duration: f64,
    pub cached: bool,
    pub error: Option<String>,
}

#[tauri::command]
pub(crate) async fn clip_preview_generate(
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
pub(crate) async fn clip_preview_generate_batch(
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
        let actual_duration = probe_webp_duration(&job.output).unwrap_or(job.duration);
        return serialize_clip_preview_done(job.scene_id, job.output, actual_duration, true);
    }

    let use_gpu = false;
    render_single_preview_job(&ffmpeg, &job, use_gpu)?;

    let actual_duration = probe_webp_duration(&job.output).unwrap_or(job.duration);
    serialize_clip_preview_done(job.scene_id, job.output, actual_duration, false)
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
    // Content-fingerprint key so the preview cache stays valid across
    // rename / move / copy of the same file. Previously this was hashed
    // from (path + size + mtime), which silently invalidated every
    // preview the moment the user renamed the source — even though the
    // scene cache (which got the same fix earlier) would still hit and
    // the user would see "21 scenes ready - 0/21 previews cached" with
    // the WebPs slowly regenerating from scratch.
    let source_key = content_fingerprint(&input)
        .ok_or_else(|| "Could not compute preview cache fingerprint for source file.".to_string())?;
    let cache_dir = app_data_dir
        .join("clip_previews")
        .join(&source_key);
    fs::create_dir_all(&cache_dir)
        .map_err(|error| format!("Could not create preview cache folder: {error}"))?;

    let start_key = format!("{:.3}", request.start);
    let end_key = format!("{:.3}", request.end);
    let fps_key = format!("{:.3}", request.fps);
    // Filename is purely (start, end, fps) — no scene_id, because the
    // frontend builds clip.id from the source filename and we want the
    // cache to survive renames. Two distinct scenes can't share the same
    // (start, end) within the same source, so this stays unique.
    let range_key = short_stable_id(&[&start_key, &end_key, &fps_key, "preview-webp-v2"]);
    let output = cache_dir.join(format!("{range_key}.webp"));
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

    let use_gpu = false;
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
                    let actual_duration = probe_webp_duration(&job.output).unwrap_or(job.duration);
                    items.push(ClipPreviewBatchItem {
                        scene_id: job.scene_id,
                        path: Some(job.output.to_string_lossy().to_string()),
                        duration: actual_duration,
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

    // Capped at 2 (down from 4) so preview rendering never floods the CPU
    // while the user is interacting. Combined with the libwebp -threads cap
    // in run_preview_ffmpeg, this leaves ~4 cores reserved for the encoder
    // and the rest permanently free for the UI / scrolling / playback.
    const PARALLELISM: usize = 2;
    let ffmpeg_path = ffmpeg.as_path();
    for chunk in pending.chunks(PARALLELISM) {
        let rendered: Vec<ClipPreviewBatchItem> = thread::scope(|scope| {
            let handles: Vec<_> = chunk
                .iter()
                .map(|job| {
                    scope.spawn(move || match render_single_preview_job(ffmpeg_path, job, use_gpu) {
                        Ok(()) => {
                            let actual_duration =
                                probe_webp_duration(&job.output).unwrap_or(job.duration);
                            ClipPreviewBatchItem {
                                scene_id: job.scene_id.clone(),
                                path: Some(job.output.to_string_lossy().to_string()),
                                duration: actual_duration,
                                cached: false,
                                error: None,
                            }
                        }
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

// Sum the exact per-frame delays encoded into an animated WebP so the CSS
// loop animation matches the WebP playback frame-for-frame. ffmpeg truncates
// per-frame delays to integer milliseconds (e.g. 83ms instead of 83.33ms at
// fps=12), which would otherwise drift visibly over a few loops.
fn probe_webp_duration(path: &Path) -> Option<f64> {
    let bytes = fs::read(path).ok()?;
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return None;
    }
    let mut offset = 12usize;
    let mut total_ms: u64 = 0;
    while offset + 8 <= bytes.len() {
        let tag = &bytes[offset..offset + 4];
        let size = u32::from_le_bytes([
            bytes[offset + 4],
            bytes[offset + 5],
            bytes[offset + 6],
            bytes[offset + 7],
        ]) as usize;
        let payload_start = offset + 8;
        let payload_end = payload_start.checked_add(size)?;
        if payload_end > bytes.len() {
            break;
        }
        if tag == b"ANMF" && size >= 16 {
            let dur_lo = bytes[payload_start + 12] as u32;
            let dur_mid = bytes[payload_start + 13] as u32;
            let dur_hi = bytes[payload_start + 14] as u32;
            total_ms += (dur_lo | (dur_mid << 8) | (dur_hi << 16)) as u64;
        }
        offset = payload_end + (size & 1);
    }
    if total_ms == 0 {
        None
    } else {
        Some(total_ms as f64 / 1000.0)
    }
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
        // scale_cuda must convert to nv12 on-GPU (`:format=nv12`): 10-bit HEVC
        // decodes to p010, and hwdownload cannot emit nv12 from a p010 surface.
        args.push("scale_cuda=426:240:format=nv12,hwdownload,format=nv12,fps=12".to_string());
    } else {
        args.push("fps=12,scale=426:240:force_original_aspect_ratio=increase,crop=426:240".to_string());
    }

    args.extend([
        "-vcodec".to_string(),
        "libwebp".to_string(),
        // Cap encoder to 2 threads so the cache fill can't soak every core
        // even when several preview jobs run in parallel.
        "-threads".to_string(),
        "2".to_string(),
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

pub(crate) fn serialize_clip_preview_done(
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
