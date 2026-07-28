use std::{
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::Stdio,
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

use crate::{
    app_root, apply_python_env, clear_child_pid, cmd, deadframe_cli_path, kill_child_pid,
    log_error, log_info, python_exe_checked, run_deadframe_cli, store_child_pid, truncate_log_text,
    DEADFRAME_ACTIVE_OUTPUT, DEADFRAME_CHILD_PID,
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeadFrameJob {
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

/// The one-shot bridge hands back the sidecar's own stdout on failure, which is
/// a `{"type":"error","message":...}` line. The webview only ever shows the
/// human sentence, so unwrap it here rather than leaking raw JSON into a toast.
fn bridge_error_text(raw: &str) -> String {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|value| {
            value
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| raw.to_string())
}

fn set_active_output(path: Option<PathBuf>) {
    if let Ok(mut active) = DEADFRAME_ACTIVE_OUTPUT
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
    {
        *active = path;
    }
}

fn remove_active_output() {
    let path = DEADFRAME_ACTIVE_OUTPUT
        .get()
        .and_then(|slot| slot.lock().ok().and_then(|active| active.clone()));
    if let Some(path) = path {
        let _ = fs::remove_file(path);
    }
    set_active_output(None);
}

#[tauri::command]
pub(crate) fn deadframe_list_folder(folder: String) -> Result<Vec<String>, String> {
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
pub(crate) async fn cancel_deadframe() {
    cancel_deadframe_now();
}

pub(crate) fn cancel_deadframe_now() {
    log_info(
        "deadframe.cancel",
        "Cancelling active dead-frame removal",
        Value::Null,
    );
    // No tools::cancel_active_install() here: this feature downloads no model
    // and no tool, and that flag is shared with every other download.
    kill_child_pid(&DEADFRAME_CHILD_PID);
    remove_active_output();
}

struct JobsFileGuard(PathBuf);

impl Drop for JobsFileGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn write_jobs_file(app: &tauri::AppHandle, jobs: &[DeadFrameJob]) -> Result<JobsFileGuard, String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Could not resolve dead-frame cache directory: {error}"))?
        .join("deadframe");
    fs::create_dir_all(&cache_dir)
        .map_err(|error| format!("Could not create dead-frame cache directory: {error}"))?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let path = cache_dir.join(format!("jobs-{}-{nonce}.json", std::process::id()));
    let payload = serde_json::to_vec(jobs)
        .map_err(|error| format!("Could not serialize dead-frame queue: {error}"))?;
    fs::write(&path, payload)
        .map_err(|error| format!("Could not write dead-frame queue: {error}"))?;
    Ok(JobsFileGuard(path))
}

// Key -> container extension. The shared Python encoder picks the container
// from the output file name it is handed, not from the format key, so an
// extension that disagrees with the key silently changes the muxer flags.
const OUTPUT_FORMATS: &[(&str, &str)] = &[
    ("h264-mp4", "mp4"),
    ("hevc-mp4", "mp4"),
    ("h264-mkv", "mkv"),
    ("prores-mov", "mov"),
];

const DEFAULT_SUFFIX: &str = "_nodead";

fn format_extension(key: &str) -> Option<&'static str> {
    OUTPUT_FORMATS
        .iter()
        .find(|(name, _)| *name == key)
        .map(|(_, extension)| *extension)
}

/// The suffix is free text the user types, so it has to be reduced to
/// something that can only ever be part of a file name: no separators, no
/// drive colon, no trailing dot or space (Windows silently drops those and the
/// written file would not be the one we reported back).
fn sanitize_suffix(suffix: &str) -> String {
    suffix
        .chars()
        .filter(|character| {
            !matches!(
                character,
                '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            ) && !character.is_control()
        })
        .collect::<String>()
        .trim_matches([' ', '.'])
        .to_string()
}

fn same_path(left: &Path, right: &Path) -> bool {
    left.to_string_lossy().to_lowercase() == right.to_string_lossy().to_lowercase()
}

fn export_output_path(source: &Path, suffix: &str, extension: &str) -> Result<PathBuf, String> {
    let parent = source
        .parent()
        .ok_or_else(|| format!("Could not resolve the folder for {}.", source.display()))?;
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("Could not resolve the name for {}.", source.display()))?;
    let candidate = parent.join(format!("{stem}{suffix}.{extension}"));
    if same_path(&candidate, source) {
        // An empty suffix plus a format that matches the source container would
        // point the encoder at the file it is still reading from. Fall back to
        // the default suffix rather than destroying the source.
        return Ok(parent.join(format!("{stem}{DEFAULT_SUFFIX}.{extension}")));
    }
    Ok(candidate)
}

/// Builds one destination per queued clip. Re-running over the same source
/// overwrites its previous result on purpose (§9 of the spec, no recovery
/// prompt), but two different sources inside one batch must never land on the
/// same file, or the second clip would silently erase the first one's output.
fn export_output_paths(
    sources: &[PathBuf],
    suffix: &str,
    output_format: &str,
) -> Result<Vec<PathBuf>, String> {
    let extension = format_extension(output_format).ok_or_else(|| {
        format!(
            "Output format must be one of {}.",
            OUTPUT_FORMATS
                .iter()
                .map(|(name, _)| *name)
                .collect::<Vec<_>>()
                .join(", ")
        )
    })?;
    let suffix = sanitize_suffix(suffix);
    let mut outputs: Vec<PathBuf> = Vec::with_capacity(sources.len());
    for source in sources {
        let base = export_output_path(source, &suffix, extension)?;
        let mut candidate = base.clone();
        let mut attempt = 1;
        while outputs.iter().any(|taken| same_path(taken, &candidate)) {
            attempt += 1;
            let stem = base
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("clip");
            candidate = base.with_file_name(format!("{stem}-{attempt}.{extension}"));
        }
        outputs.push(candidate);
    }
    Ok(outputs)
}

fn export_settings(
    sensitivity: f64,
    rate_mode: Option<String>,
    quality: Option<u32>,
    bitrate_mbps: Option<f64>,
) -> Result<(f64, String, u32, f64), String> {
    if !sensitivity.is_finite() {
        return Err("Sensitivity must be a number between 0 and 100.".to_string());
    }
    let sensitivity = sensitivity.clamp(0.0, 100.0);
    let rate_mode = rate_mode.unwrap_or_else(|| "quality".to_string());
    if !matches!(rate_mode.as_str(), "quality" | "vbr" | "cbr") {
        return Err("Rate control must be quality, vbr, or cbr.".to_string());
    }
    let quality = quality.unwrap_or(18).clamp(14, 28);
    let bitrate_mbps = bitrate_mbps.unwrap_or(20.0);
    if !bitrate_mbps.is_finite() || bitrate_mbps <= 0.0 {
        return Err("Target bitrate must be greater than 0 Mbps.".to_string());
    }
    Ok((sensitivity, rate_mode, quality, bitrate_mbps))
}

/// The optional export frame rate. `None` keeps each clip's own rate; a chosen
/// rate re-times the surviving frames, so it has to be a number FFmpeg will
/// actually accept — the ceiling only exists to catch a garbage value before a
/// whole batch is spent encoding it.
fn validate_export_fps(fps: Option<f64>) -> Result<Option<f64>, String> {
    match fps {
        None => Ok(None),
        Some(value) if value.is_finite() && value > 0.0 && value <= 1000.0 => Ok(Some(value)),
        Some(_) => Err("Export frame rate must be between 0 and 1000 fps.".to_string()),
    }
}

/// Previews live under app_data_dir: the panel plays them through
/// convertFileSrc and the asset protocol scope only covers $APPDATA /
/// $RESOURCE / $HOME.
fn preview_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?
        .join("deadframe_previews");
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Could not create the preview folder: {error}"))?;
    Ok(dir)
}

/// Silently clear whatever the last preview (or a crash) left behind. A file
/// the player still holds open cannot be deleted on Windows, so this is
/// best-effort and the next sweep picks the leftovers up. Never prompt about
/// leftovers — the house rule is to collect them quietly.
fn clear_preview_dir(dir: &Path) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.filter_map(Result::ok) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

#[tauri::command]
pub(crate) async fn deadframe_clear_previews(app: tauri::AppHandle) -> Result<(), String> {
    clear_preview_dir(&preview_dir(&app)?);
    Ok(())
}

#[tauri::command]
pub(crate) async fn deadframe_analyze(input: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_deadframe_cli(&["analyze", "--input", &input]).map_err(|error| bridge_error_text(&error))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn deadframe_preview(
    app: tauri::AppHandle,
    window: tauri::Window,
    input: String,
    sensitivity: f64,
) -> Result<String, String> {
    if !sensitivity.is_finite() {
        return Err("Sensitivity must be a number between 0 and 100.".to_string());
    }
    let sensitivity = sensitivity.clamp(0.0, 100.0);
    let preview_dir = preview_dir(&app)?;
    clear_preview_dir(&preview_dir);
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let output = preview_dir.join(format!("preview-{}-{nonce}.mp4", std::process::id()));

    let args = vec![
        "preview".to_string(),
        "--input".to_string(),
        input,
        "--sensitivity".to_string(),
        sensitivity.to_string(),
        "--output".to_string(),
        output.to_string_lossy().to_string(),
    ];
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_streaming_deadframe_cli(window, args, vec![output], "deadframe-preview-progress")
    })
    .await
    .map_err(|error| error.to_string())?;
    set_active_output(None);
    result
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn deadframe_export(
    app: tauri::AppHandle,
    window: tauri::Window,
    inputs: Vec<String>,
    sensitivity: f64,
    suffix: Option<String>,
    output_format: Option<String>,
    rate_mode: Option<String>,
    quality: Option<u32>,
    bitrate_mbps: Option<f64>,
    keep_audio: Option<bool>,
    fps: Option<f64>,
    gpu: Option<bool>,
) -> Result<String, String> {
    if inputs.is_empty() {
        return Err("Add at least one clip before exporting.".to_string());
    }
    let (sensitivity, rate_mode, quality, bitrate_mbps) =
        export_settings(sensitivity, rate_mode, quality, bitrate_mbps)?;
    let fps = validate_export_fps(fps)?;
    let output_format = output_format.unwrap_or_else(|| "h264-mp4".to_string());
    let suffix = suffix.unwrap_or_else(|| DEFAULT_SUFFIX.to_string());
    let sources: Vec<PathBuf> = inputs.iter().map(PathBuf::from).collect();
    let output_paths = export_output_paths(&sources, &suffix, &output_format)?;
    let jobs: Vec<DeadFrameJob> = sources
        .iter()
        .zip(&output_paths)
        .map(|(input, output)| DeadFrameJob {
            input: input.to_string_lossy().to_string(),
            output: output.to_string_lossy().to_string(),
        })
        .collect();
    let jobs_file = write_jobs_file(&app, &jobs)?;
    let keep_audio = keep_audio.unwrap_or(false);
    // GPU stays opt-in: h264 becomes h264_nvenc only when the panel says the
    // machine has an NVIDIA card, and libx264 otherwise.
    let gpu = gpu.unwrap_or(false);
    let mut args = vec![
        "export".to_string(),
        "--jobs".to_string(),
        jobs_file.0.to_string_lossy().to_string(),
        "--sensitivity".to_string(),
        sensitivity.to_string(),
        "--rate-mode".to_string(),
        rate_mode,
        "--quality".to_string(),
        quality.to_string(),
        "--bitrate-mbps".to_string(),
        bitrate_mbps.to_string(),
        "--output-format".to_string(),
        output_format,
        "--keep-audio".to_string(),
        keep_audio.to_string(),
        "--gpu".to_string(),
        gpu.to_string(),
    ];
    // Absent means "keep each clip's own rate", and the sidecar spells that 0.
    if let Some(fps) = fps {
        args.push("--fps".to_string());
        args.push(fps.to_string());
    }
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _jobs_file = jobs_file;
        run_streaming_deadframe_cli(window, args, output_paths, "deadframe-export-progress")
    })
    .await
    .map_err(|error| error.to_string())?;
    set_active_output(None);
    result
}

