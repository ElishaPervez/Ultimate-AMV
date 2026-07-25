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
    log_error, log_info, python_exe, run_interpolate_cli, store_child_pid, tools,
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

fn cancel_interpolate_now() {
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

#[tauri::command]
pub(crate) async fn interpolate_run(
    app: tauri::AppHandle,
    window: tauri::Window,
    jobs: Vec<InterpolateJob>,
    factor: u32,
    model: String,
    gpu: bool,
    half: bool,
) -> Result<String, String> {
    if jobs.is_empty() {
        return Err("Add at least one clip before starting interpolation.".to_string());
    }
    if !matches!(factor, 2 | 3 | 4) {
        return Err("Frame interpolation supports 2x, 3x, or 4x speed factors.".to_string());
    }
    let model_tool = match model.as_str() {
        "rife4.25" => "rife-4.25",
        "rife4.6" => "rife-4.6",
        _ => return Err(format!("Unknown interpolation model: {model}")),
    };

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
    let args = vec![
        "interpolate".to_string(),
        "--jobs".to_string(),
        jobs_file.0.to_string_lossy().to_string(),
        "--factor".to_string(),
        factor.to_string(),
        "--model".to_string(),
        model,
        "--gpu".to_string(),
        gpu.to_string(),
        "--half".to_string(),
        half.to_string(),
    ];
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _jobs_file = jobs_file;
        run_streaming_interpolate_cli(window, args, output_paths)
    })
    .await
    .map_err(|error| error.to_string())?;
    set_active_output(None);
    result
}

pub(crate) fn run_streaming_interpolate_cli(
    window: tauri::Window,
    args: Vec<String>,
    output_paths: Vec<PathBuf>,
) -> Result<String, String> {
    let root = app_root()?;
    log_info(
        "interpolate.streaming_bridge.start",
        "Starting streaming frame interpolation bridge",
        json!({ "args": &args, "outputCount": output_paths.len() }),
    );
    let mut command = cmd(python_exe(&root));
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
                let _ = window.emit("interpolate-progress", value);
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
}
