use std::{
    fs::{self, File},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, Window};

use crate::{log_error, log_info, log_warn};

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BinaryKind {
    Single {
        dest: String,
    },
    Zip {
        extract: Vec<ExtractRule>,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ExtractRule {
    #[serde(rename = "from")]
    pub from_glob: String,
    #[serde(default)]
    pub to: Option<String>,
    #[serde(default)]
    pub to_dir: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ToolBinary {
    pub name: String,
    pub url: String,
    pub sha256: String,
    #[serde(default)]
    #[allow(dead_code)]
    pub size: Option<u64>,
    #[serde(flatten)]
    pub kind: BinaryKind,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ToolsManifest {
    #[allow(dead_code)]
    pub manifest_version: u32,
    pub binaries: Vec<ToolBinary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryStatus {
    pub name: String,
    pub present: bool,
    pub valid: bool,
    pub missing_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolsStatus {
    pub ok: bool,
    pub tools_dir: String,
    pub binaries: Vec<BinaryStatus>,
}

static CANCEL_FLAG: AtomicBool = AtomicBool::new(false);

pub fn tools_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not resolve app local data directory: {error}"))?;
    Ok(base.join("tools"))
}

fn manifest_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(path) = app
        .path()
        .resolve("tools.json", tauri::path::BaseDirectory::Resource)
    {
        candidates.push(path);
    }
    // Dev fallback: when `cargo run` / `tauri dev` is launched from the
    // project root, the bundled-resource resolver may not find tools.json
    // until the next `tauri build`. Allow a sibling-of-exe and a
    // current-dir lookup so dev runs work without staging.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("tools.json"));
            if let Some(grand) = parent.parent() {
                candidates.push(grand.join("tools.json"));
                if let Some(great) = grand.parent() {
                    candidates.push(great.join("tools.json"));
                }
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("tools.json"));
        if let Some(parent) = cwd.parent() {
            candidates.push(parent.join("tools.json"));
        }
    }
    candidates
}

fn load_manifest(app: &AppHandle) -> Result<ToolsManifest, String> {
    let mut tried = Vec::new();
    for candidate in manifest_candidates(app) {
        if candidate.is_file() {
            let raw = fs::read_to_string(&candidate).map_err(|error| {
                format!(
                    "Could not read tools manifest at {}: {error}",
                    candidate.display()
                )
            })?;
            return serde_json::from_str::<ToolsManifest>(&raw)
                .map_err(|error| format!("Could not parse tools manifest: {error}"));
        }
        tried.push(candidate.display().to_string());
    }
    Err(format!(
        "tools.json was not found in any expected location. Tried: {}",
        tried.join(", ")
    ))
}

fn binary_status(dir: &Path, binary: &ToolBinary) -> BinaryStatus {
    let mut missing = Vec::new();
    let mut present_dir_check = true;

    match &binary.kind {
        BinaryKind::Single { dest } => {
            let path = dir.join(dest);
            if !path.is_file() {
                missing.push(dest.clone());
            }
        }
        BinaryKind::Zip { extract } => {
            for rule in extract {
                if let Some(to) = &rule.to {
                    let path = dir.join(to);
                    if !path.is_file() {
                        missing.push(to.clone());
                    }
                } else if let Some(to_dir) = &rule.to_dir {
                    let path = dir.join(to_dir);
                    let has_files = path
                        .read_dir()
                        .ok()
                        .map(|entries| entries.flatten().any(|e| e.path().is_file()))
                        .unwrap_or(false);
                    if !has_files {
                        present_dir_check = false;
                        missing.push(to_dir.clone());
                    }
                }
            }
        }
    }

    let present = missing.is_empty() && present_dir_check;
    BinaryStatus {
        name: binary.name.clone(),
        present,
        valid: present,
        missing_files: missing,
    }
}

#[tauri::command]
pub fn tools_status(app: AppHandle) -> Result<ToolsStatus, String> {
    let manifest = load_manifest(&app)?;
    let dir = tools_dir(&app)?;
    let binaries: Vec<BinaryStatus> = manifest
        .binaries
        .iter()
        .map(|binary| binary_status(&dir, binary))
        .collect();
    let ok = binaries.iter().all(|b| b.present);
    Ok(ToolsStatus {
        ok,
        tools_dir: dir.to_string_lossy().to_string(),
        binaries,
    })
}

fn emit_progress(window: &Window, payload: Value) {
    let _ = window.emit("tools-progress", payload);
}

fn cleanup_partial(path: &Path) {
    if path.exists() {
        let _ = fs::remove_file(path);
    }
}

async fn download_with_progress(
    window: &Window,
    binary_name: &str,
    url: &str,
    dest: &Path,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .user_agent("UltimateAMV-Tools/1.0")
        .build()
        .map_err(|error| format!("Could not build HTTP client: {error}"))?;

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("Could not start download: {error}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Download for {binary_name} failed: HTTP {}",
            response.status()
        ));
    }

    let total = response.content_length();
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create download dir: {error}"))?;
    }

    let mut file = File::create(dest)
        .map_err(|error| format!("Could not create download file {}: {error}", dest.display()))?;
    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_emit = Instant::now();

    emit_progress(
        window,
        json!({
            "type": "download-start",
            "binary": binary_name,
            "totalBytes": total,
        }),
    );

    while let Some(chunk) = stream.next().await {
        if CANCEL_FLAG.load(Ordering::SeqCst) {
            cleanup_partial(dest);
            return Err("Download cancelled by user.".to_string());
        }
        let chunk = chunk.map_err(|error| {
            cleanup_partial(dest);
            format!("Download failed mid-stream: {error}")
        })?;
        file.write_all(&chunk).map_err(|error| {
            cleanup_partial(dest);
            format!("Could not write download chunk: {error}")
        })?;
        downloaded += chunk.len() as u64;

        if last_emit.elapsed().as_millis() >= 100 {
            last_emit = Instant::now();
            emit_progress(
                window,
                json!({
                    "type": "download-progress",
                    "binary": binary_name,
                    "downloadedBytes": downloaded,
                    "totalBytes": total,
                }),
            );
        }
    }

    file.flush().ok();
    drop(file);

    emit_progress(
        window,
        json!({
            "type": "download-progress",
            "binary": binary_name,
            "downloadedBytes": downloaded,
            "totalBytes": total.or(Some(downloaded)),
        }),
    );
    emit_progress(
        window,
        json!({
            "type": "download-complete",
            "binary": binary_name,
            "downloadedBytes": downloaded,
        }),
    );
    Ok(())
}

