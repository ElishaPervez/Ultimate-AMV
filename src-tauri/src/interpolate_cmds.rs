use std::{
    fs,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::Stdio,
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

use crate::{
    app_root, apply_python_env, clear_child_pid, cmd, interpolate_cli_path, kill_child_pid,
    log_error, log_info, python_exe_checked, run_interpolate_cli, store_child_pid, tools,
    truncate_log_text, INTERPOLATE_ACTIVE_OUTPUT, INTERPOLATE_CHILD_PID,
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InterpolateJob {
    input: String,
    output: String,
}

#[derive(Debug, PartialEq)]
enum StreamMessage {
    Forward(Value),
    Final(Value),
    Ignore,
}

fn demux_line(line: &str) -> StreamMessage {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return StreamMessage::Ignore;
    };
    match value.get("type").and_then(Value::as_str) {
        Some("progress") => StreamMessage::Forward(value),
        Some("done") | Some("error") => StreamMessage::Final(value),
        _ => StreamMessage::Ignore,
    }
}

fn set_active_output(path: Option<PathBuf>) {
    if let Ok(mut active) = INTERPOLATE_ACTIVE_OUTPUT
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
    {
        *active = path;
    }
}

fn remove_active_output() {
    let path = INTERPOLATE_ACTIVE_OUTPUT
        .get()
        .and_then(|slot| slot.lock().ok().and_then(|active| active.clone()));
    if let Some(path) = path {
        let _ = fs::remove_file(path);
    }
    set_active_output(None);
}

#[tauri::command]
pub(crate) async fn interpolate_status() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run_interpolate_cli(&["status"]))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) fn interpolate_list_folder(folder: String) -> Result<Vec<String>, String> {
    const VIDEO_EXTENSIONS: &[&str] = &["mp4", "mkv", "mov", "webm", "avi", "m4v"];
    let root = PathBuf::from(folder);
    let entries = fs::read_dir(&root)
        .map_err(|error| format!("Could not read {}: {error}", root.display()))?;
    let mut videos: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .map(|extension| {
                        VIDEO_EXTENSIONS
                            .iter()
                            .any(|accepted| extension.eq_ignore_ascii_case(accepted))
                    })
                    .unwrap_or(false)
        })
        .collect();
    videos.sort_by_key(|path| {
        path.file_name()
            .map(|name| name.to_string_lossy().to_lowercase())
            .unwrap_or_default()
    });
    Ok(videos
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect())
}

#[tauri::command]
pub(crate) async fn cancel_interpolate() {
    cancel_interpolate_now();
}

pub(crate) fn cancel_interpolate_now() {
    log_info(
        "interpolate.cancel",
        "Cancelling active frame interpolation",
        Value::Null,
    );
    tools::cancel_active_install();
    kill_child_pid(&INTERPOLATE_CHILD_PID);
    remove_active_output();
}

struct JobsFileGuard(PathBuf);

impl Drop for JobsFileGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn write_jobs_file(
    app: &tauri::AppHandle,
    jobs: &[InterpolateJob],
) -> Result<JobsFileGuard, String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Could not resolve interpolation cache directory: {error}"))?
        .join("interpolate");
    fs::create_dir_all(&cache_dir)
        .map_err(|error| format!("Could not create interpolation cache directory: {error}"))?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let path = cache_dir.join(format!("jobs-{}-{nonce}.json", std::process::id()));
    let payload = serde_json::to_vec(jobs)
        .map_err(|error| format!("Could not serialize interpolation queue: {error}"))?;
    fs::write(&path, payload)
        .map_err(|error| format!("Could not write interpolation queue: {error}"))?;
    Ok(JobsFileGuard(path))
}

const OUTPUT_FORMATS: &[&str] = &["h264-mp4", "hevc-mp4", "h264-mkv", "prores-mov"];

