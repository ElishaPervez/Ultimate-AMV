use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::{Mutex, OnceLock},
};

use serde_json::json;
use tokio::process::Command as AsyncCommand;

use crate::{log_error, log_info, truncate_log_text};

// Tools (ffmpeg/ffprobe/yt-dlp + the ffmpeg-shared DLLs that nelux loads via
// os.add_dll_directory) are no longer bundled inside the installer. They live
// in the per-user app_local_data_dir and are downloaded on first launch by
// the tools gate (see src-tauri/src/tools.rs). The Tauri setup callback
// initializes TOOLS_DIR_OVERRIDE; every code path that needs ffmpeg /
// ffprobe / yt-dlp reads from there, and every Python sidecar spawn
// propagates the resolved path through the ULTIMATE_AMV_TOOLS_DIR env var
// so backend/clip_cli.py's add_dll_directory call (and the matching probe
// in backend/amv_audio/setup.py:_nelux_importable) point at the right
// place.
pub(crate) static TOOLS_DIR_OVERRIDE: OnceLock<PathBuf> = OnceLock::new();

pub(crate) fn app_root() -> Result<PathBuf, String> {
    let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    if cwd.file_name().and_then(|name| name.to_str()) == Some("src-tauri") {
        return cwd
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "Could not resolve project root".to_string());
    }
    if cwd.join("backend").is_dir() && cwd.join("python").is_dir() {
        return Ok(cwd);
    }

    if let Some(exe_dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
    {
        if exe_dir.join("backend").is_dir() {
            return Ok(exe_dir);
        }
    }
    Ok(cwd)
}

pub(crate) fn python_exe(root: &Path) -> PathBuf {
    root.join("python").join("python.exe")
}

pub(crate) fn tools_dir_path(root: &Path) -> PathBuf {
    if let Some(dir) = TOOLS_DIR_OVERRIDE.get() {
        return dir.clone();
    }
    if let Ok(env_dir) = std::env::var("ULTIMATE_AMV_TOOLS_DIR") {
        return PathBuf::from(env_dir);
    }
    // Dev fallback only : when running from a checkout that still has a
    // local tools/ tree for legacy reasons, this lets `cargo run` work
    // before the gate has populated app_local_data_dir/tools/.
    root.join("tools")
}

pub(crate) fn find_tool(root: &Path, name: &str) -> PathBuf {
    tools_dir_path(root).join(format!("{name}.exe"))
}