fn verify_sha256(path: &Path, expected_hex: &str) -> Result<(), String> {
    let mut file = File::open(path)
        .map_err(|error| format!("Could not open file for verification: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65_536];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|error| format!("Could not read file for verification: {error}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let actual = hex::encode(hasher.finalize());
    if !actual.eq_ignore_ascii_case(expected_hex) {
        return Err(format!(
            "SHA256 mismatch: expected {expected_hex}, got {actual}"
        ));
    }
    Ok(())
}

fn install_single(src_path: &Path, dest_dir: &Path, dest_name: &str) -> Result<(), String> {
    let dest = dest_dir.join(dest_name);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create dest dir: {error}"))?;
    }
    fs::rename(src_path, &dest)
        .or_else(|_| fs::copy(src_path, &dest).map(|_| ()))
        .map_err(|error| format!("Could not install {dest_name}: {error}"))?;
    Ok(())
}

fn glob_matches(pattern: &str, candidate: &str) -> bool {
    // Minimal "**/x" style matcher: split on "/", each segment is "**", "*x", or literal.
    // Candidate is a forward-slashed zip entry name. The glob "**/bin/ffmpeg.exe" must
    // match any zip entry whose path ends in /bin/ffmpeg.exe. These win64 ffmpeg zips
    // (gyan's codexffmpeg, and BtbN before it) wrap everything in a top-level versioned
    // dir like ffmpeg-8.1.1-full_build/bin/ffmpeg.exe, and the manifest must not pin to
    // that exact prefix because the prefix changes with every upstream version bump.
    let pattern = pattern.replace('\\', "/");
    let candidate = candidate.replace('\\', "/");
    let p_parts: Vec<&str> = pattern.split('/').collect();
    let c_parts: Vec<&str> = candidate.split('/').collect();
    matches_recursive(&p_parts, &c_parts)
}

fn matches_recursive(pattern: &[&str], candidate: &[&str]) -> bool {
    if pattern.is_empty() {
        return candidate.is_empty();
    }
    let head = pattern[0];
    if head == "**" {
        if pattern.len() == 1 {
            return true;
        }
        for i in 0..=candidate.len() {
            if matches_recursive(&pattern[1..], &candidate[i..]) {
                return true;
            }
        }
        false
    } else {
        if candidate.is_empty() {
            return false;
        }
        if !segment_matches(head, candidate[0]) {
            return false;
        }
        matches_recursive(&pattern[1..], &candidate[1..])
    }
}

fn segment_matches(pattern: &str, candidate: &str) -> bool {
    if !pattern.contains('*') {
        return pattern == candidate;
    }
    let parts: Vec<&str> = pattern.split('*').collect();
    let mut pos = 0usize;
    let mut first = true;
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() {
            first = false;
            continue;
        }
        if first {
            if !candidate[pos..].starts_with(part) {
                return false;
            }
            pos += part.len();
            first = false;
        } else if i == parts.len() - 1 {
            if !candidate.ends_with(part) {
                return false;
            }
            if candidate.len() < pos + part.len() {
                return false;
            }
        } else {
            match candidate[pos..].find(part) {
                Some(idx) => pos += idx + part.len(),
                None => return false,
            }
        }
    }
    true
}

