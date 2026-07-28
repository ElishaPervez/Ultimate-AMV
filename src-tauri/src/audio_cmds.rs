use std::{
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::Stdio,
    thread,
};

use serde_json::{json, Value};
use tauri::Emitter;

use crate::{
    app_root, apply_python_env, audio_cli_path, canonical_input_path, clear_child_pid, cmd,
    emit_conversion_progress, ensure_tool, find_tool, log_error, log_info, probe_duration,
    python_exe_checked, run_audio_cli, run_ffmpeg_with_progress, store_child_pid, stop_clip_processes_for_dependency_setup,
    truncate_log_text, AUDIO_CHILD_PID, ConversionDone,
};

#[tauri::command]
pub(crate) async fn audio_status() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run_audio_cli(&["status"]))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn audio_setup_plan(mode: String) -> Result<String, String> {
    if mode != "cpu" && mode != "gpu" {
        return Err("Setup mode must be cpu or gpu".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || run_audio_cli(&["setup-plan", mode.as_str()]))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn audio_extract(window: tauri::Window, input_path: String) -> Result<String, String> {
    log_info(
        "audio.extract.invoke.start",
        "Starting audio extraction command",
        json!({ "input": &input_path }),
    );
    let log_input = input_path.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_streaming_audio_cli(
            window,
            vec!["separate".to_string(), input_path],
            "audio-progress",
        )
    })
    .await
    .map_err(|error| error.to_string())?;
    match &result {
        Ok(payload) => log_info(
            "audio.extract.invoke.complete",
            "Audio extraction command completed",
            json!({ "input": log_input, "result": payload }),
        ),
        Err(error) => log_error(
            "audio.extract.invoke.error",
            "Audio extraction command failed",
            json!({ "input": log_input, "error": error }),
        ),
    }
    result
}

/// Fetch the fast package installer before a setup run, if it is not already
/// there. Deliberately cannot fail the caller: on a machine where the download
/// is blocked (antivirus, a locked-down network, GitHub unreachable) the
/// Python side falls back to pip, so the user gets a slow setup instead of a
/// dead end. Progress goes out on its own event because the setup panel's
/// event carries a fixed payload shape that the tools installer does not
/// speak.
async fn ensure_fast_installer(app: &tauri::AppHandle, window: &tauri::Window) {
    let already_there = crate::tools::tools_dir(app)
        .map(|dir| dir.join("uv.exe").is_file())
        .unwrap_or(false);
    if already_there {
        return;
    }

    // Field names have to match AudioSetupProgress in src/types/audio.ts. The
    // panels read `state` and call .toUpperCase() on it, so a payload missing
    // it takes the whole install screen down.
    let notify = |message: &str| {
        let _ = window.emit(
            "audio-setup-progress",
            json!({
                "type": "setup-progress",
                "step": 0,
                "total": 0,
                "state": "running",
                "message": message,
            }),
        );
    };

    notify("Downloading the package installer (26 MB, first run only)...");

    // Bounded on purpose. A proxy or antivirus web shield that black-holes the
    // connection rather than refusing it would otherwise leave the wizard
    // waiting forever on a step that is optional by design.
    let fetch = crate::tools::install_named(
        app,
        window,
        &[crate::tools::UV_TOOL],
        "audio-setup-tools-progress",
    );
    match tokio::time::timeout(std::time::Duration::from_secs(300), fetch).await {
        Ok(Ok(())) => notify("Package installer ready."),
        Ok(Err(error)) => {
            log_info(
                "audio.setup.installer.unavailable",
                "Fast installer could not be fetched; setup will use the bundled one",
                json!({ "error": error }),
            );
            notify("Continuing with the bundled installer.");
        }
        Err(_) => {
            crate::tools::cancel_active_install();
            log_info(
                "audio.setup.installer.timeout",
                "Fast installer download timed out; setup will use the bundled one",
                json!({ "timeout_secs": 300 }),
            );
            notify("Installer download timed out. Continuing with the bundled installer.");
        }
    }
}

