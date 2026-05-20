/// Integration tests for the small pure helpers in `src-tauri/src/lib.rs`:
/// - `dir_file_stats`
/// - `sanitize_path_segment`
/// - `short_stable_id`
///
/// All three are private functions.  They are mirrored verbatim below — keep
/// each mirror in sync with the original when the source changes.
/// Mirror sources:
///   dir_file_stats      → lib.rs ~1224
///   sanitize_path_segment → lib.rs ~2477
///   short_stable_id     → lib.rs ~2464

use std::fs;
use std::path::Path;
use tempfile::TempDir;

// ── MIRROR: lib.rs::dir_file_stats ───────────────────────────────────────────
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

// ── MIRROR: lib.rs::short_stable_id ──────────────────────────────────────────
fn short_stable_id(parts: &[&str]) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for part in parts {
        for byte in part.as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
        hash ^= 0xff;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")[..10].to_string()
}

// ── MIRROR: lib.rs::sanitize_path_segment ────────────────────────────────────
fn sanitize_path_segment(value: &str, fallback: &str, max_len: usize) -> String {
    let mut sanitized = String::with_capacity(value.len());
    let mut last_was_space = false;
    for character in value.trim().chars() {
        let replacement = match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => ' ',
            character if character.is_control() => ' ',
            character => character,
        };

        if replacement.is_whitespace() {
            if !last_was_space {
                sanitized.push(' ');
                last_was_space = true;
            }
        } else {
            sanitized.push(replacement);
            last_was_space = false;
        }
    }

    let mut sanitized = sanitized.trim_matches([' ', '.']).to_string();
    if sanitized.is_empty() {
        sanitized = fallback.to_string();
    }
    if sanitized.len() > max_len {
        sanitized.truncate(max_len);
        sanitized = sanitized.trim_matches([' ', '.']).to_string();
    }
    if sanitized.is_empty() {
        fallback.to_string()
    } else {
        sanitized
    }
}

// ── dir_file_stats tests ──────────────────────────────────────────────────────

/// Empty dir returns (0, 0).
#[test]
fn dir_file_stats_empty_dir() {
    let tmp = TempDir::new().unwrap();
    let (files, bytes) = dir_file_stats(tmp.path());
    assert_eq!(files, 0);
    assert_eq!(bytes, 0);
}

/// Single file returns (1, file_len).
#[test]
fn dir_file_stats_single_file() {
    let tmp = TempDir::new().unwrap();
    let content = b"ultimate-amv-test-payload";
    fs::write(tmp.path().join("clip.mp4"), content).unwrap();
    let (files, bytes) = dir_file_stats(tmp.path());
    assert_eq!(files, 1);
    assert_eq!(bytes, content.len() as u64);
}

/// Multiple flat files — counts all of them.
#[test]
fn dir_file_stats_multiple_flat_files() {
    let tmp = TempDir::new().unwrap();
    fs::write(tmp.path().join("a.dat"), b"111").unwrap();
    fs::write(tmp.path().join("b.dat"), b"2222").unwrap();
    fs::write(tmp.path().join("c.dat"), b"55555").unwrap();
    let (files, bytes) = dir_file_stats(tmp.path());
    assert_eq!(files, 3);
    assert_eq!(bytes, 12); // 3 + 4 + 5
}

/// Nested subdirectories are recursed into — all files counted.
#[test]
fn dir_file_stats_recurses_nested_subdirs() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();

    // depth-1
    let d1 = root.join("level1");
    fs::create_dir_all(&d1).unwrap();
    fs::write(d1.join("x.dat"), b"XX").unwrap(); // 2 bytes

    // depth-2
    let d2 = d1.join("level2");
    fs::create_dir_all(&d2).unwrap();
    fs::write(d2.join("y.dat"), b"YYY").unwrap(); // 3 bytes

    // file at root level
    fs::write(root.join("z.dat"), b"Z").unwrap(); // 1 byte

    let (files, bytes) = dir_file_stats(root);
    assert_eq!(files, 3);
    assert_eq!(bytes, 6);
}

/// An empty subdirectory does not contribute any files or bytes.
#[test]
fn dir_file_stats_empty_subdir_contributes_nothing() {
    let tmp = TempDir::new().unwrap();
    fs::create_dir_all(tmp.path().join("empty_sub")).unwrap();
    fs::write(tmp.path().join("real_file.dat"), b"abc").unwrap();
    let (files, bytes) = dir_file_stats(tmp.path());
    assert_eq!(files, 1);
    assert_eq!(bytes, 3);
}

// ── short_stable_id tests ─────────────────────────────────────────────────────

/// Same input produces the same output (stability).
#[test]
fn short_stable_id_is_stable() {
    let a = short_stable_id(&["https://example.com/video.mp4", "1080p", "episode01"]);
    let b = short_stable_id(&["https://example.com/video.mp4", "1080p", "episode01"]);
    assert_eq!(a, b);
}

/// Different inputs produce different outputs for representative samples.
#[test]
fn short_stable_id_is_distinct_for_different_inputs() {
    let a = short_stable_id(&["input_a"]);
    let b = short_stable_id(&["input_b"]);
    let c = short_stable_id(&["input_a", "extra_part"]);
    assert_ne!(a, b, "distinct single-part inputs must differ");
    assert_ne!(a, c, "adding a part must change the id");
    assert_ne!(b, c);
}

