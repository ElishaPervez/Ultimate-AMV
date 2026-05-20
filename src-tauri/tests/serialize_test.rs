/// Serialization shape tests.
///
/// All structs in `src-tauri/src/lib.rs` that are serialized for the Tauri
/// frontend are private.  This file defines LOCAL MIRRORS of those structs and
/// verifies that their serialized JSON field names match what the frontend
/// expects.  Mirrors must be kept in sync with the originals when the source
/// changes.
///
/// Mirrored structs (with their source locations):
///   ClearCacheReport      → lib.rs ~1218  (no rename_all → snake_case fields)
///   ClipPreviewDone       → lib.rs ~100   (rename_all = "camelCase")
///   ClipPreviewBatchItem  → lib.rs ~127   (rename_all = "camelCase")
///   VideoGpuStatus        → lib.rs ~84    (rename_all = "camelCase")
///   DownloadProgress      → lib.rs ~53    (rename_all = "camelCase")

use serde::Serialize;
use serde_json::Value;

// ── MIRROR: ClearCacheReport ──────────────────────────────────────────────────
// Source: lib.rs ~1218.  No `rename_all` attribute → fields are serialized in
// snake_case (Rust's native field names are the JSON keys).
#[derive(Serialize)]
struct ClearCacheReport {
    files_removed: u64,
    bytes_freed: u64,
}

// ── MIRROR: ClipPreviewDone ───────────────────────────────────────────────────
// Source: lib.rs ~100.  `rename_all = "camelCase"`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClipPreviewDone {
    r#type: String,
    scene_id: String,
    path: String,
    duration: f64,
    cached: bool,
}

// ── MIRROR: ClipPreviewBatchItem ──────────────────────────────────────────────
// Source: lib.rs ~127.  `rename_all = "camelCase"`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClipPreviewBatchItem {
    scene_id: String,
    path: Option<String>,
    duration: f64,
    cached: bool,
    error: Option<String>,
}

// ── MIRROR: VideoGpuStatus ────────────────────────────────────────────────────
// Source: lib.rs ~84.  `rename_all = "camelCase"`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoGpuStatus {
    compatible: bool,
    gpu_name: Option<String>,
    has_nvidia_gpu: bool,
    has_ffmpeg: bool,
    has_ffprobe: bool,
    has_h264_cuvid: bool,
    has_hevc_cuvid: bool,
    has_hevc_nvenc: bool,
    has_h264_nvenc: bool,
    has_av1_nvenc: bool,
    message: String,
}

// ── MIRROR: DownloadProgress ──────────────────────────────────────────────────
// Source: lib.rs ~53.  `rename_all = "camelCase"`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    job_id: Option<String>,
    stage: String,
    percent: Option<f32>,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    warning: Option<String>,
}

// ── ClearCacheReport tests ────────────────────────────────────────────────────

/// `ClearCacheReport` must serialize with snake_case field names — the source
/// struct has NO `rename_all` attribute, so Rust's field names become JSON keys.
#[test]
fn clear_cache_report_serializes_with_snake_case_keys() {
    let report = ClearCacheReport {
        files_removed: 42,
        bytes_freed: 1_048_576,
    };
    let v: Value = serde_json::to_value(&report).unwrap();
    let obj = v.as_object().expect("must be a JSON object");

    assert!(
        obj.contains_key("files_removed"),
        "expected 'files_removed' key; got keys: {:?}",
        obj.keys().collect::<Vec<_>>()
    );
    assert!(
        obj.contains_key("bytes_freed"),
        "expected 'bytes_freed' key; got keys: {:?}",
        obj.keys().collect::<Vec<_>>()
    );
    // Verify no camelCase variants leaked.
    assert!(
        !obj.contains_key("filesRemoved"),
        "'filesRemoved' (camelCase) must not exist — no rename_all on this struct"
    );
    assert!(
        !obj.contains_key("bytesFreed"),
        "'bytesFreed' (camelCase) must not exist — no rename_all on this struct"
    );
}

