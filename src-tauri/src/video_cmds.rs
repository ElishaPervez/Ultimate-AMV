use std::{
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Mutex, OnceLock},
    thread,
};

use serde::Serialize;
use serde_json::json;
use tauri::Emitter;

use crate::{
    app_root, clear_child_pid, cmd, find_tool, log_error, log_info, log_warn, store_child_pid,
    truncate_log_text, ConversionDone, ConversionProgress, GPU_INTRA_SOURCE_CODECS,
    VIDEO_CHILD_PID,
};

pub(crate) fn canonical_input_path(input_path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(input_path.trim().trim_matches(['"', '\'']));
    if !path.is_file() {
        return Err(format!("Input file not found: {}", path.to_string_lossy()));
    }
    let canonicalized = path.canonicalize()
        .map_err(|error| format!("Could not read input path: {error}"))?;

    #[cfg(target_os = "windows")]
    {
        let path_str = canonicalized.to_string_lossy();
        if path_str.starts_with(r"\\?\") {
            return Ok(PathBuf::from(&path_str[4..]));
        }
    }

    Ok(canonicalized)
}

pub(crate) fn ensure_tool(path: &Path) -> Result<(), String> {
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

pub(crate) fn unique_sibling_path(input: &Path, suffix: &str, extension: &str) -> PathBuf {
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

pub(crate) static H264_NVENC_AVAILABLE: OnceLock<bool> = OnceLock::new();

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VideoGpuStatus {
    pub compatible: bool,
    pub gpu_name: Option<String>,
    pub has_nvidia_gpu: bool,
    pub has_ffmpeg: bool,
    pub has_ffprobe: bool,
    pub has_h264_cuvid: bool,
    pub has_hevc_cuvid: bool,
    pub has_hevc_nvenc: bool,
    pub has_h264_nvenc: bool,
    pub has_av1_nvenc: bool,
    pub message: String,
}

#[tauri::command]
pub(crate) async fn video_transcode(
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
pub(crate) async fn video_gpu_status() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let status = collect_video_gpu_status();
        serde_json::to_string(&status).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn video_source_codec(input_path: String) -> Result<String, String> {
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

pub(crate) fn command_available(path: &Path) -> bool {
    cmd(path)
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

pub(crate) fn ffmpeg_listing(ffmpeg: &Path, kind: &str) -> String {
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

pub(crate) fn probe_duration(ffprobe: &Path, input: &Path) -> Result<f64, String> {
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

pub(crate) fn probe_video_codec(ffprobe: &Path, input: &Path) -> Result<String, String> {
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

// Featherweight previews: the single probe that drives clip_playback_plan's
// friendly-vs-proxy routing. One ffprobe call reads the first video stream's
// codec/pix_fmt/dimensions plus the first audio stream's codec, using the JSON
// output form (mirrors downloads.rs's format probe) so we parse one document
// instead of fragile key=value lines across two streams.
#[derive(Clone, Default)]
pub(crate) struct MediaSummary {
    pub video_codec: Option<String>,
    pub pix_fmt: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub audio_codec: Option<String>,
}

pub(crate) fn probe_media_summary(ffprobe: &Path, input: &Path) -> Result<MediaSummary, String> {
    let output = cmd(ffprobe)
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=index,codec_type,codec_name,pix_fmt,width,height",
            "-of",
            "json",
        ])
        .arg(input)
        .output()
        .map_err(|error| format!("Could not start ffprobe: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let parsed: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Could not parse ffprobe JSON: {error}"))?;
    let streams = parsed
        .get("streams")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut summary = MediaSummary::default();
    // Take the FIRST video stream and FIRST audio stream (v:0 / a:0), matching
    // how the rest of the app maps 0:v:0 / 0:a:0.
    for stream in &streams {
        let codec_type = stream
            .get("codec_type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let codec_name = stream
            .get("codec_name")
            .and_then(serde_json::Value::as_str)
            .map(|s| s.to_ascii_lowercase());
        match codec_type {
            "video" if summary.video_codec.is_none() => {
                summary.video_codec = codec_name;
                summary.pix_fmt = stream
                    .get("pix_fmt")
                    .and_then(serde_json::Value::as_str)
                    .map(|s| s.to_ascii_lowercase());
                summary.width = stream
                    .get("width")
                    .and_then(serde_json::Value::as_u64)
                    .map(|v| v as u32);
                summary.height = stream
                    .get("height")
                    .and_then(serde_json::Value::as_u64)
                    .map(|v| v as u32);
            }
            "audio" if summary.audio_codec.is_none() => {
                summary.audio_codec = codec_name;
            }
            _ => {}
        }
    }
    Ok(summary)
}

pub(crate) fn probe_has_audio_stream(ffprobe: &Path, input: &Path) -> Result<bool, String> {
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

pub(crate) fn run_ffmpeg_with_progress(
    window: &tauri::Window,
    ffmpeg: &Path,
    args: Vec<String>,
    duration: f64,
    label: &str,
    pid_slot: Option<&OnceLock<Mutex<Option<u32>>>>,
) -> Result<(), String> {
    run_ffmpeg_with_progress_tap(window, ffmpeg, args, duration, label, pid_slot, None)
}

// Same as run_ffmpeg_with_progress, plus an optional per-tick side-channel
// event. When `progress_tap` is Some((event_name, source_path)) the determinate
// percent is also forwarded on `event_name` as { sourcePath, percent, stage }
// so a caller (e.g. the featherweight source-proxy build) can carry the source
// identity alongside the percent without disturbing the shared
// "conversion-progress" stream. All existing callers pass None via the thin
// wrapper above.
#[allow(clippy::too_many_arguments)]
pub(crate) fn run_ffmpeg_with_progress_tap(
    window: &tauri::Window,
    ffmpeg: &Path,
    args: Vec<String>,
    duration: f64,
    label: &str,
    pid_slot: Option<&OnceLock<Mutex<Option<u32>>>>,
    progress_tap: Option<(&str, &str)>,
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
                        if let Some((event, source_path)) = progress_tap {
                            let _ = window.emit(
                                event,
                                json!({ "sourcePath": source_path, "percent": percent, "stage": "processing" }),
                            );
                        }
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
                if let Some((event, source_path)) = progress_tap {
                    let _ = window.emit(
                        event,
                        json!({ "sourcePath": source_path, "percent": 100.0, "stage": "finalizing" }),
                    );
                }
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

pub(crate) fn emit_conversion_progress(
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
