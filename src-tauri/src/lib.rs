use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::async_runtime::Mutex as AsyncMutex;
use tokio::process::Child as AsyncChild;

mod audio_cmds;
mod background_img;
mod clips;
mod config;
mod discord;
mod downloads;
mod eyedropper;
mod logging;
mod preview;
mod python_env;
mod sniffer;
mod tools;
mod tsukyio;
mod video_cmds;
mod wallpaper;
mod bgremove_cmds;

// Re-export internal helpers so sibling modules and discord.rs/tools.rs can
// keep using `crate::xxx` paths.
pub(crate) use clips::stop_clip_processes_for_dependency_setup;
pub(crate) use downloads::{content_fingerprint, sanitize_path_segment, short_stable_id};
pub(crate) use logging::{append_app_log, app_state_dir, log_error, log_info, log_warn, reset_app_logs, truncate_log_text};
pub(crate) use preview::serialize_clip_preview_done;
pub(crate) use python_env::{
    app_root, apply_python_env, apply_python_env_async, audio_cli_path, clear_child_pid,
    clip_cli_path, bgremove_cli_path, cmd, find_tool, kill_child_pid, python_exe, run_audio_cli,
    run_bgremove_cli, store_child_pid, tools_dir_path,
};
pub(crate) use video_cmds::{
    canonical_input_path, command_available, emit_conversion_progress, ensure_tool, ffmpeg_listing,
    probe_duration, probe_has_audio_stream, probe_media_summary, run_ffmpeg_with_progress,
    MediaSummary, H264_NVENC_AVAILABLE,
};

// ---- Shared types used across modules (kept in lib.rs to avoid circular deps) ----

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversionProgress {
    pub stage: String,
    pub percent: Option<f32>,
    pub message: String,
    pub fps: Option<String>,
    pub speed: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversionDone {
    pub r#type: String,
    pub input: String,
    pub output: String,
    pub archived_original: Option<String>,
    pub preset: String,
}

// ---- Module-level statics (shared across feature modules) ----

pub(crate) static AUDIO_CHILD_PID: OnceLock<Mutex<Option<u32>>> = OnceLock::new();
pub(crate) static CLIP_CHILD_PID: OnceLock<Mutex<Option<u32>>> = OnceLock::new();
// Featherweight previews: the in-flight source-proxy ffmpeg build. Mirrors
// CLIP_CHILD_PID so a new source selection / app teardown cancels it.
pub(crate) static PROXY_CHILD_PID: OnceLock<Mutex<Option<u32>>> = OnceLock::new();
pub(crate) static DOWNLOAD_CHILD_PID: OnceLock<Mutex<Option<u32>>> = OnceLock::new();
pub(crate) static VIDEO_CHILD_PID: OnceLock<Mutex<Option<u32>>> = OnceLock::new();
pub(crate) static BGREMOVE_CHILD_PID: OnceLock<Mutex<Option<u32>>> = OnceLock::new();
// Raw HANDLE to the Job Object set up by setup_kill_on_close_job().
// Stored as usize so we can revisit it across threads / from a Tauri command
// (windows-rs HANDLE is !Send). prepare_for_update() reopens it to drop
// KILL_ON_JOB_CLOSE, otherwise the auto-updater's installer dies with us.
#[cfg(target_os = "windows")]
pub(crate) static JOB_HANDLE_RAW: OnceLock<usize> = OnceLock::new();
pub(crate) static CLIP_SERVER: OnceLock<AsyncMutex<Option<AsyncChild>>> = OnceLock::new();

pub(crate) const GPU_INTRA_SOURCE_CODECS: &str = "H.264 or HEVC";

#[tauri::command]
fn open_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    log_info("shell.open_path.start", "Opening path in shell", json!({ "path": &path }));
    let result = app.opener().open_path(path.clone(), None::<String>).map_err(|e| e.to_string());
    match &result {
        Ok(_) => log_info("shell.open_path.complete", "Path opened in shell", json!({ "path": path })),
        Err(error) => log_error("shell.open_path.error", "Could not open path in shell", json!({ "path": path, "error": error })),
    }
    result
}

