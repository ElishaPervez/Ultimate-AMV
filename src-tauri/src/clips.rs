use std::{
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::Stdio,
    thread,
};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{Emitter, Manager};
use tauri::async_runtime::Mutex as AsyncMutex;
use tokio::process::{Child as AsyncChild, Command as AsyncCommand};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader as AsyncBufReader};

use crate::{
    app_root, apply_python_env, apply_python_env_async, canonical_input_path, clear_child_pid,
    clip_cli_path, cmd, emit_conversion_progress, ensure_tool, ffmpeg_listing, find_tool,
    kill_child_pid, log_error, log_info, log_warn, python_exe, run_ffmpeg_with_progress,
    sanitize_path_segment, serialize_clip_preview_done, short_stable_id, store_child_pid,
    truncate_log_text, append_app_log, CLIP_CHILD_PID, CLIP_SERVER, ConversionDone,
    H264_NVENC_AVAILABLE,
};

#[derive(Deserialize)]
pub(crate) struct ExportClip {
    pub source: String,
    pub start: f64,
    pub end: f64,
    pub index: usize,
    pub fps: Option<f64>,
}

fn preset_extension(preset: &str) -> &'static str {
    match preset {
        "prores-lt" | "prores-hq" | "gpu-intra" => "mov",
        "h264-cpu" | "hevc-cpu" | "h264-nvenc" | "av1-nvenc" => "mp4",
        _ => "mov",
    }
}

#[tauri::command]
pub(crate) async fn clip_export(
    window: tauri::Window,
    clips: Vec<ExportClip>,
    output_dir: String,
    preset: String,
    quality_value: Option<i32>,
) -> Result<String, String> {
    if !matches!(preset.as_str(), "gpu-intra" | "prores-lt" | "prores-hq" | "h264-nvenc" | "av1-nvenc" | "h264-cpu" | "hevc-cpu") {
        return Err("Video preset must be gpu-intra, prores-lt, prores-hq, h264-nvenc, av1-nvenc, h264-cpu, or hevc-cpu".to_string());
    }
    log_info(
        "clip.export.start",
        "Starting clip export",
        json!({ "clipCount": clips.len(), "outputDir": &output_dir, "preset": &preset, "qualityValue": quality_value }),
    );
    let log_clip_count = clips.len();
    let log_output_dir = output_dir.clone();
    let log_preset = preset.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_clip_export(window, clips, output_dir, preset, quality_value)
    })
    .await
    .map_err(|error| error.to_string())?;
    match &result {
        Ok(payload) => log_info(
            "clip.export.complete",
            "Clip export completed",
            json!({ "clipCount": log_clip_count, "outputDir": log_output_dir, "preset": log_preset, "qualityValue": quality_value, "result": payload }),
        ),
        Err(error) => log_error(
            "clip.export.error",
            "Clip export failed",
            json!({ "clipCount": log_clip_count, "outputDir": log_output_dir, "preset": log_preset, "qualityValue": quality_value, "error": error }),
        ),
    }
    result
}

fn clamp_quality(quality: Option<i32>, min: i32, max: i32, default: i32) -> i32 {
    match quality {
        Some(value) => value.clamp(min, max),
        None => default,
    }
}