fn extract_zip(
    zip_path: &Path,
    dest_dir: &Path,
    rules: &[ExtractRule],
) -> Result<(), String> {
    let file = File::open(zip_path)
        .map_err(|error| format!("Could not open downloaded zip: {error}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| format!("Could not read zip archive: {error}"))?;

    let names: Vec<String> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
        .collect();

    for rule in rules {
        let mut matched = false;
        for name in &names {
            if !glob_matches(&rule.from_glob, name) {
                continue;
            }
            let mut entry = archive
                .by_name(name)
                .map_err(|error| format!("Could not open zip entry {name}: {error}"))?;
            if entry.is_dir() {
                continue;
            }
            let leaf = Path::new(name)
                .file_name()
                .and_then(|s| s.to_str())
                .ok_or_else(|| format!("Zip entry {name} has no file name"))?
                .to_string();

            let dest = if let Some(to) = &rule.to {
                dest_dir.join(to)
            } else if let Some(to_dir) = &rule.to_dir {
                dest_dir.join(to_dir).join(&leaf)
            } else {
                return Err(format!(
                    "Extract rule for {} must set either 'to' or 'to_dir'",
                    rule.from_glob
                ));
            };

            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("Could not create dir {}: {error}", parent.display()))?;
            }

            let mut out = File::create(&dest)
                .map_err(|error| format!("Could not create {}: {error}", dest.display()))?;
            io::copy(&mut entry, &mut out)
                .map_err(|error| format!("Could not extract {}: {error}", dest.display()))?;
            matched = true;

            if rule.to.is_some() {
                break;
            }
        }
        if !matched {
            return Err(format!(
                "Zip extract pattern '{}' matched no entries",
                rule.from_glob
            ));
        }
    }
    Ok(())
}

fn install_binary(
    binary: &ToolBinary,
    download_path: &Path,
    dest_dir: &Path,
) -> Result<(), String> {
    fs::create_dir_all(dest_dir)
        .map_err(|error| format!("Could not create tools dir: {error}"))?;
    match &binary.kind {
        BinaryKind::Single { dest } => install_single(download_path, dest_dir, dest),
        BinaryKind::Zip { extract } => {
            extract_zip(download_path, dest_dir, extract)?;
            let _ = fs::remove_file(download_path);
            Ok(())
        }
    }
}

