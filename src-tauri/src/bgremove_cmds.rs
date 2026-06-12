use std::{
    io::{BufRead, BufReader},
    process::Stdio,
    thread,
};

use serde_json::{json, Value};
use tauri::{Emitter, Manager};

use crate::{
    app_root, apply_python_env, bgremove_cli_path, clear_child_pid, cmd, kill_child_pid,
    log_error, log_info, python_exe, run_bgremove_cli, store_child_pid, truncate_log_text,
    BGREMOVE_CHILD_PID,
};

#[tauri::command]
pub(crate) async fn bgremove_status() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run_bgremove_cli(&["status"]))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn cancel_bgremove() {
    log_info("bgremove.cancel", "Cancelling active background removal", Value::Null);
    kill_child_pid(&BGREMOVE_CHILD_PID);
}

/// Fast-path for image downloads: copies the already-cached preview result to
/// the user's chosen destination instead of re-running the full AI pipeline.
#[tauri::command]
pub(crate) async fn bgremove_save_preview(
    source_path: String,
    destination_path: String,
) -> Result<String, String> {
    log_info(
        "bgremove.save_preview.start",
        "Saving cached preview to user destination",
        json!({
            "source": &source_path,
            "destination": &destination_path,
        }),
    );

    let source = std::path::PathBuf::from(&source_path);
    let destination = std::path::PathBuf::from(&destination_path);

    if !source.exists() {
        return Err(format!(
            "Cached preview file not found: {}",
            source.display()
        ));
    }

    // Ensure destination parent directory exists
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            format!("Could not create destination directory: {error}")
        })?;
    }

    let started = std::time::Instant::now();
    std::fs::copy(&source, &destination).map_err(|error| {
        log_error(
            "bgremove.save_preview.error",
            "Could not copy cached preview",
            json!({ "source": &source_path, "destination": &destination_path, "error": error.to_string() }),
        );
        format!("Could not save isolated image: {error}")
    })?;
    let elapsed = started.elapsed().as_secs_f64();

    let payload = serde_json::json!({
        "type": "done",
        "input": &source_path,
        "output": &destination_path,
        "frames": 1,
        "elapsedSeconds": (elapsed * 100.0).round() / 100.0,
    })
    .to_string();

    log_info(
        "bgremove.save_preview.complete",
        "Cached preview saved successfully",
        json!({ "source": &source_path, "destination": &destination_path, "elapsed": elapsed }),
    );

    Ok(payload)
}

#[tauri::command]
pub(crate) async fn bgremove_preview(
    window: tauri::Window,
    input_path: String,
    model: String,
    cpu: bool,
    cache_tag: Option<String>,
    frame: Option<i64>,
) -> Result<String, String> {
    log_info(
        "bgremove.preview.invoke.start",
        "Starting background removal single-frame preview",
        json!({
            "input": &input_path,
            "model": &model,
            "cpu": cpu,
            "cacheTag": &cache_tag,
            "frame": frame,
        }),
    );

    // The CLI writes fixed file names (orig.png / isolated.png), so each tab
    // gets its own subdirectory to keep the video and image previews from
    // overwriting each other.
    let cache_sub = match cache_tag.as_deref() {
        Some("image") => "image",
        _ => "video",
    };
    // Previews must live under app_data_dir: the frontend displays them via
    // convertFileSrc, and the asset-protocol scope only covers $APPDATA /
    // $RESOURCE / $HOME — app_root() (dev checkout or install dir) can fall
    // outside it, which renders the preview images as broken/blank.
    let app_data_dir = window
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?;
    let preview_dir = app_data_dir.join("bgremove_previews").join(cache_sub);
    std::fs::create_dir_all(&preview_dir).map_err(|error| {
        format!("Could not create preview cache directory: {error}")
    })?;
    // Silently GC the legacy preview cache that lived next to the app.
    if let Ok(root) = app_root() {
        let _ = std::fs::remove_dir_all(root.join("cache").join("bgremove_previews"));
    }

    let args = vec![
        "preview".to_string(),
        "--input".to_string(),
        input_path.clone(),
        "--output-dir".to_string(),
        preview_dir.to_string_lossy().to_string(),
        "--model".to_string(),
        model,
    ];
    
    let mut final_args = args;
    if let Some(frame) = frame.filter(|index| *index >= 0) {
        final_args.push("--frame".to_string());
        final_args.push(frame.to_string());
    }
    if cpu {
        final_args.push("--cpu".to_string());
    }

    let result = tauri::async_runtime::spawn_blocking(move || {
        run_streaming_bgremove_cli(
            window,
            final_args,
            "bgremove-progress",
        )
    })
    .await
    .map_err(|error| error.to_string())?;

    match &result {
        Ok(payload) => log_info(
            "bgremove.preview.invoke.complete",
            "Background removal preview completed successfully",
            json!({ "input": input_path, "result": payload }),
        ),
        Err(error) => log_error(
            "bgremove.preview.invoke.error",
            "Background removal preview failed",
            json!({ "input": input_path, "error": error }),
        ),
    }
    result
}