fn interpolation_settings(
    factor: u32,
    target_fps: Option<f64>,
    slow_motion: bool,
    model: &str,
    rate_mode: Option<String>,
    quality: Option<u32>,
    bitrate_mbps: Option<f64>,
    output_format: Option<String>,
) -> Result<(&'static str, String, u32, f64, String), String> {
    let valid_factor = if slow_motion {
        matches!(factor, 2 | 3 | 4 | 8 | 16 | 32 | 64)
    } else {
        target_fps.is_some() || matches!(factor, 2 | 3 | 4)
    };
    if !valid_factor {
        return Err(if slow_motion {
            "Slow motion supports 2x, 3x, 4x, 8x, 16x, 32x, or 64x factors.".to_string()
        } else {
            "Frame interpolation supports 2x, 3x, or 4x speed factors.".to_string()
        });
    }
    if slow_motion && target_fps.is_some() {
        return Err("Slow motion cannot be combined with a target frame rate.".to_string());
    }
    if let Some(target) = target_fps {
        let target_int = target.round() as u32;
        if !target.is_finite()
            || (target - target_int as f64).abs() > f64::EPSILON
            || !matches!(target_int, 30 | 60 | 120)
        {
            return Err("Target frame rate must be 30, 60, or 120 fps.".to_string());
        }
    }
    let rate_mode = rate_mode.unwrap_or_else(|| "quality".to_string());
    if !matches!(rate_mode.as_str(), "quality" | "vbr" | "cbr") {
        return Err("Rate control must be quality, vbr, or cbr.".to_string());
    }
    let quality = quality.unwrap_or(18).clamp(14, 28);
    let bitrate_mbps = bitrate_mbps.unwrap_or(20.0);
    if !bitrate_mbps.is_finite() || bitrate_mbps <= 0.0 {
        return Err("Target bitrate must be greater than 0 Mbps.".to_string());
    }
    let output_format = output_format.unwrap_or_else(|| "h264-mp4".to_string());
    if !OUTPUT_FORMATS.contains(&output_format.as_str()) {
        return Err(format!(
            "Output format must be one of {}.",
            OUTPUT_FORMATS.join(", ")
        ));
    }
    let model_tool = match model {
        "rife4.25" => "rife-4.25",
        "rife4.6" => "rife-4.6",
        _ => return Err(format!("Unknown interpolation model: {model}")),
    };
    Ok((model_tool, rate_mode, quality, bitrate_mbps, output_format))
}

fn interpolation_args(
    jobs_file: &JobsFileGuard,
    factor: u32,
    target_fps: Option<f64>,
    slow_motion: bool,
    model: String,
    gpu: bool,
    half: bool,
    rate_mode: String,
    quality: u32,
    bitrate_mbps: f64,
    output_format: String,
) -> Vec<String> {
    let mut args = vec![
        "interpolate".to_string(),
        "--jobs".to_string(),
        jobs_file.0.to_string_lossy().to_string(),
        "--factor".to_string(),
        factor.to_string(),
        "--slow-motion".to_string(),
        slow_motion.to_string(),
        "--model".to_string(),
        model,
        "--gpu".to_string(),
        gpu.to_string(),
        "--half".to_string(),
        half.to_string(),
        "--rate-mode".to_string(),
        rate_mode,
        "--quality".to_string(),
        quality.to_string(),
        "--bitrate-mbps".to_string(),
        bitrate_mbps.to_string(),
        "--output-format".to_string(),
        output_format,
    ];
    if let Some(target) = target_fps {
        args.push("--target-fps".to_string());
        args.push(target.to_string());
    }
    args
}

#[tauri::command]
pub(crate) async fn interpolate_run(
    app: tauri::AppHandle,
    window: tauri::Window,
    jobs: Vec<InterpolateJob>,
    factor: u32,
    target_fps: Option<f64>,
    slow_motion: bool,
    model: String,
    gpu: bool,
    half: bool,
    output_format: Option<String>,
    rate_mode: Option<String>,
    quality: Option<u32>,
    bitrate_mbps: Option<f64>,
) -> Result<String, String> {
    if jobs.is_empty() {
        return Err("Add at least one clip before starting interpolation.".to_string());
    }
    let (model_tool, rate_mode, quality, bitrate_mbps, output_format) = interpolation_settings(
        factor,
        target_fps,
        slow_motion,
        &model,
        rate_mode,
        quality,
        bitrate_mbps,
        output_format,
    )?;

    window
        .emit(
            "interpolate-progress",
            json!({
                "type": "progress",
                "stage": "model-init",
                "percent": -1,
                "message": "Checking the selected RIFE model",
            }),
        )
        .ok();
    tools::install_named(&app, &window, &[model_tool], "interpolate-progress").await?;

    let jobs_file = write_jobs_file(&app, &jobs)?;
    let output_paths: Vec<PathBuf> = jobs.iter().map(|job| PathBuf::from(&job.output)).collect();
    let args = interpolation_args(
        &jobs_file,
        factor,
        target_fps,
        slow_motion,
        model,
        gpu,
        half,
        rate_mode,
        quality,
        bitrate_mbps,
        output_format,
    );
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _jobs_file = jobs_file;
        run_streaming_interpolate_cli(window, args, output_paths, "interpolate-progress")
    })
    .await
    .map_err(|error| error.to_string())?;
    set_active_output(None);
    result
}

