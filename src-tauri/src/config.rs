use std::{fs, path::Path};

use serde::Serialize;
use serde_json::json;
use tauri::Manager;

use crate::{log_error, log_info, run_audio_cli};

#[derive(Serialize)]
pub(crate) struct ClearCacheReport {
    pub files_removed: u64,
    pub bytes_freed: u64,
}

pub(crate) fn dir_file_stats(dir: &Path) -> (u64, u64) {
    let mut files: u64 = 0;
    let mut bytes: u64 = 0;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Ok(meta) = entry.metadata() {
                if meta.is_dir() {
                    let (sub_files, sub_bytes) = dir_file_stats(&path);
                    files += sub_files;
                    bytes += sub_bytes;
                } else {
                    files += 1;
                    bytes += meta.len();
                }
            }
        }
    }
    (files, bytes)
}

#[tauri::command]
pub(crate) async fn clear_app_cache(window: tauri::Window) -> Result<ClearCacheReport, String> {
    let app_data_dir = window
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?;

    log_info(
        "cache.clear.start",
        "Clearing app caches",
        json!({ "app_data_dir": app_data_dir.display().to_string() }),
    );

    let report = tauri::async_runtime::spawn_blocking(move || -> Result<ClearCacheReport, String> {
        // All of these are regenerated on demand, so wiping them is safe.
        // Don't touch `backgrounds/`, `logs/`, `*.json`, or the WebView2
        // browser data — those are user data, not cache.
        const CACHE_DIRS: &[&str] = &[
            "clip_previews",
            "scene_clips",
            "source_proxies",
            "clip_compat_cache",
            "bgremove_previews",
        ];

        let mut total_files = 0u64;
        let mut total_bytes = 0u64;
        let mut first_error: Option<String> = None;

        for name in CACHE_DIRS {
            let dir = app_data_dir.join(name);
            if !dir.exists() {
                continue;
            }
            let (files, bytes) = dir_file_stats(&dir);
            match fs::remove_dir_all(&dir) {
                Ok(()) => {
                    total_files += files;
                    total_bytes += bytes;
                }
                Err(error) => {
                    let msg = format!("Could not remove {name}: {error}");
                    log_error("cache.clear.dir_error", &msg, json!({ "dir": name }));
                    if first_error.is_none() {
                        first_error = Some(msg);
                    }
                }
            }
        }

        if let Some(error) = first_error {
            return Err(error);
        }
        Ok(ClearCacheReport {
            files_removed: total_files,
            bytes_freed: total_bytes,
        })
    })
    .await
    .map_err(|error| error.to_string())??;

    log_info(
        "cache.clear.complete",
        "App caches cleared",
        json!({
            "files_removed": report.files_removed,
            "bytes_freed": report.bytes_freed,
        }),
    );

    Ok(report)
}

#[tauri::command]
pub(crate) async fn get_config() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run_audio_cli(&["config"]))
        .await
        .map_err(|error| error.to_string())?
}

/// Config keys whose value is a secret and must never hit the on-disk log in
/// plaintext. A key is sensitive if its name (case-insensitive) contains any
/// of these substrings, so `tsukyio_api_key`, `*_token`, `*_secret`,
/// `*_password` are all covered without an explicit allow-list.
pub(crate) fn is_sensitive_config_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    ["key", "token", "secret", "password"]
        .iter()
        .any(|needle| lower.contains(needle))
}

/// Produces a log-safe rendering of a config value: secrets become a short
/// masked placeholder (first 4 chars + ellipsis, or just `<redacted>` when too
/// short to show a prefix safely), everything else logs verbatim.
pub(crate) fn redact_config_value(key: &str, value: &str) -> String {
    if !is_sensitive_config_key(key) {
        return value.to_string();
    }
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let prefix: String = trimmed.chars().take(4).collect();
    if prefix.chars().count() < 4 {
        "<redacted>".to_string()
    } else {
        format!("{prefix}…")
    }
}

#[tauri::command]
pub(crate) async fn set_config(key: String, value: String) -> Result<String, String> {
    log_info(
        "config.set.start",
        "Updating app configuration",
        json!({ "key": &key, "value": redact_config_value(&key, &value) }),
    );
    let log_key = key.clone();
    let result = tauri::async_runtime::spawn_blocking(move || run_audio_cli(&["set-config", &key, &value]))
        .await
        .map_err(|error| error.to_string())?;
    match &result {
        Ok(_) => log_info("config.set.complete", "App configuration updated", json!({ "key": log_key })),
        Err(error) => {
            // For sensitive keys the CLI error body could echo the value, so
            // never log it verbatim.
            let safe_error = if is_sensitive_config_key(&log_key) {
                "<redacted>".to_string()
            } else {
                error.clone()
            };
            log_error("config.set.error", "App configuration update failed", json!({ "key": log_key, "error": safe_error }));
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sensitive_keys_are_detected_case_insensitively() {
        assert!(is_sensitive_config_key("tsukyio_api_key"));
        assert!(is_sensitive_config_key("API_KEY"));
        assert!(is_sensitive_config_key("access_token"));
        assert!(is_sensitive_config_key("client_secret"));
        assert!(is_sensitive_config_key("PASSWORD"));
        assert!(!is_sensitive_config_key("download_path"));
        assert!(!is_sensitive_config_key("theme"));
        assert!(!is_sensitive_config_key("clip_extraction_mode"));
    }

    #[test]
    fn redact_masks_secrets_but_passes_normal_values() {
        // Non-sensitive: verbatim.
        assert_eq!(redact_config_value("download_path", "D:/clips"), "D:/clips");
        // Sensitive with a usable prefix: first 4 chars + ellipsis, never the rest.
        let masked = redact_config_value("tsukyio_api_key", "tsk_supersecretvalue");
        assert_eq!(masked, "tsk_…");
        assert!(!masked.contains("supersecret"));
        // Sensitive but short: no prefix leaked.
        assert_eq!(redact_config_value("tsukyio_api_key", "ab"), "<redacted>");
        // Empty stays empty (clearing the key).
        assert_eq!(redact_config_value("tsukyio_api_key", ""), "");
    }
}