fn run_clip_export(
    window: tauri::Window,
    clips: Vec<ExportClip>,
    output_dir: String,
    preset: String,
    quality_value: Option<i32>,
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

        let ext = preset_extension(&preset);
        let output = loop {
            let candidate = out_dir.join(format!("{file_index}.{ext}"));
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

        let input_args = vec![
            "-ss".to_string(),
            format!("{export_start:.3}"),
            "-i".to_string(),
            input.to_string_lossy().to_string(),
            "-t".to_string(),
            format!("{export_duration:.3}"),
        ];

        let message = match preset.as_str() {
            "gpu-intra" => {
                let qp = clamp_quality(quality_value, 10, 28, 16);
                args.extend(input_args.iter().cloned());
                args.extend([
                    "-c:v".to_string(),
                    "hevc_nvenc".to_string(),
                    "-preset".to_string(),
                    "p1".to_string(),
                    "-rc".to_string(),
                    "constqp".to_string(),
                    "-qp".to_string(),
                    qp.to_string(),
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
                let cq = clamp_quality(quality_value, 14, 28, 18);
                args.extend(input_args.iter().cloned());
                args.extend([
                    "-c:v".to_string(),
                    "h264_nvenc".to_string(),
                    "-preset".to_string(),
                    "p4".to_string(),
                    "-rc".to_string(),
                    "constqp".to_string(),
                    "-cq".to_string(),
                    cq.to_string(),
                    "-spatial-aq".to_string(),
                    "1".to_string(),
                    "-temporal-aq".to_string(),
                    "1".to_string(),
                    "-c:a".to_string(),
                    "aac".to_string(),
                    "-b:a".to_string(),
                    "320k".to_string(),
                    "-movflags".to_string(),
                    "+faststart".to_string(),
                ]);
                format!("Encoding H.264 (NVENC) clip {}/{}", i + 1, clips.len())
            }
            "av1-nvenc" => {
                let cq = clamp_quality(quality_value, 18, 34, 24);
                args.extend(input_args.iter().cloned());
                args.extend([
                    "-c:v".to_string(),
                    "av1_nvenc".to_string(),
                    "-preset".to_string(),
                    "p4".to_string(),
                    "-rc".to_string(),
                    "constqp".to_string(),
                    "-cq".to_string(),
                    cq.to_string(),
                    "-spatial-aq".to_string(),
                    "1".to_string(),
                    "-temporal-aq".to_string(),
                    "1".to_string(),
                    "-c:a".to_string(),
                    "aac".to_string(),
                    "-b:a".to_string(),
                    "320k".to_string(),
                    "-movflags".to_string(),
                    "+faststart".to_string(),
                ]);
                format!("Encoding AV1 (NVENC) clip {}/{}", i + 1, clips.len())
            }
            "h264-cpu" => {
                let crf = clamp_quality(quality_value, 14, 28, 18);
                args.extend(input_args.iter().cloned());
                args.extend([
                    "-c:v".to_string(),
                    "libx264".to_string(),
                    "-preset".to_string(),
                    "slow".to_string(),
                    "-crf".to_string(),
                    crf.to_string(),
                    "-c:a".to_string(),
                    "aac".to_string(),
                    "-b:a".to_string(),
                    "320k".to_string(),
                    "-movflags".to_string(),
                    "+faststart".to_string(),
                ]);
                format!("Encoding H.264 (CPU) clip {}/{}", i + 1, clips.len())
            }
            "hevc-cpu" => {
                let crf = clamp_quality(quality_value, 14, 28, 18);
                args.extend(input_args.iter().cloned());
                args.extend([
                    "-c:v".to_string(),
                    "libx265".to_string(),
                    "-tag:v".to_string(),
                    "hvc1".to_string(),
                    "-preset".to_string(),
                    "slow".to_string(),
                    "-crf".to_string(),
                    crf.to_string(),
                    "-c:a".to_string(),
                    "aac".to_string(),
                    "-b:a".to_string(),
                    "320k".to_string(),
                    "-movflags".to_string(),
                    "+faststart".to_string(),
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
        let primary_result = run_ffmpeg_with_progress(
            &window,
            &ffmpeg,
            args,
            duration,
            "Exporting clip",
            Some(&CLIP_CHILD_PID),
        );

        if let Err(primary_error) = primary_result {
            if preset == "gpu-intra" {
                let qp = clamp_quality(quality_value, 10, 28, 16);
                log_warn(
                    "clip.export.fallback",
                    "GPU Intra NVENC failed; retrying with libx264 software encoder",
                    json!({ "clip": i + 1, "error": &primary_error }),
                );
                let _ = fs::remove_file(&output);
                let mut fallback_args: Vec<String> = vec![
                    "-y".to_string(),
                    "-hide_banner".to_string(),
                    "-nostdin".to_string(),
                ];
                fallback_args.extend(input_args.iter().cloned());
                fallback_args.extend([
                    "-c:v".to_string(),
                    "libx264".to_string(),
                    "-preset".to_string(),
                    "slow".to_string(),
                    "-crf".to_string(),
                    qp.to_string(),
                    "-pix_fmt".to_string(),
                    "yuv420p".to_string(),
                    "-c:a".to_string(),
                    "aac".to_string(),
                    "-b:a".to_string(),
                    "320k".to_string(),
                    "-progress".to_string(),
                    "pipe:1".to_string(),
                    "-stats_period".to_string(),
                    "0.5".to_string(),
                    output.to_string_lossy().to_string(),
                ]);
                run_ffmpeg_with_progress(
                    &window,
                    &ffmpeg,
                    fallback_args,
                    duration,
                    "Exporting clip (libx264 fallback)",
                    Some(&CLIP_CHILD_PID),
                )?;
            } else {
                return Err(primary_error);
            }
        }
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
pub(crate) async fn clip_export_merged(
    window: tauri::Window,
    clips: Vec<ExportClip>,
    output_dir: String,
    preset: String,
    quality_value: Option<i32>,
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
        json!({ "clipCount": clips.len(), "outputDir": &output_dir, "preset": &preset, "qualityValue": quality_value }),
    );
    let log_clip_count = clips.len();
    let log_output_dir = output_dir.clone();
    let log_preset = preset.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_clip_export_merged(window, clips, output_dir, preset, quality_value)
    })
    .await
    .map_err(|error| error.to_string())?;
    match &result {
        Ok(payload) => log_info(
            "clip.export_merged.complete",
            "Merged clip export completed",
            json!({ "clipCount": log_clip_count, "outputDir": log_output_dir, "preset": log_preset, "qualityValue": quality_value, "result": payload }),
        ),
        Err(error) => log_error(
            "clip.export_merged.error",
            "Merged clip export failed",
            json!({ "clipCount": log_clip_count, "outputDir": log_output_dir, "preset": log_preset, "qualityValue": quality_value, "error": error }),
        ),
    }
    result
}

fn run_clip_export_merged(
    window: tauri::Window,
    clips: Vec<ExportClip>,
    output_dir: String,
    preset: String,
    quality_value: Option<i32>,
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
    let ext = preset_extension(&preset);
    let mut output = out_dir.join(format!("{base_name}.{ext}"));
    let mut suffix = 1;
    while output.exists() {
        output = out_dir.join(format!("{base_name} ({suffix}).{ext}"));
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

    let encode_args: Vec<String> = match preset.as_str() {
        "gpu-intra" => {
            let qp = clamp_quality(quality_value, 10, 28, 16);
            vec![
                "-c:v".to_string(), "hevc_nvenc".to_string(),
                "-preset".to_string(), "p1".to_string(),
                "-rc".to_string(), "constqp".to_string(),
                "-qp".to_string(), qp.to_string(),
                "-g".to_string(), "1".to_string(),
                "-bf".to_string(), "0".to_string(),
                "-profile:v".to_string(), "main10".to_string(),
                "-highbitdepth".to_string(), "1".to_string(),
                "-c:a".to_string(), "aac".to_string(),
                "-b:a".to_string(), "320k".to_string(),
            ]
        }
        "prores-lt" | "prores-hq" => {
            let profile = if preset == "prores-lt" { "1" } else { "3" };
            vec![
                "-c:v".to_string(), "prores_ks".to_string(),
                "-profile:v".to_string(), profile.to_string(),
                "-pix_fmt".to_string(), "yuv422p10le".to_string(),
                "-c:a".to_string(), "pcm_s16le".to_string(),
            ]
        }
        "h264-nvenc" => {
            let cq = clamp_quality(quality_value, 14, 28, 18);
            vec![
                "-c:v".to_string(), "h264_nvenc".to_string(),
                "-preset".to_string(), "p4".to_string(),
                "-rc".to_string(), "constqp".to_string(),
                "-cq".to_string(), cq.to_string(),
                "-spatial-aq".to_string(), "1".to_string(),
                "-temporal-aq".to_string(), "1".to_string(),
                "-c:a".to_string(), "aac".to_string(),
                "-b:a".to_string(), "320k".to_string(),
                "-movflags".to_string(), "+faststart".to_string(),
            ]
        }
        "av1-nvenc" => {
            let cq = clamp_quality(quality_value, 18, 34, 24);
            vec![
                "-c:v".to_string(), "av1_nvenc".to_string(),
                "-preset".to_string(), "p4".to_string(),
                "-rc".to_string(), "constqp".to_string(),
                "-cq".to_string(), cq.to_string(),
                "-spatial-aq".to_string(), "1".to_string(),
                "-temporal-aq".to_string(), "1".to_string(),
                "-c:a".to_string(), "aac".to_string(),
                "-b:a".to_string(), "320k".to_string(),
                "-movflags".to_string(), "+faststart".to_string(),
            ]
        }
        "h264-cpu" => {
            let crf = clamp_quality(quality_value, 14, 28, 18);
            vec![
                "-c:v".to_string(), "libx264".to_string(),
                "-preset".to_string(), "slow".to_string(),
                "-crf".to_string(), crf.to_string(),
                "-c:a".to_string(), "aac".to_string(),
                "-b:a".to_string(), "320k".to_string(),
                "-movflags".to_string(), "+faststart".to_string(),
            ]
        }
        "hevc-cpu" => {
            let crf = clamp_quality(quality_value, 14, 28, 18);
            vec![
                "-c:v".to_string(), "libx265".to_string(),
                "-tag:v".to_string(), "hvc1".to_string(),
                "-preset".to_string(), "slow".to_string(),
                "-crf".to_string(), crf.to_string(),
                "-c:a".to_string(), "aac".to_string(),
                "-b:a".to_string(), "320k".to_string(),
                "-movflags".to_string(), "+faststart".to_string(),
            ]
        }
        _ => unreachable!(),
    };

    let pre_encode_args = args.clone();
    args.extend(encode_args);

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
    let primary_result = run_ffmpeg_with_progress(
        &window,
        &ffmpeg,
        args,
        total_duration,
        "Merging clips",
        Some(&CLIP_CHILD_PID),
    );
    if let Err(primary_error) = primary_result {
        if preset == "gpu-intra" {
            let crf = clamp_quality(quality_value, 10, 28, 16);
            log_warn(
                "clip.export_merged.fallback",
                "GPU Intra NVENC failed during merge; retrying with libx264 software encoder",
                json!({ "error": &primary_error }),
            );
            let _ = fs::remove_file(&output);
            let mut fallback_args = pre_encode_args;
            fallback_args.extend([
                "-c:v".to_string(), "libx264".to_string(),
                "-preset".to_string(), "slow".to_string(),
                "-crf".to_string(), crf.to_string(),
                "-pix_fmt".to_string(), "yuv420p".to_string(),
                "-c:a".to_string(), "aac".to_string(),
                "-b:a".to_string(), "320k".to_string(),
                "-progress".to_string(), "pipe:1".to_string(),
                "-stats_period".to_string(), "0.5".to_string(),
                output.to_string_lossy().to_string(),
            ]);
            run_ffmpeg_with_progress(
                &window,
                &ffmpeg,
                fallback_args,
                total_duration,
                "Merging clips (libx264 fallback)",
                Some(&CLIP_CHILD_PID),
            )?;
        } else {
            return Err(primary_error);
        }
    }

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
pub(crate) async fn scene_clip_render(
    window: tauri::Window,
    scene_id: String,
    source_path: String,
    start: f64,
    end: f64,
) -> Result<String, String> {
    log_info(
        "scene.clip.start",
        "Starting scene clip render",
        json!({ "sceneId": &scene_id, "source": &source_path, "start": start, "end": end }),
    );
    let app_data_dir = window
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not get app data directory: {error}"))?;

    let log_scene_id = scene_id.clone();
    let log_source = source_path.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        generate_scene_clip(app_data_dir, scene_id, source_path, start, end)
    })
    .await
    .map_err(|error| error.to_string())?;

    match &result {
        Ok(payload) => log_info(
            "scene.clip.complete",
            "Scene clip render completed",
            json!({ "sceneId": log_scene_id, "source": log_source, "result": payload }),
        ),
        Err(error) => log_error(
            "scene.clip.error",
            "Scene clip render failed",
            json!({ "sceneId": log_scene_id, "source": log_source, "error": error }),
        ),
    }
    result
}

fn generate_scene_clip(
    app_data_dir: PathBuf,
    scene_id: String,
    source_path: String,
    start: f64,
    end: f64,
) -> Result<String, String> {
    if !start.is_finite() || !end.is_finite() || end <= start {
        return Err("Scene range must have a valid start and end time.".to_string());
    }

    let root = app_root()?;
    let ffmpeg = find_tool(&root, "ffmpeg");
    ensure_tool(&ffmpeg)?;

    let input = canonical_input_path(&source_path)?;
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
        .join("scene_clips")
        .join(format!("{source_name}-{source_key}"));
    fs::create_dir_all(&cache_dir)
        .map_err(|error| format!("Could not create scene clip cache folder: {error}"))?;

    let start_key = format!("{:.3}", start);
    let end_key = format!("{:.3}", end);
    // v4: -hwaccel auto for universal hardware decode acceleration.
    let range_key = short_stable_id(&[&scene_id, &start_key, &end_key, "scene-clip-v4"]);
    let safe_scene_id = sanitize_path_segment(&scene_id, "scene", 48).replace(' ', "_");
    let output = cache_dir.join(format!("{safe_scene_id}-{range_key}.mp4"));
    let duration = (end - start).max(0.05);

    if output
        .metadata()
        .map(|metadata| metadata.len() > 1024)
        .unwrap_or(false)
    {
        return serialize_clip_preview_done(scene_id, output, duration, true);
    }

    let use_nvenc = *H264_NVENC_AVAILABLE
        .get_or_init(|| ffmpeg_listing(&ffmpeg, "-encoders").contains("h264_nvenc"));

    if let Err(error) = render_scene_clip_job(&ffmpeg, &input, &output, start, duration, use_nvenc)
    {
        // Software fallback: NVENC can refuse some sources (10-bit HEVC, exotic
        // pixel formats) where libx264 still happily encodes.
        if use_nvenc {
            render_scene_clip_job(&ffmpeg, &input, &output, start, duration, false)?;
        } else {
            return Err(error);
        }
    }

    serialize_clip_preview_done(scene_id, output, duration, false)
}

fn render_scene_clip_job(
    ffmpeg: &Path,
    input: &Path,
    output: &Path,
    start: f64,
    duration: f64,
    use_nvenc: bool,
) -> Result<(), String> {
    // Dual -ss for fast accurate seek:
    //   - Coarse -ss BEFORE -i: ffmpeg keyframe-seeks straight to ~2s before
    //     the cut. Without this, the demuxer walks every packet from t=0,
    //     which for a scene 18 minutes into an episode is the dominant cost
    //     of the whole render (~3-5s of wasted decode work).
    //   - Precise -ss AFTER -i: decodes-and-discards the remaining frames up
    //     to the exact cut point. This preserves the original scene-boundary
    //     semantics (no encoder "bleed" frames at the head) - see
    //     CLAUDE.md "Clip extractor : scene boundary semantics".
    // -avoid_negative_ts make_zero is the muxer-level safety net for any
    // residual negative PTS.
    let coarse_back: f64 = 2.0;
    let coarse_start = (start - coarse_back).max(0.0);
    let fine_offset = (start - coarse_start).max(0.0);
    let mut args: Vec<String> = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-nostdin".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-ss".to_string(),
        format!("{coarse_start:.3}"),
        // Universal HW decode: NVDEC on NVIDIA, QSV on Intel, D3D11VA on AMD,
        // software fallback otherwise. NOT NVIDIA-gated - works on any GPU and
        // degrades to software cleanly per the CPU/GPU parity rule.
        "-hwaccel".to_string(),
        "auto".to_string(),
        "-i".to_string(),
        input.to_string_lossy().to_string(),
        "-ss".to_string(),
        format!("{fine_offset:.3}"),
        "-t".to_string(),
        format!("{duration:.3}"),
        // Optional audio mapping: silent sources skip the audio stream without
        // failing the encode.
        "-map".to_string(),
        "0:v:0".to_string(),
        "-map".to_string(),
        "0:a:0?".to_string(),
        // Downscale to 720p max (preserve aspect, round width to even). The
        // min() guard keeps sub-720p sources at native size instead of
        // upscaling, which would just slow the encode for no quality gain.
        // Single quotes are intentional - they tell ffmpeg's expression
        // parser to treat the inner comma as a function arg, not a filter
        // chain separator.
        "-vf".to_string(),
        "scale=-2:'min(720,ih)'".to_string(),
    ];

    if use_nvenc {
        args.extend([
            "-c:v".to_string(),
            "h264_nvenc".to_string(),
            "-preset".to_string(),
            "p1".to_string(),
            "-cq".to_string(),
            "23".to_string(),
            "-pix_fmt".to_string(),
            "yuv420p".to_string(),
        ]);
    } else {
        args.extend([
            "-c:v".to_string(),
            "libx264".to_string(),
            "-preset".to_string(),
            "ultrafast".to_string(),
            "-crf".to_string(),
            "23".to_string(),
            "-pix_fmt".to_string(),
            "yuv420p".to_string(),
        ]);
    }

    args.extend([
        "-c:a".to_string(),
        "aac".to_string(),
        "-b:a".to_string(),
        "128k".to_string(),
        "-ac".to_string(),
        "2".to_string(),
        "-avoid_negative_ts".to_string(),
        "make_zero".to_string(),
        "-movflags".to_string(),
        "+faststart".to_string(),
        output.to_string_lossy().to_string(),
    ]);

    let result = cmd(ffmpeg)
        .args(args)
        .output()
        .map_err(|error| format!("Could not start ffmpeg scene clip renderer: {error}"))?;
    if result.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&result.stderr).trim().to_string();
    if stderr.is_empty() {
        Err(format!(
            "Scene clip renderer exited with code {}",
            result.status.code().unwrap_or(-1)
        ))
    } else {
        Err(stderr)
    }
}

// Pay ffmpeg's cold-start tax (process spawn + DLL loads + NVENC capability
// probe) once at app warmup, not on the user's first scene-preview click.
// On Windows the first ffmpeg invocation per session is ~400-900ms slower
// than subsequent ones because tools/ffmpeg-shared/avcodec-62.dll and ~6
// other DLLs cold-load from disk; the NVENC probe doubles that by spawning
// a second ffmpeg just to ask `-encoders`. Done as a fire-and-forget
// background task so it doesn't block the rest of the warmup.
//
// Idempotent: if H264_NVENC_AVAILABLE is already set, the work has already
// been done in this process, so subsequent calls are no-ops. Both clip
// modes (CPU + GPU) hit scene_clip_render, so the warmup is registered as
// its own Tauri command and called unconditionally from app startup -
// gating it on clipMode would leave CPU users with the cold-start tax on
// their first preview click, violating the CPU/GPU parity rule.
fn warm_ffmpeg_background() {
    if H264_NVENC_AVAILABLE.get().is_some() {
        return;
    }
    std::thread::spawn(|| {
        let Ok(root) = app_root() else { return };
        let ffmpeg = find_tool(&root, "ffmpeg");
        if ensure_tool(&ffmpeg).is_err() {
            log_warn(
                "clip.warmup.ffmpeg.missing",
                "Could not warm ffmpeg: binary not found",
                Value::Null,
            );
            return;
        }
        // Touch the DLLs by running a no-op. We don't care about the output.
        let _ = cmd(&ffmpeg)
            .args(["-hide_banner", "-version"])
            .output();
        // Cache the NVENC capability so the first scene_clip_render doesn't
        // spawn a second ffmpeg to discover it.
        H264_NVENC_AVAILABLE
            .get_or_init(|| ffmpeg_listing(&ffmpeg, "-encoders").contains("h264_nvenc"));
        log_info(
            "clip.warmup.ffmpeg.done",
            "Warmed ffmpeg DLL cache + NVENC probe",
            Value::Null,
        );
    });
}

#[tauri::command]
pub(crate) async fn warmup_ffmpeg() -> Result<(), String> {
    warm_ffmpeg_background();
    Ok(())
}

#[tauri::command]
pub(crate) async fn warmup_clip_server(app: tauri::AppHandle) -> Result<(), String> {
    log_info("clip.server.warmup.start", "Starting clip server warmup", Value::Null);
    warm_ffmpeg_background();
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
    apply_python_env_async(&mut command);

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
pub(crate) async fn clip_extract(window: tauri::Window, input_path: String, mode: String) -> Result<String, String> {
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

#[tauri::command]
pub(crate) async fn clip_compat_convert(
    window: tauri::Window,
    input_path: String,
) -> Result<String, String> {
    log_info(
        "clip.compat.start",
        "Starting compatibility conversion",
        json!({ "input": &input_path }),
    );
    let app_data_dir = window
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not get app data directory: {error}"))?;

    let log_input = input_path.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_clip_compat_convert(window, app_data_dir, input_path)
    })
    .await
    .map_err(|error| error.to_string())?;
    match &result {
        Ok(payload) => log_info(
            "clip.compat.complete",
            "Compatibility conversion completed",
            json!({ "input": log_input, "result": payload }),
        ),
        Err(error) => log_error(
            "clip.compat.error",
            "Compatibility conversion failed",
            json!({ "input": log_input, "error": error }),
        ),
    }
    result
}

fn run_clip_compat_convert(
    window: tauri::Window,
    app_data_dir: PathBuf,
    input_path: String,
) -> Result<String, String> {
    let input = canonical_input_path(&input_path)?;
    let metadata = input
        .metadata()
        .map_err(|error| format!("Could not read source metadata: {error}"))?;
    let size_key = format!("{}", metadata.len());
    let mtime_key = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| format!("{}", d.as_millis()))
        .unwrap_or_default();
    let path_key = input.to_string_lossy().to_string();
    let cache_key = short_stable_id(&[
        &path_key,
        &size_key,
        &mtime_key,
        "compat-h264-mp4-v1",
    ]);

    let source_name = sanitize_path_segment(
        input
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("source"),
        "source",
        48,
    )
    .replace(' ', "_");

    let cache_dir = app_data_dir.join("clip_compat_cache");
    fs::create_dir_all(&cache_dir)
        .map_err(|error| format!("Could not create compat cache folder: {error}"))?;

    let output = cache_dir.join(format!("{source_name}-{cache_key}.mp4"));
    if output
        .metadata()
        .map(|m| m.len() > 1024)
        .unwrap_or(false)
    {
        log_info(
            "clip.compat.cache_hit",
            "Reusing cached compatible copy",
            json!({ "input": &path_key, "output": output.to_string_lossy() }),
        );
        let _ = window.emit(
            "clip-progress",
            json!({
                "type": "progress",
                "stage": "complete",
                "percent": 100,
                "message": "Using cached compatible copy",
            }),
        );
        return Ok(json!({
            "type": "done",
            "output": output.to_string_lossy().to_string(),
            "cached": true,
        })
        .to_string());
    }

    let root = app_root()?;
    let ffmpeg = find_tool(&root, "ffmpeg");
    let ffprobe = find_tool(&root, "ffprobe");
    ensure_tool(&ffmpeg)?;
    ensure_tool(&ffprobe)?;

    let duration_seconds = probe_duration_seconds(&ffprobe, &input).unwrap_or(0.0);

    let temp_output = output.with_extension("converting.mp4");
    let _ = fs::remove_file(&temp_output);

    let _ = window.emit(
        "clip-progress",
        json!({
            "type": "progress",
            "stage": "starting",
            "percent": 0,
            "message": "Converting to compatible format...",
        }),
    );

    let mut child = cmd(&ffmpeg)
        .arg("-hide_banner")
        .arg("-loglevel").arg("error")
        .arg("-y")
        .arg("-i").arg(&input)
        .arg("-map").arg("0:v:0")
        .arg("-map").arg("0:a:0?")
        .arg("-c:v").arg("libx264")
        .arg("-preset").arg("veryfast")
        .arg("-crf").arg("20")
        .arg("-pix_fmt").arg("yuv420p")
        .arg("-c:a").arg("aac")
        .arg("-b:a").arg("192k")
        .arg("-movflags").arg("+faststart")
        .arg("-progress").arg("pipe:1")
        .arg("-nostats")
        .arg(&temp_output)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start ffmpeg: {error}"))?;

    let stdout = child.stdout.take();
    let progress_handle = stdout.map(|stdout| {
        let window_clone = window.clone();
        let total = duration_seconds;
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if let Some(rest) = line.strip_prefix("out_time_ms=") {
                    if let Ok(us) = rest.trim().parse::<u64>() {
                        let secs = us as f64 / 1_000_000.0;
                        let percent = if total > 0.0 {
                            (secs / total * 100.0).clamp(0.0, 99.0)
                        } else {
                            0.0
                        };
                        let message = if total > 0.0 {
                            format!("Converting... {percent:.0}%")
                        } else {
                            "Converting to compatible format...".to_string()
                        };
                        let _ = window_clone.emit(
                            "clip-progress",
                            json!({
                                "type": "progress",
                                "stage": "decode",
                                "percent": percent,
                                "message": message,
                            }),
                        );
                    }
                }
            }
        })
    });

    let stderr = child.stderr.take();
    let stderr_handle = stderr.map(|mut stderr| {
        thread::spawn(move || {
            use std::io::Read;
            let mut buf = String::new();
            let _ = stderr.read_to_string(&mut buf);
            buf
        })
    });

    let status = child
        .wait()
        .map_err(|error| format!("ffmpeg wait failed: {error}"))?;
    let _ = progress_handle.map(|h| h.join());
    let stderr_text = stderr_handle
        .and_then(|h| h.join().ok())
        .unwrap_or_default();

    if !status.success() {
        let _ = fs::remove_file(&temp_output);
        let trimmed = stderr_text.trim();
        let message = if trimmed.is_empty() {
            "Could not convert this file. The source may be corrupted or use a codec ffmpeg can't decode.".to_string()
        } else {
            format!(
                "Could not convert this file to a compatible format.\n\n{}",
                trimmed
            )
        };
        return Err(message);
    }

    fs::rename(&temp_output, &output)
        .map_err(|error| format!("Could not finalize converted file: {error}"))?;

    let _ = window.emit(
        "clip-progress",
        json!({
            "type": "progress",
            "stage": "complete",
            "percent": 100,
            "message": "Conversion complete",
        }),
    );

    Ok(json!({
        "type": "done",
        "output": output.to_string_lossy().to_string(),
        "cached": false,
    })
    .to_string())
}

