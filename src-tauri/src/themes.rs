//! Runtime (drop-in) theme discovery for the CSS theme engine.
//!
//! Built-in themes are bundled into the frontend at build time; this module
//! only handles EXTERNAL themes: a developer drops a folder containing a
//! `theme.json` manifest + an entry CSS file (default `theme.css`) into
//!   <app state dir>/themes/<id>/
//! and it shows up in the in-app picker with no rebuild.
//!
//! Two commands:
//!   - `list_themes`    : scan the themes dir, parse each manifest, return them.
//!   - `read_theme_css` : return the entry CSS contents for a discovered theme.
//!
//! Both are defensive: malformed folders are skipped (logged, never panic), and
//! `read_theme_css` guards against path traversal by only serving ids that the
//! scan actually discovered and re-resolving the entry inside the theme folder.
//!
//! v1 limitation: external themes are a single self-contained `theme.css`
//! (+ assets). Nested `@import` inside the entry CSS is NOT resolved here.

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{app_state_dir, log_info, log_warn};

/// Manifest as returned to the frontend. `dir` is the absolute theme folder so
/// the frontend can `convertFileSrc` relative asset references.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThemeManifestOut {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub author: Option<String>,
    pub version: Option<String>,
    pub entry: String,
    pub dir: String,
}

/// Raw `theme.json` shape. All fields optional except we derive `id`/`name`
/// from the folder name when missing.
#[derive(Deserialize, Default)]
struct RawManifest {
    id: Option<String>,
    name: Option<String>,
    description: Option<String>,
    author: Option<String>,
    version: Option<String>,
    entry: Option<String>,
}

/// Absolute path to the runtime themes directory (created if missing).
fn themes_dir() -> PathBuf {
    app_state_dir().join("themes")
}

fn ensure_themes_dir() -> PathBuf {
    let dir = themes_dir();
    if !dir.exists() {
        if let Err(error) = fs::create_dir_all(&dir) {
            log_warn(
                "theme.dir.create_error",
                "Could not create themes directory",
                json!({ "dir": dir.display().to_string(), "error": error.to_string() }),
            );
        }
    }
    dir
}

/// True for a syntactically safe theme id: a single path segment, no traversal,
/// no separators. External ids are the folder name, so this also rejects any
/// attempt to smuggle a path through the id.
fn is_safe_theme_id(id: &str) -> bool {
    !id.is_empty()
        && id != "."
        && id != ".."
        && !id.contains('/')
        && !id.contains('\\')
        && !id.contains('\0')
}