struct TemporaryOutputs(Vec<PathBuf>);

impl Drop for TemporaryOutputs {
    fn drop(&mut self) {
        for path in &self.0 {
            let _ = fs::remove_file(path);
        }
    }
}

fn temporary_interpolation_path(source: &std::path::Path) -> Result<PathBuf, String> {
    let parent = source
        .parent()
        .ok_or_else(|| format!("Could not resolve the folder for {}.", source.display()))?;
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("Could not resolve the name for {}.", source.display()))?;
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("mp4");
    Ok(parent.join(format!(
        ".{stem}.interpolating-{}.{}",
        std::process::id(),
        extension
    )))
}

fn replace_export(original: &std::path::Path, replacement: &std::path::Path) -> Result<(), String> {
    let parent = original
        .parent()
        .ok_or_else(|| format!("Could not resolve the folder for {}.", original.display()))?;
    let stem = original
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("clip");
    let extension = original
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("video");
    let mut backup_index = 0;
    let backup = loop {
        let suffix = if backup_index == 0 {
            String::new()
        } else {
            format!("-{backup_index}")
        };
        let candidate = parent.join(format!(
            ".{stem}.before-interpolation-{}{suffix}.{extension}",
            std::process::id()
        ));
        if !candidate.exists() {
            break candidate;
        }
        backup_index += 1;
    };
    fs::rename(original, &backup).map_err(|error| {
        format!(
            "The exported clip could not be prepared for replacement ({}): {error}",
            original.display()
        )
    })?;
    if let Err(error) = fs::rename(replacement, original) {
        let _ = fs::rename(&backup, original);
        return Err(format!(
            "The smoothed clip could not replace {}: {error}",
            original.display()
        ));
    }
    let _ = fs::remove_file(backup);
    Ok(())
}

#[tauri::command]
pub(crate) async fn interpolate_exported_clips(
    app: tauri::AppHandle,
    window: tauri::Window,
    paths: Vec<String>,
    factor: u32,
    model: String,
    gpu: bool,
    half: bool,
    rate_mode: Option<String>,
    quality: Option<u32>,
    bitrate_mbps: Option<f64>,
) -> Result<String, String> {
    if paths.is_empty() {
        return Err("No exported clips were available for smoothing.".to_string());
    }
    // The smoothed file has to slot back in where the export was, so its
    // container is whatever that clip already used and only the video codec is
    // fixed here.
    let (model_tool, rate_mode, quality, bitrate_mbps, output_format) = interpolation_settings(
        factor,
        None,
        false,
        &model,
        rate_mode,
        quality,
        bitrate_mbps,
        None,
    )?;
    window
        .emit(
            "conversion-progress",
            json!({
                "type": "progress",
                "stage": "model-init",
                "percent": -1,
                "message": "Loading motion smoothing model",
            }),
        )
        .ok();
    tools::install_named(&app, &window, &[model_tool], "conversion-progress").await?;

    let originals: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    for path in &originals {
        if !path.is_file() {
            return Err(format!("The exported clip was not found: {}", path.display()));
        }
    }
    let temporary_paths: Vec<PathBuf> = originals
        .iter()
        .map(|path| temporary_interpolation_path(path))
        .collect::<Result<_, _>>()?;
    let temporary_guard = TemporaryOutputs(temporary_paths.clone());
    let jobs: Vec<InterpolateJob> = originals
        .iter()
        .zip(&temporary_paths)
        .map(|(input, output)| InterpolateJob {
            input: input.to_string_lossy().to_string(),
            output: output.to_string_lossy().to_string(),
        })
        .collect();
    let jobs_file = write_jobs_file(&app, &jobs)?;
    let args = interpolation_args(
        &jobs_file,
        factor,
        None,
        false,
        model,
        gpu,
        half,
        rate_mode,
        quality,
        bitrate_mbps,
        output_format,
    );
    let raw = tauri::async_runtime::spawn_blocking(move || {
        let _jobs_file = jobs_file;
        let _temporary_guard = temporary_guard;
        let payload = run_streaming_interpolate_cli(
            window,
            args,
            temporary_paths.clone(),
            "conversion-progress",
        )?;
        let value: Value = serde_json::from_str(&payload)
            .map_err(|error| format!("Could not read interpolation result: {error}"))?;
        let outcomes = value
            .get("outcomes")
            .and_then(Value::as_array)
            .ok_or_else(|| "Frame interpolation returned no clip results.".to_string())?;
        if outcomes.len() != originals.len() {
            return Err(format!(
                "Frame interpolation returned {} results for {} exported clips. The original exports were kept.",
                outcomes.len(),
                originals.len()
            ));
        }
        let failures: Vec<String> = outcomes
            .iter()
            .filter(|outcome| outcome.get("ok").and_then(Value::as_bool) != Some(true))
            .map(|outcome| {
                outcome
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("Unknown interpolation error")
                    .to_string()
            })
            .collect();
        if !failures.is_empty() {
            return Err(format!(
                "{} exported clip(s) could not be smoothed. The original exports were kept. {}",
                failures.len(),
                failures.join(" ")
            ));
        }
        for (original, replacement) in originals.iter().zip(&temporary_paths) {
            replace_export(original, replacement)?;
        }
        Ok(payload)
    })
    .await
    .map_err(|error| error.to_string())??;
    set_active_output(None);
    Ok(raw)
}

