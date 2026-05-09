# Known Issues — Ultimate AMV

_Last updated: 2026-05-02_

---

## 1. Default clip extraction mode is GPU even when no GPU detected

**Symptom:** Settings shows "GPU" for Detection Engine even on CPU-only machines.

**Cause:** `DEFAULT_CONFIG["clip_extraction_mode"] = "gpu"` in `backend/amv_audio/config.py`. The SetupWizard sets `setup_type` (audio engine) but never sets `clip_extraction_mode`. The Settings UI also falls back to `"gpu"` via `payload.clip_extraction_mode ?? "gpu"` in `main.tsx:1410` and `main.tsx:3135`.

**Fix:** In `SetupWizard.tsx` complete step, after calling `set_config(setup_complete, true)`, also call `set_config(clip_extraction_mode, cpu)` when the chosen mode is CPU. Alternatively change the default in `config.py` to `"cpu"` and let GPU-capable machines upgrade via Settings.

---

## 2. Quality detection is slow in AniKai

**Symptom:** Format/quality list takes a long time to appear when browsing anime episodes.

**Cause:** Not yet deeply investigated. Likely `inspect_stream_formats` in `lib.rs` is calling yt-dlp with full format enumeration (`--list-formats` or similar) synchronously, or the Jikan API + yt-dlp calls are sequential rather than parallel.

**Fix:** Need to read the `inspect_stream_formats` command in `lib.rs` and the AniKai component in `main.tsx` to confirm. May need to cache results or parallelize API + format probe.

---

## 3. Console windows flash open on every subprocess call (installer build only)

**Symptom:** Black CMD windows briefly appear every time the app invokes Python, ffmpeg, or yt-dlp from the installed `.exe`.

**Cause:** Rust's `std::process::Command` on Windows spawns console-subsystem processes with an inherited console by default. No `CREATE_NO_WINDOW` (0x08000000) creation flag is set anywhere in `lib.rs`.

**Fix:** Add `.creation_flags(0x08000000)` to every `Command` builder in `lib.rs`. Requires `use std::os::windows::process::CommandExt;` at the top. Affects: `run_audio_cli`, `run_streaming_audio_cli`, `run_streaming_clip_cli`, `run_media_to_audio`, `run_video_transcode`, `download_stream`, and every other `Command::new(...)` call.

---

## 4. Clips do not play after extraction (click or grid preview)

**Symptom:** Clip tiles and the lightbox player show no video after extraction completes.

**Cause:** Not yet confirmed. Most likely causes:
- `clip.src` is a raw filesystem path string but the `<video>` element needs a `asset://` URL via `convertFileSrc()`. Check whether `src` in `ClipPreviewItem` is passed through `convertFileSrc` or used raw.
- The extracted clip files may not exist at the path stored in `clip.src` (check where `clip_cli.py` writes output vs. what gets stored in the result).
- The `#t=start,end` media fragment may be rejected by WebView2 for certain codecs.

**Fix:** Read `clip_cli.py` output path logic and `ClipRangePlayer` src construction in `main.tsx` around line 1811. Ensure path goes through `convertFileSrc`. Also verify files actually land where expected.

---

## 5. Status badge can show "Engine: GPU" with a CPU vocal extractor

**Symptom:** The engine label in the UI says GPU but the active extractor is a CPU model (e.g. Kim Vocal).

**Cause:** The display reads `backendConfig.setup_type` ("gpu"/"cpu") but `force_cpu: true` can independently override runtime to CPU without changing `setup_type`. The badge shows the *configured target*, not the *active runtime*.

**Fix:** In `main.tsx` status display, derive the shown mode from both `setup_type` AND `force_cpu`: if `force_cpu` is true, always show "CPU" regardless of `setup_type`. Location: find where "Engine: GPU/CPU" badge is rendered and apply `force_cpu ? "CPU" : setup_type.toUpperCase()`.

---

## 6. No "Open extracted vocals" button after vocal extraction

**Symptom:** After vocal separation completes, there is no shortcut to open the output file or its containing folder.

**Cause:** Feature not implemented. The output path is available in the extraction result.

**Fix:** Add a button in the vocal extraction result area that calls `invoke("open_path", { path: outputDir })` or uses `openUrl("file://...")` via `@tauri-apps/plugin-opener`. Need a Rust command or use the existing opener plugin. Add to the extraction complete state in the audio section of `main.tsx`.

---

## 7. No cancel button for Vocal Extraction or Clip Extraction

**Symptom:** Once extraction starts there is no way to stop it short of closing the app.

**Cause:** No cancellation mechanism exists. The streaming commands (`run_streaming_audio_cli`, `run_streaming_clip_cli`) hold a `Child` process but do not expose a kill handle to the frontend.

**Fix:**
- Store the `Child` handle in a global `Mutex<Option<Child>>` (one each for audio and clip).
- Add `cancel_audio` and `cancel_clip` Tauri commands that call `child.kill()`.
- Frontend: show a Cancel button during active progress, invoke the command on click, reset progress state on response.

---

## 8. Background processes not killed when window is closed

**Symptom:** Python, ffmpeg, or yt-dlp processes continue running in Task Manager after the app window is closed.

**Cause:** No `CloseRequested` event handler in `lib.rs`. Tauri exits the Rust process but child processes (spawned without `CREATE_NO_WINDOW` or as detached) may survive.

**Fix:**
- Same global child handle store as issue #7.
- In `setup_builder.on_window_event(|window, event| { if CloseRequested → kill all tracked children })`.
- Also fixes issue #7 as a prerequisite.

---

## 9. `npm run desktop` (dev mode) broken — error 183

**Symptom:** `cargo` fails during `tauri dev` with `Cannot create a file when that file already exists. (os error 183)` when staging the `python/` directory resources.

**Cause:** The debug build's tauri-build staging directory at `src-tauri/target/debug/build/ultimate-amv-script-<hash>/out/` has stale Python files from a previous run. The files are read-only or locked and cannot be overwritten.

**Fix:** Delete the stale staging output before running dev:
```powershell
Remove-Item -Recurse -Force "src-tauri\target\debug\build\ultimate-amv-script-*"
npm run desktop
```
Long-term: add a `prebuild` or `predev` script in `package.json` that clears that directory, or investigate why tauri-build doesn't handle overwrite correctly on Windows for the debug profile.

---

## 10. Entire panels unclickable in non-fullscreen / smaller window sizes

**Symptom:** Settings panel and possibly other panels become unclickable when the window is not maximized.

**Cause:** Not yet confirmed. Likely candidates:
- An absolutely-positioned overlay or invisible element is sitting on top of the content (check for any `position: absolute` + `inset: 0` elements with no `pointer-events: none`).
- The app shell grid's `overflow: hidden` clips the content area and the hit-test area doesn't match the visual area at certain sizes.
- The sidebar transition animation leaves a ghost element blocking clicks during/after collapse.

**Fix:** Inspect with DevTools (`F12` in dev mode, or enable devtools in release). Use the element picker to identify what element is intercepting the click. Then either add `pointer-events: none` to the overlay or fix the grid/overflow layout so hit areas match visual areas.

---

## Dev workflow note

Run `dev-uninstall.bat` (project root) between test installs to wipe the install dir, WebView2 cache, and Tauri storage for a fully clean reinstall.