/// Parse one theme folder into a manifest. Returns None (and logs) on any
/// problem so a single bad folder never breaks the whole list.
fn parse_theme_folder(entry_dir: &Path) -> Option<ThemeManifestOut> {
    let folder_name = entry_dir.file_name()?.to_string_lossy().to_string();
    if !is_safe_theme_id(&folder_name) {
        return None;
    }

    let manifest_path = entry_dir.join("theme.json");
    let raw_text = match fs::read_to_string(&manifest_path) {
        Ok(text) => text,
        Err(_) => return None, // no manifest -> not a theme folder
    };

    let raw: RawManifest = match serde_json::from_str(&raw_text) {
        Ok(parsed) => parsed,
        Err(error) => {
            log_warn(
                "theme.manifest.parse_error",
                "Skipping theme with invalid theme.json",
                json!({ "dir": entry_dir.display().to_string(), "error": error.to_string() }),
            );
            return None;
        }
    };

    // Folder name is the canonical id; an explicit manifest id must match it so
    // an id can never point outside its own folder.
    let id = match raw.id {
        Some(ref explicit) if explicit.trim() == folder_name => folder_name.clone(),
        Some(ref explicit) if !explicit.trim().is_empty() => {
            log_warn(
                "theme.manifest.id_mismatch",
                "Theme manifest id does not match folder name; using folder name",
                json!({ "folder": folder_name, "manifest_id": explicit.trim() }),
            );
            folder_name.clone()
        }
        _ => folder_name.clone(),
    };

    let entry = raw
        .entry
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "theme.css".to_string());

    // Reject an entry that tries to escape the folder.
    if entry.contains("..") || entry.starts_with('/') || entry.starts_with('\\') || entry.contains(':') {
        log_warn(
            "theme.entry.unsafe",
            "Skipping theme with unsafe entry path",
            json!({ "id": id, "entry": entry }),
        );
        return None;
    }

    // Entry CSS must actually exist or the theme injects nothing.
    if !entry_dir.join(&entry).is_file() {
        log_warn(
            "theme.entry.missing",
            "Skipping theme whose entry CSS is missing",
            json!({ "id": id, "entry": entry }),
        );
        return None;
    }

    let name = raw
        .name
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| id.clone());

    Some(ThemeManifestOut {
        id,
        name,
        description: raw.description.filter(|v| !v.trim().is_empty()),
        author: raw.author.filter(|v| !v.trim().is_empty()),
        version: raw.version.filter(|v| !v.trim().is_empty()),
        entry,
        dir: entry_dir.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub(crate) async fn list_themes() -> Result<Vec<ThemeManifestOut>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let dir = ensure_themes_dir();
        let mut out: Vec<ThemeManifestOut> = Vec::new();

        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(error) => {
                // Dir missing/unreadable after the create attempt — return empty
                // rather than erroring; built-ins still work without externals.
                log_warn(
                    "theme.dir.read_error",
                    "Could not read themes directory",
                    json!({ "dir": dir.display().to_string(), "error": error.to_string() }),
                );
                return Ok(Vec::new());
            }
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if let Some(manifest) = parse_theme_folder(&path) {
                out.push(manifest);
            }
        }

        out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        log_info(
            "theme.list.complete",
            "Listed external themes",
            json!({ "count": out.len() }),
        );
        Ok(out)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn read_theme_css(id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_safe_theme_id(&id) {
            return Err(format!("Invalid theme id: {id}"));
        }

        let dir = themes_dir().join(&id);
        // Re-parse the folder so the entry is resolved exactly as `list_themes`
        // would, and so a folder that isn't a valid theme is rejected.
        let manifest = parse_theme_folder(&dir)
            .ok_or_else(|| format!("Theme not found or invalid: {id}"))?;

        let entry_path = dir.join(&manifest.entry);
        fs::read_to_string(&entry_path)
            .map_err(|error| format!("Could not read theme CSS for {id}: {error}"))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_id_rejects_traversal_and_separators() {
        assert!(is_safe_theme_id("midnight-neon"));
        assert!(is_safe_theme_id("my_theme_1"));
        assert!(!is_safe_theme_id(""));
        assert!(!is_safe_theme_id("."));
        assert!(!is_safe_theme_id(".."));
        assert!(!is_safe_theme_id("../secrets"));
        assert!(!is_safe_theme_id("a/b"));
        assert!(!is_safe_theme_id("a\\b"));
        assert!(!is_safe_theme_id("a\0b"));
    }

    #[test]
    fn parse_skips_folder_without_manifest() {
        let tmp = std::env::temp_dir().join(format!("amv-theme-test-{}", std::process::id()));
        let theme_dir = tmp.join("no-manifest");
        let _ = fs::create_dir_all(&theme_dir);
        assert!(parse_theme_folder(&theme_dir).is_none());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn parse_reads_valid_theme() {
        let tmp = std::env::temp_dir().join(format!("amv-theme-ok-{}", std::process::id()));
        let theme_dir = tmp.join("cool-theme");
        let _ = fs::create_dir_all(&theme_dir);
        fs::write(
            theme_dir.join("theme.json"),
            r#"{"name":"Cool Theme","entry":"theme.css","author":"me"}"#,
        )
        .unwrap();
        fs::write(theme_dir.join("theme.css"), ":root{}").unwrap();

        let manifest = parse_theme_folder(&theme_dir).expect("should parse");
        assert_eq!(manifest.id, "cool-theme");
        assert_eq!(manifest.name, "Cool Theme");
        assert_eq!(manifest.entry, "theme.css");
        assert_eq!(manifest.author.as_deref(), Some("me"));

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn parse_skips_missing_entry_css() {
        let tmp = std::env::temp_dir().join(format!("amv-theme-noentry-{}", std::process::id()));
        let theme_dir = tmp.join("broken-theme");
        let _ = fs::create_dir_all(&theme_dir);
        fs::write(theme_dir.join("theme.json"), r#"{"name":"Broken"}"#).unwrap();
        // no theme.css written
        assert!(parse_theme_folder(&theme_dir).is_none());
        let _ = fs::remove_dir_all(&tmp);
    }
}