#[tauri::command]
pub(crate) async fn bgremove_process(
    window: tauri::Window,
    input_path: String,
    output_path: String,
    model: String,
    format: String,
    cpu: bool,
) -> Result<String, String> {
    log_info(
        "bgremove.process.invoke.start",
        "Starting background removal process",
        json!({
            "input": &input_path,
            "output": &output_path,
            "model": &model,
            "format": &format,
            "cpu": cpu
        }),
    );
    
    let log_input = input_path.clone();
    let mut args = vec![
        "process".to_string(),
        "--input".to_string(),
        input_path,
        "--output".to_string(),
        output_path,
        "--model".to_string(),
        model,
        "--format".to_string(),
        format,
    ];
    if cpu {
        args.push("--cpu".to_string());
    }
    // Best-effort comparison preview: the CLI encodes a compact alpha WebM of
    // the result here for the in-app before/after player. Must live under
    // app_data_dir so the asset protocol can serve it (see bgremove_preview).
    if let Ok(app_data_dir) = window.app_handle().path().app_data_dir() {
        let showcase_dir = app_data_dir.join("bgremove_previews").join("showcase");
        if std::fs::create_dir_all(&showcase_dir).is_ok() {
            args.push("--showcase-dir".to_string());
            args.push(showcase_dir.to_string_lossy().to_string());
        }
    }

    let result = tauri::async_runtime::spawn_blocking(move || {
        run_streaming_bgremove_cli(
            window,
            args,
            "bgremove-progress",
        )
    })
    .await
    .map_err(|error| error.to_string())?;

    match &result {
        Ok(payload) => log_info(
            "bgremove.process.invoke.complete",
            "Background removal command completed successfully",
            json!({ "input": log_input, "result": payload }),
        ),
        Err(error) => log_error(
            "bgremove.process.invoke.error",
            "Background removal command failed",
            json!({ "input": log_input, "error": error }),
        ),
    }
    result
}

pub(crate) fn run_streaming_bgremove_cli(
    window: tauri::Window,
    args: Vec<String>,
    progress_event: &str,
) -> Result<String, String> {
    let root = app_root()?;
    log_info(
        "bgremove.streaming_bridge.start",
        "Starting streaming background removal bridge",
        json!({ "args": &args, "progressEvent": progress_event }),
    );
    
    let mut command = cmd(python_exe(&root));
    command
        .arg("-I")
        .arg(bgremove_cli_path(&root))
        .args(&args)
        .current_dir(&root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_python_env(&mut command);
    
    let mut child = command.spawn().map_err(|error| {
        log_error(
            "bgremove.streaming_bridge.spawn.error",
            "Could not start streaming background removal bridge",
            json!({ "args": &args, "error": error.to_string() }),
        );
        format!("Could not start Python background removal bridge: {error}")
    })?;
    
    store_child_pid(&BGREMOVE_CHILD_PID, child.id());

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not read background removal output stream".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Could not read background removal error stream".to_string())?;

    // Drain stderr asynchronously so it doesn't block
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
    let mut forwarded_events: u64 = 0;
    let mut read_error: Option<String> = None;
    for line in BufReader::new(stdout).lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                read_error = Some(error.to_string());
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(&line) {
            match value.get("type").and_then(Value::as_str) {
                Some("progress") | Some("dependencies") | Some("processing") | Some("model-init") => {
                    // DIAGNOSTIC (progress-stuck investigation): log the first
                    // forwarded event so System Logs shows whether the bridge
                    // saw and emitted progress at all.
                    if forwarded_events == 0 {
                        log_info(
                            "bgremove.streaming_bridge.first_event",
                            "Forwarding first progress event to the webview",
                            json!({ "event": progress_event, "payload": &value }),
                        );
                    }
                    forwarded_events += 1;
                    let emitted = window.emit(progress_event, value);
                    if forwarded_events == 1 {
                        if let Err(error) = emitted {
                            log_error(
                                "bgremove.streaming_bridge.emit_error",
                                "Could not emit progress event to the webview",
                                json!({ "event": progress_event, "error": error.to_string() }),
                            );
                        }
                    }
                }
                Some("done") | Some("preview_done") | Some("error") => {
                    final_payload = Some(line);
                }
                _ => {}
            }
        }
    }

    if let Some(error) = read_error {
        kill_child_pid(&BGREMOVE_CHILD_PID);
        let _ = child.wait();
        clear_child_pid(&BGREMOVE_CHILD_PID);
        let stderr_tail = stderr_handle.join().unwrap_or_default();
        log_error(
            "bgremove.streaming_bridge.error",
            "Could not read streaming background removal output",
            json!({
                "args": &args,
                "error": &error,
                "stderr": truncate_log_text(stderr_tail.trim()),
            }),
        );
        return Err(error);
    }

    let wait_result = child.wait();
    clear_child_pid(&BGREMOVE_CHILD_PID);
    let status = wait_result.map_err(|error| error.to_string())?;
    let stderr_tail = stderr_handle.join().unwrap_or_default();

    if status.success() {
        let result = final_payload.ok_or_else(|| {
            let tail = stderr_tail.trim();
            if tail.is_empty() {
                "Background removal finished without a result".to_string()
            } else {
                format!("Background removal finished without a result. {tail}")
            }
        });
        match &result {
            Ok(payload) => log_info(
                "bgremove.streaming_bridge.complete",
                "Streaming background removal bridge completed",
                json!({ "args": &args, "result": payload, "forwardedEvents": forwarded_events }),
            ),
            Err(error) => log_error(
                "bgremove.streaming_bridge.error",
                "Streaming background removal bridge finished without a result",
                json!({ "args": &args, "error": error, "stderr": truncate_log_text(stderr_tail.trim()) }),
            ),
        }
        result
    } else {
        let error = final_payload.unwrap_or_else(|| {
            let tail = stderr_tail.trim();
            if tail.is_empty() {
                format!(
                    "Python process exited with code {}",
                    status.code().unwrap_or(-1)
                )
            } else {
                tail.to_string()
            }
        });
        log_error(
            "bgremove.streaming_bridge.error",
            "Streaming background removal bridge process failed",
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