fn probe_duration_seconds(ffprobe: &Path, input: &Path) -> Option<f64> {
    let output = cmd(ffprobe)
        .arg("-v").arg("error")
        .arg("-show_entries").arg("format=duration")
        .arg("-of").arg("default=nokey=1:noprint_wrappers=1")
        .arg(input)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    text.trim().parse::<f64>().ok()
}

fn run_streaming_clip_cli(window: tauri::Window, args: Vec<String>) -> Result<String, String> {
    let root = app_root()?;
    log_info(
        "clip.bridge.start",
        "Starting one-shot clip bridge",
        json!({ "args": &args }),
    );
    let mut command = cmd(python_exe(&root));
    command
        .arg("-I")
        .arg(clip_cli_path(&root))
        .args(&args)
        .current_dir(&root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_python_env(&mut command);
    let mut child = command.spawn().map_err(|error| {
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

pub(crate) async fn stop_clip_processes_for_dependency_setup(window: &tauri::Window) {
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

#[tauri::command]
pub(crate) async fn cancel_clip(window: tauri::Window) {
    log_warn("clip.cancel", "Cancelling active clip process", Value::Null);
    kill_child_pid(&CLIP_CHILD_PID);

    // The persistent clip server runs nelux/torchcodec native code that can
    // hang in C++ on unsupported codecs without ever raising. The one-shot
    // PID kill above doesn't touch this child : we must stop it explicitly
    // so the next extraction starts on a fresh process instead of writing
    // to a stuck stdin.
    if let Some(mutex) = CLIP_SERVER.get() {
        let mut guard = mutex.lock().await;
        if let Some(mut child) = guard.take() {
            log_info("clip.server.kill", "Stopping clip server on cancel", Value::Null);
            let _ = window.emit(
                "clip-server-event",
                json!({ "type": "stopped", "reason": "cancel" }),
            );
            if let Err(error) = child.start_kill() {
                log_warn(
                    "clip.server.kill.warning",
                    "Could not request clip server stop on cancel",
                    json!({ "error": error.to_string() }),
                );
            } else {
                let _ = tokio::time::timeout(
                    std::time::Duration::from_secs(3),
                    child.wait(),
                )
                .await;
            }
        }
    }
}
