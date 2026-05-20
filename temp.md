# Tasks 1–7 — Read-only Review Summary

## 1. Non-blocking export modal

- **Today:** Export state lives in `ClipExtractorPanel` local state (`exportSession`/`exportSessionRef`); modal is mounted inside the panel. Panels stay mounted (`display:none`), so the export *can* survive panel switches — it just visually blocks the active panel today.
- **Tauri side:** `clip_export` / `clip_export_merged` are awaited promises, serialized by the JS for-loop. No queue or concurrency token in Rust. Progress streams via `conversion-progress` event.
- **No notification library, no global store** (zustand/context/redux). Only `UpdateToast` exists as a single-purpose toast pattern.
- **Fix surface:** add a small Context provider (`ExportQueueProvider`) under `src/features/clips/`, move export state + listener out of `ClipExtractorPanel`, mount the modal + a new `ClipExportCornerToast` at `App.tsx`. Cancel must use a new `cancel_clip_export` that only touches `CLIP_CHILD_PID` (don't call `cancel_clip` — it also tears down `CLIP_SERVER`, which would ruin subsequent extraction clicks).
- **Open question:** Context provider vs a tiny custom-event singleton — leaning Context (no new deps, matches codebase shape). OK with that?

---

## 2. Gradient color picker lag

- **Root cause:** native `<input type="color">` (no library) fires `onChange` per pointer tick → full `App` re-render + Tauri `invoke("set_config")` disk write each tick.
- **Fix surface:** `src/features/settings/AppearanceSettings.tsx` only. Keep CSS-var preview live on every tick (cheap, `applyAppTheme` 3 setProperty calls); debounce `theme-changed` dispatch + `persistConfigField` to drag-end/blur. Also kill redundant `applyAppTheme` effect in `App.tsx:119-121`.
- **No regression surface** — picker is used at exactly two sites, both in this file.

---

## 3. Filter gif/ping URLs

- **Root cause:** `sniffer.rs::media_kind` (L65-84) does *substring* matching on the URL — analytics beacons like `ping.gif?url=...m3u8...` pass because `.m3u8` appears in the query string. Once captured, yt-dlp can't parse the gif → `downloads.rs:382-392` synthesizes the placeholder labeled "Captured playback stream", which is exactly what the user sees fail on download.
- **Fix surface:** `sniffer.rs:65-84` — switch substring to pathname-only check (ignore query string); add explicit blacklist for `.gif/.png/.jpg/.jpeg/.webp/.ico/.svg`, `/ping.`, `/beacon`, `/collect`, `/analytics`. Also: `downloads.rs:382-392` — when `formats.is_empty()`, surface a real error instead of inventing a fake quality. Episode detection does **not** depend on these URLs (the relevant code paths are host-gated to `anikai.to`/`aniwaves.ru`).

---

## 4. YouTube downloads under anime downloads

- **Root cause (confirmed line):** `resolve_download_root()` in `src-tauri/src/downloads.rs:659-670` hardcodes `.../Ultimate AMV/anime downloads` as the *root* — so the YouTube flow then appends `youtube downloads/` *inside* the anime root.
- **Fix surface:**
  - `downloads.rs:666-667` — remove `.join("anime downloads")` so the helper returns the `Ultimate AMV` root.
  - `downloads.rs:730` — anime flow inserts its own `"anime downloads"` segment.
  - `downloads.rs:248-260` — `list_anime_folders` must list `<root>/anime downloads` (otherwise `youtube downloads` shows up as a fake "anime" in the EpisodeLabelModal dropdown).
  - UI copy: `FeatureSettings.tsx:33,42`, `SetupWizard.tsx:229`.
- **Migration:** per `feedback_no_recovery_nags`, **don't move existing user content** — change affects new downloads only.

---

## 5. Export quality across formats / CQ — answer to your question

**Short answer: yes, there is a real visible quality drop between the "mezzanine" presets and the "delivery" presets today, and the alternatives do NOT make up for it as currently tuned.** All quality numbers are hardcoded in Rust; UI only exposes the format dropdown — no CQ/CRF slider for clip export (the slider in Video-to-Video is a separate command).

| Preset | Current args | Verdict |
|---|---|---|
| `gpu-intra` | hevc_nvenc Main10, `-rc constqp -qp 16 -g 1 -bf 0 -highbitdepth 1` | Near-lossless. **Missing NVENC→libx264 fallback** (only scene preview has it). Violates CLAUDE.md CPU/GPU parity rule. |
| `prores-lt`/`hq` | prores_ks, 10-bit 4:2:2 | Excellent. No quality knob exposed. |
| `h264-nvenc` | `-preset p4 -cq 18`, no `-rc constqp`, no AQ | Default NVENC RC → banding on anime gradients, smearing on fast cuts. Visible drop vs gpu-intra. |
| `av1-nvenc` | `-preset p4 -cq 24`, no `-rc constqp` | "Good" not transparent; psy-tuned for streaming. |
| `h264-cpu` | `libx264 -crf 18 -preset fast` | `-preset fast` leaves quality on the table; `-preset slow` would be smaller AND cleaner. |
| `hevc-cpu` | `libx265 -crf 18 -preset fast` | Same story. |
| All MP4 paths | no `+faststart`, no explicit `-pix_fmt` | Web playback buffers from tail; 10-bit source can surprise the encoder. |

**Recommended improvements** (none implemented yet):
- Add `-rc constqp -spatial-aq 1 -temporal-aq 1` to both NVENC presets.
- Switch CPU presets from `fast` → `slow` (clip-length encodes; wall-clock cost is small).
- Add `-movflags +faststart` to all MP4 exports.
- Add NVENC→libx264 fallback to `gpu-intra` (satisfies CLAUDE.md).
- **Expose CQ/CRF slider in `ClipExtractorPanel`** — mirror `video_transcode`'s `quality_value` param.
- Optional: add `prores-4444`, true lossless (`libx264 -qp 0`, `ffv1`).

**Question for you:** which of these do you want shipped — just the tuning fixes, or also the new UI slider? They're independent.

---

## 6. hianime.ms stream detection

- **Why hianime only shows ping.gif:** hianime plays via a cross-origin iframe (megacloud.club/similar) where the real `.m3u8` is **encrypted in JSON, decrypted in-page, fed to MSE via blob: URL** — that blob URL never appears as an HTTP request the sniffer can catch. The only same-origin traffic is analytics beacons that happen to contain `.m3u8` in a query parameter, hence pass `media_kind`.
- **Why episode dropdown is blank:** `sniffer.rs:254-269` and the injected DOM poller hardcode `anikai.to`/`aniwaves.ru` selectors. hianime is unregistered → no identity scraping, no episode number.
- **Fix surface (substantial — this is the biggest item):**
  - Add `hianime` preset to `AnikaiBrowser.tsx:40-43` (with `megacloud.club` etc. in the host allowlist for the iframe).
  - Extend the response-body scan in `sniffer.rs:617-672` to scan *any* JSON response for embedded `m3u8` strings (currently AniKai-gated).
  - Inject a `window.fetch` / `XHR` / `MediaSource.addSourceBuffer` shim via `AddScriptToExecuteOnDocumentCreated` to catch MSE/blob streams that never hit the request layer. This is the only way to recover hianime's actual playlist.
  - Extend DOM poller selectors (`.film-name`, `.ssli.active .ssli-order`, document title parse) for hianime.
  - Manual-URL fallback in the UI when auto-detection fails (today the Download button is gated on `captureState === 'detected'`).
- **Question for you:** scope. Full hianime support (fetch/XHR shim, JSON response scan, manual URL paste) is meaningful work. Want me to do the full thing, or start with the noise filter (Task 3) + manual-URL fallback only and revisit?

---

## 7. Duplicate bar at bottom of collapsed sidebar

- **Root cause:** `.settings-button` (footer "Logs"/"Settings" buttons in `App.tsx:224-244`) renders its label `<span>` without the `.nav-icon` wrapper that the top nav uses. In compact mode the `.is-compact .settings-button span { width: 0; padding: 0 }` rule shrinks the span to zero width but doesn't remove it — that zero-width span inside `overflow: hidden; border-radius: 12px` produces a 1px sliver on the left edge of each footer button. Two stacked buttons → two slivers → "duplicate bar".
- **Innocent:** the `f48c5a6` "section dividers" commit is comment-only — not the cause.
- **Fix surface:** `src/styles.css:4631-4650` only. Either set `.is-compact .settings-button span { display: none }` or change `.is-compact .settings-button` grid to a single 40px column. No TSX changes.

---

## Suggested order to ship (lowest risk → highest)

1. Task 7 (CSS one-liner)
2. Task 2 (color picker debounce — single file)
3. Task 4 (folder path — small Rust change, careful with `list_anime_folders`)
4. Task 3 (gif filter — sniffer + downloads tweak)
5. Task 5 quality tuning (Rust constants only) — and confirm whether you want the new UI slider too
6. Task 1 (non-blocking export — new Context, app-level mount)
7. Task 6 (hianime — biggest, needs in-page shim)

**Two calls needed before coding:**
- **Task 5:** tuning only, or tuning + new CQ/CRF UI slider?
- **Task 6:** full hianime support (incl. fetch/MSE shim), or noise filter + manual-URL fallback first and revisit?