/// Reveals a file in the OS file manager (selecting it), as opposed to
/// `open_path` which launches the file in its default app. On Windows we run
/// `explorer /select,<path>`; on macOS `open -R <path>`; on Linux there is no
/// portable "select" verb, so we fall back to opening the containing folder.
#[tauri::command]
fn reveal_in_folder(#[allow(unused_variables)] app: tauri::AppHandle, path: String) -> Result<(), String> {
    log_info("shell.reveal.start", "Revealing path in file manager", json!({ "path": &path }));

    let result: Result<(), String> = {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            // raw_arg: Command::arg would quote the whole thing when the path
            // has spaces (`"/select,C:\..."`), which explorer can't parse — it
            // silently opens Documents instead. Explorer also rejects forward
            // slashes in the /select target.
            let native = path.replace('/', "\\");
            cmd("explorer")
                .raw_arg(format!("/select,\"{}\"", native))
                .spawn()
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
        #[cfg(target_os = "macos")]
        {
            cmd("open")
                .arg("-R")
                .arg(&path)
                .spawn()
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            use tauri_plugin_opener::OpenerExt;
            let parent = std::path::Path::new(&path)
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| path.clone());
            app.opener()
                .open_path(parent, None::<String>)
                .map_err(|e| e.to_string())
        }
    };

    match &result {
        Ok(_) => log_info("shell.reveal.complete", "Path revealed in file manager", json!({ "path": path })),
        Err(error) => log_error("shell.reveal.error", "Could not reveal path", json!({ "path": path, "error": error })),
    }
    result
}

#[tauri::command]
fn cancel_video() {
    log_warn("video.cancel", "Cancelling active video transcode", Value::Null);
    kill_child_pid(&VIDEO_CHILD_PID);
}

// Assign the current process to a Windows Job Object configured with
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE so every Python sidecar we spawn
// dies automatically when this process exits : even on TerminateProcess
// (which the installer uses) or an unexpected crash, where the normal
// CloseRequested handler does not run. Without this, orphaned python.exe
// children keep _bz2.pyd / *.dll handles open and the next installer
// hits "file in use" errors on update.
#[cfg(target_os = "windows")]
fn setup_kill_on_close_job() {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::GetCurrentProcess;

    unsafe {
        let job = match CreateJobObjectW(None, windows::core::PCWSTR::null()) {
            Ok(handle) => handle,
            Err(error) => {
                log_warn(
                    "app.jobobject.create.error",
                    "Could not create job object for sidecar cleanup",
                    json!({ "error": error.to_string() }),
                );
                return;
            }
        };

        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if let Err(error) = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) {
            log_warn(
                "app.jobobject.configure.error",
                "Could not configure job object for sidecar cleanup",
                json!({ "error": error.to_string() }),
            );
            let _ = CloseHandle(job);
            return;
        }

        if let Err(error) = AssignProcessToJobObject(job, GetCurrentProcess()) {
            // Already inside a non-nestable job (e.g. some Windows Sandbox /
            // container environments). The on-close handler is still our
            // fallback; not fatal.
            log_warn(
                "app.jobobject.assign.error",
                "Could not assign main process to job object : relying on close-event cleanup",
                json!({ "error": error.to_string() }),
            );
            let _ = CloseHandle(job);
            return;
        }

        log_info(
            "app.jobobject.ready",
            "Job object assigned : Python sidecars will auto-terminate with the main process",
            Value::Null,
        );
        // Save the raw handle so prepare_for_update can drop
        // KILL_ON_JOB_CLOSE before the auto-updater spawns the installer
        // (the installer inherits the job and would otherwise be killed
        // when we exit, leaving the user on the old version).
        let _ = JOB_HANDLE_RAW.set(job.0 as usize);
        // windows-rs HANDLE is a Copy newtype with no Drop, so the kernel
        // handle persists past this scope. The kernel auto-closes it when
        // we exit, which is precisely when KILL_ON_JOB_CLOSE should fire
        // to terminate any surviving sidecars.
        let _ = job;
    }
}

// Called by the Settings → Update card right before tauri-plugin-updater's
// install() spawns the new installer. Two things have to happen first:
//
//  1. Kill the Python sidecars synchronously. install() is going to exit
//     the main exe via TerminateProcess, which does NOT fire our
//     CloseRequested handler : so the children would otherwise survive
//     long enough to hold _bz2.pyd / python.exe handles open while NSIS
//     tries to overwrite them.
//
//  2. Drop JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE from the job. The installer
//     is spawned as a child of this process and therefore inherits the
//     job. When we exit, the kernel closes our last handle to the job,
//     and KILL_ON_JOB_CLOSE would terminate the installer mid-install :
//     leaving the user stuck on the old version (no update applied, no
//     auto-relaunch, no error). Clearing the flag lets the installer
//     outlive us.
#[tauri::command]
fn prepare_for_update() -> Result<(), String> {
    log_info(
        "updater.prepare.start",
        "Preparing for auto-update : killing sidecars and relaxing job object",
        Value::Null,
    );
    kill_child_pid(&AUDIO_CHILD_PID);
    kill_child_pid(&CLIP_CHILD_PID);
    kill_child_pid(&PROXY_CHILD_PID);
    kill_child_pid(&DOWNLOAD_CHILD_PID);
    kill_child_pid(&VIDEO_CHILD_PID);
    kill_child_pid(&BGREMOVE_CHILD_PID);
    kill_child_pid(&wallpaper::WALLPAPER_CHILD_PID);
    if let Some(mutex) = CLIP_SERVER.get() {
        let mut guard = mutex.blocking_lock();
        if let Some(child) = guard.as_mut() {
            let _ = child.start_kill();
        }
    }

    #[cfg(target_os = "windows")]
    unsafe {
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::JobObjects::{
            JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        };

        let Some(&raw) = JOB_HANDLE_RAW.get() else {
            log_warn(
                "updater.prepare.no_job",
                "No saved job handle : installer should survive anyway",
                Value::Null,
            );
            return Ok(());
        };
        let job = HANDLE(raw as *mut _);
        // Zeroed struct == LimitFlags cleared == no KILL_ON_JOB_CLOSE.
        // The job object itself stays alive (still useful for sidecar
        // accounting), it just stops killing its members on close.
        let info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        if let Err(error) = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) {
            log_warn(
                "updater.prepare.relax_failed",
                "Could not clear KILL_ON_JOB_CLOSE : installer may be killed at exit",
                json!({ "error": error.to_string() }),
            );
        } else {
            log_info(
                "updater.prepare.relaxed",
                "Cleared KILL_ON_JOB_CLOSE : installer will survive process exit",
                Value::Null,
            );
        }
    }

    Ok(())
}