pub(crate) fn python_sidecar_env() -> Vec<(&'static str, std::ffi::OsString)> {
    let mut env: Vec<(&'static str, std::ffi::OsString)> =
        vec![("ULTIMATE_AMV_STATE_DIR", crate::app_state_dir().into_os_string())];
    if let Some(dir) = TOOLS_DIR_OVERRIDE.get() {
        env.push(("ULTIMATE_AMV_TOOLS_DIR", dir.clone().into_os_string()));
    }
    env.push(("PYTHONIOENCODING", "utf-8".into()));
    env.push(("PYTHONUTF8", "1".into()));
    env
}

pub(crate) fn apply_python_env(command: &mut Command) {
    for (key, value) in python_sidecar_env() {
        command.env(key, value);
    }
}

pub(crate) fn apply_python_env_async(command: &mut AsyncCommand) {
    for (key, value) in python_sidecar_env() {
        command.env(key, value);
    }
}

pub(crate) fn cmd(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut c = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    c
}

pub(crate) fn store_child_pid(slot: &OnceLock<Mutex<Option<u32>>>, pid: u32) {
    if let Ok(mut g) = slot.get_or_init(|| Mutex::new(None)).lock() {
        *g = Some(pid);
    }
}

pub(crate) fn clear_child_pid(slot: &OnceLock<Mutex<Option<u32>>>) {
    if let Some(m) = slot.get() {
        if let Ok(mut g) = m.lock() {
            *g = None;
        }
    }
}

pub(crate) fn kill_child_pid(slot: &OnceLock<Mutex<Option<u32>>>) {
    let Some(m) = slot.get() else { return };
    let Ok(g) = m.lock() else { return };
    if let Some(pid) = *g {
        let _ = cmd("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .output();
    }
}

pub(crate) fn audio_cli_path(root: &Path) -> PathBuf {
    root.join("backend").join("audio_cli.py")
}

pub(crate) fn clip_cli_path(root: &Path) -> PathBuf {
    root.join("backend").join("clip_cli.py")
}

pub(crate) fn bgremove_cli_path(root: &Path) -> PathBuf {
    root.join("backend").join("bgremove_cli.py")
}

/// Returns a copy of the bridge `args` safe to write to the on-disk log.
/// `set-config <key> <value>` carries a secret value when `<key>` is sensitive
/// (e.g. `tsukyio_api_key`), so mask that argument before it reaches the log
/// file users routinely share for debugging. All other commands log verbatim.
fn redacted_cli_args(args: &[&str]) -> Vec<String> {
    if args.first().copied() == Some("set-config") {
        if let [cmd, key, value, rest @ ..] = args {
            let mut out = vec![cmd.to_string(), key.to_string()];
            out.push(crate::config::redact_config_value(key, value));
            out.extend(rest.iter().map(|a| a.to_string()));
            return out;
        }
    }
    args.iter().map(|a| a.to_string()).collect()
}

/// `set-config` / `config` print the full config payload (which includes the
/// secret Tsukyio key) on stdout. Never echo that payload into the log on
/// failure; collapse it to a placeholder instead.
fn redact_bridge_stdout(args: &[&str], stdout: &str) -> String {
    match args.first().copied() {
        Some("set-config") | Some("config") => "<config payload redacted>".to_string(),
        _ => truncate_log_text(stdout),
    }
}

pub(crate) fn run_audio_cli(args: &[&str]) -> Result<String, String> {
    let root = app_root()?;
    let log_args = redacted_cli_args(args);
    if args.first().copied() != Some("logs") {
        log_info(
            "audio.bridge.start",
            "Starting audio bridge command",
            json!({ "args": log_args }),
        );
    }
    let mut command = cmd(python_exe(&root));
    command
        .arg("-I")
        .arg(audio_cli_path(&root))
        .args(args)
        .current_dir(&root);
    apply_python_env(&mut command);
    let output = command
        .output()
        .map_err(|error| format!("Could not start Python audio bridge: {error}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if output.status.success() {
        if args.first().copied() != Some("logs") {
            log_info(
                "audio.bridge.complete",
                "Audio bridge command completed",
                json!({ "args": log_args }),
            );
        }
        Ok(stdout)
    } else if !stdout.is_empty() {
        log_error(
            "audio.bridge.error",
            "Audio bridge command failed",
            json!({
                "args": log_args,
                "code": output.status.code(),
                "stdout": redact_bridge_stdout(args, &stdout),
                "stderr": truncate_log_text(&stderr),
            }),
        );
        Err(stdout)
    } else {
        log_error(
            "audio.bridge.error",
            "Audio bridge command failed",
            json!({
                "args": log_args,
                "code": output.status.code(),
                "stderr": truncate_log_text(&stderr),
            }),
        );
        Err(stderr)
    }
}

pub(crate) fn run_bgremove_cli(args: &[&str]) -> Result<String, String> {
    let root = app_root()?;
    log_info(
        "bgremove.bridge.start",
        "Starting background removal bridge command",
        json!({ "args": args }),
    );
    let mut command = cmd(python_exe(&root));
    command
        .arg("-I")
        .arg(bgremove_cli_path(&root))
        .args(args)
        .current_dir(&root);
    apply_python_env(&mut command);
    let output = command
        .output()
        .map_err(|error| format!("Could not start Python background removal bridge: {error}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if output.status.success() {
        log_info(
            "bgremove.bridge.complete",
            "Background removal bridge command completed",
            json!({ "args": args }),
        );
        Ok(stdout)
    } else if !stdout.is_empty() {
        log_error(
            "bgremove.bridge.error",
            "Background removal bridge command failed",
            json!({
                "args": args,
                "code": output.status.code(),
                "stdout": truncate_log_text(&stdout),
                "stderr": truncate_log_text(&stderr),
            }),
        );
        Err(stdout)
    } else {
        log_error(
            "bgremove.bridge.error",
            "Background removal bridge command failed",
            json!({
                "args": args,
                "code": output.status.code(),
                "stderr": truncate_log_text(&stderr),
            }),
        );
        Err(stderr)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacted_args_mask_secret_set_config_value() {
        let args = ["set-config", "tsukyio_api_key", "tsk_supersecretvalue"];
        let redacted = redacted_cli_args(&args);
        assert_eq!(redacted, vec!["set-config", "tsukyio_api_key", "tsk_…"]);
        assert!(!redacted.iter().any(|a| a.contains("supersecret")));
    }

    #[test]
    fn redacted_args_pass_non_secret_set_config_value() {
        let args = ["set-config", "download_path", "D:/clips"];
        let redacted = redacted_cli_args(&args);
        assert_eq!(redacted, vec!["set-config", "download_path", "D:/clips"]);
    }

    #[test]
    fn redacted_args_leave_other_commands_untouched() {
        let args = ["config"];
        assert_eq!(redacted_cli_args(&args), vec!["config"]);
        let args = ["setup-plan", "gpu"];
        assert_eq!(redacted_cli_args(&args), vec!["setup-plan", "gpu"]);
    }

    #[test]
    fn config_payload_stdout_is_never_echoed() {
        let payload = r#"{"type":"config","tsukyio_api_key":"tsk_supersecretvalue"}"#;
        assert_eq!(
            redact_bridge_stdout(&["set-config", "tsukyio_api_key", "x"], payload),
            "<config payload redacted>"
        );
        assert_eq!(redact_bridge_stdout(&["config"], payload), "<config payload redacted>");
        // Unrelated command stdout is preserved (truncation only).
        assert_eq!(redact_bridge_stdout(&["status"], "ok"), "ok");
    }
}