pub(crate) fn run_streaming_deadframe_cli(
    window: tauri::Window,
    args: Vec<String>,
    output_paths: Vec<PathBuf>,
    progress_event: &'static str,
) -> Result<String, String> {
    let root = app_root()?;
    log_info(
        "deadframe.streaming_bridge.start",
        "Starting streaming dead-frame removal bridge",
        json!({ "args": &args, "outputCount": output_paths.len() }),
    );
    let mut command = cmd(python_exe_checked(&root)?);
    command
        .arg("-I")
        .arg(deadframe_cli_path(&root))
        .args(&args)
        .current_dir(&root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_python_env(&mut command);

    let mut child = command.spawn().map_err(|error| {
        log_error(
            "deadframe.streaming_bridge.spawn.error",
            "Could not start streaming dead-frame removal bridge",
            json!({ "args": &args, "error": error.to_string() }),
        );
        format!("Could not start Python dead-frame removal bridge: {error}")
    })?;
    store_child_pid(&DEADFRAME_CHILD_PID, child.id());
    // A preview reports no clip index, so seed the file cancellation should
    // delete from the single destination we handed the sidecar.
    if output_paths.len() == 1 {
        set_active_output(output_paths.first().cloned());
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not read dead-frame removal output stream".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Could not read dead-frame removal error stream".to_string())?;
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
        kill_child_pid(&DEADFRAME_CHILD_PID);
        let _ = child.wait();
        clear_child_pid(&DEADFRAME_CHILD_PID);
        set_active_output(None);
        let stderr_tail = stderr_handle.join().unwrap_or_default();
        log_error(
            "deadframe.streaming_bridge.read.error",
            "Could not read streaming dead-frame removal output",
            json!({ "error": &error, "stderr": truncate_log_text(stderr_tail.trim()) }),
        );
        return Err(error);
    }

    let status = child.wait().map_err(|error| error.to_string())?;
    clear_child_pid(&DEADFRAME_CHILD_PID);
    set_active_output(None);
    let stderr_tail = stderr_handle.join().unwrap_or_default();
    if let Some(payload) = final_payload {
        match payload.get("type").and_then(Value::as_str) {
            Some("done") => return Ok(payload.to_string()),
            Some("error") => {
                return Err(payload
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Dead-frame removal failed.")
                    .to_string())
            }
            _ => {}
        }
    }
    let tail = stderr_tail.trim();
    let error = if tail.is_empty() {
        format!(
            "Dead-frame removal stopped without a result (exit code {}).",
            status.code().unwrap_or(-1)
        )
    } else {
        tail.to_string()
    };
    log_error(
        "deadframe.streaming_bridge.error",
        "Streaming dead-frame removal bridge failed",
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
        let message = demux_line(r#"{"type":"progress","stage":"remove","percent":42}"#);
        assert!(matches!(message, StreamMessage::Forward(_)));
    }

    #[test]
    fn event_demux_returns_done_payload() {
        let message = demux_line(r#"{"type":"done","succeeded":2}"#);
        assert!(matches!(message, StreamMessage::Final(_)));
    }

    #[test]
    fn event_demux_returns_error_payload() {
        let message = demux_line(r#"{"type":"error","message":"nope"}"#);
        assert!(matches!(message, StreamMessage::Final(_)));
    }

    #[test]
    fn event_demux_ignores_malformed_lines() {
        assert_eq!(demux_line("not json"), StreamMessage::Ignore);
        assert_eq!(demux_line(""), StreamMessage::Ignore);
        assert_eq!(demux_line(r#"{"type":"analysis"}"#), StreamMessage::Ignore);
    }

    #[test]
    fn bridge_errors_show_the_sentence_not_the_json() {
        assert_eq!(
            bridge_error_text(r#"{"type":"error","message":"Could not read this file."}"#),
            "Could not read this file."
        );
        assert_eq!(bridge_error_text("plain text failure"), "plain text failure");
    }

    #[test]
    fn export_paths_land_beside_the_source_with_the_format_extension() {
        let sources = vec![PathBuf::from(r"C:\clips\scene.mov")];
        let outputs = export_output_paths(&sources, "_nodead", "h264-mkv").expect("paths");
        assert_eq!(outputs[0], PathBuf::from(r"C:\clips\scene_nodead.mkv"));
    }

    #[test]
    fn export_paths_use_each_formats_own_container() {
        let sources = vec![PathBuf::from(r"C:\clips\scene.mkv")];
        for (format, expected) in [
            ("h264-mp4", "scene_nodead.mp4"),
            ("hevc-mp4", "scene_nodead.mp4"),
            ("h264-mkv", "scene_nodead.mkv"),
            ("prores-mov", "scene_nodead.mov"),
        ] {
            let outputs = export_output_paths(&sources, "_nodead", format).expect("paths");
            assert_eq!(
                outputs[0].file_name().and_then(|value| value.to_str()),
                Some(expected)
            );
        }
    }

    #[test]
    fn export_rejects_an_unknown_format() {
        let sources = vec![PathBuf::from(r"C:\clips\scene.mp4")];
        assert!(export_output_paths(&sources, "_nodead", "vp9-webm").is_err());
    }

    #[test]
    fn export_path_never_targets_the_source_file() {
        let sources = vec![PathBuf::from(r"C:\clips\scene.mp4")];
        let outputs = export_output_paths(&sources, "", "h264-mp4").expect("paths");
        assert_eq!(outputs[0], PathBuf::from(r"C:\clips\scene_nodead.mp4"));
        // A suffix made only of stripped characters is the same situation.
        let outputs = export_output_paths(&sources, "/\\:", "h264-mp4").expect("paths");
        assert_eq!(outputs[0], PathBuf::from(r"C:\clips\scene_nodead.mp4"));
    }

    #[test]
    fn a_suffix_cannot_walk_out_of_the_source_folder() {
        let sources = vec![PathBuf::from(r"C:\clips\scene.mp4")];
        let outputs = export_output_paths(&sources, r"..\..\evil", "h264-mp4").expect("paths");
        assert_eq!(outputs[0].parent(), Some(Path::new(r"C:\clips")));
        assert_eq!(
            outputs[0].file_name().and_then(|value| value.to_str()),
            Some("sceneevil.mp4")
        );
    }

    #[test]
    fn two_clips_in_one_batch_never_share_a_destination() {
        let sources = vec![
            PathBuf::from(r"C:\clips\scene.mp4"),
            PathBuf::from(r"C:\clips\scene.mkv"),
            PathBuf::from(r"C:\clips\scene.mov"),
        ];
        let outputs = export_output_paths(&sources, "_nodead", "h264-mp4").expect("paths");
        assert_eq!(outputs[0], PathBuf::from(r"C:\clips\scene_nodead.mp4"));
        assert_eq!(outputs[1], PathBuf::from(r"C:\clips\scene_nodead-2.mp4"));
        assert_eq!(outputs[2], PathBuf::from(r"C:\clips\scene_nodead-3.mp4"));
    }

    #[test]
    fn re_exporting_the_same_clip_reuses_the_same_destination() {
        // Overwriting a previous run is deliberate: same source, same suffix,
        // same file. Only a collision inside one batch is redirected.
        let sources = vec![PathBuf::from(r"C:\clips\scene.mp4")];
        let first = export_output_paths(&sources, "_nodead", "h264-mp4").expect("paths");
        let second = export_output_paths(&sources, "_nodead", "h264-mp4").expect("paths");
        assert_eq!(first, second);
    }

    #[test]
    fn export_settings_reject_impossible_values() {
        assert!(export_settings(18.0, Some("sideways".to_string()), None, None).is_err());
        assert!(export_settings(18.0, None, None, Some(0.0)).is_err());
        assert!(export_settings(f64::NAN, None, None, None).is_err());
    }

    #[test]
    fn export_settings_clamp_the_dial_and_the_quality() {
        let (sensitivity, mode, quality, bitrate) =
            export_settings(140.0, None, Some(99), None).expect("settings");
        assert_eq!(sensitivity, 100.0);
        assert_eq!(mode, "quality");
        assert_eq!(quality, 28);
        assert_eq!(bitrate, 20.0);
        let (sensitivity, _, quality, _) =
            export_settings(-5.0, None, Some(1), None).expect("settings");
        assert_eq!(sensitivity, 0.0);
        assert_eq!(quality, 14);
    }

    #[test]
    fn an_absent_frame_rate_means_the_source_rate() {
        assert_eq!(validate_export_fps(None), Ok(None));
    }

    #[test]
    fn a_chosen_frame_rate_survives_validation_intact() {
        assert_eq!(validate_export_fps(Some(23.976)), Ok(Some(23.976)));
        assert_eq!(validate_export_fps(Some(60.0)), Ok(Some(60.0)));
    }

    #[test]
    fn impossible_frame_rates_are_rejected_before_any_encode_starts() {
        assert!(validate_export_fps(Some(0.0)).is_err());
        assert!(validate_export_fps(Some(-24.0)).is_err());
        assert!(validate_export_fps(Some(f64::NAN)).is_err());
        assert!(validate_export_fps(Some(f64::INFINITY)).is_err());
        assert!(validate_export_fps(Some(1001.0)).is_err());
    }

    #[test]
    fn cancelling_without_a_running_job_is_a_no_op() {
        cancel_deadframe_now();
    }

    #[test]
    fn folder_listing_returns_only_video_files() {
        let temp = tempfile::tempdir().expect("temporary folder");
        fs::write(temp.path().join("B.MKV"), b"video").expect("mkv");
        fs::write(temp.path().join("a.mp4"), b"video").expect("mp4");
        fs::write(temp.path().join("notes.txt"), b"text").expect("text");
        let files =
            deadframe_list_folder(temp.path().to_string_lossy().to_string()).expect("listing");
        assert_eq!(files.len(), 2);
        assert!(files[0].ends_with("a.mp4"));
        assert!(files[1].ends_with("B.MKV"));
    }
}