/// Field values round-trip correctly through JSON.
#[test]
fn clear_cache_report_field_values_round_trip() {
    let report = ClearCacheReport {
        files_removed: 7,
        bytes_freed: 2048,
    };
    let v: Value = serde_json::to_value(&report).unwrap();
    assert_eq!(v["files_removed"], 7u64);
    assert_eq!(v["bytes_freed"], 2048u64);
}

/// Zero counts serialize correctly (not null, not missing).
#[test]
fn clear_cache_report_zero_values_serialize_as_numbers() {
    let report = ClearCacheReport {
        files_removed: 0,
        bytes_freed: 0,
    };
    let v: Value = serde_json::to_value(&report).unwrap();
    assert_eq!(v["files_removed"], Value::Number(0.into()));
    assert_eq!(v["bytes_freed"], Value::Number(0.into()));
}

// ── ClipPreviewDone tests ─────────────────────────────────────────────────────

/// `ClipPreviewDone` must serialize with camelCase field names.
#[test]
fn clip_preview_done_serializes_with_camel_case_keys() {
    let done = ClipPreviewDone {
        r#type: "clipPreviewDone".to_string(),
        scene_id: "scene-001".to_string(),
        path: "/tmp/clip.mp4".to_string(),
        duration: 3.14,
        cached: false,
    };
    let v: Value = serde_json::to_value(&done).unwrap();
    let obj = v.as_object().unwrap();

    // Renamed fields must be camelCase.
    assert!(obj.contains_key("sceneId"), "expected 'sceneId' (camelCase); keys: {:?}", obj.keys().collect::<Vec<_>>());
    // Fields that are already one word should stay as-is.
    assert!(obj.contains_key("type"));
    assert!(obj.contains_key("path"));
    assert!(obj.contains_key("duration"));
    assert!(obj.contains_key("cached"));

    // snake_case variants must NOT appear.
    assert!(!obj.contains_key("scene_id"), "'scene_id' must be renamed to 'sceneId'");
}

/// `ClipPreviewDone.type` serializes as the string value, not the keyword.
#[test]
fn clip_preview_done_type_field_value_correct() {
    let done = ClipPreviewDone {
        r#type: "clipPreviewDone".to_string(),
        scene_id: "s".to_string(),
        path: "p".to_string(),
        duration: 0.0,
        cached: true,
    };
    let v: Value = serde_json::to_value(&done).unwrap();
    assert_eq!(v["type"], "clipPreviewDone");
    assert_eq!(v["cached"], true);
}

// ── ClipPreviewBatchItem tests ────────────────────────────────────────────────

/// Optional `path` field serializes as `null` when absent.
#[test]
fn clip_preview_batch_item_null_path_serializes_as_null() {
    let item = ClipPreviewBatchItem {
        scene_id: "scene-x".to_string(),
        path: None,
        duration: 2.5,
        cached: false,
        error: None,
    };
    let v: Value = serde_json::to_value(&item).unwrap();
    assert_eq!(v["path"], Value::Null);
    assert_eq!(v["error"], Value::Null);
}

/// Optional `error` field serializes correctly when present.
#[test]
fn clip_preview_batch_item_error_field_when_present() {
    let item = ClipPreviewBatchItem {
        scene_id: "scene-y".to_string(),
        path: None,
        duration: 0.1,
        cached: false,
        error: Some("ffmpeg exited with code 1".to_string()),
    };
    let v: Value = serde_json::to_value(&item).unwrap();
    assert_eq!(v["error"], "ffmpeg exited with code 1");
    // Keys must be camelCase.
    assert!(v.as_object().unwrap().contains_key("sceneId"));
}

// ── VideoGpuStatus tests ──────────────────────────────────────────────────────