pub(crate) fn run_streaming_interpolate_cli(
    window: tauri::Window,
    args: Vec<String>,
    output_paths: Vec<PathBuf>,
    progress_event: &'static str,
) -> Result<String, String> {
    let root = app_root()?;
    log_info(
        "interpolate.streaming_bridge.start",
        "Starting streaming frame interpolation bridge",
        json!({ "args": &args, "outputCount": output_paths.len() }),
    );
    let mut command = cmd(python_exe_checked(&root)?);
    command
        .arg("-I")
        .arg(interpolate_cli_path(&root))
        .args(&args)
        .current_dir(&root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_python_env(&mut command);

    let mut child = command.spawn().map_err(|error| {
        log_error(
            "interpolate.streaming_bridge.spawn.error",
            "Could not start streaming frame interpolation bridge",
            json!({ "args": &args, "error": error.to_string() }),
        );
        format!("Could not start Python frame interpolation bridge: {error}")
    })?;
    store_child_pid(&INTERPOLATE_CHILD_PID, child.id());

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not read frame interpolation output stream".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Could not read frame interpolation error stream".to_string())?;
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

    let mut final_payload: Option<Value> = None;
    let mut read_error: Option<String> = None;
    for line in BufReader::new(stdout).lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                read_error = Some(error.to_string());
                break;
            }
        };
        match demux_line(&line) {
            StreamMessage::Forward(value) => {
                if let Some(index) = value
                    .get("clipIndex")
                    .and_then(Value::as_u64)
                    .and_then(|value| usize::try_from(value).ok())
                {
                    set_active_output(output_paths.get(index.saturating_sub(1)).cloned());
                }
                let finished_clip = value.get("stage").and_then(Value::as_str) == Some("encode")
                    && value.get("percent").and_then(Value::as_f64).unwrap_or(-1.0) >= 100.0;
                if finished_clip {
                    set_active_output(None);
                }
                let _ = window.emit(progress_event, value);
            }
            StreamMessage::Final(value) => final_payload = Some(value),
            StreamMessage::Ignore => {}
        }
    }

    if let Some(error) = read_error {
        kill_child_pid(&INTERPOLATE_CHILD_PID);
        let _ = child.wait();
        clear_child_pid(&INTERPOLATE_CHILD_PID);
        set_active_output(None);
        let stderr_tail = stderr_handle.join().unwrap_or_default();
        log_error(
            "interpolate.streaming_bridge.read.error",
            "Could not read streaming frame interpolation output",
            json!({ "error": &error, "stderr": truncate_log_text(stderr_tail.trim()) }),
        );
        return Err(error);
    }

    let status = child.wait().map_err(|error| error.to_string())?;
    clear_child_pid(&INTERPOLATE_CHILD_PID);
    set_active_output(None);
    let stderr_tail = stderr_handle.join().unwrap_or_default();
    if let Some(payload) = final_payload {
        match payload.get("type").and_then(Value::as_str) {
            Some("done") => return Ok(payload.to_string()),
            Some("error") => {
                return Err(payload
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Frame interpolation failed.")
                    .to_string())
            }
            _ => {}
        }
    }
    let tail = stderr_tail.trim();
    let error = if tail.is_empty() {
        format!(
            "Frame interpolation stopped without a result (exit code {}).",
            status.code().unwrap_or(-1)
        )
    } else {
        tail.to_string()
    };
    log_error(
        "interpolate.streaming_bridge.error",
        "Streaming frame interpolation bridge failed",
        json!({
            "code": status.code(),
            "error": &error,
            "stderr": truncate_log_text(tail),
        }),
    );
    Err(error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_demux_forwards_progress() {
        let message = demux_line(r#"{"type":"progress","percent":42}"#);
        assert!(matches!(message, StreamMessage::Forward(_)));
    }

    #[test]
    fn event_demux_returns_done_payload() {
        let message = demux_line(r#"{"type":"done","succeeded":2}"#);
        assert!(matches!(message, StreamMessage::Final(_)));
    }

    #[test]
    fn event_demux_ignores_malformed_lines() {
        assert_eq!(demux_line("not json"), StreamMessage::Ignore);
    }

    #[test]
    fn cancelling_without_a_running_job_is_a_no_op() {
        cancel_interpolate_now();
    }

    #[test]
    fn slow_motion_rejects_a_target_frame_rate() {
        let result =
            interpolation_settings(2, Some(60.0), true, "rife4.25", None, None, None, None);
        assert_eq!(
            result.unwrap_err(),
            "Slow motion cannot be combined with a target frame rate."
        );
    }

    #[test]
    fn slow_motion_is_forwarded_to_the_python_sidecar() {
        let jobs_file = JobsFileGuard(PathBuf::from("jobs.json"));
        let args = interpolation_args(
            &jobs_file,
            64,
            None,
            true,
            "rife4.25".to_string(),
            true,
            true,
            "quality".to_string(),
            18,
            20.0,
            "h264-mp4".to_string(),
        );
        let flag = args
            .iter()
            .position(|value| value == "--slow-motion")
            .expect("slow-motion flag");
        assert_eq!(args.get(flag + 1).map(String::as_str), Some("true"));
    }

    #[test]
    fn normal_interpolation_keeps_its_four_times_ceiling() {
        let result =
            interpolation_settings(64, None, false, "rife4.25", None, None, None, None);
        assert_eq!(
            result.unwrap_err(),
            "Frame interpolation supports 2x, 3x, or 4x speed factors."
        );
    }

    #[test]
    fn folder_listing_returns_only_video_files() {
        let temp = tempfile::tempdir().expect("temporary folder");
        fs::write(temp.path().join("B.MKV"), b"video").expect("mkv");
        fs::write(temp.path().join("a.mp4"), b"video").expect("mp4");
        fs::write(temp.path().join("notes.txt"), b"text").expect("text");
        let files = interpolate_list_folder(temp.path().to_string_lossy().to_string())
            .expect("folder listing");
        assert_eq!(files.len(), 2);
        assert!(files[0].ends_with("a.mp4"));
        assert!(files[1].ends_with("B.MKV"));
    }

    #[test]
    fn in_place_output_keeps_the_original_extension() {
        let path = PathBuf::from(r"C:\clips\scene.mov");
        let temporary = temporary_interpolation_path(&path).expect("temporary path");
        assert_eq!(temporary.extension().and_then(|value| value.to_str()), Some("mov"));
        assert!(temporary
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .contains("interpolating"));
    }

    #[test]
    fn in_place_replacement_keeps_only_the_finished_file() {
        let directory = tempfile::tempdir().expect("temporary folder");
        let original = directory.path().join("scene.mp4");
        let replacement = directory.path().join(".scene.interpolating.mp4");
        fs::write(&original, b"original").expect("original");
        fs::write(&replacement, b"smoothed").expect("replacement");

        replace_export(&original, &replacement).expect("replacement succeeds");

        assert_eq!(fs::read(&original).expect("finished file"), b"smoothed");
        assert!(!replacement.exists());
        assert_eq!(
            fs::read_dir(directory.path())
                .expect("directory listing")
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().contains("before-interpolation"))
                .count(),
            0
        );
    }
}
