use std::{
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::Stdio,
    sync::atomic::{AtomicU64, Ordering},
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
    probe_has_audio_stream, probe_media_summary, python_exe_checked, run_ffmpeg_with_progress,
    sanitize_path_segment,
    serialize_clip_preview_done, short_stable_id, store_child_pid, truncate_log_text,
    append_app_log, MediaSummary, CLIP_CANCEL_REQUESTED, CLIP_CHILD_PID, CLIP_SERVER,
    PROXY_BUILD_LOCK, PROXY_CHILD_PID, ConversionDone, H264_NVENC_AVAILABLE,
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
        "h264-cpu" | "h264-10bit-cpu" | "hevc-cpu" | "h264-nvenc" | "h264-10bit-nvenc" | "av1-nvenc" => "mp4",
        // Stream-copy presets: container must tolerate arbitrary source codecs
        // (10-bit HEVC, AV1, exotic profiles) without re-muxing limits. MKV is
        // the robust choice — MP4/MOV reject several codecs on -c copy.
        // Smart cut narrows this per-source, see smart_cut_extension().
        "lossless-cut" | "smart-cut" => "mkv",
        _ => "mov",
    }
}

// Containers whose audio is, by definition, already legal in MP4: it is sitting
// in an MP4-family file right now, so it can be copied straight back into one.
fn is_mp4_family(path: &Path) -> bool {
    matches!(
        lowercase_extension(path).as_deref(),
        Some("mp4" | "m4v" | "mov")
    )
}

// Smart cut keeps the source's container instead of always writing MKV.
//
// It can, where lossless-cut cannot, because smart cut already refuses anything
// that is not H.264/HEVC at 8 or 10 bit — both native to MP4. The decision is
// made from the file NAME rather than a probe on purpose: the output path is
// chosen before the source is opened, and the UI predicts the same name in
// advance, so both need an answer without touching the file. An MP4/MOV source
// is safe by construction (its audio already lives in an MP4). Anything else —
// MKV with FLAC/DTS/PCM, WebM, unknown — keeps today's MKV behavior, because
// ffmpeg's MP4 muxer accepts those audio codecs WITHOUT error and produces
// files players then refuse; there is no failure to fall back on.
fn smart_cut_extension(sources: &[PathBuf]) -> &'static str {
    if !sources.is_empty() && sources.iter().all(|path| is_mp4_family(path)) {
        "mp4"
    } else {
        "mkv"
    }
}

// Extension for an export, given the sources it is built from. Only smart cut
// varies by source; every other preset is fixed by the preset alone.
fn preset_extension_for(preset: &str, sources: &[PathBuf]) -> &'static str {
    if preset == "smart-cut" {
        smart_cut_extension(sources)
    } else {
        preset_extension(preset)
    }
}

// HEVC in MP4 defaults to the `hev1` brand, which QuickTime/Final Cut (and some
// Premiere builds) refuse to open — same bitstream, unacceptable label. `hvc1`
// is the tag they accept; it is metadata only, applied on a stream copy, and
// meaningless outside MP4. H.264 needs nothing (it gets `avc1` already).
fn mp4_codec_tag_args(target: &Path, codec: &str) -> Vec<String> {
    if is_mp4_family(target) && codec.trim() == "hevc" {
        vec!["-tag:v".to_string(), "hvc1".to_string()]
    } else {
        Vec::new()
    }
}

const VIDEO_PRESETS: &[&str] = &[
    "gpu-intra",
    "prores-lt",
    "prores-hq",
    "h264-nvenc",
    "h264-10bit-nvenc",
    "av1-nvenc",
    "h264-cpu",
    "h264-10bit-cpu",
    "hevc-cpu",
    "lossless-cut",
    "smart-cut",
];

const VIDEO_PRESET_ERROR: &str = "Video preset must be gpu-intra, prores-lt, prores-hq, h264-nvenc, h264-10bit-nvenc, av1-nvenc, h264-cpu, h264-10bit-cpu, hevc-cpu, lossless-cut, or smart-cut";

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

static SOURCE_PROXY_REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn generated_source_proxy_request_id() -> String {
    format!(
        "proxy-{}-{}",
        std::process::id(),
        SOURCE_PROXY_REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed) + 1,
    )
}

// Clip outputs must carry only the streams the editor selected. Chapter
// metadata is independent of stream mapping, so it needs its own explicit
// opt-out or a MOV/MP4 muxer can recreate an episode-length data track.
fn append_clip_stream_maps(args: &mut Vec<String>, streams: &[&str]) {
    for stream in streams {
        args.push("-map".to_string());
        args.push((*stream).to_string());
    }
    args.extend(["-map_chapters".to_string(), "-1".to_string()]);
}