/// All boolean fields in `VideoGpuStatus` serialize under their expected
/// camelCase names.
#[test]
fn video_gpu_status_camel_case_fields() {
    let status = VideoGpuStatus {
        compatible: true,
        gpu_name: Some("RTX 3080".to_string()),
        has_nvidia_gpu: true,
        has_ffmpeg: true,
        has_ffprobe: true,
        has_h264_cuvid: true,
        has_hevc_cuvid: false,
        has_hevc_nvenc: false,
        has_h264_nvenc: true,
        has_av1_nvenc: false,
        message: "OK".to_string(),
    };
    let v: Value = serde_json::to_value(&status).unwrap();
    let obj = v.as_object().unwrap();

    let expected_keys = [
        "compatible",
        "gpuName",
        "hasNvidiaGpu",
        "hasFfmpeg",
        "hasFfprobe",
        "hasH264Cuvid",
        "hasHevcCuvid",
        "hasHevcNvenc",
        "hasH264Nvenc",
        "hasAv1Nvenc",
        "message",
    ];
    for key in &expected_keys {
        assert!(
            obj.contains_key(*key),
            "expected key '{}'; present keys: {:?}",
            key,
            obj.keys().collect::<Vec<_>>()
        );
    }
}

/// `gpuName` is `null` when the GPU name is absent.
#[test]
fn video_gpu_status_gpu_name_null_when_none() {
    let status = VideoGpuStatus {
        compatible: false,
        gpu_name: None,
        has_nvidia_gpu: false,
        has_ffmpeg: false,
        has_ffprobe: false,
        has_h264_cuvid: false,
        has_hevc_cuvid: false,
        has_hevc_nvenc: false,
        has_h264_nvenc: false,
        has_av1_nvenc: false,
        message: "No GPU".to_string(),
    };
    let v: Value = serde_json::to_value(&status).unwrap();
    assert_eq!(v["gpuName"], Value::Null);
}

// ── DownloadProgress tests ────────────────────────────────────────────────────

/// `DownloadProgress.warning` is OMITTED from JSON when it is `None`
/// (`#[serde(skip_serializing_if = "Option::is_none")]`).
#[test]
fn download_progress_warning_omitted_when_none() {
    let progress = DownloadProgress {
        job_id: Some("job-123".to_string()),
        stage: "downloading".to_string(),
        percent: Some(50.0),
        message: "50%".to_string(),
        warning: None,
    };
    let v: Value = serde_json::to_value(&progress).unwrap();
    let obj = v.as_object().unwrap();

    assert!(
        !obj.contains_key("warning"),
        "'warning' key must be absent when None (skip_serializing_if)"
    );
}

/// `DownloadProgress.warning` appears in JSON when it is `Some(...)`.
#[test]
fn download_progress_warning_present_when_some() {
    let progress = DownloadProgress {
        job_id: None,
        stage: "extracting".to_string(),
        percent: None,
        message: "extracting audio".to_string(),
        warning: Some("low disk space".to_string()),
    };
    let v: Value = serde_json::to_value(&progress).unwrap();
    assert_eq!(v["warning"], "low disk space");
}

/// `DownloadProgress` camelCase field names are correct.
#[test]
fn download_progress_camel_case_keys() {
    let progress = DownloadProgress {
        job_id: Some("j".to_string()),
        stage: "s".to_string(),
        percent: Some(1.0),
        message: "m".to_string(),
        warning: Some("w".to_string()),
    };
    let v: Value = serde_json::to_value(&progress).unwrap();
    let obj = v.as_object().unwrap();

    assert!(obj.contains_key("jobId"), "expected 'jobId'; keys: {:?}", obj.keys().collect::<Vec<_>>());
    assert!(!obj.contains_key("job_id"), "'job_id' must not appear — should be 'jobId'");
    assert!(obj.contains_key("stage"));
    assert!(obj.contains_key("percent"));
    assert!(obj.contains_key("message"));
    assert!(obj.contains_key("warning"));
}