#[tauri::command]
pub async fn tools_install(app: AppHandle, window: Window) -> Result<(), String> {
    CANCEL_FLAG.store(false, Ordering::SeqCst);

    let manifest = load_manifest(&app)?;
    let dir = tools_dir(&app)?;
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Could not create tools dir: {error}"))?;

    log_info(
        "tools.install.start",
        "Starting tools install",
        json!({
            "tools_dir": dir.display().to_string(),
            "binary_count": manifest.binaries.len(),
        }),
    );

    emit_progress(
        &window,
        json!({
            "type": "install-start",
            "binaries": manifest.binaries.iter().map(|b| &b.name).collect::<Vec<_>>(),
        }),
    );

    let download_root = dir.join("_downloads");
    fs::create_dir_all(&download_root)
        .map_err(|error| format!("Could not create download cache: {error}"))?;

    for binary in &manifest.binaries {
        let status = binary_status(&dir, binary);
        if status.present {
            log_info(
                "tools.install.skip",
                "Binary already present, skipping",
                json!({ "binary": binary.name }),
            );
            emit_progress(
                &window,
                json!({
                    "type": "binary-skip",
                    "binary": binary.name,
                }),
            );
            continue;
        }

        emit_progress(
            &window,
            json!({
                "type": "binary-start",
                "binary": binary.name,
            }),
        );

        let suffix = match &binary.kind {
            BinaryKind::Single { dest } => dest.clone(),
            BinaryKind::Zip { .. } => format!("{}.zip", binary.name),
        };
        let download_path = download_root.join(format!(
            "{}-{}",
            binary.name,
            Path::new(&suffix)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("download")
        ));

        download_with_progress(&window, &binary.name, &binary.url, &download_path).await?;

        emit_progress(
            &window,
            json!({
                "type": "verify-start",
                "binary": binary.name,
            }),
        );
        if let Err(error) = verify_sha256(&download_path, &binary.sha256) {
            cleanup_partial(&download_path);
            log_error(
                "tools.install.verify_error",
                "SHA256 mismatch on downloaded tool",
                json!({ "binary": binary.name, "error": error.clone() }),
            );
            return Err(format!("{}: {}", binary.name, error));
        }

        emit_progress(
            &window,
            json!({
                "type": "install-step",
                "binary": binary.name,
            }),
        );
        if let Err(error) = install_binary(binary, &download_path, &dir) {
            log_error(
                "tools.install.error",
                "Could not install tool binary",
                json!({ "binary": binary.name, "error": error.clone() }),
            );
            return Err(format!("{}: {}", binary.name, error));
        }

        let new_status = binary_status(&dir, binary);
        if !new_status.present {
            log_error(
                "tools.install.missing_after_install",
                "Binary still missing after install",
                json!({ "binary": binary.name, "missing": new_status.missing_files }),
            );
            return Err(format!(
                "{}: install completed but expected files are still missing ({:?})",
                binary.name, new_status.missing_files
            ));
        }

        emit_progress(
            &window,
            json!({
                "type": "binary-done",
                "binary": binary.name,
            }),
        );
    }

    let _ = fs::remove_dir_all(&download_root);

    log_info(
        "tools.install.complete",
        "Tools install completed",
        json!({ "tools_dir": dir.display().to_string() }),
    );
    emit_progress(
        &window,
        json!({
            "type": "install-complete",
        }),
    );
    Ok(())
}

#[tauri::command]
pub fn tools_cancel() {
    log_warn(
        "tools.install.cancel",
        "Tools install cancelled by user",
        Value::Null,
    );
    CANCEL_FLAG.store(true, Ordering::SeqCst);
}

pub fn ensure_writable_tools_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = tools_dir(app)?;
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Could not create tools dir: {error}"))?;
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_matches_ffmpeg_zip_layout() {
        // These win64 ffmpeg zips wrap everything in a top-level versioned dir
        // (gyan: ffmpeg-8.1.1-full_build/bin/…; BtbN before it: ffmpeg-N-…/bin/…).
        // The "**/bin/ffmpeg.exe" glob must match that without us having to pin the
        // prefix in tools.json, which changes with every upstream version bump.
        assert!(glob_matches(
            "**/bin/ffmpeg.exe",
            "ffmpeg-8.1.1-full_build/bin/ffmpeg.exe"
        ));
        assert!(glob_matches(
            "**/bin/ffprobe.exe",
            "ffmpeg-8.1.1-full_build/bin/ffprobe.exe"
        ));
        assert!(glob_matches(
            "**/bin/*.dll",
            "ffmpeg-8.1.1-full_build-shared/bin/avcodec-62.dll"
        ));
        // Legacy BtbN layout must still match too (matcher is host-agnostic).
        assert!(glob_matches(
            "**/bin/ffmpeg.exe",
            "ffmpeg-N-124464-gb2867481d9-win64-gpl/bin/ffmpeg.exe"
        ));
        assert!(!glob_matches(
            "**/bin/ffmpeg.exe",
            "ffmpeg-8.1.1-full_build-shared/bin/ffprobe.exe"
        ));
        assert!(!glob_matches(
            "**/bin/*.dll",
            "ffmpeg-8.1.1-full_build-shared/share/man/man1/ffmpeg.1.txt"
        ));
    }
}

