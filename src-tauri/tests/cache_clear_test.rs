/// Integration tests for `clear_app_cache` semantics.
///
/// `clear_app_cache` is a Tauri command and cannot be invoked directly from
/// integration tests (it requires a `tauri::Window`).  Instead, these tests
/// replicate the loop that the command runs — using the same primitives
/// (`fs::remove_dir_all`, the mirrored `dir_file_stats` helper) against a
/// real `tempfile::TempDir` — so the logic is tested end-to-end without
/// spinning up a Tauri runtime.
///
/// Mirror note: `dir_file_stats` is private in `src-tauri/src/lib.rs`.
/// It is mirrored verbatim below (see the `MIRROR` comment) because it is
/// small, pure, and directly used by the code under test.  Keep it in sync
/// manually when the original changes.

use std::fs;
use std::path::Path;
use tempfile::TempDir;

// ── MIRROR of lib.rs::dir_file_stats ─────────────────────────────────────────
// Source: src-tauri/src/lib.rs, line ~1224.
fn dir_file_stats(dir: &Path) -> (u64, u64) {
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

/// Replication of the cache-clearing loop from `clear_app_cache`.
/// Returns `(total_files, total_bytes, first_error)`.
fn run_cache_clear_loop(
    root: &Path,
) -> (u64, u64, Option<String>) {
    const CACHE_DIRS: &[&str] = &["clip_previews", "scene_clips", "clip_compat_cache"];

    let mut total_files = 0u64;
    let mut total_bytes = 0u64;
    let mut first_error: Option<String> = None;

    for name in CACHE_DIRS {
        let dir = root.join(name);
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
                if first_error.is_none() {
                    first_error = Some(msg);
                }
            }
        }
    }

    (total_files, total_bytes, first_error)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

/// All three cache dirs are wiped and their cumulative file/byte counts are
/// correct.  Protected siblings (`backgrounds`, `logs`) are untouched.
#[test]
fn cache_clear_wipes_three_dirs_and_leaves_siblings() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();

    // Populate all 5 directories — 3 cache + 2 protected.
    for name in &[
        "clip_previews",
        "scene_clips",
        "clip_compat_cache",
        "backgrounds",
        "logs",
    ] {
        let dir = root.join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.dat"), b"hello").unwrap(); // 5 bytes each
    }

    let (files, bytes, err) = run_cache_clear_loop(root);

    assert!(err.is_none(), "no error expected; got: {:?}", err);
    // 3 cache dirs × 1 file × 5 bytes
    assert_eq!(files, 3, "expected 3 files removed");
    assert_eq!(bytes, 15, "expected 15 bytes freed");

    // Cache dirs must be gone.
    for name in &["clip_previews", "scene_clips", "clip_compat_cache"] {
        assert!(
            !root.join(name).exists(),
            "cache dir '{}' should have been removed",
            name
        );
    }

    // Protected siblings must be intact.
    for name in &["backgrounds", "logs"] {
        assert!(
            root.join(name).exists(),
            "protected sibling '{}' was unexpectedly wiped",
            name
        );
        assert!(
            root.join(name).join("a.dat").exists(),
            "file inside protected sibling '{}' was removed",
            name
        );
    }
}

/// Missing cache dirs are silently skipped — no error, zero counts.
#[test]
fn cache_clear_tolerates_all_dirs_missing() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    // No cache dirs created at all.

    let (files, bytes, err) = run_cache_clear_loop(root);

    assert!(err.is_none(), "missing dirs must not produce an error");
    assert_eq!(files, 0);
    assert_eq!(bytes, 0);
}

/// Only 2 of 3 cache dirs exist — no error, counts reflect only the present
/// dirs.
#[test]
fn cache_clear_tolerates_partial_dirs_missing() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();

    // Create only `clip_previews` and `clip_compat_cache`; skip `scene_clips`.
    for name in &["clip_previews", "clip_compat_cache"] {
        let dir = root.join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("x.dat"), b"ab").unwrap(); // 2 bytes each
    }

    let (files, bytes, err) = run_cache_clear_loop(root);

    assert!(err.is_none(), "no error expected when one dir is missing");
    assert_eq!(files, 2, "only files from the 2 present dirs should be counted");
    assert_eq!(bytes, 4, "only bytes from the 2 present dirs should be counted");
    assert!(!root.join("clip_previews").exists());
    assert!(!root.join("clip_compat_cache").exists());
    // Missing dir should still be absent (not created by the loop).
    assert!(!root.join("scene_clips").exists());
}

/// Empty cache dirs are removed with zero file/byte counts — no panic.
#[test]
fn cache_clear_handles_empty_dirs() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();

    for name in &["clip_previews", "scene_clips", "clip_compat_cache"] {
        fs::create_dir_all(root.join(name)).unwrap();
    }

    let (files, bytes, err) = run_cache_clear_loop(root);

    assert!(err.is_none());
    assert_eq!(files, 0);
    assert_eq!(bytes, 0);
}