#[tauri::command]
fn discord_set_state(state: String) {
    discord::set_state(&state);
}

#[tauri::command]
fn discord_clear() {
    discord::clear();
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    use std::fs::File;
    use std::io::Write;
    
    log_info("fs.write_file.start", "Writing file", json!({ "path": &path }));
    
    let mut file = File::create(&path).map_err(|e| e.to_string())?;
    file.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
    
    log_info("fs.write_file.done", "File written successfully", Value::Null);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    reset_app_logs();
    log_info("app.start", "Ultimate AMV app starting", Value::Null);
    #[cfg(target_os = "windows")]
    setup_kill_on_close_job();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Holds the Tsukyio Bearer key for the `tsukyio://` streaming proxy so
        // the key never has to appear in any media URL the DOM can read.
        .manage(tsukyio::TsukyioSession::default())
        // Proxies the remote Tsukyio media stream through a local app-trusted
        // origin (http://tsukyio.localhost on Windows) so WebView2 can play the
        // cross-origin Range stream that it otherwise rejects. See tsukyio.rs.
        .register_asynchronous_uri_scheme_protocol(
            tsukyio::TSUKYIO_PROTOCOL,
            tsukyio::handle_stream_protocol,
        )
        .setup(|app| {
            discord::start();
            match tools::ensure_writable_tools_dir(&app.handle()) {
                Ok(dir) => {
                    let _ = python_env::TOOLS_DIR_OVERRIDE.set(dir.clone());
                    log_info(
                        "tools.dir.ready",
                        "Tools directory resolved",
                        json!({ "tools_dir": dir.display().to_string() }),
                    );
                }
                Err(error) => {
                    log_error(
                        "tools.dir.error",
                        "Could not resolve or create tools directory",
                        json!({ "error": error }),
                    );
                }
            }
            Ok(())
        })
        .on_window_event(|_window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                log_info("app.close", "Application close requested", Value::Null);
                kill_child_pid(&AUDIO_CHILD_PID);
                kill_child_pid(&CLIP_CHILD_PID);
                kill_child_pid(&PROXY_CHILD_PID);
                kill_child_pid(&DOWNLOAD_CHILD_PID);
                kill_child_pid(&VIDEO_CHILD_PID);
                kill_child_pid(&BGREMOVE_CHILD_PID);
                kill_child_pid(&wallpaper::WALLPAPER_CHILD_PID);

                // Kill persistent server
                if let Some(mutex) = CLIP_SERVER.get() {
                    let mut guard = mutex.blocking_lock();
                    if let Some(child) = guard.as_mut() {
                        log_info("clip.server.kill", "Stopping clip server during app close", Value::Null);
                        let _ = child.start_kill();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            audio_cmds::audio_status,
            logging::app_logs,
            logging::clear_app_logs,
            config::clear_app_cache,
            logging::frontend_log,
            prepare_for_update,
            audio_cmds::audio_extract,
            audio_cmds::audio_setup_plan,
            audio_cmds::audio_setup,
            audio_cmds::media_to_audio,
            video_cmds::video_transcode,
            clips::clip_export,
            clips::clip_export_merged,
            clips::clip_preview_merge,
            video_cmds::video_gpu_status,
            video_cmds::video_source_codec,
            preview::clip_preview_generate,
            preview::clip_preview_generate_batch,
            clips::scene_clip_render,
            clips::clip_playback_plan,
            clips::build_source_proxy,
            config::get_config,
            config::set_config,
            background_img::save_background_image,
            background_img::clear_background_image,
            wallpaper::wallpaper_transcode,
            wallpaper::wallpaper_cancel,
            wallpaper::wallpaper_clear,
            wallpaper::wallpaper_probe,
            wallpaper::wallpaper_commit,
            clips::clip_extract,
            clips::clip_compat_convert,
            clips::warmup_clip_server,
            clips::warmup_ffmpeg,
            sniffer::install_media_sniffer,
            downloads::download_stream,
            downloads::download_media,
            downloads::download_history,
            downloads::list_anime_folders,
            downloads::inspect_stream,
            downloads::inspect_download_formats,
            audio_cmds::cancel_audio,
            clips::cancel_clip,
            downloads::cancel_download,
            cancel_video,
            bgremove_cmds::bgremove_status,
            bgremove_cmds::bgremove_preview,
            bgremove_cmds::bgremove_process,
            bgremove_cmds::bgremove_save_preview,
            bgremove_cmds::cancel_bgremove,
            open_path,
            reveal_in_folder,
            tools::tools_status,
            tools::tools_install,
            tools::tools_cancel,
            tsukyio::tsukyio_test_connection,
            tsukyio::tsukyio_browse,
            tsukyio::tsukyio_search,
            tsukyio::tsukyio_deep_search,
            tsukyio::tsukyio_download,
            tsukyio::tsukyio_cancel_download,
            tsukyio::tsukyio_set_session_key,
            discord_set_state,
            discord_clear,
            eyedropper::sample_screen_color,
            write_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anikai_identity_request_recognizes_known_paths() {
        assert!(sniffer::is_anikai_identity_request("https://aniwaves.ru/ajax/episode/list/123"));
        assert!(sniffer::is_anikai_identity_request("https://anikai.to/api/source/abc"));
        assert!(sniffer::is_anikai_identity_request("https://anikai.to/embed/iframe?id=42"));
        assert!(!sniffer::is_anikai_identity_request("https://aniwaves.ru/static/main.js"));
        assert!(!sniffer::is_anikai_identity_request("https://other-host.com/ajax/episode/1"));
    }

    #[test]
    fn anikai_watch_document_url_only_matches_html_pages() {
        assert!(sniffer::is_anikai_watch_document_url("https://aniwaves.ru/watch/some-anime-123"));
        assert!(sniffer::is_anikai_watch_document_url("https://anikai.to/watch/foo-9"));
        assert!(!sniffer::is_anikai_watch_document_url("https://aniwaves.ru/watch/foo.m3u8"));
        assert!(!sniffer::is_anikai_watch_document_url("https://aniwaves.ru/browse"));
    }

    #[test]
    fn parse_anikai_identity_payload_extracts_episode_from_object() {
        let payload = r#"{"data":{"episode":"7","anime_title":"Bleach"}}"#;
        let identity = sniffer::parse_anikai_identity_payload(payload, "https://aniwaves.ru/ajax/list/abc")
            .expect("payload should parse");
        assert_eq!(identity.episode_number.as_deref(), Some("7"));
        assert_eq!(identity.episode_label.as_deref(), Some("Episode 7"));
        assert_eq!(identity.anime_title.as_deref(), Some("Bleach"));
    }

    #[test]
    fn parse_anikai_identity_payload_falls_back_to_url_episode() {
        let payload = r#"{"servers":[{"name":"vidstreaming"}]}"#;
        let identity = sniffer::parse_anikai_identity_payload(
            payload,
            "https://anikai.to/ajax/episode/servers?ep=12",
        )
        .expect("URL fallback should yield identity");
        assert_eq!(identity.episode_number.as_deref(), Some("12"));
    }

    #[test]
    fn parse_anikai_sync_data_keeps_title_only() {
        let html = r#"<html><script id="syncData" type="application/json">{"name":"Bleach: TYBW","series_url":"/anime/bleach"}</script></html>"#;
        let identity = sniffer::parse_anikai_sync_data(html, "https://aniwaves.ru/watch/bleach-tybw-1")
            .expect("syncData should parse");
        assert_eq!(identity.anime_title.as_deref(), Some("Bleach: TYBW"));
        assert!(identity.episode_number.is_none(), "syncData episode is intentionally ignored");
    }

    #[test]
    fn format_spec_audio_only_classification() {
        assert!(downloads::format_spec_is_audio_only("bestaudio"));
        assert!(downloads::format_spec_is_audio_only("bestaudio[ext=m4a]"));
        assert!(downloads::format_spec_is_audio_only("bestaudio/audio_only"));
        assert!(!downloads::format_spec_is_audio_only("bestvideo*+bestaudio/best"));
        assert!(!downloads::format_spec_is_audio_only("137+bestaudio/best"));
        assert!(!downloads::format_spec_is_audio_only("18"));
        assert!(!downloads::format_spec_is_audio_only(""));
    }
}