/// Output length is exactly 10 characters (as documented by `[..10]`).
#[test]
fn short_stable_id_output_length_is_ten() {
    let id = short_stable_id(&["any", "input", "here"]);
    assert_eq!(id.len(), 10, "short_stable_id must produce exactly 10 chars");
}

/// Output charset is lowercase hex (0-9, a-f).
#[test]
fn short_stable_id_output_is_lowercase_hex() {
    for input in &[
        vec!["simple"],
        vec!["with spaces and punctuation!"],
        vec!["emoji: \u{1f600}"],
        vec!["part1", "part2", "part3"],
    ] {
        let id = short_stable_id(input);
        assert!(
            id.chars().all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()),
            "id '{}' for input {:?} must be lowercase hex",
            id,
            input
        );
    }
}

/// Empty input slice produces a stable value (no panic).
#[test]
fn short_stable_id_empty_parts_does_not_panic() {
    let id = short_stable_id(&[]);
    assert_eq!(id.len(), 10);
}

/// Empty string parts are handled without panic.
#[test]
fn short_stable_id_empty_string_parts() {
    let a = short_stable_id(&[""]);
    let b = short_stable_id(&["", ""]);
    assert_eq!(a.len(), 10);
    assert_eq!(b.len(), 10);
    // Empty string part and empty-slice produce different hashes because the
    // separator mixing (`hash ^= 0xff; hash = hash.wrapping_mul(...)`) fires
    // once per part regardless of part content.
    let empty_slice = short_stable_id(&[]);
    assert_ne!(a, empty_slice, "one empty-string part should differ from empty slice");
}

// ── sanitize_path_segment tests ───────────────────────────────────────────────

/// Normal ASCII filenames pass through unchanged.
#[test]
fn sanitize_path_segment_normal_filename() {
    assert_eq!(
        sanitize_path_segment("episode_01_720p", "fallback", 96),
        "episode_01_720p"
    );
}

/// Forward slash is replaced with a space (and de-duped).
#[test]
fn sanitize_path_segment_strips_forward_slash() {
    // "a/b" → "a b"
    let result = sanitize_path_segment("a/b", "fb", 96);
    assert!(!result.contains('/'), "forward slash must be stripped");
    assert_eq!(result, "a b");
}

/// Backslash (path separator on Windows) is replaced with a space.
#[test]
fn sanitize_path_segment_strips_backslash() {
    let result = sanitize_path_segment("folder\\file", "fb", 96);
    assert!(!result.contains('\\'), "backslash must be stripped");
    assert_eq!(result, "folder file");
}

/// `..` traversal sequences are neutralised — the dots get treated as content
/// characters.  Dots at the *edges* after trimming are removed.
#[test]
fn sanitize_path_segment_strips_dotdot_at_edges() {
    // "..secret" → after trim_matches(' ', '.') → "secret"
    let result = sanitize_path_segment("..secret", "fb", 96);
    assert!(!result.starts_with(".."), "leading dotdot must be stripped");
}

/// Null bytes (control characters) are replaced with a space.
#[test]
fn sanitize_path_segment_strips_null_bytes() {
    let with_null = "abc\0def";
    let result = sanitize_path_segment(with_null, "fb", 96);
    assert!(!result.contains('\0'), "null byte must be stripped");
    assert_eq!(result, "abc def");
}

/// Other control characters (tab, newline) are also replaced.
#[test]
fn sanitize_path_segment_strips_control_chars() {
    let result = sanitize_path_segment("abc\ndef", "fb", 96);
    assert!(!result.contains('\n'));
    assert_eq!(result, "abc def");
}

/// All-invalid input falls back to the fallback string.
#[test]
fn sanitize_path_segment_all_invalid_uses_fallback() {
    // Only slashes and colons — all get replaced by spaces, then trimmed to empty.
    let result = sanitize_path_segment("///", "my_fallback", 96);
    assert_eq!(result, "my_fallback");
}

/// Empty input uses the fallback.
#[test]
fn sanitize_path_segment_empty_input_uses_fallback() {
    let result = sanitize_path_segment("", "default_fallback", 96);
    assert_eq!(result, "default_fallback");
}

/// Whitespace-only input uses the fallback.
#[test]
fn sanitize_path_segment_whitespace_only_uses_fallback() {
    let result = sanitize_path_segment("   ", "fallback_ws", 96);
    assert_eq!(result, "fallback_ws");
}

/// Long input is truncated to `max_len` and trailing spaces / dots are removed
/// after truncation.
#[test]
fn sanitize_path_segment_truncates_to_max_len() {
    let long = "a".repeat(200);
    let result = sanitize_path_segment(&long, "fb", 50);
    assert!(
        result.len() <= 50,
        "result length {} exceeds max_len 50",
        result.len()
    );
}

/// Consecutive invalid characters collapse to a single space (no double-spaces).
#[test]
fn sanitize_path_segment_collapses_consecutive_invalid_chars() {
    // "a///b" should become "a b", not "a   b".
    let result = sanitize_path_segment("a///b", "fb", 96);
    assert_eq!(result, "a b");
}

/// Windows-reserved characters (`<`, `>`, `:`, `"`, `|`, `?`, `*`) are all
/// replaced.
#[test]
fn sanitize_path_segment_strips_windows_reserved_chars() {
    let reserved = r#"a<b>c:d"e|f?g*h"#;
    let result = sanitize_path_segment(reserved, "fb", 96);
    for ch in &['<', '>', ':', '"', '|', '?', '*'] {
        assert!(
            !result.contains(*ch),
            "reserved char '{}' should have been stripped, got '{}'",
            ch,
            result
        );
    }
}