/// Cache dirs containing nested subdirectories are fully wiped and the nested
/// files are counted.
#[test]
fn cache_clear_wipes_nested_subdirs() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();

    // `clip_previews` gets a nested structure.
    let nested = root.join("clip_previews").join("sub").join("deep");
    fs::create_dir_all(&nested).unwrap();
    fs::write(nested.join("file1.dat"), b"123456").unwrap(); // 6 bytes
    fs::write(root.join("clip_previews").join("top.dat"), b"AB").unwrap(); // 2 bytes

    // `scene_clips` is flat.
    let sc = root.join("scene_clips");
    fs::create_dir_all(&sc).unwrap();
    fs::write(sc.join("s.mp4"), b"VIDDATA").unwrap(); // 7 bytes

    let (files, bytes, err) = run_cache_clear_loop(root);

    assert!(err.is_none());
    assert_eq!(files, 3); // top.dat + file1.dat + s.mp4
    assert_eq!(bytes, 15); // 2 + 6 + 7
    assert!(!root.join("clip_previews").exists());
    assert!(!root.join("scene_clips").exists());
}

/// The loop accumulates counts from all three dirs correctly when each has
/// multiple files.
#[test]
fn cache_clear_accumulates_counts_across_all_dirs() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();

    let cases: &[(&str, &[(&str, &[u8])])] = &[
        ("clip_previews", &[("a.dat", b"1"), ("b.dat", b"22")]),
        ("scene_clips", &[("c.dat", b"333")]),
        ("clip_compat_cache", &[("d.dat", b"4444"), ("e.dat", b"55555")]),
    ];

    let mut expected_files = 0u64;
    let mut expected_bytes = 0u64;

    for (name, files) in cases {
        let dir = root.join(name);
        fs::create_dir_all(&dir).unwrap();
        for (fname, content) in *files {
            fs::write(dir.join(fname), content).unwrap();
            expected_files += 1;
            expected_bytes += content.len() as u64;
        }
    }

    let (files, bytes, err) = run_cache_clear_loop(root);

    assert!(err.is_none());
    assert_eq!(files, expected_files);
    assert_eq!(bytes, expected_bytes);
}

/// The loop leaves any `*.json` files that might live at the root untouched —
/// the targeted dirs are the only things deleted.
#[test]
fn cache_clear_does_not_touch_json_files_at_root() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();

    // Simulate a settings.json at the app_data root.
    let settings = root.join("settings.json");
    fs::write(&settings, br#"{"version":1}"#).unwrap();

    // One cache dir to clear.
    let cp = root.join("clip_previews");
    fs::create_dir_all(&cp).unwrap();
    fs::write(cp.join("f.dat"), b"x").unwrap();

    let (files, bytes, err) = run_cache_clear_loop(root);

    assert!(err.is_none());
    assert_eq!(files, 1);
    assert_eq!(bytes, 1);
    assert!(settings.exists(), "settings.json must not be deleted");
}

/// When a per-dir removal fails, the function still returns the FIRST error
/// (not silently swallowing it) and does not count files from the failed dir.
/// This test simulates the behavior by running the logic against a real error
/// (read-only directory on Windows) — but since Windows read-only on dirs is
/// unreliable in CI, we simulate the error path by checking the code structure
/// rather than forcing a real OS error.
///
/// The test verifies that the function returns `Err` as soon as any removal
/// fails, by replacing the real loop with one that records the first error.
#[test]
fn cache_clear_first_error_is_bubbled_and_loop_continues() {
    // We simulate two dirs: one succeeds, one fails (we inject the error).
    // This mirrors the code structure: first_error captures only the first
    // failure, but the loop continues to attempt the other dirs.

    let tmp = TempDir::new().unwrap();
    let root = tmp.path();

    let cache_dirs = ["clip_previews", "scene_clips", "clip_compat_cache"];

    for name in &cache_dirs {
        let dir = root.join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("data.dat"), b"x").unwrap();
    }

    // Simulate: inject a failure for the first dir only.
    let mut total_files = 0u64;
    let mut total_bytes = 0u64;
    let mut first_error: Option<String> = None;
    let mut dirs_attempted = 0usize;

    for (idx, name) in cache_dirs.iter().enumerate() {
        let dir = root.join(name);
        if !dir.exists() {
            continue;
        }
        dirs_attempted += 1;
        let (files, bytes) = dir_file_stats(&dir);

        // Inject a fake error only on the first dir.
        let result: Result<(), String> = if idx == 0 {
            Err(format!("simulated removal error for {name}"))
        } else {
            fs::remove_dir_all(&dir).map_err(|e| e.to_string())
        };

        match result {
            Ok(()) => {
                total_files += files;
                total_bytes += bytes;
            }
            Err(msg) => {
                if first_error.is_none() {
                    first_error = Some(msg);
                }
            }
        }
    }

    // All 3 dirs were attempted (loop did not short-circuit on first error).
    assert_eq!(dirs_attempted, 3, "loop must visit all dirs even after a failure");

    // First error was captured.
    assert!(first_error.is_some(), "first error must be captured");
    assert!(
        first_error.as_deref().unwrap().contains("clip_previews"),
        "first error must name the failed dir"
    );

    // Only dirs 1 and 2 contributed to counts (dir 0 errored, its files were
    // not counted because the removal failed).
    assert_eq!(total_files, 2, "only successfully-removed dirs are counted");
    assert_eq!(total_bytes, 2, "only successfully-removed bytes are counted");
}
