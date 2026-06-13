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
    clip_cli_path, cmd, content_fingerprint, emit_conversion_progress, ensure_tool, ffmpeg_listing,
    find_tool, kill_child_pid, log_error, log_info, log_warn, probe_duration,
    probe_has_audio_stream, probe_media_summary, python_exe, run_ffmpeg_with_progress,
    sanitize_path_segment,
    serialize_clip_preview_done, short_stable_id, store_child_pid, truncate_log_text,
    append_app_log, MediaSummary, CLIP_CHILD_PID, CLIP_SERVER, PROXY_CHILD_PID,
    ConversionDone, H264_NVENC_AVAILABLE,
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
        // Stream-copy preset: container must tolerate arbitrary source codecs
        // (10-bit HEVC, AV1, exotic profiles) without re-muxing limits. MKV is
        // the robust choice — MP4/MOV reject several codecs on -c copy.
        "lossless-cut" => "mkv",
        _ => "mov",
    }
}

const VIDEO_PRESETS: &[&str] = &[
    "gpu-intra",
    "prores-lt",
    "prores-hq",
    "h264-nvenc",
    "av1-nvenc",
    "h264-cpu",
    "hevc-cpu",
    "lossless-cut",
];

// Source color metadata read off the input stream with ffprobe. We TAG these
// onto every re-encode output (no pixel conversion) so downstream players /
// NLEs stop guessing range + matrix and crushing or washing the blacks.
#[derive(Clone, Default)]
struct ColorMetadata {
    primaries: Option<String>,
    transfer: Option<String>,
    matrix: Option<String>,
    range: Option<String>,
}

fn ffprobe_color_field(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() || trimmed == "unknown" || trimmed == "N/A" || trimmed == "reserved" {
        return None;
    }
    Some(trimmed.to_string())
}

// Probe color_primaries / color_transfer / color_space (matrix) / color_range
// off the first video stream. Anything missing falls back to the BT.709
// limited-range default (the anime Blu-ray standard) so the output is always
// fully tagged rather than left unlabeled.
fn probe_color_metadata(ffprobe: &Path, input: &Path) -> ColorMetadata {
    let output = cmd(ffprobe)
        .arg("-v").arg("error")
        .arg("-select_streams").arg("v:0")
        .arg("-show_entries")
        .arg("stream=color_primaries,color_transfer,color_space,color_range")
        .arg("-of").arg("default=noprint_wrappers=1:nokey=0")
        .arg(input)
        .output();

    let mut meta = ColorMetadata::default();
    if let Ok(out) = output {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                let Some((key, value)) = line.split_once('=') else { continue };
                match key.trim() {
                    "color_primaries" => meta.primaries = ffprobe_color_field(Some(value)),
                    "color_transfer" => meta.transfer = ffprobe_color_field(Some(value)),
                    "color_space" => meta.matrix = ffprobe_color_field(Some(value)),
                    "color_range" => meta.range = ffprobe_color_field(Some(value)),
                    _ => {}
                }
            }
        }
    }
    meta
}

// Resolve the four color fields to concrete values, defaulting untagged
// sources to BT.709 limited (tv) — the anime BD standard. Returned as
// (primaries, transfer, matrix, range) where range is normalized to tv/pc.
fn resolved_color(meta: &ColorMetadata) -> (String, String, String, &'static str) {
    let primaries = meta.primaries.clone().unwrap_or_else(|| "bt709".to_string());
    let transfer = meta.transfer.clone().unwrap_or_else(|| "bt709".to_string());
    let matrix = meta.matrix.clone().unwrap_or_else(|| "bt709".to_string());
    let range = match meta.range.as_deref() {
        Some("pc") | Some("full") | Some("jpeg") => "pc",
        // tv / limited / mpeg / unknown all map to limited range.
        _ => "tv",
    };
    (primaries, transfer, matrix, range)
}

// Build the output-side color TAG flags. These label the bitstream; they do
// not run any zscale/colorspace pixel conversion. NOTE: on their own these
// flags are not enough — ffmpeg only writes color_primaries / color_trc into
// the encoder VUI when the *frames* carry those properties, so a matching
// setparams filter (see setparams_filter) must run on the video too. We emit
// both: the filter stamps the frame metadata, these flags stamp the muxer.
fn color_tag_args(meta: &ColorMetadata) -> Vec<String> {
    let (primaries, transfer, matrix, range) = resolved_color(meta);
    vec![
        "-color_primaries".to_string(),
        primaries,
        "-color_trc".to_string(),
        transfer,
        "-colorspace".to_string(),
        matrix,
        "-color_range".to_string(),
        range.to_string(),
    ]
}

// The setparams filter that stamps the resolved color metadata onto the
// frames. Required alongside color_tag_args so color_primaries / color_trc
// actually reach the encoder VUI (passing the -color_* output flags alone
// leaves primaries + transfer "unknown" in the bitstream). Pixel data is
// untouched — setparams only labels.
fn setparams_filter(meta: &ColorMetadata) -> String {
    let (primaries, transfer, matrix, range) = resolved_color(meta);
    format!(
        "setparams=color_primaries={primaries}:color_trc={transfer}:colorspace={matrix}:range={range}"
    )
}