#[tauri::command]
pub(crate) async fn audio_setup(
    app: tauri::AppHandle,
    window: tauri::Window,
    mode: String,
) -> Result<String, String> {
    if mode != "cpu" && mode != "gpu" {
        return Err("Setup mode must be cpu or gpu".to_string());
    }
    stop_clip_processes_for_dependency_setup(&window).await;
    ensure_fast_installer(&app, &window).await;
    log_info(
        "audio.setup.invoke.start",
        "Starting audio dependency setup command",
        json!({ "mode": &mode }),
    );
    let log_mode = mode.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_streaming_audio_cli(
            window,
            vec!["setup".to_string(), mode],
            "audio-setup-progress",
        )
    })
    .await
    .map_err(|error| error.to_string())?;
    match &result {
        Ok(payload) => log_info(
            "audio.setup.invoke.complete",
            "Audio dependency setup command completed",
            json!({ "mode": log_mode, "result": payload }),
        ),
        Err(error) => log_error(
            "audio.setup.invoke.error",
            "Audio dependency setup command failed",
            json!({ "mode": log_mode, "error": error }),
        ),
    }
    result
}

#[tauri::command]
pub(crate) async fn media_to_audio(
    window: tauri::Window,
    input_path: String,
    output_format: String,
) -> Result<String, String> {
    if output_format != "wav" && output_format != "mp3" {
        return Err("Audio output format must be wav or mp3".to_string());
    }
    log_info(
        "audio.convert.start",
        "Starting media to audio conversion",
        json!({ "input": &input_path, "outputFormat": &output_format }),
    );
    let log_input = input_path.clone();
    let log_format = output_format.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_media_to_audio(window, input_path, output_format)
    })
    .await
    .map_err(|error| error.to_string())?;
    match &result {
        Ok(payload) => log_info(
            "audio.convert.complete",
            "Media to audio conversion completed",
            json!({ "input": log_input, "outputFormat": log_format, "result": payload }),
        ),
        Err(error) => log_error(
            "audio.convert.error",
            "Media to audio conversion failed",
            json!({ "input": log_input, "outputFormat": log_format, "error": error }),
        ),
    }
    result
}

#[tauri::command]
pub(crate) fn cancel_audio() {
    crate::log_warn("audio.cancel", "Cancelling active audio process", Value::Null);
    crate::kill_child_pid(&AUDIO_CHILD_PID);
}

fn run_media_to_audio(
    window: tauri::Window,
    input_path: String,
    output_format: String,
) -> Result<String, String> {
    let root = app_root()?;
    let ffmpeg = find_tool(&root, "ffmpeg");
    let ffprobe = find_tool(&root, "ffprobe");
    let input = canonical_input_path(&input_path)?;
    ensure_tool(&ffmpeg)?;
    ensure_tool(&ffprobe)?;

    let duration = probe_duration(&ffprobe, &input).unwrap_or(0.0);
    let output = resolve_audio_output_path(&input, &output_format)?;
    let is_audio_input = is_audio_extension(input.extension().and_then(|ext| ext.to_str()));
    let final_output = input.with_extension(&output_format);

    let mut args = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-nostdin".to_string(),
        "-i".to_string(),
        input.to_string_lossy().to_string(),
        "-vn".to_string(),
    ];

    if output_format == "wav" {
        args.extend([
            "-acodec".to_string(),
            "pcm_s16le".to_string(),
            "-ar".to_string(),
            "44100".to_string(),
            "-ac".to_string(),
            "2".to_string(),
        ]);
    } else {
        args.extend([
            "-codec:a".to_string(),
            "libmp3lame".to_string(),
            "-q:a".to_string(),
            "0".to_string(),
            "-ar".to_string(),
            "44100".to_string(),
            "-ac".to_string(),
            "2".to_string(),
        ]);
    }

    args.extend([
        "-progress".to_string(),
        "pipe:1".to_string(),
        "-stats_period".to_string(),
        "0.5".to_string(),
        output.to_string_lossy().to_string(),
    ]);

    emit_conversion_progress(
        &window,
        "starting",
        Some(0.0),
        format!("Creating {} audio...", output_format.to_uppercase()),
        None,
        None,
    );
    run_ffmpeg_with_progress(&window, &ffmpeg, args, duration, "Converting audio", None)?;

    let archived_original = if is_audio_input {
        let archived = archive_original(&input)?;
        if !same_path_rs(&output, &final_output) {
            fs::rename(&output, &final_output)
                .map_err(|error| format!("Could not move converted audio into place: {error}"))?;
        }
        Some(archived)
    } else {
        None
    };

    let done = ConversionDone {
        r#type: "done".to_string(),
        input: input.to_string_lossy().to_string(),
        output: final_output.to_string_lossy().to_string(),
        archived_original: archived_original.map(|path| path.to_string_lossy().to_string()),
        preset: output_format,
    };
    serde_json::to_string(&done).map_err(|error| error.to_string())
}