#[tauri::command]
pub(crate) async fn clip_export(
    window: tauri::Window,
    clips: Vec<ExportClip>,
    output_dir: String,
    preset: String,
    quality_value: Option<i32>,
    rate_mode: Option<String>,
    bitrate_mbps: Option<f64>,
) -> Result<String, String> {
    if !VIDEO_PRESETS.contains(&preset.as_str()) {
        return Err(VIDEO_PRESET_ERROR.to_string());
    }
    log_info(
        "clip.export.start",
        "Starting clip export",
        json!({ "clipCount": clips.len(), "outputDir": &output_dir, "preset": &preset, "qualityValue": quality_value, "rateMode": &rate_mode, "bitrateMbps": bitrate_mbps }),
    );
    let log_clip_count = clips.len();
    let log_output_dir = output_dir.clone();
    let log_preset = preset.clone();
    let log_rate_mode = rate_mode.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_clip_export(window, clips, output_dir, preset, quality_value, rate_mode, bitrate_mbps)
    })
    .await
    .map_err(|error| error.to_string())?;
    match &result {
        Ok(payload) => log_info(
            "clip.export.complete",
            "Clip export completed",
            json!({ "clipCount": log_clip_count, "outputDir": log_output_dir, "preset": log_preset, "qualityValue": quality_value, "rateMode": log_rate_mode, "bitrateMbps": bitrate_mbps, "result": payload }),
        ),
        Err(error) => log_error(
            "clip.export.error",
            "Clip export failed",
            json!({ "clipCount": log_clip_count, "outputDir": log_output_dir, "preset": log_preset, "qualityValue": quality_value, "rateMode": log_rate_mode, "bitrateMbps": bitrate_mbps, "error": error }),
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RateMode {
    Quality,
    Vbr,
    Cbr,
}

fn parse_rate_mode(value: Option<&str>) -> Result<RateMode, String> {
    match value.unwrap_or("quality") {
        "quality" => Ok(RateMode::Quality),
        "vbr" | "bitrate" => Ok(RateMode::Vbr),
        "cbr" => Ok(RateMode::Cbr),
        _ => Err("Rate control must be quality, vbr, or cbr.".to_string()),
    }
}

fn bitrate_arg(value: Option<f64>) -> Result<String, String> {
    let bitrate = value.unwrap_or(20.0);
    if !bitrate.is_finite() || bitrate <= 0.0 {
        return Err("Target bitrate must be greater than 0 Mbps.".to_string());
    }
    Ok(format!("{bitrate}M"))
}

fn buffer_arg(value: Option<f64>) -> Result<String, String> {
    let bitrate = value.unwrap_or(20.0);
    if !bitrate.is_finite() || bitrate <= 0.0 {
        return Err("Target bitrate must be greater than 0 Mbps.".to_string());
    }
    Ok(format!("{}M", bitrate * 2.0))
}

/// NVENC family rate-control block.
fn nvenc_rate_args(
    rate_mode: Option<&str>,
    quality: i32,
    quality_flag: &str,
    bitrate_mbps: Option<f64>,
    cbr_padding: bool,
) -> Result<Vec<String>, String> {
    match parse_rate_mode(rate_mode)? {
        RateMode::Quality => Ok(vec![
            "-rc".to_string(), "constqp".to_string(),
            quality_flag.to_string(), quality.to_string(),
        ]),
        RateMode::Vbr => Ok(vec![
            "-rc".to_string(), "vbr".to_string(),
            "-b:v".to_string(), bitrate_arg(bitrate_mbps)?,
        ]),
        RateMode::Cbr => {
            let bitrate = bitrate_arg(bitrate_mbps)?;
            let mut args = vec![
                "-rc".to_string(), "cbr".to_string(),
                "-b:v".to_string(), bitrate.clone(),
                "-minrate".to_string(), bitrate.clone(),
                "-maxrate".to_string(), bitrate,
                "-bufsize".to_string(), buffer_arg(bitrate_mbps)?,
            ];
            if cbr_padding {
                args.extend(["-cbr_padding".to_string(), "1".to_string()]);
            }
            Ok(args)
        }
    }
}

/// libx264 / libx265 rate-control block.
fn x26x_rate_args(
    rate_mode: Option<&str>,
    quality: i32,
    bitrate_mbps: Option<f64>,
    cbr_params: Option<(&str, &str)>,
) -> Result<Vec<String>, String> {
    match parse_rate_mode(rate_mode)? {
        RateMode::Quality => Ok(vec!["-crf".to_string(), quality.to_string()]),
        RateMode::Vbr => Ok(vec![
            "-b:v".to_string(), bitrate_arg(bitrate_mbps)?,
        ]),
        RateMode::Cbr => {
            let bitrate = bitrate_arg(bitrate_mbps)?;
            let mut args = vec![
                "-b:v".to_string(), bitrate.clone(),
                "-minrate".to_string(), bitrate.clone(),
                "-maxrate".to_string(), bitrate,
                "-bufsize".to_string(), buffer_arg(bitrate_mbps)?,
            ];
            if let Some((flag, value)) = cbr_params {
                args.extend([flag.to_string(), value.to_string()]);
            }
            Ok(args)
        }
    }
}

// Direct High 10 H.264 presets. Quality 0 is deliberately accepted. VBR and
// CBR accept any positive Mbps target and add no hidden maximum ceiling.
fn h264_10bit_nvenc_video_args(
    quality: Option<i32>,
    rate_mode: Option<&str>,
    bitrate_mbps: Option<f64>,
) -> Result<Vec<String>, String> {
    let qp = clamp_quality(quality, 0, 28, 18);
    let mut args = vec![
        "-c:v".to_string(), "h264_nvenc".to_string(),
        "-preset".to_string(), "p7".to_string(),
    ];
    args.extend(nvenc_rate_args(rate_mode, qp, "-qp", bitrate_mbps, true)?);
    args.extend([
        "-profile:v".to_string(), "high10".to_string(),
        "-highbitdepth".to_string(), "1".to_string(),
        "-pix_fmt".to_string(), "p010le".to_string(),
        "-spatial-aq".to_string(), "1".to_string(),
        "-temporal-aq".to_string(), "1".to_string(),
        "-movflags".to_string(), "+faststart".to_string(),
    ]);
    Ok(args)
}

fn h264_10bit_cpu_video_args(
    quality: Option<i32>,
    rate_mode: Option<&str>,
    bitrate_mbps: Option<f64>,
) -> Result<Vec<String>, String> {
    let crf = clamp_quality(quality, 0, 28, 18);
    let mut args = vec![
        "-c:v".to_string(), "libx264".to_string(),
        "-preset".to_string(), "slow".to_string(),
    ];
    args.extend(x26x_rate_args(
        rate_mode,
        crf,
        bitrate_mbps,
        Some(("-x264-params", "nal-hrd=cbr")),
    )?);
    args.extend([
        "-profile:v".to_string(), "high10".to_string(),
        "-pix_fmt".to_string(), "yuv420p10le".to_string(),
        "-movflags".to_string(), "+faststart".to_string(),
    ]);
    Ok(args)
}

fn gpu_intra_video_args(
    quality: Option<i32>,
    rate_mode: Option<&str>,
    bitrate_mbps: Option<f64>,
) -> Result<Vec<String>, String> {
    let qp = clamp_quality(quality, 10, 28, 16);
    let mut args = vec![
        "-c:v".to_string(), "hevc_nvenc".to_string(),
        "-preset".to_string(), "p1".to_string(),
    ];
    args.extend(nvenc_rate_args(rate_mode, qp, "-qp", bitrate_mbps, true)?);
    args.extend([
        "-g".to_string(), "1".to_string(),
        "-bf".to_string(), "0".to_string(),
        "-profile:v".to_string(), "main10".to_string(),
        "-highbitdepth".to_string(), "1".to_string(),
    ]);
    Ok(args)
}

fn h264_nvenc_video_args(
    quality: Option<i32>,
    rate_mode: Option<&str>,
    bitrate_mbps: Option<f64>,
) -> Result<Vec<String>, String> {
    let cq = clamp_quality(quality, 14, 28, 18);
    let mut args = vec![
        "-c:v".to_string(), "h264_nvenc".to_string(),
        "-preset".to_string(), "p4".to_string(),
    ];
    args.extend(nvenc_rate_args(rate_mode, cq, "-cq", bitrate_mbps, true)?);
    args.extend([
        "-spatial-aq".to_string(), "1".to_string(),
        "-temporal-aq".to_string(), "1".to_string(),
        "-movflags".to_string(), "+faststart".to_string(),
    ]);
    Ok(args)
}

fn av1_nvenc_video_args(
    quality: Option<i32>,
    rate_mode: Option<&str>,
    bitrate_mbps: Option<f64>,
) -> Result<Vec<String>, String> {
    let cq = clamp_quality(quality, 18, 34, 24);
    let mut args = vec![
        "-c:v".to_string(), "av1_nvenc".to_string(),
        "-preset".to_string(), "p4".to_string(),
    ];
    args.extend(nvenc_rate_args(rate_mode, cq, "-cq", bitrate_mbps, true)?);
    args.extend([
        "-spatial-aq".to_string(), "1".to_string(),
        "-temporal-aq".to_string(), "1".to_string(),
        "-movflags".to_string(), "+faststart".to_string(),
    ]);
    Ok(args)
}

fn h264_cpu_video_args(
    quality: Option<i32>,
    rate_mode: Option<&str>,
    bitrate_mbps: Option<f64>,
) -> Result<Vec<String>, String> {
    let crf = clamp_quality(quality, 14, 28, 18);
    let mut args = vec![
        "-c:v".to_string(), "libx264".to_string(),
        "-preset".to_string(), "slow".to_string(),
    ];
    args.extend(x26x_rate_args(
        rate_mode,
        crf,
        bitrate_mbps,
        Some(("-x264-params", "nal-hrd=cbr")),
    )?);
    args.extend(["-movflags".to_string(), "+faststart".to_string()]);
    Ok(args)
}

fn hevc_cpu_video_args(
    quality: Option<i32>,
    rate_mode: Option<&str>,
    bitrate_mbps: Option<f64>,
) -> Result<Vec<String>, String> {
    let crf = clamp_quality(quality, 14, 28, 18);
    let mut args = vec![
        "-c:v".to_string(), "libx265".to_string(),
        "-tag:v".to_string(), "hvc1".to_string(),
        "-preset".to_string(), "slow".to_string(),
    ];
    args.extend(x26x_rate_args(rate_mode, crf, bitrate_mbps, None)?);
    args.extend(["-movflags".to_string(), "+faststart".to_string()]);
    Ok(args)
}

fn gpu_cpu_fallback_video_args(
    preset: &str,
    quality: Option<i32>,
    rate_mode: Option<&str>,
    bitrate_mbps: Option<f64>,
) -> Result<Vec<String>, String> {
    if preset == "h264-10bit-nvenc" {
        return h264_10bit_cpu_video_args(quality, rate_mode, bitrate_mbps);
    }

    let crf = if preset == "gpu-intra" {
        clamp_quality(quality, 10, 28, 16)
    } else if preset == "av1-nvenc" {
        clamp_quality(quality, 18, 34, 24)
    } else {
        clamp_quality(quality, 14, 28, 18)
    };
    let mut args = vec![
        "-c:v".to_string(), "libx264".to_string(),
        "-preset".to_string(), "slow".to_string(),
    ];
    args.extend(x26x_rate_args(
        rate_mode,
        crf,
        bitrate_mbps,
        Some(("-x264-params", "nal-hrd=cbr")),
    )?);
    if preset == "gpu-intra" {
        args.extend(["-pix_fmt".to_string(), "yuv420p".to_string()]);
    }
    Ok(args)
}

fn preset_supports_rate_control(preset: &str) -> bool {
    !matches!(preset, "prores-lt" | "prores-hq" | "lossless-cut" | "smart-cut")
}

// Video stream properties smart cut needs before it can splice: the codec and
// pixel format pick the head encoder, the two frame rates decide whether the
// source is constant-rate enough to splice at all, width/height and the rest
// decide whether two sources can be joined without re-encoding.
//
// `start_offset` is the container's first timestamp. Most files start at 0, but
// a stream ripped from broadcast or remuxed with an offset starts later, and
// ffprobe then reports packet timestamps on THAT timeline while every clip
// range (and every ffmpeg -ss) is counted from the first visible frame. The
// offset is what converts between the two.
#[derive(Clone, Debug, Default, PartialEq)]
struct SourceVideoParams {
    codec: String,
    pix_fmt: String,
    width: i64,
    height: i64,
    avg_frame_rate: String,
    r_frame_rate: String,
    start_offset: f64,
}

// Audio stream properties that have to line up before two cuts can be joined
// with a stream copy. `None` (no audio stream at all) is itself a mismatch when
// another source has sound.
#[derive(Clone, Debug, Default, PartialEq)]
struct SourceAudioParams {
    codec: String,
    sample_rate: String,
    channels: i64,
}

// Every smart-cut refusal reads the same: name what we could not splice, then
// point at the two presets that always work.
fn smart_cut_refusal(reason: &str) -> String {
    format!(
        "Smart cut can't splice this source's video format ({reason}). Use \"Lossless cut\" for a byte-exact export (cuts snap to keyframes) or any re-encode preset for frame-accurate output."
    )
}

// ffprobe reports frame rates as a rational ("24000/1001"); a plain decimal is
// accepted too. "0/0" (what a VFR stream reports) yields None.
fn parse_fps_rational(value: &str) -> Option<f64> {
    let trimmed = value.trim();
    let fps = match trimmed.split_once('/') {
        Some((num, den)) => {
            let den: f64 = den.trim().parse().ok()?;
            if den == 0.0 {
                return None;
            }
            num.trim().parse::<f64>().ok()? / den
        }
        None => trimmed.parse::<f64>().ok()?,
    };
    (fps.is_finite() && fps > 0.0).then_some(fps)
}

// Frame rate used for the half-frame cut tolerance, plus the VFR guard: when
// the average and nominal rates disagree by more than 1% the stream's timing is
// not predictable across a splice, so refuse instead of emitting a cut that
// drifts. Tolerances are computed from the average rate.
fn smart_cut_fps(params: &SourceVideoParams) -> Result<f64, String> {
    let (Some(avg), Some(nominal)) = (
        parse_fps_rational(&params.avg_frame_rate),
        parse_fps_rational(&params.r_frame_rate),
    ) else {
        return Err(smart_cut_refusal("variable frame rate"));
    };
    if (avg - nominal).abs() / avg.max(nominal) > 0.01 {
        return Err(smart_cut_refusal("variable frame rate"));
    }
    Ok(avg)
}

// Bit depth carried by an ffprobe pix_fmt name. The depth is the digit run
// after the last plane marker ("yuv420p10le" -> 10, "p010le" -> 10); names with
// no such run are 8-bit ("yuv420p", "nv12", "rgb24"). Note "yuv410p" is 8-bit —
// which is why this reads the suffix rather than searching for "10" anywhere.
fn pix_fmt_bit_depth(pix_fmt: &str) -> Option<u8> {
    if pix_fmt.trim().is_empty() {
        return None;
    }
    let trimmed = pix_fmt.trim().trim_end_matches("le").trim_end_matches("be");
    let tail = trimmed.rsplit('p').next().unwrap_or("");
    if tail.is_empty() {
        return Some(8);
    }
    match tail.parse::<u8>() {
        Ok(depth) if (8..=16).contains(&depth) => Some(depth),
        Ok(_) => None,
        Err(_) => Some(8),
    }
}

// Head-encoder matrix. CPU encoders only, deliberately: the head has to splice
// onto the source's own bitstream, libx264/libx265 reproduce the source profile
// far more reliably than NVENC, and it keeps CPU and GPU clip mode byte-for-byte
// identical. CRF 12/14 over a sub-second head is visually transparent. Anything
// outside the matrix is refused rather than silently re-encoded at a depth or
// codec the body copy cannot be joined to.
fn smart_cut_head_encoder_args(codec: &str, pix_fmt: &str) -> Result<Vec<String>, String> {
    let codec = codec.trim();
    let pix_fmt = pix_fmt.trim();
    match (codec, pix_fmt_bit_depth(pix_fmt)) {
        ("h264", Some(8)) => Ok(vec![
            "-c:v".to_string(), "libx264".to_string(),
            "-preset".to_string(), "medium".to_string(),
            "-crf".to_string(), "12".to_string(),
            "-pix_fmt".to_string(), pix_fmt.to_string(),
        ]),
        ("h264", Some(10)) => Ok(vec![
            "-c:v".to_string(), "libx264".to_string(),
            "-preset".to_string(), "medium".to_string(),
            "-crf".to_string(), "12".to_string(),
            "-profile:v".to_string(), "high10".to_string(),
            "-pix_fmt".to_string(), "yuv420p10le".to_string(),
        ]),
        ("hevc", Some(8)) => Ok(vec![
            "-c:v".to_string(), "libx265".to_string(),
            "-preset".to_string(), "medium".to_string(),
            "-crf".to_string(), "14".to_string(),
            "-pix_fmt".to_string(), pix_fmt.to_string(),
        ]),
        ("hevc", Some(10)) => Ok(vec![
            "-c:v".to_string(), "libx265".to_string(),
            "-preset".to_string(), "medium".to_string(),
            "-crf".to_string(), "14".to_string(),
            "-pix_fmt".to_string(), "yuv420p10le".to_string(),
        ]),
        ("h264" | "hevc", _) => Err(smart_cut_refusal(&format!("{codec} {pix_fmt}"))),
        ("", _) => Err(smart_cut_refusal("unknown")),
        _ => Err(smart_cut_refusal(codec)),
    }
}

// One source file as the merge preflight sees it.
#[derive(Clone, Debug)]
struct SourceMergeProfile {
    name: String,
    video: SourceVideoParams,
    audio: Option<SourceAudioParams>,
}

// Smart cut cuts each clip on its own and then joins the pieces with a stream
// copy. The join takes its stream layout from the FIRST piece and copies
// everything after it under that description, so anything that disagrees comes
// out broken rather than rejected: a different codec plays as garbage, a
// different size shows as a torn picture, and a first clip with no sound throws
// away the sound of every later clip. None of that surfaces as an error — the
// export reports success. So every source is compared up front and the whole
// merge is refused before a single file is written.
//
// Returns the message to show the user, or None when the sources can be joined.
fn smart_cut_merge_mismatch(profiles: &[SourceMergeProfile]) -> Option<String> {
    let refuse = |what: &str, first: &SourceMergeProfile, other: &SourceMergeProfile,
                  first_value: String, other_value: String| {
        Some(format!(
            "Smart cut can't merge clips whose {what} differ: \"{}\" is {first_value} and \"{}\" is {other_value}. \
             Joining them without re-encoding would produce a file that breaks partway through. \
             Merge these with a re-encode preset, or export the clips separately.",
            first.name, other.name
        ))
    };

    let first = profiles.first()?;
    for other in profiles.iter().skip(1) {
        if !first.video.codec.eq_ignore_ascii_case(&other.video.codec) {
            return refuse("video formats", first, other,
                first.video.codec.clone(), other.video.codec.clone());
        }
        if first.video.pix_fmt != other.video.pix_fmt {
            return refuse("colour formats", first, other,
                first.video.pix_fmt.clone(), other.video.pix_fmt.clone());
        }
        if (first.video.width, first.video.height) != (other.video.width, other.video.height) {
            return refuse("frame sizes", first, other,
                format!("{}x{}", first.video.width, first.video.height),
                format!("{}x{}", other.video.width, other.video.height));
        }
        // Frame rates get the same 1% tolerance the single-clip guard uses:
        // 23.976 and 24 splice cleanly, 24 and 30 do not.
        let rates = (
            parse_fps_rational(&first.video.avg_frame_rate),
            parse_fps_rational(&other.video.avg_frame_rate),
        );
        if let (Some(a), Some(b)) = rates {
            if (a - b).abs() / a.max(b) > 0.01 {
                return refuse("frame rates", first, other,
                    format!("{a:.3} fps"), format!("{b:.3} fps"));
            }
        }

        match (&first.audio, &other.audio) {
            (None, Some(_)) | (Some(_), None) => {
                let (silent, sounded) = if first.audio.is_none() {
                    (&first.name, &other.name)
                } else {
                    (&other.name, &first.name)
                };
                return Some(format!(
                    "Smart cut can't merge these clips: \"{silent}\" has no sound and \"{sounded}\" does. \
                     The joined file would come out silent all the way through. \
                     Merge these with a re-encode preset, or export the clips separately."
                ));
            }
            (Some(a), Some(b)) => {
                if !a.codec.eq_ignore_ascii_case(&b.codec) {
                    return refuse("sound formats", first, other, a.codec.clone(), b.codec.clone());
                }
                if a.sample_rate != b.sample_rate || a.channels != b.channels {
                    return refuse("sound layouts", first, other,
                        format!("{} Hz, {} channel(s)", a.sample_rate, a.channels),
                        format!("{} Hz, {} channel(s)", b.sample_rate, b.channels));
                }
            }
            (None, None) => {}
        }
    }
    None
}

// Earliest keyframe at or after `start` in ffprobe's `packet=pts_time,flags`
// CSV. Packets are listed in decode order, so a stream with B-frames can print
// a later pts before an earlier one — every line is scanned for the minimum
// rather than trusting the first `K`. A keyframe up to half a frame before
// `start` still counts as landing on the cut.
//
// `start_offset` is the container's first timestamp. ffprobe prints packet
// timestamps on the container's own timeline while `start` (and every ffmpeg
// -ss the caller builds from the result) is counted from the first visible
// frame, so the offset is subtracted here and the returned time is always
// counted from the start of the picture.
fn first_keyframe_at_or_after(
    csv: &str,
    start: f64,
    tolerance: f64,
    start_offset: f64,
) -> Option<f64> {
    let mut earliest: Option<f64> = None;
    for line in csv.lines() {
        let mut fields = line.split(',');
        let Some(pts) = fields.next().and_then(|field| field.trim().parse::<f64>().ok()) else {
            continue;
        };
        let Some(flags) = fields.next() else { continue };
        let pts = pts - start_offset;
        if !flags.contains('K') || pts < start - tolerance {
            continue;
        }
        if earliest.map_or(true, |current| pts < current) {
            earliest = Some(pts);
        }
    }
    earliest
}

fn parse_source_video_params(json_text: &str) -> Result<SourceVideoParams, String> {
    let value: Value = serde_json::from_str(json_text)
        .map_err(|error| format!("Could not read this file's video format: {error}"))?;
    let stream = value
        .get("streams")
        .and_then(|streams| streams.get(0))
        .ok_or_else(|| "This file has no video stream to cut.".to_string())?;
    let field = |key: &str| {
        stream
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let number = |key: &str| stream.get(key).and_then(Value::as_i64).unwrap_or_default();
    // ffmpeg's -ss is measured from the container's start_time (it adds
    // format.start_time to the seek target), so that is the value that turns a
    // probed packet timestamp into a seek position. A file with no reported
    // start (or a negative one, which ffmpeg does not add either) is treated as
    // starting at zero.
    let start_offset = value
        .get("format")
        .and_then(|format| format.get("start_time"))
        .and_then(Value::as_str)
        .and_then(|text| text.trim().parse::<f64>().ok())
        .filter(|offset| offset.is_finite() && *offset > 0.0)
        .unwrap_or(0.0);
    Ok(SourceVideoParams {
        codec: field("codec_name"),
        pix_fmt: field("pix_fmt"),
        width: number("width"),
        height: number("height"),
        avg_frame_rate: field("avg_frame_rate"),
        r_frame_rate: field("r_frame_rate"),
        start_offset,
    })
}

fn probe_source_video_params(ffprobe: &Path, input: &Path) -> Result<SourceVideoParams, String> {
    let output = cmd(ffprobe)
        .arg("-v").arg("error")
        .arg("-select_streams").arg("v:0")
        .arg("-show_entries")
        .arg("stream=codec_name,pix_fmt,width,height,avg_frame_rate,r_frame_rate:format=start_time")
        .arg("-of").arg("json")
        .arg(input)
        .output()
        .map_err(|error| format!("Could not read this file's video format: {error}"))?;
    if !output.status.success() {
        return Err("Could not read this file's video format.".to_string());
    }
    parse_source_video_params(&String::from_utf8_lossy(&output.stdout))
}

fn parse_source_audio_params(json_text: &str) -> Option<SourceAudioParams> {
    let value: Value = serde_json::from_str(json_text).ok()?;
    let stream = value.get("streams").and_then(|streams| streams.get(0))?;
    let field = |key: &str| {
        stream
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    Some(SourceAudioParams {
        codec: field("codec_name"),
        sample_rate: field("sample_rate"),
        channels: stream.get("channels").and_then(Value::as_i64).unwrap_or_default(),
    })
}

// `None` means the file has no audio stream (or could not be read), which the
// merge preflight treats as "silent" rather than as an error.
fn probe_source_audio_params(ffprobe: &Path, input: &Path) -> Option<SourceAudioParams> {
    let output = cmd(ffprobe)
        .arg("-v").arg("error")
        .arg("-select_streams").arg("a:0")
        .arg("-show_entries")
        .arg("stream=codec_name,sample_rate,channels")
        .arg("-of").arg("json")
        .arg(input)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_source_audio_params(&String::from_utf8_lossy(&output.stdout))
}

// Packets in an ffprobe `packet=pts_time` CSV dump.
//
// Only the FIRST field is parsed. ffprobe prints a trailing comma on every line
// for some containers (transport streams among them) and none for others, so a
// whole-line parse silently counts zero packets in a perfectly good segment —
// which is exactly what smart cut's body check reads as "this copy landed on
// the wrong footage", throwing away every splice and re-encoding every clip.
fn count_packet_lines(csv: &str) -> usize {
    csv.lines()
        .filter(|line| {
            line.split(',')
                .next()
                .is_some_and(|field| field.trim().parse::<f64>().is_ok())
        })
        .count()
}

// Video packet count of a finished segment. Only ever called on the short temp
// segments smart cut writes, so listing every packet is cheap.
fn probe_video_packet_count(ffprobe: &Path, input: &Path) -> Option<usize> {
    let output = cmd(ffprobe)
        .arg("-v").arg("error")
        .arg("-select_streams").arg("v:0")
        .arg("-show_entries").arg("packet=pts_time")
        .arg("-of").arg("csv=p=0")
        .arg(input)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(count_packet_lines(&String::from_utf8_lossy(&output.stdout)))
}

// Keyframe lookup over a bounded 40 s window, not the whole file — a full
// packet dump of a 24-minute episode costs seconds per clip. A start near EOF
// or an absurd GOP length returns None, which the caller answers by re-encoding
// the whole clip.
//
// `start` is counted from the first visible frame; the read window has to be
// asked for on the container's own timeline, so the source's start timestamp is
// added here and taken back off every result.
fn probe_first_keyframe(
    ffprobe: &Path,
    input: &Path,
    start: f64,
    tolerance: f64,
    start_offset: f64,
) -> Option<f64> {
    let window_start = start + start_offset;
    let output = cmd(ffprobe)
        .arg("-v").arg("error")
        .arg("-select_streams").arg("v:0")
        .arg("-show_entries").arg("packet=pts_time,flags")
        .arg("-read_intervals").arg(format!("{window_start:.3}%+40"))
        .arg("-of").arg("csv=p=0")
        .arg(input)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    first_keyframe_at_or_after(
        &String::from_utf8_lossy(&output.stdout),
        start,
        tolerance,
        start_offset,
    )
}

#[cfg(test)]
mod rate_control_tests {
    use super::{
        av1_nvenc_video_args, gpu_cpu_fallback_video_args, gpu_intra_video_args,
        h264_10bit_cpu_video_args, h264_10bit_nvenc_video_args, h264_cpu_video_args,
        h264_nvenc_video_args, hevc_cpu_video_args, preset_extension,
    };

    fn value_after<'a>(args: &'a [String], flag: &str) -> &'a str {
        let index = args.iter().position(|arg| arg == flag).expect("flag should exist");
        args.get(index + 1).expect("flag should have a value")
    }

    #[test]
    fn quality_zero_reaches_both_encoders() {
        let nvenc = h264_10bit_nvenc_video_args(Some(0), Some("quality"), None).unwrap();
        let cpu = h264_10bit_cpu_video_args(Some(0), Some("quality"), None).unwrap();
        assert_eq!(value_after(&nvenc, "-qp"), "0");
        assert_eq!(value_after(&cpu, "-crf"), "0");
    }

    #[test]
    fn quality_is_clamped_to_the_supported_range() {
        let nvenc = h264_10bit_nvenc_video_args(Some(-5), None, None).unwrap();
        let cpu = h264_10bit_cpu_video_args(Some(99), None, None).unwrap();
        assert_eq!(value_after(&nvenc, "-qp"), "0");
        assert_eq!(value_after(&cpu, "-crf"), "28");
    }

    #[test]
    fn vbr_mode_reaches_both_encoders_without_quality_flags() {
        let nvenc = h264_10bit_nvenc_video_args(None, Some("vbr"), Some(20.5)).unwrap();
        let cpu = h264_10bit_cpu_video_args(None, Some("vbr"), Some(20.5)).unwrap();
        assert_eq!(value_after(&nvenc, "-rc"), "vbr");
        assert_eq!(value_after(&nvenc, "-b:v"), "20.5M");
        assert_eq!(value_after(&cpu, "-b:v"), "20.5M");
        assert!(!nvenc.iter().any(|arg| arg == "-qp"));
        assert!(!cpu.iter().any(|arg| arg == "-crf"));
    }

    #[test]
    fn cbr_mode_enforces_the_rate_for_both_encoders() {
        let nvenc = h264_10bit_nvenc_video_args(None, Some("cbr"), Some(20.5)).unwrap();
        let cpu = h264_10bit_cpu_video_args(None, Some("cbr"), Some(20.5)).unwrap();

        assert_eq!(value_after(&nvenc, "-rc"), "cbr");
        assert_eq!(value_after(&nvenc, "-b:v"), "20.5M");
        assert_eq!(value_after(&nvenc, "-minrate"), "20.5M");
        assert_eq!(value_after(&nvenc, "-maxrate"), "20.5M");
        assert_eq!(value_after(&nvenc, "-bufsize"), "41M");
        assert_eq!(value_after(&nvenc, "-cbr_padding"), "1");

        assert_eq!(value_after(&cpu, "-b:v"), "20.5M");
        assert_eq!(value_after(&cpu, "-minrate"), "20.5M");
        assert_eq!(value_after(&cpu, "-maxrate"), "20.5M");
        assert_eq!(value_after(&cpu, "-bufsize"), "41M");
        assert_eq!(value_after(&cpu, "-x264-params"), "nal-hrd=cbr");
    }

    #[test]
    fn bitrate_has_no_upper_cap_but_rejects_zero() {
        let cpu = h264_10bit_cpu_video_args(None, Some("vbr"), Some(350.5)).unwrap();
        assert_eq!(value_after(&cpu, "-b:v"), "350.5M");
        assert!(h264_10bit_nvenc_video_args(None, Some("cbr"), Some(0.0)).is_err());
    }

    #[test]
    fn both_presets_force_high_10_four_twenty_output() {
        let nvenc = h264_10bit_nvenc_video_args(None, None, None).unwrap();
        let cpu = h264_10bit_cpu_video_args(None, None, None).unwrap();
        assert_eq!(value_after(&nvenc, "-profile:v"), "high10");
        assert_eq!(value_after(&nvenc, "-pix_fmt"), "p010le");
        assert_eq!(value_after(&cpu, "-profile:v"), "high10");
        assert_eq!(value_after(&cpu, "-pix_fmt"), "yuv420p10le");
        assert_eq!(preset_extension("h264-10bit-nvenc"), "mp4");
        assert_eq!(preset_extension("h264-10bit-cpu"), "mp4");
    }

    type VideoArgsFn = fn(Option<i32>, Option<&str>, Option<f64>) -> Result<Vec<String>, String>;

    fn assert_all_rate_modes(build: VideoArgsFn, quality_flag: &str, expected_quality: &str) {
        let quality = build(None, Some("quality"), None).unwrap();
        assert_eq!(value_after(&quality, quality_flag), expected_quality);
        assert!(!quality.iter().any(|arg| arg == "-b:v"));

        let vbr = build(None, Some("vbr"), Some(12.5)).unwrap();
        assert_eq!(value_after(&vbr, "-b:v"), "12.5M");
        assert!(!vbr.iter().any(|arg| matches!(arg.as_str(), "-crf" | "-qp" | "-cq")));

        let cbr = build(None, Some("cbr"), Some(12.5)).unwrap();
        assert_eq!(value_after(&cbr, "-b:v"), "12.5M");
        assert_eq!(value_after(&cbr, "-minrate"), "12.5M");
        assert_eq!(value_after(&cbr, "-maxrate"), "12.5M");
        assert_eq!(value_after(&cbr, "-bufsize"), "25M");
    }

    #[test]
    fn newly_enabled_presets_emit_all_three_rate_modes() {
        assert_all_rate_modes(gpu_intra_video_args, "-qp", "16");
        assert_all_rate_modes(h264_nvenc_video_args, "-cq", "18");
        assert_all_rate_modes(av1_nvenc_video_args, "-cq", "24");
        assert_all_rate_modes(h264_cpu_video_args, "-crf", "18");
        assert_all_rate_modes(hevc_cpu_video_args, "-crf", "18");
    }

    #[test]
    fn bundled_nvenc_encoders_enable_cbr_padding() {
        let h264 = h264_nvenc_video_args(None, Some("cbr"), Some(20.0)).unwrap();
        let h264_10bit = h264_10bit_nvenc_video_args(None, Some("cbr"), Some(20.0)).unwrap();
        let av1 = av1_nvenc_video_args(None, Some("cbr"), Some(20.0)).unwrap();
        let hevc = gpu_intra_video_args(None, Some("cbr"), Some(20.0)).unwrap();

        assert_eq!(value_after(&h264, "-cbr_padding"), "1");
        assert_eq!(value_after(&h264_10bit, "-cbr_padding"), "1");
        assert_eq!(value_after(&av1, "-cbr_padding"), "1");
        assert_eq!(value_after(&hevc, "-cbr_padding"), "1");
    }

    #[test]
    fn gpu_fallbacks_preserve_cbr_bitrate() {
        for preset in ["gpu-intra", "h264-nvenc", "h264-10bit-nvenc", "av1-nvenc"] {
            let args = gpu_cpu_fallback_video_args(preset, None, Some("cbr"), Some(37.5)).unwrap();
            assert_eq!(value_after(&args, "-b:v"), "37.5M", "{preset}");
            assert_eq!(value_after(&args, "-minrate"), "37.5M", "{preset}");
            assert_eq!(value_after(&args, "-maxrate"), "37.5M", "{preset}");
            assert_eq!(value_after(&args, "-bufsize"), "75M", "{preset}");
            assert!(!args.iter().any(|arg| arg == "-crf"), "{preset}");
        }
    }

    #[test]
    fn fixed_profile_and_stream_copy_presets_do_not_support_rate_control() {
        assert!(!super::preset_supports_rate_control("prores-lt"));
        assert!(!super::preset_supports_rate_control("prores-hq"));
        assert!(!super::preset_supports_rate_control("lossless-cut"));
        assert!(!super::preset_supports_rate_control("smart-cut"));
        assert!(super::preset_supports_rate_control("h264-cpu"));
    }
}

#[cfg(test)]
mod clip_output_mapping_tests {
    use super::append_clip_stream_maps;

    #[test]
    fn exported_clips_keep_optional_audio_and_discard_source_chapters() {
        let mut args = Vec::new();

        append_clip_stream_maps(&mut args, &["0:v:0", "0:a:0?"]);

        assert_eq!(
            args,
            [
                "-map",
                "0:v:0",
                "-map",
                "0:a:0?",
                "-map_chapters",
                "-1",
            ]
        );
    }
}

#[cfg(test)]
mod smart_cut_tests {
    use super::{
        count_packet_lines, first_keyframe_at_or_after, mp4_codec_tag_args, parse_fps_rational,
        parse_source_audio_params, parse_source_video_params, pix_fmt_bit_depth, preset_extension,
        preset_extension_for, smart_cut_extension, smart_cut_fps, smart_cut_head_encoder_args,
        smart_cut_merge_mismatch, SourceAudioParams, SourceMergeProfile, SourceVideoParams,
        VIDEO_PRESETS,
    };
    use std::path::PathBuf;

    fn params(codec: &str, pix_fmt: &str, avg: &str, r: &str) -> SourceVideoParams {
        SourceVideoParams {
            codec: codec.to_string(),
            pix_fmt: pix_fmt.to_string(),
            width: 1920,
            height: 1080,
            avg_frame_rate: avg.to_string(),
            r_frame_rate: r.to_string(),
            start_offset: 0.0,
        }
    }

    fn audio(codec: &str, sample_rate: &str, channels: i64) -> SourceAudioParams {
        SourceAudioParams {
            codec: codec.to_string(),
            sample_rate: sample_rate.to_string(),
            channels,
        }
    }

    fn profile(name: &str, video: SourceVideoParams, audio: Option<SourceAudioParams>) -> SourceMergeProfile {
        SourceMergeProfile { name: name.to_string(), video, audio }
    }

    #[test]
    fn smart_cut_is_a_registered_preset_defaulting_to_mkv() {
        assert!(VIDEO_PRESETS.contains(&"smart-cut"));
        // Preset alone, with no source to judge by, stays on the safe container.
        assert_eq!(preset_extension("smart-cut"), "mkv");
        assert_eq!(preset_extension_for("smart-cut", &[]), "mkv");
    }

    #[test]
    fn smart_cut_keeps_an_mp4_family_source_in_mp4() {
        for name in ["ep01.mp4", "ep01.MP4", "ep01.m4v", "ep01.mov"] {
            assert_eq!(
                smart_cut_extension(&[PathBuf::from(name)]),
                "mp4",
                "{name} should stay in mp4"
            );
        }
    }

    #[test]
    fn smart_cut_falls_back_to_mkv_for_every_other_source() {
        // MKV/WebM can hold audio (FLAC, DTS, PCM) that ffmpeg will happily
        // write into an mp4 and players then refuse, so they keep today's
        // container. A source with no extension is unknown, so also mkv.
        for name in ["ep01.mkv", "ep01.webm", "ep01.avi", "ep01.ts", "noext"] {
            assert_eq!(
                smart_cut_extension(&[PathBuf::from(name)]),
                "mkv",
                "{name} should stay in mkv"
            );
        }
    }

    #[test]
    fn a_merge_needs_every_source_in_the_mp4_family() {
        let mp4 = PathBuf::from("ep01.mp4");
        let mov = PathBuf::from("ep02.mov");
        let mkv = PathBuf::from("ep03.mkv");
        assert_eq!(smart_cut_extension(&[mp4.clone(), mov.clone()]), "mp4");
        // One mkv in the selection drags the whole merge back to mkv.
        assert_eq!(smart_cut_extension(&[mp4.clone(), mkv.clone()]), "mkv");
        assert_eq!(smart_cut_extension(&[mkv, mp4]), "mkv");
    }

    #[test]
    fn only_smart_cut_reads_the_source_when_picking_a_container() {
        let mp4 = [PathBuf::from("ep01.mp4")];
        assert_eq!(preset_extension_for("smart-cut", &mp4), "mp4");
        // Lossless cut must keep MKV whatever it is handed: it accepts any
        // source codec, including ones mp4 cannot hold.
        assert_eq!(preset_extension_for("lossless-cut", &mp4), "mkv");
        assert_eq!(preset_extension_for("prores-hq", &mp4), "mov");
        assert_eq!(preset_extension_for("h264-cpu", &[PathBuf::from("a.mkv")]), "mp4");
    }

    #[test]
    fn hevc_gets_the_quicktime_tag_only_in_mp4() {
        let mp4 = PathBuf::from("clip.mp4");
        let mkv = PathBuf::from("clip.mkv");
        assert_eq!(
            mp4_codec_tag_args(&mp4, "hevc"),
            vec!["-tag:v".to_string(), "hvc1".to_string()]
        );
        // H.264 already lands as avc1, and MKV has no such tag at all.
        assert!(mp4_codec_tag_args(&mp4, "h264").is_empty());
        assert!(mp4_codec_tag_args(&mkv, "hevc").is_empty());
    }

    #[test]
    fn keyframe_lines_are_read_flags_first_field_second() {
        let csv = "12.000000,K__\n12.041667,__\n";
        assert_eq!(first_keyframe_at_or_after(csv, 12.0, 0.02, 0.0), Some(12.0));
        // A non-keyframe packet at the requested time is never picked.
        assert_eq!(first_keyframe_at_or_after("12.000000,__\n", 12.0, 0.02, 0.0), None);
    }

    #[test]
    fn out_of_order_packets_still_yield_the_earliest_keyframe() {
        // Decode order: the later keyframe is listed first.
        let csv = "18.500000,K__\n12.250000,K__\n9.000000,K__\n";
        assert_eq!(first_keyframe_at_or_after(csv, 12.0, 0.02, 0.0), Some(12.25));
    }

    #[test]
    fn keyframes_within_half_a_frame_before_the_cut_still_count() {
        let csv = "11.990000,K__\n";
        assert_eq!(first_keyframe_at_or_after(csv, 12.0, 0.02, 0.0), Some(11.99));
        assert_eq!(first_keyframe_at_or_after(csv, 12.0, 0.005, 0.0), None);
    }

    #[test]
    fn an_empty_or_garbled_probe_yields_no_keyframe() {
        assert_eq!(first_keyframe_at_or_after("", 12.0, 0.02, 0.0), None);
        assert_eq!(first_keyframe_at_or_after("N/A,K__\nK__\n\n", 12.0, 0.02, 0.0), None);
    }

    #[test]
    fn a_source_that_starts_late_is_measured_from_its_first_frame() {
        // The file's timestamps begin at 1.000, so its keyframes at 1/3/5/7 are
        // 0/2/4/6 counted from the first visible frame. A cut asked for at 3.0
        // must NOT be told it landed on the keyframe printed as 3.000000 —
        // that one is two seconds into the picture.
        let csv = "1.000000,K__\n3.000000,K__\n5.000000,K__\n7.000000,K__\n";
        assert_eq!(first_keyframe_at_or_after(csv, 3.0, 0.02, 1.0), Some(4.0));
        // And the keyframe that IS at 3 seconds of picture is found there.
        assert_eq!(first_keyframe_at_or_after(csv, 2.0, 0.02, 1.0), Some(2.0));
        // With no offset the same probe output means something different.
        assert_eq!(first_keyframe_at_or_after(csv, 3.0, 0.02, 0.0), Some(3.0));
    }

    #[test]
    fn the_probe_keeps_the_containers_start_timestamp() {
        let json = r#"{"streams":[{"codec_name":"h264","width":1920,"height":1080,
            "pix_fmt":"yuv420p","r_frame_rate":"24/1","avg_frame_rate":"24/1"}],
            "format":{"start_time":"1.000000"}}"#;
        assert_eq!(parse_source_video_params(json).unwrap().start_offset, 1.0);
        // Missing, unreadable and negative starts all mean "starts at zero":
        // ffmpeg does not shift a seek for any of them either.
        for start in ["\"N/A\"", "\"-0.500000\"", "null"] {
            let json = format!(
                r#"{{"streams":[{{"codec_name":"h264","pix_fmt":"yuv420p"}}],
                   "format":{{"start_time":{start}}}}}"#
            );
            assert_eq!(parse_source_video_params(&json).unwrap().start_offset, 0.0, "{start}");
        }
        assert_eq!(
            parse_source_video_params(r#"{"streams":[{"codec_name":"h264"}]}"#)
                .unwrap()
                .start_offset,
            0.0
        );
    }

    #[test]
    fn the_audio_probe_reads_the_first_audio_stream() {
        let json = r#"{"streams":[{"codec_name":"aac","sample_rate":"48000","channels":2}]}"#;
        assert_eq!(parse_source_audio_params(json), Some(audio("aac", "48000", 2)));
        assert_eq!(parse_source_audio_params(r#"{"streams":[]}"#), None);
        assert_eq!(parse_source_audio_params("not json"), None);
    }

    #[test]
    fn merges_of_matching_sources_are_allowed() {
        let video = params("h264", "yuv420p", "24000/1001", "24000/1001");
        let sources = vec![
            profile("ep01.mkv", video.clone(), Some(audio("aac", "48000", 2))),
            profile("ep02.mkv", video.clone(), Some(audio("aac", "48000", 2))),
        ];
        assert_eq!(smart_cut_merge_mismatch(&sources), None);
        // 23.976 and 24 are the same rate for splicing purposes.
        let near = params("h264", "yuv420p", "24/1", "24/1");
        assert_eq!(
            smart_cut_merge_mismatch(&[
                profile("a.mkv", video.clone(), None),
                profile("b.mkv", near, None),
            ]),
            None
        );
        // One source, and no sources, have nothing to disagree with.
        assert_eq!(smart_cut_merge_mismatch(&[profile("a.mkv", video, None)]), None);
        assert_eq!(smart_cut_merge_mismatch(&[]), None);
    }

    #[test]
    fn merges_of_mismatched_sources_are_refused_by_name() {
        let h264 = params("h264", "yuv420p", "24/1", "24/1");
        let hevc = params("hevc", "yuv420p", "24/1", "24/1");
        let message = smart_cut_merge_mismatch(&[
            profile("a.mkv", h264.clone(), None),
            profile("b.mkv", hevc, None),
        ])
        .expect("mixed codecs must be refused");
        assert!(message.contains("video formats"), "{message}");
        assert!(message.contains("\"a.mkv\"") && message.contains("\"b.mkv\""), "{message}");

        let mut wide = h264.clone();
        wide.width = 1280;
        wide.height = 720;
        assert!(smart_cut_merge_mismatch(&[
            profile("a.mkv", h264.clone(), None),
            profile("b.mkv", wide, None),
        ])
        .is_some_and(|message| message.contains("frame sizes")));

        let ten_bit = params("h264", "yuv420p10le", "24/1", "24/1");
        assert!(smart_cut_merge_mismatch(&[
            profile("a.mkv", h264.clone(), None),
            profile("b.mkv", ten_bit, None),
        ])
        .is_some_and(|message| message.contains("colour formats")));

        let thirty = params("h264", "yuv420p", "30/1", "30/1");
        assert!(smart_cut_merge_mismatch(&[
            profile("a.mkv", h264.clone(), None),
            profile("b.mkv", thirty, None),
        ])
        .is_some_and(|message| message.contains("frame rates")));
    }

    #[test]
    fn a_silent_source_beside_a_sounded_one_is_refused_either_way_round() {
        let video = params("h264", "yuv420p", "24/1", "24/1");
        let silent_first = smart_cut_merge_mismatch(&[
            profile("silent.mkv", video.clone(), None),
            profile("sound.mkv", video.clone(), Some(audio("aac", "48000", 2))),
        ])
        .expect("a silent first clip must be refused");
        assert!(silent_first.contains("\"silent.mkv\" has no sound"), "{silent_first}");

        let silent_last = smart_cut_merge_mismatch(&[
            profile("sound.mkv", video.clone(), Some(audio("aac", "48000", 2))),
            profile("silent.mkv", video.clone(), None),
        ])
        .expect("a silent later clip must be refused too");
        assert!(silent_last.contains("\"silent.mkv\" has no sound"), "{silent_last}");

        // Different sound formats cannot be joined either.
        assert!(smart_cut_merge_mismatch(&[
            profile("a.mkv", video.clone(), Some(audio("aac", "48000", 2))),
            profile("b.mkv", video.clone(), Some(audio("ac3", "48000", 2))),
        ])
        .is_some_and(|message| message.contains("sound formats")));
        assert!(smart_cut_merge_mismatch(&[
            profile("a.mkv", video.clone(), Some(audio("aac", "48000", 2))),
            profile("b.mkv", video, Some(audio("aac", "44100", 2))),
        ])
        .is_some_and(|message| message.contains("sound layouts")));
    }

    #[test]
    fn packets_are_counted_with_or_without_ffprobes_trailing_comma() {
        // Transport streams (what the body copy is written as) come back with a
        // trailing comma on every line; MKV does not. Both are real packets.
        assert_eq!(count_packet_lines("1.483333,\n1.650000,\n1.566667,\n"), 3);
        assert_eq!(count_packet_lines("0.000000\n0.167000\n0.083000\n"), 3);
        assert_eq!(count_packet_lines("N/A\n\nnot-a-time\n"), 0);
        assert_eq!(count_packet_lines(""), 0);
    }

    #[test]
    fn frame_rates_parse_as_rationals_and_decimals() {
        assert_eq!(parse_fps_rational("24000/1001"), Some(24000.0 / 1001.0));
        assert_eq!(parse_fps_rational("25/1"), Some(25.0));
        assert_eq!(parse_fps_rational("23.976"), Some(23.976));
        assert_eq!(parse_fps_rational("0/0"), None);
        assert_eq!(parse_fps_rational(""), None);
    }

    #[test]
    fn pixel_format_depth_reads_the_suffix_not_any_digit() {
        assert_eq!(pix_fmt_bit_depth("yuv420p"), Some(8));
        assert_eq!(pix_fmt_bit_depth("nv12"), Some(8));
        // 4:1:0 chroma — "10" in the name, still 8-bit.
        assert_eq!(pix_fmt_bit_depth("yuv410p"), Some(8));
        assert_eq!(pix_fmt_bit_depth("yuv420p10le"), Some(10));
        assert_eq!(pix_fmt_bit_depth("p010le"), Some(10));
        assert_eq!(pix_fmt_bit_depth("yuv444p12le"), Some(12));
        assert_eq!(pix_fmt_bit_depth(""), None);
    }

    #[test]
    fn the_head_encoder_matrix_matches_the_source_family() {
        let h264_8bit = smart_cut_head_encoder_args("h264", "yuv420p").unwrap();
        assert_eq!(
            h264_8bit,
            vec!["-c:v", "libx264", "-preset", "medium", "-crf", "12", "-pix_fmt", "yuv420p"]
        );

        let h264_10bit = smart_cut_head_encoder_args("h264", "yuv420p10le").unwrap();
        assert_eq!(
            h264_10bit,
            vec![
                "-c:v", "libx264", "-preset", "medium", "-crf", "12", "-profile:v", "high10",
                "-pix_fmt", "yuv420p10le"
            ]
        );

        let hevc_8bit = smart_cut_head_encoder_args("hevc", "yuv420p").unwrap();
        assert_eq!(
            hevc_8bit,
            vec!["-c:v", "libx265", "-preset", "medium", "-crf", "14", "-pix_fmt", "yuv420p"]
        );

        for pix_fmt in ["yuv420p10le", "p010le"] {
            let hevc_10bit = smart_cut_head_encoder_args("hevc", pix_fmt).unwrap();
            assert_eq!(
                hevc_10bit,
                vec![
                    "-c:v", "libx265", "-preset", "medium", "-crf", "14", "-pix_fmt",
                    "yuv420p10le"
                ],
                "{pix_fmt}"
            );
        }
    }

    #[test]
    fn unsupported_codecs_and_depths_refuse_with_the_alternatives() {
        let av1 = smart_cut_head_encoder_args("av1", "yuv420p10le").unwrap_err();
        assert!(av1.starts_with("Smart cut can't splice this source's video format (av1)."), "{av1}");
        assert!(av1.contains("Lossless cut"), "{av1}");
        assert!(av1.contains("frame-accurate"), "{av1}");

        for codec in ["vp9", "mpeg4", "prores"] {
            assert!(smart_cut_head_encoder_args(codec, "yuv420p").is_err(), "{codec}");
        }

        // Right codec family, depth we will not re-encode blind.
        let deep = smart_cut_head_encoder_args("hevc", "yuv444p12le").unwrap_err();
        assert!(deep.contains("(hevc yuv444p12le)"), "{deep}");
        assert!(smart_cut_head_encoder_args("", "").is_err());
    }

    #[test]
    fn constant_frame_rate_sources_pass_and_variable_ones_refuse() {
        let ntsc = params("h264", "yuv420p", "24000/1001", "24000/1001");
        assert_eq!(smart_cut_fps(&ntsc).unwrap(), 24000.0 / 1001.0);

        // Under 1% apart (23.976 vs 24) is still treated as constant.
        let close = params("h264", "yuv420p", "24000/1001", "24/1");
        assert!(smart_cut_fps(&close).is_ok());

        for (avg, r) in [("24000/1001", "30000/1001"), ("0/0", "24/1"), ("", "")] {
            let vfr = params("h264", "yuv420p", avg, r);
            let error = smart_cut_fps(&vfr).unwrap_err();
            assert!(error.contains("(variable frame rate)"), "{avg}/{r}: {error}");
        }
    }

    #[test]
    fn the_stream_probe_reads_the_first_video_stream() {
        let json = r#"{"streams":[{"codec_name":"hevc","width":1920,"height":1080,
            "pix_fmt":"yuv420p10le","r_frame_rate":"24000/1001","avg_frame_rate":"24000/1001"}],
            "format":{"start_time":"0.000000"}}"#;
        assert_eq!(
            parse_source_video_params(json).unwrap(),
            params("hevc", "yuv420p10le", "24000/1001", "24000/1001")
        );
        assert!(parse_source_video_params(r#"{"streams":[]}"#).is_err());
        assert!(parse_source_video_params("not json").is_err());
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

// Called at the top of every export: a cancel request belongs to the export it
// was made during, never to the next one.
fn begin_clip_export() {
    CLIP_CANCEL_REQUESTED.store(false, std::sync::atomic::Ordering::SeqCst);
}

fn clip_export_cancelled() -> bool {
    CLIP_CANCEL_REQUESTED.load(std::sync::atomic::Ordering::SeqCst)
}

// Every ffmpeg run that belongs to a clip export goes through here. Killing the
// running child is not enough on its own: between two of them there is no child
// to kill, so the flag is checked before the next one starts and again after it
// returns. The error text matches what a killed run produces, so the frontend
// sees one cancellation either way.
fn run_clip_ffmpeg(
    window: &tauri::Window,
    ffmpeg: &Path,
    args: Vec<String>,
    duration: f64,
    label: &str,
) -> Result<(), String> {
    if clip_export_cancelled() {
        return Err(format!("{label} cancelled."));
    }
    let result = run_ffmpeg_with_progress(
        window,
        ffmpeg,
        args,
        duration,
        label,
        Some(&CLIP_CHILD_PID),
    );
    if clip_export_cancelled() {
        return Err(format!("{label} cancelled."));
    }
    result
}

fn run_clip_export(
    window: tauri::Window,
    clips: Vec<ExportClip>,
    output_dir: String,
    preset: String,
    quality_value: Option<i32>,
    rate_mode: Option<String>,
    bitrate_mbps: Option<f64>,
) -> Result<String, String> {
    begin_clip_export();
    let (rate_mode, bitrate_mbps) = if preset_supports_rate_control(&preset) {
        (rate_mode, bitrate_mbps)
    } else {
        (None, None)
    };
    let root = app_root()?;
    let ffmpeg = find_tool(&root, "ffmpeg");
    let ffprobe = find_tool(&root, "ffprobe");
    ensure_tool(&ffmpeg)?;
    ensure_tool(&ffprobe)?;

    let out_dir = PathBuf::from(&output_dir);
    fs::create_dir_all(&out_dir).map_err(|e| format!("Could not create output directory: {e}"))?;

    let mut file_index = 1;
    let mut exported_paths = Vec::with_capacity(clips.len());

    for (i, clip) in clips.iter().enumerate() {
        let input = canonical_input_path(&clip.source)?;
        let color = probe_color_metadata(&ffprobe, &input);

        let ext = preset_extension_for(&preset, std::slice::from_ref(&input));
        let output = loop {
            let candidate = out_dir.join(format!("{file_index}.{ext}"));
            if !candidate.exists() {
                break candidate;
            }
            file_index += 1;
        };
        file_index += 1;

        // Smart cut cannot share the single-invocation shape below: one clip is
        // a head re-encode + a body copy + a concat. It is handled here and the
        // arm list is left untouched.
        if preset == "smart-cut" {
            let (export_start, export_duration) = padded_clip_range(clip);
            let span = 100.0 / clips.len() as f32;
            run_smart_cut_clip(
                &window,
                &ffmpeg,
                &ffprobe,
                &input,
                &color,
                export_start,
                export_duration,
                &output,
                &format!("Smart cut clip {}/{}", i + 1, clips.len()),
                i as f32 * span,
                span,
            )?;
            exported_paths.push(output.to_string_lossy().to_string());
            continue;
        }

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
                args.extend(input_args.iter().cloned());
                args.extend(gpu_intra_video_args(
                    quality_value,
                    rate_mode.as_deref(),
                    bitrate_mbps,
                )?);
                args.extend([
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
                args.extend(input_args.iter().cloned());
                args.extend(h264_nvenc_video_args(
                    quality_value,
                    rate_mode.as_deref(),
                    bitrate_mbps,
                )?);
                args.extend([
                    "-c:a".to_string(),
                    "aac".to_string(),
                    "-b:a".to_string(),
                    "320k".to_string(),
                ]);
                format!("Encoding H.264 (NVENC) clip {}/{}", i + 1, clips.len())
            }
            "h264-10bit-nvenc" => {
                args.extend(input_args.iter().cloned());
                args.extend(h264_10bit_nvenc_video_args(quality_value, rate_mode.as_deref(), bitrate_mbps)?);
                args.extend([
                    "-c:a".to_string(),
                    "aac".to_string(),
                    "-b:a".to_string(),
                    "320k".to_string(),
                ]);
                format!("Encoding H.264 10-bit (NVENC) clip {}/{}", i + 1, clips.len())
            }
            "av1-nvenc" => {
                args.extend(input_args.iter().cloned());
                args.extend(av1_nvenc_video_args(
                    quality_value,
                    rate_mode.as_deref(),
                    bitrate_mbps,
                )?);
                args.extend([
                    "-c:a".to_string(),
                    "aac".to_string(),
                    "-b:a".to_string(),
                    "320k".to_string(),
                ]);
                format!("Encoding AV1 (NVENC) clip {}/{}", i + 1, clips.len())
            }
            "h264-cpu" => {
                args.extend(input_args.iter().cloned());
                args.extend(h264_cpu_video_args(
                    quality_value,
                    rate_mode.as_deref(),
                    bitrate_mbps,
                )?);
                args.extend([
                    "-c:a".to_string(),
                    "aac".to_string(),
                    "-b:a".to_string(),
                    "320k".to_string(),
                ]);
                format!("Encoding H.264 (CPU) clip {}/{}", i + 1, clips.len())
            }
            "h264-10bit-cpu" => {
                args.extend(input_args.iter().cloned());
                args.extend(h264_10bit_cpu_video_args(quality_value, rate_mode.as_deref(), bitrate_mbps)?);
                args.extend([
                    "-c:a".to_string(),
                    "aac".to_string(),
                    "-b:a".to_string(),
                    "320k".to_string(),
                ]);
                format!("Encoding H.264 10-bit (CPU) clip {}/{}", i + 1, clips.len())
            }
            "hevc-cpu" => {
                args.extend(input_args.iter().cloned());
                args.extend(hevc_cpu_video_args(
                    quality_value,
                    rate_mode.as_deref(),
                    bitrate_mbps,
                )?);
                args.extend([
                    "-c:a".to_string(),
                    "aac".to_string(),
                    "-b:a".to_string(),
                    "320k".to_string(),
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

        // Keep the finished file to picture + optional audio. Chapter metadata
        // has a separate mapping switch and can otherwise stretch a MOV's
        // advertised timeline back to the full source episode.
        append_clip_stream_maps(&mut args, &["0:v:0", "0:a:0?"]);

        args.extend([
            "-progress".to_string(),
            "pipe:1".to_string(),
            "-stats_period".to_string(),
            "0.5".to_string(),
            output.to_string_lossy().to_string(),
        ]);

        let duration = export_duration;
        emit_conversion_progress(&window, "starting", Some(0.0), message, None, None);
        let primary_result = run_clip_ffmpeg(
            &window,
            &ffmpeg,
            args,
            duration,
            "Exporting clip",
        );

        if let Err(primary_error) = primary_result {
            if matches!(
                preset.as_str(),
                "gpu-intra" | "h264-nvenc" | "h264-10bit-nvenc" | "av1-nvenc"
            ) {
                let fallback_message = match preset.as_str() {
                    "h264-10bit-nvenc" => "H.264 10-bit NVENC failed; retrying with the CPU 10-bit encoder",
                    "h264-nvenc" => "H.264 NVENC failed; retrying with libx264 software encoder",
                    "av1-nvenc" => "AV1 NVENC failed; retrying with libx264 software encoder",
                    _ => "GPU Intra NVENC failed; retrying with libx264 software encoder",
                };
                log_warn(
                    "clip.export.fallback",
                    fallback_message,
                    json!({ "clip": i + 1, "preset": &preset, "error": &primary_error }),
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
                ]);
                fallback_args.extend(gpu_cpu_fallback_video_args(
                    &preset,
                    quality_value,
                    rate_mode.as_deref(),
                    bitrate_mbps,
                )?);
                fallback_args.extend([
                    "-c:a".to_string(),
                    "aac".to_string(),
                    "-b:a".to_string(),
                    "320k".to_string(),
                ]);
                fallback_args.extend(color_tag_args(&color));
                append_clip_stream_maps(&mut fallback_args, &["0:v:0", "0:a:0?"]);
                fallback_args.extend([
                    "-progress".to_string(),
                    "pipe:1".to_string(),
                    "-stats_period".to_string(),
                    "0.5".to_string(),
                    output.to_string_lossy().to_string(),
                ]);
                run_clip_ffmpeg(
                    &window,
                    &ffmpeg,
                    fallback_args,
                    duration,
                    "Exporting clip (libx264 fallback)",
                )?;
            } else {
                return Err(primary_error);
            }
        }
        exported_paths.push(output.to_string_lossy().to_string());
    }

    serde_json::to_string(&json!({
        "type": "done",
        "input": format!("{} clips", clips.len()),
        "output": output_dir,
        "outputs": exported_paths,
        "archivedOriginal": null,
        "preset": preset,
    }))
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn clip_export_merged(
    window: tauri::Window,
    clips: Vec<ExportClip>,
    output_dir: String,
    preset: String,
    quality_value: Option<i32>,
    rate_mode: Option<String>,
    bitrate_mbps: Option<f64>,
) -> Result<String, String> {
    if clips.len() < 2 {
        return Err("Merge requires at least 2 clips".to_string());
    }
    if !VIDEO_PRESETS.contains(&preset.as_str()) {
        return Err(VIDEO_PRESET_ERROR.to_string());
    }
    log_info(
        "clip.export_merged.start",
        "Starting merged clip export",
        json!({ "clipCount": clips.len(), "outputDir": &output_dir, "preset": &preset, "qualityValue": quality_value, "rateMode": &rate_mode, "bitrateMbps": bitrate_mbps }),
    );
    let log_clip_count = clips.len();
    let log_output_dir = output_dir.clone();
    let log_preset = preset.clone();
    let log_rate_mode = rate_mode.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_clip_export_merged(window, clips, output_dir, preset, quality_value, rate_mode, bitrate_mbps)
    })
    .await
    .map_err(|error| error.to_string())?;
    match &result {
        Ok(payload) => log_info(
            "clip.export_merged.complete",
            "Merged clip export completed",
            json!({ "clipCount": log_clip_count, "outputDir": log_output_dir, "preset": log_preset, "qualityValue": quality_value, "rateMode": log_rate_mode, "bitrateMbps": bitrate_mbps, "result": payload }),
        ),
        Err(error) => log_error(
            "clip.export_merged.error",
            "Merged clip export failed",
            json!({ "clipCount": log_clip_count, "outputDir": log_output_dir, "preset": log_preset, "qualityValue": quality_value, "rateMode": log_rate_mode, "bitrateMbps": bitrate_mbps, "error": error }),
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
    rate_mode: Option<String>,
    bitrate_mbps: Option<f64>,
) -> Result<String, String> {
    begin_clip_export();
    let (rate_mode, bitrate_mbps) = if preset_supports_rate_control(&preset) {
        (rate_mode, bitrate_mbps)
    } else {
        (None, None)
    };
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
    // Sources are resolved BEFORE the output is named: smart cut picks the
    // container from them, so the name cannot be decided without them.
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

    let ext = preset_extension_for(&preset, &input_paths);
    let mut output = out_dir.join(format!("{base_name}.{ext}"));
    let mut suffix = 1;
    while output.exists() {
        output = out_dir.join(format!("{base_name} ({suffix}).{ext}"));
        suffix += 1;
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

    // Smart-cut merge is the same stream-copy shape, with each segment cut
    // frame-accurately instead of snapped to a keyframe.
    if preset == "smart-cut" {
        return run_smart_cut_merge(
            &window,
            &ffmpeg,
            &ffprobe,
            &clips,
            &input_paths,
            &input_index_for_clip,
            &out_dir,
            &output,
            &color,
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
    let mut output_streams = vec!["[outv]"];
    if any_has_audio {
        output_streams.push("[outa]");
    }
    append_clip_stream_maps(&mut args, &output_streams);

    let encode_args: Vec<String> = match preset.as_str() {
        "gpu-intra" => {
            let mut v = gpu_intra_video_args(
                quality_value,
                rate_mode.as_deref(),
                bitrate_mbps,
            )?;
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
            let mut v = h264_nvenc_video_args(
                quality_value,
                rate_mode.as_deref(),
                bitrate_mbps,
            )?;
            if any_has_audio {
                v.extend([
                    "-c:a".to_string(), "aac".to_string(),
                    "-b:a".to_string(), "320k".to_string(),
                ]);
            }
            v
        }
        "h264-10bit-nvenc" => {
            let mut v = h264_10bit_nvenc_video_args(quality_value, rate_mode.as_deref(), bitrate_mbps)?;
            if any_has_audio {
                v.extend([
                    "-c:a".to_string(), "aac".to_string(),
                    "-b:a".to_string(), "320k".to_string(),
                ]);
            }
            v
        }
        "av1-nvenc" => {
            let mut v = av1_nvenc_video_args(
                quality_value,
                rate_mode.as_deref(),
                bitrate_mbps,
            )?;
            if any_has_audio {
                v.extend([
                    "-c:a".to_string(), "aac".to_string(),
                    "-b:a".to_string(), "320k".to_string(),
                ]);
            }
            v
        }
        "h264-cpu" => {
            let mut v = h264_cpu_video_args(
                quality_value,
                rate_mode.as_deref(),
                bitrate_mbps,
            )?;
            if any_has_audio {
                v.extend([
                    "-c:a".to_string(), "aac".to_string(),
                    "-b:a".to_string(), "320k".to_string(),
                ]);
            }
            v
        }
        "h264-10bit-cpu" => {
            let mut v = h264_10bit_cpu_video_args(quality_value, rate_mode.as_deref(), bitrate_mbps)?;
            if any_has_audio {
                v.extend([
                    "-c:a".to_string(), "aac".to_string(),
                    "-b:a".to_string(), "320k".to_string(),
                ]);
            }
            v
        }
        "hevc-cpu" => {
            let mut v = hevc_cpu_video_args(
                quality_value,
                rate_mode.as_deref(),
                bitrate_mbps,
            )?;
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
    let primary_result = run_clip_ffmpeg(
        &window,
        &ffmpeg,
        args,
        total_duration,
        "Merging clips",
    );
    if let Err(primary_error) = primary_result {
        if matches!(
            preset.as_str(),
            "gpu-intra" | "h264-nvenc" | "h264-10bit-nvenc" | "av1-nvenc"
        ) {
            let fallback_message = match preset.as_str() {
                "h264-10bit-nvenc" => "H.264 10-bit NVENC failed during merge; retrying with the CPU 10-bit encoder",
                "h264-nvenc" => "H.264 NVENC failed during merge; retrying with libx264 software encoder",
                "av1-nvenc" => "AV1 NVENC failed during merge; retrying with libx264 software encoder",
                _ => "GPU Intra NVENC failed during merge; retrying with libx264 software encoder",
            };
            log_warn(
                "clip.export_merged.fallback",
                fallback_message,
                json!({ "preset": &preset, "error": &primary_error }),
            );
            let _ = fs::remove_file(&output);
            let mut fallback_args = pre_encode_args;
            fallback_args.extend(gpu_cpu_fallback_video_args(
                &preset,
                quality_value,
                rate_mode.as_deref(),
                bitrate_mbps,
            )?);
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
            run_clip_ffmpeg(
                &window,
                &ffmpeg,
                fallback_args,
                total_duration,
                "Merging clips (libx264 fallback)",
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

// RAII-ish cleanup of a segment temp dir on every exit path — success, error,
// and cancel (the ffmpeg child dies first, then this unwinds).
struct TempDirGuard(PathBuf);
impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

// A final output written under a temporary name and moved into place only once
// ffmpeg has finished successfully.
//
// ffmpeg creates its output file the moment it opens it, so a failure, a
// cancel, or a killed process leaves a playable-looking file sitting in the
// export folder under the name the user asked for — usually zero bytes or a
// fraction of the clip. Writing beside it and renaming afterwards means the
// export folder only ever gains a file that is finished. The temp name keeps
// the real extension so ffmpeg still picks the right container, and starts with
// a dot so it is out of the way if anything ever interrupts the cleanup.
struct StagedOutput {
    temp: PathBuf,
    destination: PathBuf,
    committed: bool,
}

impl StagedOutput {
    fn new(destination: &Path) -> StagedOutput {
        let parent = destination.parent().unwrap_or_else(|| Path::new("."));
        let stem = destination
            .file_stem()
            .map(|stem| stem.to_string_lossy().to_string())
            .unwrap_or_else(|| "output".to_string());
        // The extension has to stay on the end: ffmpeg picks the container from
        // it, and a name ending in ".part1234" would fail to open at all.
        let temp_name = match destination.extension() {
            Some(ext) => format!(".{stem}.part{}.{}", std::process::id(), ext.to_string_lossy()),
            None => format!(".{stem}.part{}", std::process::id()),
        };
        StagedOutput {
            temp: parent.join(temp_name),
            destination: destination.to_path_buf(),
            committed: false,
        }
    }

    fn path(&self) -> &Path {
        &self.temp
    }

    fn commit(mut self) -> Result<(), String> {
        fs::rename(&self.temp, &self.destination)
            .map_err(|error| format!("Could not write the finished clip: {error}"))?;
        self.committed = true;
        Ok(())
    }
}

impl Drop for StagedOutput {
    fn drop(&mut self) {
        if !self.committed {
            let _ = fs::remove_file(&self.temp);
        }
    }
}

// Temp dir for intermediate segments, next to the output so the final rename /
// concat stays on one volume. The pid keeps two app instances writing into the
// same output folder apart.
fn create_segment_temp_dir(out_dir: &Path, prefix: &str) -> Result<PathBuf, String> {
    let temp_dir = out_dir.join(format!(".{prefix}_tmp_{}", std::process::id()));
    fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Could not create temporary merge directory: {e}"))?;
    Ok(temp_dir)
}

// Shared tail of every stream-copy join: write the concat-demuxer list for the
// finished segments, then join them with -c copy. List lines escape single
// quotes per ffmpeg's syntax. `bitstream_filter` is for callers that need the
// packets tidied on the way through (smart cut strips the access-unit
// delimiters its transport-stream intermediates add); it never re-encodes.
// `extra_output_args` carries container metadata (the MP4 `hvc1` tag); it never
// re-encodes either.
#[allow(clippy::too_many_arguments)]
fn concat_copy_segments(
    window: &tauri::Window,
    ffmpeg: &Path,
    temp_dir: &Path,
    segments: &[PathBuf],
    total_duration: f64,
    output: &Path,
    bitstream_filter: Option<&str>,
    extra_output_args: &[String],
    percent: f32,
    message: String,
    label: &str,
) -> Result<(), String> {
    let mut concat_list = String::new();
    for segment in segments {
        let escaped = segment.to_string_lossy().replace('\'', "'\\''");
        concat_list.push_str(&format!("file '{escaped}'\n"));
    }

    let list_path = temp_dir.join("concat.txt");
    fs::write(&list_path, concat_list)
        .map_err(|e| format!("Could not write concat list: {e}"))?;

    let mut concat_args: Vec<String> = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-nostdin".to_string(),
        "-f".to_string(),
        "concat".to_string(),
        "-safe".to_string(),
        "0".to_string(),
        "-i".to_string(),
        list_path.to_string_lossy().to_string(),
    ];
    append_clip_stream_maps(&mut concat_args, &["0:v:0", "0:a:0?"]);
    concat_args.extend(["-c".to_string(), "copy".to_string()]);
    if let Some(filter) = bitstream_filter {
        concat_args.extend(["-bsf:v".to_string(), filter.to_string()]);
    }
    concat_args.extend(extra_output_args.iter().cloned());
    concat_args.extend([
        "-progress".to_string(),
        "pipe:1".to_string(),
        "-stats_period".to_string(),
        "0.5".to_string(),
        output.to_string_lossy().to_string(),
    ]);
    emit_conversion_progress(window, "encode", Some(percent), message, None, None);
    run_clip_ffmpeg(
        window,
        ffmpeg,
        concat_args,
        total_duration,
        label,
    )
}

// How far back the audio cut seeks before the requested start. The demuxer
// snaps an input seek to a keyframe, so this only has to cover one GOP; a
// bigger window just means a few more packets are read and thrown away.
const SMART_CUT_AUDIO_BACKOFF: f64 = 15.0;

// How many frames the copied body may differ from the requested length before
// the whole clip is re-encoded instead. Packet-boundary and open-GOP effects
// account for one or two; a seek that landed in the wrong place is off by a
// whole group of pictures, which is dozens.
const SMART_CUT_BODY_FRAME_SLACK: usize = 4;

// One smart cut. The video is built in two pieces — the head (requested start
// -> first keyframe at or after it) re-encoded so the clip opens on the exact
// requested frame, the body (that keyframe -> requested end) copied byte for
// byte — joined with the concat demuxer under -c copy. The audio is cut once,
// for the whole clip, and copied.
//
// The pieces are VIDEO-ONLY on purpose. ffmpeg leaves a re-encoded video stream
// on the source timeline whenever a stream-copied audio stream shares the same
// output, which makes the concat demuxer read the head as (head + start) long
// and pushes the body that far out — a 5.5s clip lands at 8.3s. Keeping video
// and audio in separate files and muxing them at the end sidesteps that
// entirely.
//
// Two shortcuts: a cut that already lands on a keyframe is a plain copy with no
// temp files at all, and a keyframe past the requested end (or no keyframe in
// the probe window) makes the whole clip a single re-encode. Refuses (Err) on
// codecs and frame rates that cannot be spliced. Every ffmpeg run goes through
// CLIP_CHILD_PID so cancel kills whichever child is live.
#[allow(clippy::too_many_arguments)]
fn run_smart_cut_clip(
    window: &tauri::Window,
    ffmpeg: &Path,
    ffprobe: &Path,
    input: &Path,
    color: &ColorMetadata,
    start: f64,
    duration: f64,
    output: &Path,
    label: &str,
    percent_from: f32,
    percent_span: f32,
) -> Result<(), String> {
    let params = probe_source_video_params(ffprobe, input)?;
    let fps = smart_cut_fps(&params)?;
    let head_encoder = smart_cut_head_encoder_args(&params.codec, &params.pix_fmt)?;
    // Container of the file we were asked to write. Every intermediate that can
    // become the finished clip follows it, so the silent-source path can rename
    // rather than remux, and so HEVC gets the MP4 tag QuickTime needs.
    let target_is_mp4 = is_mp4_family(output);
    let tag_args = mp4_codec_tag_args(output, &params.codec);

    // Half a frame: closer than this and the cut IS the keyframe, so there is
    // nothing to re-encode.
    let tolerance = 0.5 / fps;
    let end = start + duration;
    // Counted from the first visible frame, like `start` and every -ss below —
    // probe_first_keyframe has already taken the container's start timestamp
    // off. Without that, a source whose timestamps begin at 1.000 would make a
    // cut at 3.000 look like it landed on a keyframe that is really at 2.000,
    // and the clip would open on the wrong image and run a second long.
    let keyframe = probe_first_keyframe(ffprobe, input, start, tolerance, params.start_offset);
    let stage = |fraction: f32| Some(percent_from + percent_span * fraction);

    // The cut already sits on a keyframe: one copy from the keyframe's exact
    // timestamp is frame-accurate on its own, video and audio together.
    if let Some(kf) = keyframe {
        if (kf - start).abs() < tolerance {
            let length = (end - kf).max(0.0);
            emit_conversion_progress(
                window,
                "encode",
                stage(0.0),
                format!("{label} (already on a keyframe)..."),
                None,
                None,
            );
            let staged = StagedOutput::new(output);
            let mut copy_args = vec![
                "-y".to_string(),
                "-hide_banner".to_string(),
                "-nostdin".to_string(),
                "-loglevel".to_string(),
                "error".to_string(),
                "-ss".to_string(),
                format!("{kf:.6}"),
                "-i".to_string(),
                input.to_string_lossy().to_string(),
                "-t".to_string(),
                format!("{length:.3}"),
            ];
            append_clip_stream_maps(&mut copy_args, &["0:v:0", "0:a:0?"]);
            copy_args.extend([
                "-c".to_string(),
                "copy".to_string(),
                "-avoid_negative_ts".to_string(),
                "make_zero".to_string(),
            ]);
            run_clip_ffmpeg(
                window,
                ffmpeg,
                copy_args
                    .into_iter()
                    .chain(tag_args.iter().cloned())
                    .chain([
                    "-progress".to_string(),
                    "pipe:1".to_string(),
                    "-stats_period".to_string(),
                    "0.5".to_string(),
                    staged.path().to_string_lossy().to_string(),
                ])
                .collect(),
                length,
                "Smart cut (stream copy)",
            )?;
            return staged.commit();
        }
    }

    let temp_parent = output.parent().unwrap_or_else(|| Path::new("."));
    let temp_dir = create_segment_temp_dir(temp_parent, "smartcut")?;
    let _guard = TempDirGuard(temp_dir.clone());
    let video = temp_dir.join(if target_is_mp4 { "video.mp4" } else { "video.mkv" });

    // Head re-encode. -ss before -i is frame-accurate here BECAUSE the video is
    // re-encoded: ffmpeg decodes from the preceding keyframe and throws away
    // the frames before the seek point. Only -c copy snaps to a keyframe.
    let head_args = |length: f64, target: &Path, as_ts: bool| {
        let mut args: Vec<String> = vec![
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
            format!("{length:.3}"),
        ];
        append_clip_stream_maps(&mut args, &["0:v:0"]);
        args.extend(head_encoder.iter().cloned());
        args.push("-vf".to_string());
        args.push(setparams_filter(color));
        args.extend(color_tag_args(color));
        if as_ts {
            args.extend(["-f".to_string(), "mpegts".to_string()]);
        } else {
            // Writing the finished video directly (nothing to splice): this file
            // becomes the clip, so it needs the container tag now.
            args.extend(tag_args.iter().cloned());
        }
        args.push(target.to_string_lossy().to_string());
        args
    };

    // The two pieces are joined as MPEG-TS, not MKV. A re-encoded head and an
    // untouched body carry different parameter sets, and MKV stores those once
    // in the header — the muxer takes the head's and then rejects the body's
    // packets outright ("Error muxing a packet" on HEVC). Transport streams
    // carry the parameter sets in-band with every keyframe, so the two splice.
    //
    // Neither piece gets -avoid_negative_ts make_zero: on a stream copy it
    // shifts every packet forward by the first frame's DTS/PTS gap (two frames
    // on a B-frame source), which both offsets the body inside the join and
    // drags two frames from before the keyframe in with it.
    let mut joined = false;
    if let Some(kf) = keyframe.filter(|kf| *kf < end - tolerance) {
        let head = temp_dir.join("head.ts");
        emit_conversion_progress(
            window,
            "encode",
            stage(0.0),
            format!("{label}: re-encoding the opening frames..."),
            None,
            None,
        );
        run_clip_ffmpeg(
            window,
            ffmpeg,
            head_args(kf - start, &head, true),
            kf - start,
            "Smart cut head",
        )?;

        let body = temp_dir.join("body.ts");
        emit_conversion_progress(
            window,
            "encode",
            stage(0.4),
            format!("{label}: copying the original stream..."),
            None,
            None,
        );
        let mut body_args = vec![
            "-y".to_string(),
            "-hide_banner".to_string(),
            "-nostdin".to_string(),
            "-loglevel".to_string(),
            "error".to_string(),
            "-ss".to_string(),
            format!("{kf:.6}"),
            "-i".to_string(),
            input.to_string_lossy().to_string(),
            "-t".to_string(),
            format!("{:.3}", end - kf),
        ];
        append_clip_stream_maps(&mut body_args, &["0:v:0"]);
        body_args.extend([
            "-c".to_string(),
            "copy".to_string(),
            "-f".to_string(),
            "mpegts".to_string(),
            body.to_string_lossy().to_string(),
        ]);
        run_clip_ffmpeg(
            window,
            ffmpeg,
            body_args,
            end - kf,
            "Smart cut body",
        )?;

        // A source whose keyframe index lies (ffmpeg says "File is broken,
        // keyframes not correctly marked") seeks to the wrong place on a stream
        // copy, and the body would silently hold footage from elsewhere in the
        // episode. Counting what the copy actually produced catches it.
        //
        // The allowance is a fixed handful of frames, not a share of the clip:
        // a stream copy can only end on a packet boundary and an open-GOP source
        // hands over a couple of leading pictures with the keyframe, but nothing
        // legitimate scales with length. A tenth of a 20-second body would have
        // waved through two full seconds of wrong footage. Erring towards an
        // unnecessary re-encode is the deliberate trade — it is slower, never
        // wrong. A count that cannot be read at all is treated the same way,
        // rather than assumed correct.
        let wanted_frames = ((end - kf) * fps).round().max(1.0) as usize;
        let copied_frames = probe_video_packet_count(ffprobe, &body);
        let body_matches = copied_frames
            .is_some_and(|copied| copied.abs_diff(wanted_frames) <= SMART_CUT_BODY_FRAME_SLACK);
        if body_matches {
            concat_copy_segments(
                window,
                ffmpeg,
                &temp_dir,
                &[head, body],
                duration,
                &video,
                Some(&format!("{}_metadata=aud=remove", params.codec)),
                &tag_args,
                percent_from + percent_span * 0.6,
                format!("{label}: joining..."),
                "Joining smart cut",
            )?;
            joined = true;
        } else {
            log_warn(
                "clip.smart_cut.body_mismatch",
                "Smart cut body copy landed on the wrong footage; re-encoding the whole clip",
                json!({
                    "input": input.to_string_lossy(),
                    "keyframe": kf,
                    "wantedFrames": wanted_frames,
                    "copiedFrames": copied_frames,
                    "reason": if copied_frames.is_some() { "frame count" } else { "unreadable" },
                }),
            );
        }
    }

    // No keyframe before the clip ends (start near EOF, a GOP longer than the
    // probe window, or a source whose index cannot be trusted): re-encode the
    // whole clip. Slower, but it only happens on degenerate sources and
    // correctness wins.
    if !joined {
        emit_conversion_progress(
            window,
            "encode",
            stage(0.0),
            format!("{label} (no keyframe to splice — re-encoding)..."),
            None,
            None,
        );
        run_clip_ffmpeg(
            window,
            ffmpeg,
            head_args(duration, &video, false),
            duration,
            "Smart cut (full re-encode)",
        )?;
    }

    // Silent source: the joined video already IS the clip.
    if !probe_has_audio_stream(ffprobe, input).unwrap_or(false) {
        return fs::rename(&video, output)
            .map_err(|e| format!("Could not write the finished clip: {e}"));
    }

    // Audio, cut once for the whole clip. Two-stage seek: the input -ss gets
    // the demuxer near the cut (on its own it would snap back to a keyframe and
    // hand back seconds of extra audio), then the output -ss — measured from the
    // REQUESTED input seek, not from wherever the demuxer landed — drops the
    // overshoot packet by packet. Exact, and it never reads more than the
    // backoff window extra.
    let audio = temp_dir.join("audio.mka");
    let seek_from = (start - SMART_CUT_AUDIO_BACKOFF).max(0.0);
    emit_conversion_progress(
        window,
        "encode",
        stage(0.75),
        format!("{label}: copying the audio..."),
        None,
        None,
    );
    let mut audio_args = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-nostdin".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-ss".to_string(),
        format!("{seek_from:.3}"),
        "-i".to_string(),
        input.to_string_lossy().to_string(),
        "-ss".to_string(),
        format!("{:.3}", start - seek_from),
        "-t".to_string(),
        format!("{duration:.3}"),
    ];
    append_clip_stream_maps(&mut audio_args, &["0:a:0"]);
    audio_args.extend([
        "-c".to_string(),
        "copy".to_string(),
        "-avoid_negative_ts".to_string(),
        "make_zero".to_string(),
        audio.to_string_lossy().to_string(),
    ]);
    run_clip_ffmpeg(
        window,
        ffmpeg,
        audio_args,
        duration,
        "Smart cut audio",
    )?;

    emit_conversion_progress(
        window,
        "encode",
        stage(0.9),
        format!("{label}: writing the clip..."),
        None,
        None,
    );
    let staged = StagedOutput::new(output);
    let mut mux_args = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-nostdin".to_string(),
        "-i".to_string(),
        video.to_string_lossy().to_string(),
        "-i".to_string(),
        audio.to_string_lossy().to_string(),
    ];
    append_clip_stream_maps(&mut mux_args, &["0:v:0", "1:a:0"]);
    mux_args.extend(["-c".to_string(), "copy".to_string()]);
    run_clip_ffmpeg(
        window,
        ffmpeg,
        mux_args
            .into_iter()
            .chain(tag_args.iter().cloned())
            .chain([
            "-progress".to_string(),
            "pipe:1".to_string(),
            "-stats_period".to_string(),
            "0.5".to_string(),
            staged.path().to_string_lossy().to_string(),
        ])
        .collect(),
        duration,
        "Smart cut mux",
    )?;
    staged.commit()
}

// Smart-cut merge: identical in shape to the lossless merge below, except each
// temp segment is cut frame-accurately (head re-encode + body copy) instead of
// snapped to the nearest keyframe. The join is still -c copy. Color tags come
// from the first input, matching the rest of the merge path.
#[allow(clippy::too_many_arguments)]
fn run_smart_cut_merge(
    window: &tauri::Window,
    ffmpeg: &Path,
    ffprobe: &Path,
    clips: &[ExportClip],
    input_paths: &[PathBuf],
    input_index_for_clip: &[usize],
    out_dir: &Path,
    output: &Path,
    color: &ColorMetadata,
) -> Result<String, String> {
    // Compatibility first, before anything is written. The join copies every
    // segment under the first one's stream description, so mismatched sources
    // produce a file that plays for a few seconds and then breaks — with no
    // error anywhere. Refusing here costs the user one clear message instead.
    let mut profiles: Vec<SourceMergeProfile> = Vec::with_capacity(input_paths.len());
    for path in input_paths {
        profiles.push(SourceMergeProfile {
            name: path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| path.to_string_lossy().to_string()),
            video: probe_source_video_params(ffprobe, path)?,
            audio: probe_source_audio_params(ffprobe, path),
        });
    }
    if let Some(message) = smart_cut_merge_mismatch(&profiles) {
        log_warn(
            "clip.smart_cut.merge_refused",
            "Smart cut merge refused: the selected clips cannot be joined without re-encoding",
            json!({ "sources": profiles.iter().map(|p| p.name.clone()).collect::<Vec<_>>() }),
        );
        return Err(message);
    }

    let temp_dir = create_segment_temp_dir(out_dir, "smartcutmerge")?;
    let _guard = TempDirGuard(temp_dir.clone());

    let mut total_duration = 0.0_f64;
    let mut segment_paths: Vec<PathBuf> = Vec::with_capacity(clips.len());
    let span = 90.0 / clips.len() as f32;
    // Segments carry the finished file's container, so each one is written
    // exactly as a single-clip export would be and the join is same-into-same.
    let segment_ext = if is_mp4_family(output) { "mp4" } else { "mkv" };

    for (i, clip) in clips.iter().enumerate() {
        let input = &input_paths[input_index_for_clip[i]];
        let (start, duration) = padded_clip_range(clip);
        total_duration += duration;

        let segment = temp_dir.join(format!("seg_{i:04}.{segment_ext}"));
        run_smart_cut_clip(
            window,
            ffmpeg,
            ffprobe,
            input,
            color,
            start,
            duration,
            &segment,
            &format!("Smart cut segment {}/{}", i + 1, clips.len()),
            i as f32 * span,
            span,
        )?;
        segment_paths.push(segment);
    }

    let merge_tag_args = profiles
        .first()
        .map(|profile| mp4_codec_tag_args(output, &profile.video.codec))
        .unwrap_or_default();
    let staged = StagedOutput::new(output);
    concat_copy_segments(
        window,
        ffmpeg,
        &temp_dir,
        &segment_paths,
        total_duration,
        staged.path(),
        None,
        &merge_tag_args,
        92.0_f32,
        format!("Joining {} smart-cut segments...", clips.len()),
        "Joining smart-cut segments",
    )?;
    staged.commit()?;

    let done = ConversionDone {
        r#type: "done".to_string(),
        input: format!("{} clips merged", clips.len()),
        output: output.to_string_lossy().to_string(),
        archived_original: None,
        preset: "smart-cut".to_string(),
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
    let temp_dir = create_segment_temp_dir(out_dir, "losslesscut")?;
    let _guard = TempDirGuard(temp_dir.clone());

    let mut total_duration = 0.0_f64;
    let mut segment_paths: Vec<PathBuf> = Vec::with_capacity(clips.len());

    for (i, clip) in clips.iter().enumerate() {
        let input = &input_paths[input_index_for_clip[i]];
        let (start, duration) = padded_clip_range(clip);
        total_duration += duration;

        let segment = temp_dir.join(format!("seg_{i:04}.mkv"));
        let mut args: Vec<String> = vec![
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
        ];
        append_clip_stream_maps(&mut args, &["0:v:0", "0:a:0?"]);
        args.extend([
            "-c".to_string(),
            "copy".to_string(),
            "-avoid_negative_ts".to_string(),
            "make_zero".to_string(),
            segment.to_string_lossy().to_string(),
        ]);
        emit_conversion_progress(
            window,
            "decode",
            Some(((i as f32) / (clips.len() as f32)) * 90.0),
            format!("Cutting segment {}/{} (lossless)...", i + 1, clips.len()),
            None,
            None,
        );
        run_clip_ffmpeg(
            window,
            ffmpeg,
            args,
            duration,
            "Cutting lossless segment",
        )?;

        segment_paths.push(segment);
    }

    concat_copy_segments(
        window,
        ffmpeg,
        &temp_dir,
        &segment_paths,
        total_duration,
        output,
        None,
        &[],
        92.0_f32,
        format!("Joining {} lossless segments...", clips.len()),
        "Joining lossless segments",
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

// Preview-quality cap, threaded from the Settings "Preview quality" dropdown as
// the `height` invoke arg (Rust never reads config.json). The frontend sends 0
// (and `None` when absent) for the "Source"/unlimited preset. The two helpers
// below intentionally map None/0 DIFFERENTLY because the ceiling means two
// different things in the two call sites:
//   * resolve_preview_cap — the DIRECT-vs-PROXY decision. Source = no cap, so a
//     friendly file at any height stays "direct" (current behavior preserved).
//   * resolve_proxy_height — the forced ENCODE height. Source = cap at 1080,
//     because WebView2 gains nothing above 1080 even when a proxy is forced.

// Decision ceiling: None/0 (Source preset) -> None (don't force a proxy on an
// otherwise-friendly file); any other height -> Some(h).
fn resolve_preview_cap(height: Option<u32>) -> Option<u32> {
    match height {
        None | Some(0) => None,
        Some(h) => Some(h),
    }
}

// Encode ceiling: None/0 (Source preset) -> 1080 (no WebView2 benefit above
// that); any other height -> that height. The min(h,ih) clamp in the scale
// filter still prevents upscaling a shorter source.
fn resolve_proxy_height(height: Option<u32>) -> u32 {
    match height {
        None | Some(0) => 1080,
        Some(h) => h,
    }
}

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
    height: Option<u32>,
) -> Result<PlaybackPlan, String> {
    log_info(
        "clip.playback_plan.start",
        "Computing clip playback plan",
        json!({ "source": &source_path, "height": height }),
    );
    let result = tauri::async_runtime::spawn_blocking(move || compute_playback_plan(&app, source_path, height))
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

fn compute_playback_plan(
    app: &tauri::AppHandle,
    source_path: String,
    height: Option<u32>,
) -> Result<PlaybackPlan, String> {
    let root = app_root()?;
    let ffprobe = find_tool(&root, "ffprobe");
    ensure_tool(&ffprobe)?;
    let input = canonical_input_path(&source_path)?;

    let summary: MediaSummary = probe_media_summary(&ffprobe, &input).unwrap_or_default();
    let container = lowercase_extension(&input);
    let in_scope = path_in_asset_scope(app, &input);
    // Source/unlimited -> None (no extra cap); any preset height -> Some(h).
    let cap = resolve_preview_cap(height);

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

    // Cap-aware proxy gate (independent of the 1920x1080 WebView2-friendliness
    // clause above): a friendly source TALLER than the chosen preview cap should
    // build a proxy so weak machines get a smoother, lower-res preview even on an
    // otherwise-direct file. Source preset (cap == None) skips this entirely, so
    // friendly files stay direct (current behavior).
    if let (Some(cap_h), Some(h)) = (cap, summary.height) {
        if h > cap_h {
            reasons.push(format!("source height {h} exceeds preview cap {cap_h}p"));
        }
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
// timeline; capped at the chosen preview height (the Settings "Preview quality"
// dropdown — default 240p, never upscaled), short fixed GOP + no B-frames so
// currentTime seeks land near a keyframe; yuv420p + AAC + faststart mp4 so it is
// friendly by construction and always lives under $APPDATA (in asset scope).
// Mirrors generate_scene_clip: NVENC fast path with a libx264 fallback (CPU/GPU
// parity), content-fingerprint cache key (which folds in the height so distinct
// qualities cache separately), atomic tmp+rename, progress events. The in-flight
// ffmpeg PID lives in PROXY_CHILD_PID so a new source selection / teardown
// cancels it. `height` carries the Settings cap (None/Some(0) = Source preset,
// which the encode caps at 1080 since WebView2 gains nothing above that).
#[tauri::command]
pub(crate) async fn build_source_proxy(
    window: tauri::Window,
    source_path: String,
    force: bool,
    height: Option<u32>,
    request_id: Option<String>,
) -> Result<String, String> {
    let start = std::time::Instant::now();
    let request_id = request_id.unwrap_or_else(generated_source_proxy_request_id);
    log_info(
        "clip.source_proxy.start",
        "Building source proxy",
        json!({ "source": &source_path, "height": height, "requestId": &request_id }),
    );
    // Serialize proxy builds: the single PROXY_CHILD_PID slot can only track one
    // encode, so hold this guard across the supersede-kill below AND the
    // spawn_blocking await. This guarantees exactly one live proxy encode owns
    // the slot at a time — a second invoke waits here instead of racing past the
    // best-effort kill and orphaning the first ffmpeg.
    let _build_guard = PROXY_BUILD_LOCK.get_or_init(|| AsyncMutex::new(())).lock().await;

    // A new source build supersedes any in-flight one — cancel it first so we
    // never run two proxy encodes at once (mirror the single-source contract).
    kill_child_pid(&PROXY_CHILD_PID);

    let app_data_dir = window
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not get app data directory: {error}"))?;

    let log_source = source_path.clone();
    let log_request_id = request_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        generate_source_proxy(window, app_data_dir, source_path, force, height, request_id)
    })
    .await
    .map_err(|error| error.to_string())?;

    match &result {
        Ok(path) => log_info(
            "clip.source_proxy.complete",
            "Source proxy ready",
            json!({ "source": log_source, "proxy": path, "requestId": log_request_id, "elapsed_s": start.elapsed().as_secs_f64() }),
        ),
        Err(error) => log_error(
            "clip.source_proxy.error",
            "Source proxy build failed",
            json!({ "source": log_source, "requestId": log_request_id, "error": error, "elapsed_s": start.elapsed().as_secs_f64() }),
        ),
    }
    result
}

fn generate_source_proxy(
    window: tauri::Window,
    app_data_dir: PathBuf,
    source_path: String,
    force: bool,
    height: Option<u32>,
    request_id: String,
) -> Result<String, String> {
    let root = app_root()?;
    let ffmpeg = find_tool(&root, "ffmpeg");
    let ffprobe = find_tool(&root, "ffprobe");
    ensure_tool(&ffmpeg)?;

    // Resolve the encode height once: Source preset (None/0) caps at 1080 (no
    // WebView2 benefit above that); any preset height is used verbatim. The
    // min(h,ih) clamp in the scale filter still prevents upscaling. Defaulting
    // here also defends any non-Settings caller (warmup/other paths) that omits
    // the arg — they get the historical behavior.
    let h: u32 = resolve_proxy_height(height);

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
    // version. The height is the actual encode cap (e.g. "360p") so each preview
    // quality caches as a distinct proxy and switching rebuilds rather than
    // serving a stale size. NOT bumping "source-proxy-v3": the height now
    // distinguishes the key, so existing 240p caches stay valid for the 240p
    // preset. Bump "source-proxy-v3" only to invalidate every cached proxy.
    let proxy_key = short_stable_id(&[&source_key, &format!("{h}p"), encoder_decision, "source-proxy-v3"]);
    let output = cache_dir.join(format!("{proxy_key}.mp4"));

    // >1024-byte cache hit short-circuit (matches every other app cache).
    // `force` (from "extract again") bypasses it: a stale/buggy proxy must never
    // mask a rebuild, or any proxy fix is invisible behind the cache. The atomic
    // rename below replaces the old file on success.
    if !force
        && output
            .metadata()
            .map(|metadata| metadata.len() > 1024)
            .unwrap_or(false)
    {
        return Ok(output.to_string_lossy().to_string());
    }

    let duration = probe_duration(&ffprobe, &input).unwrap_or(0.0);

    // Atomic write: encode to a per-process tmp file, then rename into place so
    // a concurrent reader never sees a half-written proxy.
    let tmp_output = cache_dir.join(format!("{proxy_key}.{}.tmp.mp4", std::process::id()));
    let _ = fs::remove_file(&tmp_output);

    let primary = run_source_proxy_job(
        &window, &ffmpeg, &input, &tmp_output, duration, &source_path, &request_id, use_nvenc, &color, h,
    );

    if let Err(error) = primary {
        // NVENC can refuse exotic sources where libx264 still succeeds; mirror
        // generate_scene_clip's fallback. A user cancel (PID kill) must NOT be
        // retried — it surfaces as a cancellation, not an encoder failure.
        if error.contains("cancelled") {
            let _ = fs::remove_file(&tmp_output);
            return Err(error);
        }
        if use_nvenc {
            log_warn(
                "clip.source_proxy.fallback",
                "NVENC proxy build failed; retrying with libx264",
                json!({ "error": &error }),
            );
            let _ = fs::remove_file(&tmp_output);
            run_source_proxy_job(
                &window, &ffmpeg, &input, &tmp_output, duration, &source_path, &request_id, false, &color, h,
            )?;
        } else {
            let _ = fs::remove_file(&tmp_output);
            return Err(error);
        }
    }

    fs::rename(&tmp_output, &output)
        .map_err(|error| format!("Could not finalize source proxy: {error}"))?;

    Ok(output.to_string_lossy().to_string())
}

fn run_source_proxy_job(
    window: &tauri::Window,
    ffmpeg: &Path,
    input: &Path,
    output: &Path,
    duration: f64,
    source_path: &str,
    request_id: &str,
    use_nvenc: bool,
    color: &ColorMetadata,
    height: u32,
) -> Result<(), String> {
    // Whole-file transcode (NO -ss) so the proxy timeline matches the source
    // 1:1. The decode prefix and -vf chain diverge by encoder so the NVENC path
    // can keep every frame on the GPU end-to-end while CPU users stay on a
    // pure-software pipeline (CPU/GPU parity rule).
    //
    // NVENC path (full-VRAM): `-hwaccel cuda -hwaccel_output_format cuda` keeps
    // NVDEC output as CUDA hwframes, then scale_cuda resizes on the GPU and
    // hands frames straight to NVENC -- no download-to-RAM / CPU-libswscale /
    // re-upload round-trip (that round-trip was the build-time cost). Two hard
    // requirements verified on this build: (1) setparams MUST precede scale_cuda
    // -- if dropped or placed after, ffmpeg inserts a CPU auto_scale to reconcile
    // unknown->bt709 colorspace which can't run on a CUDA hwframe and hard-fails
    // (exit 127), breaking untagged sources (the common anime case); (2) NO
    // top-level `-pix_fmt yuv420p` -- it's expressed as `scale_cuda=...:format=
    // yuv420p` instead, since a top-level pix_fmt against a cuda hwframe forces a
    // CPU conversion or fails. If NVDEC can't handle a codec the primary job
    // errors and the existing libx264 fallback retries with `auto`.
    //
    // libx264 path: plain `-hwaccel auto` (non-NVIDIA machines decode cleanly)
    // and the CPU scale/setparams chain, unchanged.
    let mut args: Vec<String> = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-nostdin".to_string(),
    ];

    if use_nvenc {
        args.extend([
            "-hwaccel".to_string(),
            "cuda".to_string(),
            "-hwaccel_output_format".to_string(),
            "cuda".to_string(),
        ]);
    } else {
        args.extend([
            "-hwaccel".to_string(),
            "auto".to_string(),
        ]);
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

    // Configurable height cap from the Settings "Preview quality" dropdown
    // (default 240; never upscale via the min() guard). setparams carries the
    // same color tags as the export (scaling preserves color; setparams only
    // labels). Single quotes keep the inner comma an expression arg, not a
    // filter-chain separator. NVENC: setparams FIRST, then GPU scale_cuda (with
    // format) so the whole chain runs on cuda hwframes. CPU: software scale then
    // setparams. Both branches honor the SAME height (CPU/GPU parity).
    args.push("-vf".to_string());
    if use_nvenc {
        args.push(format!(
            "{},scale_cuda=-2:'min({height},ih)':format=yuv420p",
            setparams_filter(color)
        ));
    } else {
        args.push(format!("scale=-2:'min({height},ih)',{}", setparams_filter(color)));
    }

    if use_nvenc {
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
            // No top-level -pix_fmt here: the output pixel format is set on the
            // GPU via `scale_cuda=...:format=yuv420p` (see -vf above). A
            // top-level pix_fmt against a cuda hwframe forces a CPU conversion.
        ]);
    } else {
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

    // Forward a "proxy-progress" side-channel { sourcePath, requestId, percent, stage } so
    // the grid can show which source is building. The tapped FFmpeg runner
    // suppresses the shared conversion stream, and this source-specific stream
    // is bookended with "starting" and terminal "complete"/"error" ticks.
    let _ = window.emit(
        "proxy-progress",
        json!({ "sourcePath": source_path, "requestId": request_id, "percent": 0.0, "stage": "starting" }),
    );

    let label = if use_nvenc {
        "Building preview proxy"
    } else {
        "Building preview proxy (libx264)"
    };
    let result = crate::video_cmds::run_ffmpeg_with_progress_tap(
        window,
        ffmpeg,
        args,
        duration,
        label,
        Some(&PROXY_CHILD_PID),
        Some(("proxy-progress", source_path, request_id)),
    );

    let stage = if result.is_ok() { "complete" } else { "error" };
    let _ = window.emit(
        "proxy-progress",
        json!({ "sourcePath": source_path, "requestId": request_id, "percent": if result.is_ok() { 100.0 } else { 0.0 }, "stage": stage }),
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
    let mut command = AsyncCommand::new(python_exe_checked(&root)?);
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
    let mut command = cmd(python_exe_checked(&root)?);
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
    // Same as a user cancel: an export mid-way between two ffmpeg runs must not
    // start another one against a runtime that is being reinstalled underneath it.
    CLIP_CANCEL_REQUESTED.store(true, std::sync::atomic::Ordering::SeqCst);
    kill_child_pid(&CLIP_CHILD_PID);
    // A dependency-setup run reinstalls the Python/ffmpeg runtime an in-flight
    // proxy build is using — stop that build too, not just the clip child.
    kill_child_pid(&PROXY_CHILD_PID);

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
    // Raised BEFORE the kill so an export that is between two of its ffmpeg
    // runs right now still sees it and stops instead of starting the next one.
    CLIP_CANCEL_REQUESTED.store(true, std::sync::atomic::Ordering::SeqCst);
    kill_child_pid(&CLIP_CHILD_PID);
    crate::interpolate_cmds::cancel_interpolate_now();
    // A featherweight source-proxy build can be running independently of the
    // clip child; stop it on cancel too so it isn't left burning GPU/CPU after
    // the user cancelled.
    kill_child_pid(&PROXY_CHILD_PID);

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