#[tauri::command]
pub(crate) async fn clip_export(
    window: tauri::Window,
    clips: Vec<ExportClip>,
    output_dir: String,
    preset: String,
    quality_value: Option<i32>,
) -> Result<String, String> {
    if !VIDEO_PRESETS.contains(&preset.as_str()) {
        return Err("Video preset must be gpu-intra, prores-lt, prores-hq, h264-nvenc, av1-nvenc, h264-cpu, hevc-cpu, or lossless-cut".to_string());
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

// Corrected (start, duration) for a clip cut. The 1.5/fps offset guarantees we
// skip the last frame of the previous clip, which is often included due to
// exact-boundary floating-point rounding; non-trivial durations are trimmed by
// 15ms for the same reason at the tail.
fn padded_clip_range(clip: &ExportClip) -> (f64, f64) {
    let fps = clip.fps.filter(|f| *f > 0.0).unwrap_or(24.0);
    let offset = 1.5 / fps;
    let start = clip.start + offset;
    let raw_duration = (clip.end - start).max(0.0);
    let duration = if raw_duration > 0.05 {
        raw_duration - 0.015
    } else {
        raw_duration
    };
    (start, duration)
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
        let color = probe_color_metadata(&ffprobe, &input);

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

        let (export_start, export_duration) = padded_clip_range(clip);

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
            "lossless-cut" => {
                // Bit-exact stream copy — no re-encode. Keyframe-only seek:
                // -ss BEFORE -i snaps the cut to the nearest preceding
                // keyframe (NOT frame-accurate; surfaced in the UI). Color
                // metadata rides along untouched with -c copy, so no color
                // tag flags are appended for this preset.
                args.extend([
                    "-ss".to_string(),
                    format!("{export_start:.3}"),
                    "-i".to_string(),
                    input.to_string_lossy().to_string(),
                    "-t".to_string(),
                    format!("{export_duration:.3}"),
                    "-map".to_string(),
                    "0:v:0".to_string(),
                    "-map".to_string(),
                    "0:a:0?".to_string(),
                    "-c".to_string(),
                    "copy".to_string(),
                    "-avoid_negative_ts".to_string(),
                    "make_zero".to_string(),
                ]);
                format!("Lossless cut clip {}/{}", i + 1, clips.len())
            }
            _ => unreachable!(),
        };

        // Tag (do not convert) the source's color metadata on every re-encode
        // output. The setparams filter stamps the frame-level color props so
        // the encoder VUI carries primaries + transfer (output -color* flags
        // alone leave those "unknown"); color_tag_args stamps the muxer.
        // Skipped for lossless-cut, where -c copy preserves the original tags
        // verbatim. None of the re-encode single presets use -vf elsewhere, so
        // a single -vf setparams is safe to append here.
        if preset != "lossless-cut" {
            args.push("-vf".to_string());
            args.push(setparams_filter(&color));
            args.extend(color_tag_args(&color));
        }

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
                    "-vf".to_string(),
                    setparams_filter(&color),
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
                ]);
                fallback_args.extend(color_tag_args(&color));
                fallback_args.extend([
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
    if !VIDEO_PRESETS.contains(&preset.as_str()) {
        return Err("Video preset must be gpu-intra, prores-lt, prores-hq, h264-nvenc, av1-nvenc, h264-cpu, hevc-cpu, or lossless-cut".to_string());
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
    let ffprobe = find_tool(&root, "ffprobe");
    ensure_tool(&ffmpeg)?;
    ensure_tool(&ffprobe)?;

    let out_dir = PathBuf::from(&output_dir);
    fs::create_dir_all(&out_dir).map_err(|e| format!("Could not create output directory: {e}"))?;

    let parts: Vec<usize> = clips.iter().map(|c| c.index + 1).collect();
    let base_name = {
        let full_join = parts.iter().map(|x| x.to_string()).collect::<Vec<_>>().join("+");
        if full_join.len() <= 30 {
            full_join
        } else {
            let min = parts.iter().min().copied().unwrap_or(1);
            let max = parts.iter().max().copied().unwrap_or(1);
            format!("{}-{} ({} clips)", min, max, parts.len())
        }
    };
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

    // Probe which inputs actually have audio streams
    let mut input_has_audio: Vec<bool> = Vec::with_capacity(input_paths.len());
    for path in &input_paths {
        let has_audio = probe_has_audio_stream(&ffprobe, path).unwrap_or(false);
        input_has_audio.push(has_audio);
    }
    let any_has_audio = input_has_audio.iter().any(|&h| h);

    // Color metadata is read off the first input. The merged output is a
    // single stream, so it carries one consistent tag set; for the typical
    // same-episode merge every segment shares these values anyway.
    let color = probe_color_metadata(&ffprobe, &input_paths[0]);

    // Lossless-cut merge takes a separate stream-copy path (filter_complex
    // requires re-encoding, which would defeat the point). Each segment is
    // copied to a temp keyframe-snapped file, then concatenated with the
    // concat demuxer — bit-exact, color tags ride along untouched.
    if preset == "lossless-cut" {
        return run_lossless_cut_merge(
            &window,
            &ffmpeg,
            &clips,
            &input_paths,
            &input_index_for_clip,
            &out_dir,
            &output,
        );
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
        let (start, duration) = padded_clip_range(clip);
        total_duration += duration;
        filter_parts.push(format!(
            "[{input_idx}:v]trim=start={start:.3}:duration={duration:.3},setpts=PTS-STARTPTS[v{i}]"
        ));
        if any_has_audio {
            let clip_has_audio = input_has_audio[input_idx];
            if clip_has_audio {
                filter_parts.push(format!(
                    "[{input_idx}:a]atrim=start={start:.3}:duration={duration:.3},asetpts=PTS-STARTPTS[a{i}]"
                ));
            } else {
                filter_parts.push(format!(
                    "anullsrc=channel_layout=stereo:sample_rate=44100,atrim=duration={duration:.3},asetpts=PTS-STARTPTS[a{i}]"
                ));
            }
            concat_inputs.push_str(&format!("[v{i}][a{i}]"));
        } else {
            concat_inputs.push_str(&format!("[v{i}]"));
        }
    }
    let n = clips.len();
    // filter_complex (trim/concat) strips stream-level color metadata, so we
    // re-stamp it inside the graph with setparams (matched by the output -color*
    // flags below). Untagged sources default to BT.709 limited — the anime BD
    // standard.
    let setparams = setparams_filter(&color);
    if any_has_audio {
        filter_parts.push(format!(
            "{concat_inputs}concat=n={n}:v=1:a=1[cv][outa];[cv]{setparams}[outv]"
        ));
    } else {
        filter_parts.push(format!(
            "{concat_inputs}concat=n={n}:v=1:a=0[cv];[cv]{setparams}[outv]"
        ));
    }
    args.push("-filter_complex".to_string());
    args.push(filter_parts.join(";"));
    args.push("-map".to_string());
    args.push("[outv]".to_string());
    if any_has_audio {
        args.push("-map".to_string());
        args.push("[outa]".to_string());
    }

    let encode_args: Vec<String> = match preset.as_str() {
        "gpu-intra" => {
            let qp = clamp_quality(quality_value, 10, 28, 16);
            let mut v = vec![
                "-c:v".to_string(), "hevc_nvenc".to_string(),
                "-preset".to_string(), "p1".to_string(),
                "-rc".to_string(), "constqp".to_string(),
                "-qp".to_string(), qp.to_string(),
                "-g".to_string(), "1".to_string(),
                "-bf".to_string(), "0".to_string(),
                "-profile:v".to_string(), "main10".to_string(),
                "-highbitdepth".to_string(), "1".to_string(),
            ];
            if any_has_audio {
                v.extend([
                    "-c:a".to_string(), "aac".to_string(),
                    "-b:a".to_string(), "320k".to_string(),
                ]);
            }
            v
        }
        "prores-lt" | "prores-hq" => {
            let profile = if preset == "prores-lt" { "1" } else { "3" };
            let mut v = vec![
                "-c:v".to_string(), "prores_ks".to_string(),
                "-profile:v".to_string(), profile.to_string(),
                "-pix_fmt".to_string(), "yuv422p10le".to_string(),
            ];
            if any_has_audio {
                v.extend([
                    "-c:a".to_string(), "pcm_s16le".to_string(),
                ]);
            }
            v
        }
        "h264-nvenc" => {
            let cq = clamp_quality(quality_value, 14, 28, 18);
            let mut v = vec![
                "-c:v".to_string(), "h264_nvenc".to_string(),
                "-preset".to_string(), "p4".to_string(),
                "-rc".to_string(), "constqp".to_string(),
                "-cq".to_string(), cq.to_string(),
                "-spatial-aq".to_string(), "1".to_string(),
                "-temporal-aq".to_string(), "1".to_string(),
                "-movflags".to_string(), "+faststart".to_string(),
            ];
            if any_has_audio {
                v.extend([
                    "-c:a".to_string(), "aac".to_string(),
                    "-b:a".to_string(), "320k".to_string(),
                ]);
            }
            v
        }
        "av1-nvenc" => {
            let cq = clamp_quality(quality_value, 18, 34, 24);
            let mut v = vec![
                "-c:v".to_string(), "av1_nvenc".to_string(),
                "-preset".to_string(), "p4".to_string(),
                "-rc".to_string(), "constqp".to_string(),
                "-cq".to_string(), cq.to_string(),
                "-spatial-aq".to_string(), "1".to_string(),
                "-temporal-aq".to_string(), "1".to_string(),
                "-movflags".to_string(), "+faststart".to_string(),
            ];
            if any_has_audio {
                v.extend([
                    "-c:a".to_string(), "aac".to_string(),
                    "-b:a".to_string(), "320k".to_string(),
                ]);
            }
            v
        }
        "h264-cpu" => {
            let crf = clamp_quality(quality_value, 14, 28, 18);
            let mut v = vec![
                "-c:v".to_string(), "libx264".to_string(),
                "-preset".to_string(), "slow".to_string(),
                "-crf".to_string(), crf.to_string(),
                "-movflags".to_string(), "+faststart".to_string(),
            ];
            if any_has_audio {
                v.extend([
                    "-c:a".to_string(), "aac".to_string(),
                    "-b:a".to_string(), "320k".to_string(),
                ]);
            }
            v
        }
        "hevc-cpu" => {
            let crf = clamp_quality(quality_value, 14, 28, 18);
            let mut v = vec![
                "-c:v".to_string(), "libx265".to_string(),
                "-tag:v".to_string(), "hvc1".to_string(),
                "-preset".to_string(), "slow".to_string(),
                "-crf".to_string(), crf.to_string(),
                "-movflags".to_string(), "+faststart".to_string(),
            ];
            if any_has_audio {
                v.extend([
                    "-c:a".to_string(), "aac".to_string(),
                    "-b:a".to_string(), "320k".to_string(),
                ]);
            }
            v
        }
        _ => unreachable!(),
    };

    let pre_encode_args = args.clone();
    args.extend(encode_args);
    // Output-side color tags matching the in-graph setparams above, so the
    // muxer writes the labels into the container.
    args.extend(color_tag_args(&color));

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
            ]);
            if any_has_audio {
                fallback_args.extend([
                    "-c:a".to_string(), "aac".to_string(),
                    "-b:a".to_string(), "320k".to_string(),
                ]);
            }
            fallback_args.extend(color_tag_args(&color));
            fallback_args.extend([
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

// Lossless-cut merge: stream-copy each segment to a keyframe-snapped temp MKV,
// then concat-demux them into one MKV with -c copy. Bit-exact, no re-encode;
// color metadata + every other stream parameter ride along untouched. Cuts
// snap to the nearest preceding keyframe (not frame-accurate — surfaced in the
// UI). Audio is copied per-segment if present; segments with no audio simply
// have none in the concat (the concat demuxer tolerates a missing audio stream
// across parts so long as the muxer settings line up, which they do for
// same-codec same-source segments).
fn run_lossless_cut_merge(
    window: &tauri::Window,
    ffmpeg: &Path,
    clips: &[ExportClip],
    input_paths: &[PathBuf],
    input_index_for_clip: &[usize],
    out_dir: &Path,
    output: &Path,
) -> Result<String, String> {
    let temp_dir = out_dir.join(format!(".losslesscut_tmp_{}", std::process::id()));
    fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Could not create temporary merge directory: {e}"))?;

    // RAII-ish cleanup of the temp dir on every exit path.
    struct TempDirGuard(PathBuf);
    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let _guard = TempDirGuard(temp_dir.clone());

    let mut total_duration = 0.0_f64;
    let mut concat_list = String::new();
    let mut segment_paths: Vec<PathBuf> = Vec::with_capacity(clips.len());

    for (i, clip) in clips.iter().enumerate() {
        let input = &input_paths[input_index_for_clip[i]];
        let (start, duration) = padded_clip_range(clip);
        total_duration += duration;

        let segment = temp_dir.join(format!("seg_{i:04}.mkv"));
        let args: Vec<String> = vec![
            "-y".to_string(),
            "-hide_banner".to_string(),
            "-nostdin".to_string(),
            "-loglevel".to_string(),
            "error".to_string(),
            "-ss".to_string(),
            format!("{start:.3}"),
            "-i".to_string(),
            input.to_string_lossy().to_string(),
            "-t".to_string(),
            format!("{duration:.3}"),
            "-map".to_string(),
            "0:v:0".to_string(),
            "-map".to_string(),
            "0:a:0?".to_string(),
            "-c".to_string(),
            "copy".to_string(),
            "-avoid_negative_ts".to_string(),
            "make_zero".to_string(),
            segment.to_string_lossy().to_string(),
        ];
        emit_conversion_progress(
            window,
            "decode",
            Some(((i as f32) / (clips.len() as f32)) * 90.0),
            format!("Cutting segment {}/{} (lossless)...", i + 1, clips.len()),
            None,
            None,
        );
        run_ffmpeg_with_progress(
            window,
            ffmpeg,
            args,
            duration,
            "Cutting lossless segment",
            Some(&CLIP_CHILD_PID),
        )?;

        // Concat-demuxer list lines escape single quotes per ffmpeg's syntax.
        let escaped = segment.to_string_lossy().replace('\'', "'\\''");
        concat_list.push_str(&format!("file '{escaped}'\n"));
        segment_paths.push(segment);
    }

    let list_path = temp_dir.join("concat.txt");
    fs::write(&list_path, concat_list)
        .map_err(|e| format!("Could not write concat list: {e}"))?;

    let concat_args: Vec<String> = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-nostdin".to_string(),
        "-f".to_string(),
        "concat".to_string(),
        "-safe".to_string(),
        "0".to_string(),
        "-i".to_string(),
        list_path.to_string_lossy().to_string(),
        "-c".to_string(),
        "copy".to_string(),
        "-progress".to_string(),
        "pipe:1".to_string(),
        "-stats_period".to_string(),
        "0.5".to_string(),
        output.to_string_lossy().to_string(),
    ];
    emit_conversion_progress(
        window,
        "encode",
        Some(92.0_f32),
        format!("Joining {} lossless segments...", clips.len()),
        None,
        None,
    );
    run_ffmpeg_with_progress(
        window,
        ffmpeg,
        concat_args,
        total_duration,
        "Joining lossless segments",
        Some(&CLIP_CHILD_PID),
    )?;

    let done = ConversionDone {
        r#type: "done".to_string(),
        input: format!("{} clips merged", clips.len()),
        output: output.to_string_lossy().to_string(),
        archived_original: None,
        preset: "lossless-cut".to_string(),
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
    let ffprobe = find_tool(&root, "ffprobe");
    ensure_tool(&ffmpeg)?;

    let input = canonical_input_path(&source_path)?;
    // Carry the source's color metadata through onto the preview so the player
    // shows the same range/matrix the final export will use (defaults to
    // BT.709 limited when untagged). ffprobe is optional here — if it's
    // missing we still render with the BT.709 default.
    let color = if ensure_tool(&ffprobe).is_ok() {
        probe_color_metadata(&ffprobe, &input)
    } else {
        ColorMetadata::default()
    };
    // Content-fingerprint key so renames / copies / moves of the same file
    // all share the same cache folder. Path-based keys here would cache-
    // miss every time the user renamed the source.
    let source_key = content_fingerprint(&input).ok_or_else(|| {
        "Could not compute scene cache fingerprint for source file.".to_string()
    })?;
    let cache_dir = app_data_dir
        .join("scene_clips")
        .join(&source_key);
    fs::create_dir_all(&cache_dir)
        .map_err(|error| format!("Could not create scene clip cache folder: {error}"))?;

    let start_key = format!("{:.3}", start);
    let end_key = format!("{:.3}", end);
    // v6: tag source color metadata onto the preview (bumped from v5 to
    // regenerate previews that were cached untagged). v5: dropped scene_id
    // from filename; (start, end) is unique-per-source by definition since
    // scenes don't overlap. v4: -hwaccel auto for universal hw decode accel.
    let range_key = short_stable_id(&[&start_key, &end_key, "scene-clip-v6"]);
    let output = cache_dir.join(format!("{range_key}.mp4"));
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

    if let Err(error) = render_scene_clip_job(&ffmpeg, &input, &output, start, duration, use_nvenc, &color)
    {
        // Software fallback: NVENC can refuse some sources (10-bit HEVC, exotic
        // pixel formats) where libx264 still happily encodes.
        if use_nvenc {
            render_scene_clip_job(&ffmpeg, &input, &output, start, duration, false, &color)?;
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
    color: &ColorMetadata,
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
        // chain separator. setparams is chained on so the preview carries the
        // same color tags the export will (scale preserves color; setparams
        // only labels). Defaults to BT.709 limited when the source is untagged.
        "-vf".to_string(),
        format!("scale=-2:'min(720,ih)',{}", setparams_filter(color)),
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

    // Tag the source color metadata onto the preview (scale preserves color,
    // so this labels rather than converts). Untagged sources default to
    // BT.709 limited.
    args.extend(color_tag_args(color));

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

// ============================================================================
// Featherweight offset-playback previews — playback plan + source proxy.
//
// Instead of materializing one re-encoded clip per scene, the frontend points
// ONE <video> at a single decode-friendly source and produces the illusion of
// N clips with a currentTime offset loop. clip_playback_plan decides whether
// the ORIGINAL is directly playable in WebView2 (mode "direct") or needs a
// shared low-res short-GOP proxy (mode "proxy"); build_source_proxy produces
// that proxy. Both are gated frontend-side on the featherweight_previews flag.
// ============================================================================

// Friendly-source clauses: each must hold for "direct" playback in WebView2.
const FRIENDLY_VIDEO_CODECS: &[&str] = &["h264", "avc1"];
const FRIENDLY_PIX_FMTS: &[&str] = &["yuv420p", "yuvj420p"];
const FRIENDLY_AUDIO_CODECS: &[&str] = &["aac", "mp3"];
const FRIENDLY_CONTAINERS: &[&str] = &["mp4", "m4v", "mov"];
const FRIENDLY_MAX_WIDTH: u32 = 1920;
const FRIENDLY_MAX_HEIGHT: u32 = 1080;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlaybackPlan {
    pub mode: String, // "direct" | "proxy"
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub pix_fmt: Option<String>,
    pub container: Option<String>,
    pub in_scope: bool,
    pub reasons: Vec<String>,
}

// True iff `path` resolves under one of the asset-protocol scope roots
// ($HOME / $APPDATA / $RESOURCE — see tauri.conf.json assetProtocol.scope).
// convertFileSrc() 403s for anything outside these, so an off-scope original
// is unplayable in WebView2 regardless of codec and MUST be proxied.
fn path_in_asset_scope(app: &tauri::AppHandle, path: &Path) -> bool {
    let resolver = app.path();
    let roots = [
        resolver.home_dir().ok(),
        resolver.app_data_dir().ok(),
        resolver.resource_dir().ok(),
    ];
    // Compare canonicalized forms so symlinks / `\\?\` prefixes / casing don't
    // produce false negatives. Falls back to the raw path if canonicalize fails.
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    for root in roots.into_iter().flatten() {
        let root_canonical = root.canonicalize().unwrap_or(root);
        if canonical.starts_with(&root_canonical) {
            return true;
        }
    }
    false
}

// Lowercase file extension without the dot, if any.
fn lowercase_extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
}

// Probe a source once and decide direct-vs-proxy. FRIENDLY (direct) requires
// ALL clauses; any failure routes to the always-in-scope, always-H.264/AAC
// proxy. The proxy itself never needs this plan — it is friendly by
// construction.
#[tauri::command]
pub(crate) async fn clip_playback_plan(
    app: tauri::AppHandle,
    source_path: String,
) -> Result<PlaybackPlan, String> {
    log_info(
        "clip.playback_plan.start",
        "Computing clip playback plan",
        json!({ "source": &source_path }),
    );
    let result = tauri::async_runtime::spawn_blocking(move || compute_playback_plan(&app, source_path))
        .await
        .map_err(|error| error.to_string())?;
    match &result {
        Ok(plan) => log_info(
            "clip.playback_plan.complete",
            "Computed clip playback plan",
            json!({ "mode": &plan.mode, "inScope": plan.in_scope, "reasons": &plan.reasons }),
        ),
        Err(error) => log_error(
            "clip.playback_plan.error",
            "Could not compute clip playback plan",
            json!({ "error": error }),
        ),
    }
    result
}

fn compute_playback_plan(app: &tauri::AppHandle, source_path: String) -> Result<PlaybackPlan, String> {
    let root = app_root()?;
    let ffprobe = find_tool(&root, "ffprobe");
    ensure_tool(&ffprobe)?;
    let input = canonical_input_path(&source_path)?;

    let summary: MediaSummary = probe_media_summary(&ffprobe, &input).unwrap_or_default();
    let container = lowercase_extension(&input);
    let in_scope = path_in_asset_scope(app, &input);

    let mut reasons: Vec<String> = Vec::new();

    match summary.video_codec.as_deref() {
        Some(codec) if FRIENDLY_VIDEO_CODECS.contains(&codec) => {}
        Some(codec) => reasons.push(format!("video codec {codec} not WebView2-friendly")),
        None => reasons.push("no readable video stream".to_string()),
    }

    match summary.pix_fmt.as_deref() {
        Some(pix) if FRIENDLY_PIX_FMTS.contains(&pix) => {}
        Some(pix) => reasons.push(format!("pixel format {pix} not 8-bit 4:2:0")),
        None => reasons.push("unknown pixel format".to_string()),
    }

    // No audio stream is friendly (a silent source plays fine). A present audio
    // stream must be aac/mp3, or WebView2 plays video with no sound.
    match summary.audio_codec.as_deref() {
        None => {}
        Some(codec) if FRIENDLY_AUDIO_CODECS.contains(&codec) => {}
        Some(codec) => reasons.push(format!("audio codec {codec} not WebView2-friendly")),
    }

    match container.as_deref() {
        Some(ext) if FRIENDLY_CONTAINERS.contains(&ext) => {}
        Some(ext) => reasons.push(format!("container .{ext} not demuxable by <video>")),
        None => reasons.push("unknown container".to_string()),
    }

    match (summary.width, summary.height) {
        (Some(w), Some(h)) if w <= FRIENDLY_MAX_WIDTH && h <= FRIENDLY_MAX_HEIGHT => {}
        (Some(w), Some(h)) => reasons.push(format!("resolution {w}x{h} exceeds 1920x1080")),
        _ => reasons.push("unknown resolution".to_string()),
    }

    if !in_scope {
        reasons.push("source outside asset-protocol scope ($HOME/$APPDATA/$RESOURCE)".to_string());
    }

    let mode = if reasons.is_empty() { "direct" } else { "proxy" };

    Ok(PlaybackPlan {
        mode: mode.to_string(),
        video_codec: summary.video_codec,
        audio_codec: summary.audio_codec,
        width: summary.width,
        height: summary.height,
        pix_fmt: summary.pix_fmt,
        container,
        in_scope,
        reasons,
    })
}

// Build (or reuse) the shared low-res short-GOP proxy for an unfriendly / off-
// scope source. Whole-file (NO -ss) so scene timecodes map 1:1 onto the proxy
// timeline; 240p, short fixed GOP + no B-frames so currentTime seeks land near
// a keyframe; yuv420p + AAC + faststart mp4 so it is friendly by construction
// and always lives under $APPDATA (in asset scope). Mirrors generate_scene_clip:
// NVENC fast path with a libx264 fallback (CPU/GPU parity), content-fingerprint
// cache key, atomic tmp+rename, progress events. The in-flight ffmpeg PID lives
// in PROXY_CHILD_PID so a new source selection / teardown cancels it.
#[tauri::command]
pub(crate) async fn build_source_proxy(
    window: tauri::Window,
    source_path: String,
) -> Result<String, String> {
    log_info(
        "clip.source_proxy.start",
        "Building source proxy",
        json!({ "source": &source_path }),
    );
    // A new source build supersedes any in-flight one — cancel it first so we
    // never run two proxy encodes at once (mirror the single-source contract).
    kill_child_pid(&PROXY_CHILD_PID);

    let app_data_dir = window
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not get app data directory: {error}"))?;

    let log_source = source_path.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        generate_source_proxy(window, app_data_dir, source_path)
    })
    .await
    .map_err(|error| error.to_string())?;

    match &result {
        Ok(path) => log_info(
            "clip.source_proxy.complete",
            "Source proxy ready",
            json!({ "source": log_source, "proxy": path }),
        ),
        Err(error) => log_error(
            "clip.source_proxy.error",
            "Source proxy build failed",
            json!({ "source": log_source, "error": error }),
        ),
    }
    result
}

fn generate_source_proxy(
    window: tauri::Window,
    app_data_dir: PathBuf,
    source_path: String,
) -> Result<String, String> {
    let root = app_root()?;
    let ffmpeg = find_tool(&root, "ffmpeg");
    let ffprobe = find_tool(&root, "ffprobe");
    ensure_tool(&ffmpeg)?;

    let input = canonical_input_path(&source_path)?;
    // Carry the source's color metadata onto the proxy so offset playback looks
    // identical to the original (defaults to BT.709 limited when untagged).
    // ffprobe is optional — without it we still encode with the BT.709 default.
    let color = if ensure_tool(&ffprobe).is_ok() {
        probe_color_metadata(&ffprobe, &input)
    } else {
        ColorMetadata::default()
    };

    // Content fingerprint so renames / copies of the same file share the cache.
    let source_key = content_fingerprint(&input)
        .ok_or_else(|| "Could not compute source proxy fingerprint.".to_string())?;
    let cache_dir = app_data_dir.join("source_proxies").join(&source_key);
    fs::create_dir_all(&cache_dir)
        .map_err(|error| format!("Could not create source proxy cache folder: {error}"))?;

    let use_nvenc = *H264_NVENC_AVAILABLE
        .get_or_init(|| ffmpeg_listing(&ffmpeg, "-encoders").contains("h264_nvenc"));
    let encoder_decision = if use_nvenc { "nvenc" } else { "x264" };

    // Cache key folds in the resolution target + encoder decision + protocol
    // version. Bump "source-proxy-v4" to invalidate every cached proxy.
    let proxy_key = short_stable_id(&[&source_key, "240p", encoder_decision, "source-proxy-v4"]);
    let output = cache_dir.join(format!("{proxy_key}.mp4"));

    // >1024-byte cache hit short-circuit (matches every other app cache).
    if output
        .metadata()
        .map(|metadata| metadata.len() > 1024)
        .unwrap_or(false)
    {
        return Ok(output.to_string_lossy().to_string());
    }

    let duration = probe_duration(&ffprobe, &input).unwrap_or(0.0);

    // Decide whether the source codec is GPU-decodable so we can engage the
    // full-VRAM cuda pipeline (Tier 1). Only h264/hevc/av1 are reliably NVDEC
    // decodable here; everything else (vp9 profiles, exotic codecs, mpeg2,
    // etc.) routes through the sw-decode nvenc rung. A probe failure (no
    // ffprobe / unreadable stream) conservatively disables the cuda tier.
    let codec = if ensure_tool(&ffprobe).is_ok() {
        crate::video_cmds::probe_video_codec(&ffprobe, &input).ok()
    } else {
        None
    };
    let gpu_decodable = matches!(codec.as_deref(), Some("h264" | "hevc" | "av1"));

    // Atomic write: encode to a per-process tmp file, then rename into place so
    // a concurrent reader never sees a half-written proxy.
    let tmp_output = cache_dir.join(format!("{proxy_key}.{}.tmp.mp4", std::process::id()));
    let _ = fs::remove_file(&tmp_output);

    emit_conversion_progress(
        &window,
        "starting",
        Some(0.0),
        "Building preview proxy...".to_string(),
        None,
        None,
    );

    // 3-tier dispatch. The cuda pipeline (Tier 1) decodes + scales + uploads
    // entirely in VRAM; the sw-decode nvenc rung (Tier 2) is the previous
    // behavior for exotic codecs; libx264 (Tier 3) is the universal floor that
    // needs zero GPU and keeps the feature ungated per the CPU/GPU parity rule.
    // A user cancel (PID kill) must NOT fall through tiers — it surfaces as a
    // cancellation, not an encoder failure, so short-circuit on it everywhere.
    let tiers: &[ProxyTier] = match (use_nvenc, gpu_decodable) {
        (true, true) => &[ProxyTier::GpuCuda, ProxyTier::NvencSwDecode, ProxyTier::Libx264],
        (true, false) => &[ProxyTier::NvencSwDecode, ProxyTier::Libx264],
        (false, _) => &[ProxyTier::Libx264],
    };

    let mut last_error: Option<String> = None;
    for (idx, tier) in tiers.iter().enumerate() {
        // Each tier writes to the SAME tmp_output; clear any partial bytes the
        // previous failed tier left behind before trying the next one.
        let _ = fs::remove_file(&tmp_output);
        match run_source_proxy_job(
            &window, &ffmpeg, &input, &tmp_output, duration, &source_path, *tier, &color,
        ) {
            Ok(()) => {
                last_error = None;
                break;
            }
            Err(error) => {
                if error.contains("cancelled") {
                    let _ = fs::remove_file(&tmp_output);
                    return Err(error);
                }
                let next = tiers.get(idx + 1);
                if let Some(next_tier) = next {
                    log_warn(
                        "clip.source_proxy.fallback",
                        "Source proxy tier failed; falling back",
                        json!({
                            "failed_tier": format!("{tier:?}"),
                            "next_tier": format!("{next_tier:?}"),
                            "error": &error,
                        }),
                    );
                }
                last_error = Some(error);
            }
        }
    }

    if let Some(error) = last_error {
        let _ = fs::remove_file(&tmp_output);
        return Err(error);
    }

    fs::rename(&tmp_output, &output)
        .map_err(|error| format!("Could not finalize source proxy: {error}"))?;

    Ok(output.to_string_lossy().to_string())
}

// Which ffmpeg argument shape run_source_proxy_job emits. Tier 1 is the fast
// full-VRAM cuda pipeline; Tier 2 is sw-decode -> nvenc for codecs NVDEC can't
// decode; Tier 3 is the universal libx264 software floor (zero GPU).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProxyTier {
    GpuCuda,
    NvencSwDecode,
    Libx264,
}

fn run_source_proxy_job(
    window: &tauri::Window,
    ffmpeg: &Path,
    input: &Path,
    output: &Path,
    duration: f64,
    source_path: &str,
    tier: ProxyTier,
    color: &ColorMetadata,
) -> Result<(), String> {
    // Whole-file transcode (NO -ss) so the proxy timeline matches the source
    // 1:1. The decode prefix + -vf + encoder block all differ per tier; the
    // tail (audio, mux flags, progress) is shared below.
    let mut args: Vec<String> = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-nostdin".to_string(),
    ];

    // Decode prefix.
    match tier {
        ProxyTier::GpuCuda => {
            // Full-VRAM pipeline: NVDEC keeps decoded frames as cuda hwframes
            // (-hwaccel_output_format cuda) so scale_cuda runs on the GPU with
            // no download/re-upload round-trip. -hwaccel auto silently picked
            // dxva2 here, which copies every frame to RAM and scales on the CPU.
            args.extend([
                "-hwaccel".to_string(),
                "cuda".to_string(),
                "-hwaccel_output_format".to_string(),
                "cuda".to_string(),
            ]);
        }
        ProxyTier::NvencSwDecode | ProxyTier::Libx264 => {
            // -hwaccel auto = universal HW decode (NVDEC/QSV/D3D11VA/software),
            // not NVIDIA-gated, degrading cleanly per the CPU/GPU parity rule.
            args.extend(["-hwaccel".to_string(), "auto".to_string()]);
        }
    }

    args.extend([
        "-i".to_string(),
        input.to_string_lossy().to_string(),
        // Optional audio: silent sources skip the audio stream without failing.
        "-map".to_string(),
        "0:v:0".to_string(),
        "-map".to_string(),
        "0:a:0?".to_string(),
    ]);

    // Video filter. 240p cap (never upscale via the min() guard). setparams
    // carries the export's color tags onto the proxy (scale preserves color;
    // setparams only labels). Single quotes keep the inner comma an expression
    // arg, not a filter-chain separator.
    let vf = match tier {
        ProxyTier::GpuCuda => {
            // CRITICAL: setparams MUST be prepended BEFORE scale_cuda. It runs
            // on the CPU AVFrame before the GPU upload and stamps the color VUI.
            // Dropping it and relying on the output -color_* flags alone
            // HARD-FAILS (exit 127, "Impossible to convert ... cuda -> auto_scale")
            // on any source with unknown/unspecified color VUI — the common
            // untagged-anime case this app defaults to bt709. With the VUI
            // stamped, ffmpeg won't try to insert an impossible CPU auto_scale
            // on a cuda hwframe. Do NOT "optimize" setparams away.
            format!(
                "{},scale_cuda=-2:'min(240,ih)':format=yuv420p",
                setparams_filter(color)
            )
        }
        ProxyTier::NvencSwDecode | ProxyTier::Libx264 => {
            format!("scale=-2:'min(240,ih)',{}", setparams_filter(color))
        }
    };
    args.extend(["-vf".to_string(), vf]);

    // Encoder block.
    match tier {
        ProxyTier::GpuCuda => {
            // Same h264_nvenc flags as the sw-decode rung, but WITHOUT
            // -pix_fmt yuv420p: scale_cuda's format=yuv420p already sets the
            // output format, and a stray -pix_fmt forces an auto_scale
            // conversion of a cuda hwframe, which breaks the pipeline.
            // Short fixed GOP, no scene-cut, forced IDR, no B-frames so every
            // currentTime seek lands cleanly near a keyframe for tight offset loops.
            args.extend([
                "-c:v".to_string(),
                "h264_nvenc".to_string(),
                "-preset".to_string(),
                "p4".to_string(),
                "-rc".to_string(),
                "vbr".to_string(),
                "-cq".to_string(),
                "30".to_string(),
                "-g".to_string(),
                "12".to_string(),
                "-no-scenecut".to_string(),
                "1".to_string(),
                "-forced-idr".to_string(),
                "1".to_string(),
                "-bf".to_string(),
                "0".to_string(),
            ]);
        }
        ProxyTier::NvencSwDecode => {
            // Short fixed GOP, no scene-cut, forced IDR, no B-frames so every
            // currentTime seek lands cleanly near a keyframe for tight offset loops.
            args.extend([
                "-c:v".to_string(),
                "h264_nvenc".to_string(),
                "-preset".to_string(),
                "p4".to_string(),
                "-rc".to_string(),
                "vbr".to_string(),
                "-cq".to_string(),
                "30".to_string(),
                "-g".to_string(),
                "12".to_string(),
                "-no-scenecut".to_string(),
                "1".to_string(),
                "-forced-idr".to_string(),
                "1".to_string(),
                "-bf".to_string(),
                "0".to_string(),
                "-pix_fmt".to_string(),
                "yuv420p".to_string(),
            ]);
        }
        ProxyTier::Libx264 => {
            args.extend([
                "-c:v".to_string(),
                "libx264".to_string(),
                "-preset".to_string(),
                "veryfast".to_string(),
                "-crf".to_string(),
                "30".to_string(),
                "-g".to_string(),
                "12".to_string(),
                "-keyint_min".to_string(),
                "12".to_string(),
                "-sc_threshold".to_string(),
                "0".to_string(),
                "-bf".to_string(),
                "0".to_string(),
                "-pix_fmt".to_string(),
                "yuv420p".to_string(),
            ]);
        }
    }

    // Output-side color tags matching the in-graph setparams above.
    args.extend(color_tag_args(color));

    args.extend([
        "-c:a".to_string(),
        "aac".to_string(),
        "-b:a".to_string(),
        "96k".to_string(),
        "-ac".to_string(),
        "2".to_string(),
        "-movflags".to_string(),
        "+faststart".to_string(),
        "-progress".to_string(),
        "pipe:1".to_string(),
        "-stats_period".to_string(),
        "0.5".to_string(),
        output.to_string_lossy().to_string(),
    ]);

    // Forward a "proxy-progress" side-channel { sourcePath, percent, stage } so
    // the grid can show which source is building. The per-tick percent rides the
    // shared progress reader via the tap; we bookend it with a "starting" tick
    // and a terminal "complete"/"error" tick so the frontend sees the lifecycle.
    let _ = window.emit(
        "proxy-progress",
        json!({ "sourcePath": source_path, "percent": 0.0, "stage": "starting" }),
    );

    let label = match tier {
        ProxyTier::GpuCuda | ProxyTier::NvencSwDecode => "Building preview proxy",
        ProxyTier::Libx264 => "Building preview proxy (libx264)",
    };
    let result = crate::video_cmds::run_ffmpeg_with_progress_tap(
        window,
        ffmpeg,
        args,
        duration,
        label,
        Some(&PROXY_CHILD_PID),
        Some(("proxy-progress", source_path)),
    );

    let stage = if result.is_ok() { "complete" } else { "error" };
    let _ = window.emit(
        "proxy-progress",
        json!({ "sourcePath": source_path, "percent": if result.is_ok() { 100.0 } else { 0.0 }, "stage": stage }),
    );

    result
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
                let event_type = value.get("type").and_then(Value::as_str);
                let is_progress = event_type == Some("progress");
                if matches!(event_type, Some("log") | Some("error") | Some("done")) {
                    let level = if event_type == Some("error") { "error" } else { "info" };
                    append_app_log(level, "clip.server.event", "Clip server emitted event", value.clone());
                }
                if event_type == Some("done") {
                    if let Ok(app_data_dir) = app_handle.path().app_data_dir() {
                        try_persist_scene_cache(&app_data_dir, &value);
                    }
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

// Scene-detection cache. The expensive AI pass (TransNetV2 / PySceneDetect)
// is fully determined by the input file's content + extraction mode, so
// the result can be reused verbatim on re-select. The cache key is purely
// content-based:
// - sampling SHA-256 fingerprint (head + middle + tail + size) — uniquely
//   identifies the bytes regardless of path, rename, or copy. Renaming a
//   file or extracting a duplicate copy in a different folder both reuse
//   the cache for free.
// - mode (CPU vs GPU may detect slightly differently)
// - protocol version (bump to invalidate the whole cache atomically)
// On cache hit, the original payload's "input" field (the path of the
// file the original extraction ran on) is overwritten with the path the
// user actually selected, so the rest of the app sees the correct path.
//
// v4: CPU detector switched from the old mean-abs-diff scorer to
// PySceneDetect's ContentDetector — the bump forces existing CPU-mode
// results to re-detect once on next select instead of serving stale cuts.
// (GPU caches drop too; GPU re-detection is deterministic, so it's cheap.)
const CLIP_SCENES_CACHE_VERSION: &str = "clip-scenes-v4";

fn scene_cache_key(input: &Path, mode: &str) -> Option<String> {
    // Path/size/mtime are deliberately NOT in the key. The fingerprint
    // already uniquely identifies the file's content (it folds in the
    // size as a salt), so any path-dependent factor would just defeat
    // cross-rename and cross-copy dedup. canonicalize() is still needed
    // to resolve the file the user pointed at — but only so we can read
    // its bytes for the fingerprint, not to make it part of the key.
    let canonical = input.canonicalize().ok()?;
    let fingerprint = content_fingerprint(&canonical)?;
    Some(short_stable_id(&[
        &fingerprint,
        mode,
        CLIP_SCENES_CACHE_VERSION,
    ]))
}

fn scene_cache_path(app_data_dir: &Path, key: &str) -> PathBuf {
    app_data_dir
        .join("clip_scenes_cache")
        .join(format!("{key}.json"))
}

fn read_scene_cache(path: &Path) -> Option<Value> {
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn write_scene_cache(path: &Path, payload: &Value) {
    // Atomic write via tmp + rename so a concurrent reader can't observe
    // a truncated JSON file (fs::write truncates in place). The 300-scene
    // payload is hundreds of KB; a torn read would silently fail
    // deserialization and re-trigger the full AI pass.
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let Ok(text) = serde_json::to_string(payload) else { return };
    let tmp = path.with_extension("json.tmp");
    if fs::write(&tmp, text).is_ok() {
        let _ = fs::rename(&tmp, path);
    }
}

// Called from both the persistent-server reader and the one-shot reader on
// every "done" event so successful extractions self-populate the cache
// regardless of which path produced them. The input + mode come straight
// from the done payload (clip_cli.py emits them), so this stays correct
// even if multiple extractions overlap.
fn try_persist_scene_cache(app_data_dir: &Path, done_payload: &Value) {
    let Some(input) = done_payload.get("input").and_then(Value::as_str) else { return };
    let Some(mode) = done_payload.get("mode").and_then(Value::as_str) else { return };
    let Some(key) = scene_cache_key(Path::new(input), mode) else { return };
    write_scene_cache(&scene_cache_path(app_data_dir, &key), done_payload);
}

#[tauri::command]
pub(crate) async fn clip_extract(
    window: tauri::Window,
    input_path: String,
    mode: String,
    force: Option<bool>,
) -> Result<String, String> {
    if mode != "cpu" && mode != "gpu" {
        return Err("Clip extraction mode must be cpu or gpu".to_string());
    }
    let force = force.unwrap_or(false);
    log_info(
        "clip.extract.start",
        "Starting clip extraction",
        json!({ "input": &input_path, "mode": &mode, "force": force }),
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

    // Cache short-circuit: scene detection is fully deterministic for the
    // same (file content, mode) tuple, so reuse the prior JSON instead of
    // re-running the AI pass. The frontend's one-shot branch parses the
    // returned payload directly, so the cache hit looks identical to a
    // fast one-shot extraction from the UI side. `force` is set by the
    // "Extract again" button so a user can deliberately bust the cache
    // when they suspect detection drift or want a fresh run.
    if !force {
        if let Ok(app_data_dir) = window.app_handle().path().app_data_dir() {
            if let Some(key) = scene_cache_key(&input_path_buf, &mode) {
                let cache_path = scene_cache_path(&app_data_dir, &key);
                if let Some(mut payload) = read_scene_cache(&cache_path) {
                    let scene_count = payload
                        .get("sceneCount")
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    // Cache may have been written by an earlier extraction
                    // of the same content at a different path (rename, copy
                    // to another folder, etc.). Rewrite the user-visible
                    // paths to whatever they selected this time — the
                    // top-level "input" used by progress messages AND each
                    // scene's "source" which the frontend feeds back into
                    // the preview backend as the clip's path. Leaving the
                    // original source there would make the preview backend
                    // try to open the prior path, which may no longer
                    // exist after a rename, producing 0/N cached.
                    if let Some(map) = payload.as_object_mut() {
                        map.insert("input".to_string(), Value::String(source_path.clone()));
                        if let Some(scenes) = map.get_mut("scenes").and_then(Value::as_array_mut) {
                            for scene in scenes {
                                if let Some(scene_obj) = scene.as_object_mut() {
                                    scene_obj.insert(
                                        "source".to_string(),
                                        Value::String(source_path.clone()),
                                    );
                                }
                            }
                        }
                    }
                    log_info(
                        "clip.extract.cache.hit",
                        "Reusing cached scene extraction",
                        json!({ "input": &source_path, "mode": &mode, "scenes": scene_count }),
                    );
                    let _ = window.emit(
                        "clip-progress",
                        json!({
                            "type": "progress",
                            "stage": "complete",
                            "percent": 100,
                            "message": format!("Loaded {} scenes from cache", scene_count),
                        }),
                    );
                    return Ok(payload.to_string());
                }
            }
        }
    }

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
                Some("done") => {
                    if let Ok(app_data_dir) = window.app_handle().path().app_data_dir() {
                        try_persist_scene_cache(&app_data_dir, &value);
                    }
                    final_payload = Some(line);
                }
                Some("error") => {
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

#[tauri::command]
pub(crate) async fn clip_preview_merge(
    window: tauri::Window,
    clips: Vec<ExportClip>,
) -> Result<String, String> {
    if clips.len() < 2 {
        return Err("Merge requires at least 2 clips".to_string());
    }
    log_info(
        "clip.preview_merge.start",
        "Starting real-time preview merge",
        json!({ "clipCount": clips.len() }),
    );
    let log_clip_count = clips.len();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_clip_preview_merge(window, clips)
    })
    .await
    .map_err(|error| error.to_string())?;
    match &result {
        Ok(payload) => log_info(
            "clip.preview_merge.complete",
            "Real-time preview merge completed",
            json!({ "clipCount": log_clip_count, "result": payload }),
        ),
        Err(error) => log_error(
            "clip.preview_merge.error",
            "Real-time preview merge failed",
            json!({ "clipCount": log_clip_count, "error": error }),
        ),
    }
    result
}

fn run_clip_preview_merge(
    window: tauri::Window,
    clips: Vec<ExportClip>,
) -> Result<String, String> {
    let root = app_root()?;
    let ffmpeg = find_tool(&root, "ffmpeg");
    let ffprobe = find_tool(&root, "ffprobe");
    ensure_tool(&ffmpeg)?;
    ensure_tool(&ffprobe)?;

    let app_data_dir = window
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not get app data directory: {error}"))?;

    // Create unique key based on the clips to be merged
    let mut hash_input = String::new();
    for clip in &clips {
        hash_input.push_str(&clip.source);
        hash_input.push_str(&format!(":{:.3}:{:.3}", clip.start, clip.end));
    }
    let range_key = short_stable_id(&[&hash_input, "preview-merge-v1"]);
    
    // Save under scene_clips so it uses same permissions/location as other preview clips
    let cache_dir = app_data_dir.join("scene_clips").join("merged");
    fs::create_dir_all(&cache_dir)
        .map_err(|error| format!("Could not create preview merge cache folder: {error}"))?;

    let output = cache_dir.join(format!("{range_key}.mp4"));
    let temp_output = output.with_extension("tmp.mp4");

    // Check if target output already exists and has non-trivial size
    if output.metadata().map(|m| m.len() > 1024).unwrap_or(false) {
        let mut total_duration = 0.0_f64;
        for clip in &clips {
            let (_, duration) = padded_clip_range(clip);
            total_duration += duration;
        }
        return serialize_clip_preview_done("merged-preview".to_string(), output, total_duration, true);
    }

    // Deduplicate inputs (exact same code as run_clip_export_merged)
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

    // Probe which inputs actually have audio streams
    let mut input_has_audio: Vec<bool> = Vec::with_capacity(input_paths.len());
    for path in &input_paths {
        let has_audio = probe_has_audio_stream(&ffprobe, path).unwrap_or(false);
        input_has_audio.push(has_audio);
    }
    let any_has_audio = input_has_audio.iter().any(|&h| h);

    let mut args: Vec<String> = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-nostdin".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
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
        let (start, duration) = padded_clip_range(clip);
        total_duration += duration;
        filter_parts.push(format!(
            "[{input_idx}:v]trim=start={start:.3}:duration={duration:.3},setpts=PTS-STARTPTS[v{i}]"
        ));
        if any_has_audio {
            let clip_has_audio = input_has_audio[input_idx];
            if clip_has_audio {
                filter_parts.push(format!(
                    "[{input_idx}:a]atrim=start={start:.3}:duration={duration:.3},asetpts=PTS-STARTPTS[a{i}]"
                ));
            } else {
                filter_parts.push(format!(
                    "anullsrc=channel_layout=stereo:sample_rate=44100,atrim=duration={duration:.3},asetpts=PTS-STARTPTS[a{i}]"
                ));
            }
            concat_inputs.push_str(&format!("[v{i}][a{i}]"));
        } else {
            concat_inputs.push_str(&format!("[v{i}]"));
        }
    }
    let n = clips.len();
    if any_has_audio {
        filter_parts.push(format!(
            "{concat_inputs}concat=n={n}:v=1:a=1[mergedv][mergeda]"
        ));
    } else {
        filter_parts.push(format!(
            "{concat_inputs}concat=n={n}:v=1:a=0[mergedv]"
        ));
    }
    // Scale output to 720p maximum
    filter_parts.push("[mergedv]scale=-2:'min(720,ih)'[outv]".to_string());

    args.push("-filter_complex".to_string());
    args.push(filter_parts.join(";"));
    args.push("-map".to_string());
    args.push("[outv]".to_string());
    if any_has_audio {
        args.push("-map".to_string());
        args.push("[mergeda]".to_string());
    }

    // Check NVENC availability
    let use_nvenc = *H264_NVENC_AVAILABLE
        .get_or_init(|| ffmpeg_listing(&ffmpeg, "-encoders").contains("h264_nvenc"));

    let primary_result = run_preview_merge_encode(
        &ffmpeg,
        &args,
        preview_merge_encode_args(use_nvenc),
        any_has_audio,
        &temp_output,
    );
    if let Err(primary_error) = primary_result {
        if use_nvenc && primary_error != PREVIEW_MERGE_CANCELLED {
            log_warn(
                "clip.preview_merge.fallback",
                "Preview merge NVENC failed; retrying with libx264 software encoder",
                json!({ "error": &primary_error }),
            );
            run_preview_merge_encode(
                &ffmpeg,
                &args,
                preview_merge_encode_args(false),
                any_has_audio,
                &temp_output,
            )?;
        } else {
            return Err(primary_error);
        }
    }

    if !temp_output.metadata().map(|m| m.len() > 1024).unwrap_or(false) {
        let _ = fs::remove_file(&temp_output);
        return Err("FFmpeg did not create a valid merged preview file.".to_string());
    }

    if output.exists() {
        let _ = fs::remove_file(&output);
    }
    fs::rename(&temp_output, &output)
        .map_err(|error| format!("Could not finalize merged preview: {error}"))?;

    serialize_clip_preview_done("merged-preview".to_string(), output, total_duration, false)
}

const PREVIEW_MERGE_CANCELLED: &str = "Preview merge cancelled.";

fn preview_merge_encode_args(use_nvenc: bool) -> Vec<String> {
    if use_nvenc {
        vec![
            "-c:v".to_string(),
            "h264_nvenc".to_string(),
            "-preset".to_string(),
            "p1".to_string(),
            "-cq".to_string(),
            "26".to_string(),
            "-pix_fmt".to_string(),
            "yuv420p".to_string(),
        ]
    } else {
        vec![
            "-c:v".to_string(),
            "libx264".to_string(),
            "-preset".to_string(),
            "ultrafast".to_string(),
            "-crf".to_string(),
            "26".to_string(),
            "-pix_fmt".to_string(),
            "yuv420p".to_string(),
        ]
    }
}

fn run_preview_merge_encode(
    ffmpeg: &Path,
    base_args: &[String],
    encode_args: Vec<String>,
    any_has_audio: bool,
    temp_output: &Path,
) -> Result<(), String> {
    let mut final_args = base_args.to_vec();
    final_args.extend(encode_args);
    if any_has_audio {
        final_args.extend([
            "-c:a".to_string(),
            "aac".to_string(),
            "-b:a".to_string(),
            "128k".to_string(),
            "-ac".to_string(),
            "2".to_string(),
        ]);
    }
    final_args.extend([
        "-avoid_negative_ts".to_string(),
        "make_zero".to_string(),
        "-movflags".to_string(),
        "+faststart".to_string(),
        temp_output.to_string_lossy().to_string(),
    ]);

    let _ = fs::remove_file(temp_output);
    let child = cmd(ffmpeg)
        .args(final_args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start ffmpeg for preview merge: {error}"))?;
    store_child_pid(&CLIP_CHILD_PID, child.id());
    let wait_result = child.wait_with_output();
    clear_child_pid(&CLIP_CHILD_PID);
    let result =
        wait_result.map_err(|error| format!("Could not run ffmpeg for preview merge: {error}"))?;

    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr).trim().to_string();
        let _ = fs::remove_file(temp_output);
        if result.status.code().is_none() || result.status.code() == Some(1) && stderr.is_empty() {
            return Err(PREVIEW_MERGE_CANCELLED.to_string());
        }
        return Err(if stderr.is_empty() {
            format!("FFmpeg exited with code {}", result.status.code().unwrap_or(-1))
        } else {
            stderr
        });
    }
    Ok(())
}