fn resolve_audio_output_path(input: &Path, output_format: &str) -> Result<PathBuf, String> {
    let final_output = input.with_extension(output_format);
    if same_path_rs(input, &final_output) {
        let stem = input
            .file_stem()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "Input file needs a valid filename".to_string())?;
        return Ok(input.with_file_name(format!("{stem}.tmp.{output_format}")));
    }
    Ok(final_output)
}

fn archive_original(input: &Path) -> Result<PathBuf, String> {
    let file_name = input
        .file_name()
        .ok_or_else(|| "Input file needs a valid filename".to_string())?;
    let archive_dir = input
        .parent()
        .ok_or_else(|| "Input file needs a parent folder".to_string())?
        .join("old");
    fs::create_dir_all(&archive_dir)
        .map_err(|error| format!("Could not create old folder: {error}"))?;

    let mut archive = archive_dir.join(file_name);
    if archive.exists() {
        let stem = input.file_stem().and_then(|value| value.to_str()).unwrap_or("original");
        let ext = input.extension().and_then(|value| value.to_str()).unwrap_or("");
        let mut index = 1;
        loop {
            let name = if ext.is_empty() {
                format!("{stem}_{index}")
            } else {
                format!("{stem}_{index}.{ext}")
            };
            archive = archive_dir.join(name);
            if !archive.exists() {
                break;
            }
            index += 1;
        }
    }

    fs::rename(input, &archive).map_err(|error| format!("Could not archive original file: {error}"))?;
    Ok(archive)
}

pub(crate) fn is_audio_extension(extension: Option<&str>) -> bool {
    matches!(
        extension.map(|value| value.to_ascii_lowercase()).as_deref(),
        Some("wav" | "mp3" | "flac" | "m4a" | "ogg" | "aac" | "opus" | "wma")
    )
}

fn same_path_rs(left: &Path, right: &Path) -> bool {
    left.to_string_lossy()
        .eq_ignore_ascii_case(&right.to_string_lossy())
}

pub(crate) fn run_streaming_audio_cli(
    window: tauri::Window,
    args: Vec<String>,
    progress_event: &str,
) -> Result<String, String> {
    let root = app_root()?;
    log_info(
        "audio.streaming_bridge.start",
        "Starting streaming audio bridge",
        json!({ "args": &args, "progressEvent": progress_event }),
    );
    let mut command = cmd(python_exe_checked(&root)?);
    command
        .arg("-I")
        .arg(audio_cli_path(&root))
        .args(&args)
        .current_dir(&root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_python_env(&mut command);
    let mut child = command.spawn().map_err(|error| {
        log_error(
            "audio.streaming_bridge.spawn.error",
            "Could not start streaming audio bridge",
            json!({ "args": &args, "error": error.to_string() }),
        );
        format!("Could not start Python audio bridge: {error}")
    })?;
    store_child_pid(&AUDIO_CHILD_PID, child.id());

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not read audio extraction output".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Could not read audio extraction error stream".to_string())?;

    // Drain stderr on a separate thread so audio-separator's tqdm output cannot
    // fill the OS pipe buffer and stall the Python process. We keep only the
    // tail so a verbose log doesn't blow up memory.
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
                Some("progress") | Some("setup-progress") => {
                    let _ = window.emit(progress_event, value);
                }
                Some("done") | Some("error") | Some("setup-done") | Some("setup-error") => {
                    final_payload = Some(line);
                }
                _ => {}
            }
        }
    }

    let wait_result = child.wait();
    clear_child_pid(&AUDIO_CHILD_PID);
    let status = wait_result.map_err(|error| error.to_string())?;
    let stderr_tail = stderr_handle.join().unwrap_or_default();

    if status.success() {
        let result = final_payload.ok_or_else(|| {
            let tail = stderr_tail.trim();
            if tail.is_empty() {
                "Audio extraction finished without a result".to_string()
            } else {
                format!("Audio extraction finished without a result. {tail}")
            }
        });
        match &result {
            Ok(payload) => log_info(
                "audio.streaming_bridge.complete",
                "Streaming audio bridge completed",
                json!({ "args": &args, "result": payload }),
            ),
            Err(error) => log_error(
                "audio.streaming_bridge.error",
                "Streaming audio bridge finished without a result",
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
            "audio.streaming_bridge.error",
            "Streaming audio bridge process failed",
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
