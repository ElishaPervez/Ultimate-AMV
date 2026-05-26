use std::{
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::Stdio,
    thread,
};

use serde_json::{json, Value};
use tauri::Emitter;

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
    for line in BufReader::new(stdout).lines() {
        let line = line.map_err(|error| error.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(&line) {
            match value.get("type").and_then(Value::as_str) {
                Some("progress") | Some("dependencies") | Some("processing") | Some("model-init") => {
                    let _ = window.emit(progress_event, value);
                }
                Some("done") | Some("error") => {
                    final_payload = Some(line);
                }
                _ => {}
            }
        }
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
                json!({ "args": &args, "result": payload }),
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
