# Issues Status & Resolution Summary

This document tracks the initial batch of issues reported for the Ultimate AMV Script app, the root causes identified, and their current resolution status.

## 1. Intra-frame Converter (.mov) Incompatibility
*   **Issue:** The app's intra-frame converter produces ProRes `.mov` files, but the clip finder rejects them.
*   **Conclusion:** The backend (`clip_cli.py`) is hardcoded to require NVDEC hardware decoding. However, NVIDIA's NVDEC chip does not natively support ProRes. ProRes must be decoded via CPU or general GPU compute.
*   **Status:** ❌ **Not Fixed Yet**. Requires updating the backend to allow ProRes codecs and gracefully fall back to CPU decoding for those specific files.

## 2. Slow Clip Loading
*   **Issue:** The clip finder takes 3-4 seconds per clip to load thumbnails in the UI, causing massive delays.
*   **Conclusion:** The frontend has a hardcoded concurrency limit (`CLIP_PREVIEW_CONCURRENCY = 2`) and spawns a completely new FFmpeg process for every single thumbnail. Process spawning has significant overhead.
*   **Status:** ❌ **Not Fixed Yet**. Needs optimization by either batching FFmpeg requests, implementing process reuse, or increasing the concurrency limit.

## 3. Export & Merge Functionality
*   **Issue:** No proper export/merge system. Users need to select output format, location, and specific clips (via a UI button) to export sequentially.
*   **Conclusion:** The UI only had placeholder buttons, and the backend lacked the Tauri/FFmpeg commands to execute the exports.
*   **Status:** 
    *   ✅ **Partially Fixed (Export):** Implemented a complete export workflow. Added a persistent, dark-themed selection toggle to the top-right of every clip tile. Created an export dropdown for formats (Lossless, GPU Intra, ProRes LT/HQ). Wired the backend to export clips with frame-accurate precision using output seeking and a 35ms micro-offset to prevent bleeding frames from adjacent clips. Changed the default format to GPU Intra for accuracy.
    *   ❌ **Not Fixed Yet (Merge):** The ability to merge the selected clips into a single continuous file is still pending.

## 4. No Cancel Button for Downloads
*   **Issue:** Downloading an episode cannot be canceled by the user.
*   **Conclusion:** The `yt-dlp` child process is spawned without tracking its Process ID (PID). Without the PID, Tauri cannot send a kill signal to stop the download.
*   **Status:** ❌ **Not Fixed Yet**. Requires tracking the download PID in Tauri state and wiring a new "Cancel" UI button to a process-kill command.

## 5. Lack of High-Quality Clip Workflow
*   **Issue:** The app lacks a proper workflow for extracting HQ clips because it rejects its own intraframe `.mov` format.
*   **Conclusion:** This is a direct symptom of Issue #1. 
*   **Status:** ❌ **Not Fixed Yet**. Will be resolved once Issue #1 is fixed (adding ProRes CPU fallback).

## 6. Default Website & AniWave (Alt)
*   **Issue:** The default website should be `anikai.to`, and the broken `AniWave (Alt)` option should be removed.
*   **Conclusion:** The provider URL state and UI dropdown needed updating to match the requested defaults.
*   **Status:** ✅ **Fixed**. `anikai.to` is now the default provider on load, the alt option has been removed, and the dropdown styling was fixed to match the app's dark theme (removing the white background).

## 7. PyTorch Compatibility (Question)
*   **Issue:** Does the app automatically handle RTX 20/30/40 series cards, or do they require different PyTorch versions?
*   **Conclusion:** ✅ **Answered**. The bundled CUDA 12.8 (`cu128`) PyTorch automatically supports Turing (RTX 20), Ampere (RTX 30), and Ada Lovelace (RTX 40) architectures natively. No separate versions or configurations are required.