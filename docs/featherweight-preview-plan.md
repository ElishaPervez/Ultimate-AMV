I now have all the load-bearing details verified. Here is the synthesized plan.

---

# Featherweight Offset-Playback Scene Previews â€” Spike / Implementation Plan

## 0. The one-line thesis

Stop materializing one asset *per scene* (today: one animated WebP per grid tile + one re-encoded mp4 per modal click). Instead, point a `<video>` at **one** decode-friendly source â€” the **original** when it is WebView2-playable *and* in asset scope, otherwise **one shared low-res short-GOP proxy per episode** â€” and produce the illusion of N clips purely with `currentTime` + a JS loop over `[previewStart, previewEnd]`. The boundary-correct ranges (`previewStart/previewEnd`) and the original source URL (`sourceSrc`) **already flow to the UI** (`ClipExtractorPanel.tsx:379-383`, `clip.ts:15-19`); the dead `sourceClipPlaybackRange` (`ClipPreviewTile.tsx:7-17`) is literally the blueprint for the friendly path.

---

## 1. Architecture overview â€” data + control flow under the new model

### 1.1 Shared concepts

- **Playback plan, per distinct source.** A new Rust command `clip_playback_plan(sourcePath)` probes once per episode and returns `{ mode: "direct" | "proxy", reasons, codec, audioCodec, width, height, pixFmt, container, inScope }`. The frontend caches this in a `Record<sourcePath, PlaybackPlan>` keyed by `scene.source` (mirrors the existing `detectorProxies` Record state pattern).
- **Playback source per clip.** Each tile/modal resolves `playbackSrc`:
  - `mode === "direct"` â†’ `clip.sourceSrc` (already `convertFileSrc(scene.source)`), seek-window `[previewStart, previewEnd]` maps 1:1 onto the original timeline.
  - `mode === "proxy"` â†’ `convertFileSrc(proxyPath)`. Because the proxy is a straight full-timeline transcode (no `-ss` trim), `previewStart/previewEnd` map 1:1 onto the proxy timeline too â€” no remapping needed.
- **Loop = JS, not the muxer.** Set `video.currentTime = previewStart` on the genuine play edge, then a `requestVideoFrameCallback` (rVFC) loop snaps back to `previewStart` when `currentTime >= previewEnd`. Native `loop` attribute is **removed** because it loops `[0, duration]`, i.e. the whole episode.

### 1.2 Grid tile (ClipPreviewTile) control flow

```
shouldPlay falseâ†’true (existing wasPlayingRef/playToken edge, l122-128)
  â†’ mount <video muted playsInline preload="metadata" src={playbackSrc}>
  â†’ onLoadedMetadata / onCanPlay: video.currentTime = clip.previewStart
  â†’ start rVFC loop:
        if (now.mediaTime >= clip.previewEnd) video.currentTime = clip.previewStart
        else schedule next rVFC
  â†’ onError (MEDIA_ERR_SRC_NOT_SUPPORTED): fall back to WebP <img> (poster path)
shouldPlay trueâ†’false  â†’ cancel rVFC, pause(), src="" + load() teardown (TsukyioPlayer pattern)
```

Poster: keep `useWebpThumbnail` (l32-76) and the WebP `previewState.src` **exactly as today** as the static-thumbnail base layer and as the live fallback while the proxy builds or if `<video>` errors. The CSS `clip-loop-progress` bar (l165-173) is retained but driven off rVFC `mediaTime` (or simply kept CSS-only against `loopDuration = previewEnd - previewStart`).

Decode throttle is **unchanged**: `activeGridClipIds` windowing + `MAX_GRID_AUTOPLAYERS=100` + `playable`/`paused` props already gate which tiles animate. The `<video>` mount is gated on the same `shouldPlay`, so the cap transfers from WebP-decode to video-decode with zero new throttling code.

### 1.3 Modal (SceneViewerModal) control flow

```
open clip
  â†’ resolve playbackSrc from the cached plan (no scene_clip_render invoke on the happy path)
  â†’ <video src={playbackSrc} autoPlay muted={isMuted}>
  â†’ onLoadedMetadata: video.currentTime = previewStart; setDuration(previewEnd - previewStart)
  â†’ rVFC loop: wrap currentTime back to previewStart at previewEnd
  â†’ scrub: rebase pointer fraction onto [previewStart, previewEnd] (NOT [0, video.duration])
  â†’ on plan==unavailable OR <video> error: FALL BACK to today's scene_clip_render mp4 path
```

The WebP poster (l264-271) stays as the "until video is ready / on error" layer.

---

## 2. Friendly-vs-unfriendly routing â€” the exact decision rule

Computed in Rust inside `clip_playback_plan`, using ffprobe once per source. **Friendly (play ORIGINAL directly) requires ALL of:**

| Clause | Rule | Why |
| --- | --- | --- |
| Video codec | `codec_name âˆˆ {h264, avc1}` | Only H.264 reliably decodes in WebView2 (HEVC needs paid extension, AV1 needs OS extension â€” neither guaranteed). |
| Pixel format / depth | `pix_fmt âˆˆ {yuv420p, yuvj420p}` (8-bit 4:2:0 only) | High-10 / 4:2:2 / 4:4:4 H.264 is undecodable in WebView2; `render_scene_clip_job` forces `yuv420p` for exactly this reason (clips.rs:1217). |
| Audio codec | `audioCodec âˆˆ {aac, mp3}` OR no audio stream | AC3/E-AC3/DTS/FLAC/Opus-in-MKV won't decode; an H.264 video with AC3 audio *looks* friendly but fails. This is the "silent killer". |
| Container | extension âˆˆ `{mp4, m4v, mov}` | `<video>` cannot demux MKV/MOV-without-faststart even with H.264+AAC. MKV is the dominant anime-rip container â†’ most rips fail here. |
| Resolution | `width <= 1920 && height <= 1080` | Avoid seeking a 4K original inline. |
| **Asset scope** | source path is under `$HOME` (`C:\Users\<name>\**`), `$APPDATA`, or `$RESOURCE` | **Hard CSP constraint** (`tauri.conf.json:30`). `convertFileSrc` 403s for `D:\Anime`, network shares, etc. This clause alone forces most real libraries to the proxy. |

**Any clause failing â†’ `mode: "proxy"`.** The proxy lives under `$APPDATA` so it is *always* in scope and *always* H.264+AAC+yuv420p+mp4+short-GOP, sidestepping every clause above.

Implementation: extend the probe to read `codec_name,pix_fmt,width,height` for `v:0` plus the first audio `codec_name`, using the JSON ffprobe form already proven in `downloads.rs:552-599` (`stream=width,height,codec_name,bit_rate -of json`). `probe_video_codec` (video_cmds.rs:393) and `probe_has_audio_stream` (video_cmds.rs:419) are the existing single-field probes to extend or sit alongside. The asset-scope check is a Rust-side path-prefix test against the resolved `$HOME`/`$APPDATA`/`$RESOURCE` dirs (Tauri's `path()` resolver).

> Decision needed (see Â§9): whether to **widen `assetProtocol.scope`** to a user-configurable library root vs **always-proxy** off-scope sources. Recommended default: always-proxy off-scope (parity-safe, no security surface change). Most real libraries are MKV anyway, which already forces proxy.

---

## 3. Proxy spec

**One file per episode**, keyed by content fingerprint, whole-timeline (no `-ss` trim so timecodes map 1:1).

### 3.1 Container / video / audio knobs

- **Resolution:** `scale=-2:'min(480,ih)'` (480p cap; legible in the modal, plenty for grid tiles). Never upscale (the `min()` guard mirrors clips.rs:1206).
- **GOP:** short, fixed cadence so `currentTime` seeks land near a keyframe â€” `-g 12 -keyint_min 12 -sc_threshold 0` (~0.5s at 24fps).
- **No B-frames:** `-bf 0`. WebView2/Chromium snaps `currentTime` to the nearest *preceding* keyframe and B-frames degrade per-frame seek accuracy â€” keeping every frame independently seekable preserves the boundary semantics that the inward `previewStart` pad protects.
- **Pixel format:** `-pix_fmt yuv420p` (WebView2 law).
- **Audio:** `-c:a aac -b:a 96k -ac 2` (downmix; AC3/Opus â†’ AAC for free).
- **Container:** `-movflags +faststart` mp4.
- **Color:** reuse `probe_color_metadata` + `setparams_filter` + `color_tag_args` (clips.rs:80-154) so the proxy carries the same BT.709-limited-default tags as the modal/export â€” offset playback should look identical to the original.
- **Decode accel:** `-hwaccel auto` (clips.rs:1183 pattern â€” NVDEC/QSV/D3D11VA/software, not NVIDIA-gated).

### 3.2 NVENC build command (GPU fast path)

```
ffmpeg -y -hide_banner -nostdin -hwaccel auto -i <src>
  -map 0:v:0 -map 0:a:0?
  -vf "scale=-2:'min(480,ih)',<setparams(color)>"
  -c:v h264_nvenc -preset p4 -rc vbr -cq 30 -g 12 -no-scenecut 1 -forced-idr 1 -bf 0 -pix_fmt yuv420p
  <color_tag_args>
  -c:a aac -b:a 96k -ac 2
  -movflags +faststart -progress pipe:1 <out>
```

### 3.3 libx264 build command (CPU parity path â€” MANDATORY)

```
ffmpeg -y -hide_banner -nostdin -hwaccel auto -i <src>
  -map 0:v:0 -map 0:a:0?
  -vf "scale=-2:'min(480,ih)',<setparams(color)>"
  -c:v libx264 -preset veryfast -crf 30 -g 12 -keyint_min 12 -sc_threshold 0 -bf 0 -pix_fmt yuv420p
  <color_tag_args>
  -c:a aac -b:a 96k -ac 2
  -movflags +faststart -progress pipe:1 <out>
```

Selection mirrors `generate_scene_clip` exactly: `use_nvenc = *H264_NVENC_AVAILABLE.get_or_init(|| ffmpeg_listing(&ffmpeg,"-encoders").contains("h264_nvenc"))` (clips.rs:1132-1133); build NVENC args, and **on any Err, retry libx264** (clips.rs:1135-1144). No NVENC-only path. All flags are confirmed available in the pinned FFmpeg 8.1.1 gyan/codexffmpeg build.

### 3.4 Cache location + key + invalidation

- **Dir:** `<app_data_dir>/source_proxies/<content_fingerprint>/` (sibling to `scene_clips/` and `clip_previews/`; under `$APPDATA` â†’ always in asset scope).
- **Filename / key:** `short_stable_id(&[&fingerprint, "480p", encoder_decision, "source-proxy-v1"]).mp4` using `short_stable_id` (downloads.rs:1478) over `content_fingerprint` (downloads.rs:1498, rename/copy-stable).
- **Cache hit:** `>1024 bytes` short-circuit, atomic tmp+rename write â€” same pattern as every other cache.
- **Invalidation:** bump the literal `"source-proxy-v1"` tag.
- **GC:** add `source_proxies/` to `config::clear_app_cache` (lib.rs:397). Proxies are app-owned derived/temp data â†’ silently GC-able. **No "leftover X" nag, no auto-delete of user data** (per memory: `feedback_no_recovery_nags`).

### 3.5 Progressive build so early tiles light up

`+faststart` relocates the `moov` atom to the end, so a single-file proxy is not reliably playable until ffmpeg exits â€” a regression from today's progressive per-scene WebP fill. Two options, decide in Â§9:

- **(A) Segment muxer (true progressive):** `-f segment -segment_time 30 -reset_timestamps 1 -segment_format mp4 -movflags +faststart proxy_%05d.mp4`. Each ~30s chunk finalizes independently; map a scene at time `T` to segment `floor(T/30)` and offset-play within it. Handles scenes that straddle a boundary by playing from the segment that contains `previewStart`. Most progressive, most frontend complexity.
- **(B) Single file + `run_ffmpeg_with_progress` (video_cmds.rs:442):** determinate `%` progress bar via `-progress pipe:1`; tiles stay on WebP poster until the proxy completes, then flip live. Simplest; keeps the existing WebP poster as the "still building" experience so the grid never looks empty.

**Recommended for v1: (B)** â€” it leans on the already-perfect WebP poster pipeline as the progressive fill, with a single determinate progress affordance, and avoids segment-mapping complexity. Revisit (A) only if proxy build latency on CPU-mode proves painful in practice.

Build is **lazy / on-demand** (first preview interaction on an unfriendly source), **never pre-warmed** â€” pre-warm batches violate `feedback_cpu_gpu_parity`. Store the proxy ffmpeg PID in a kill-slot (mirror `CLIP_CHILD_PID`) so a new source selection / app teardown cancels an in-flight build.

---

## 4. Frontend changes

### 4.1 Shared offset-player hook / component

Create a small `useOffsetLoop(videoRef, { start, end, active })` hook (or extend `DirectStreamPlayer.tsx`, the existing minimal `<video>` with no offset/loop). Responsibilities:
- On `loadedmetadata`/`canplay` and on the `active` falseâ†’true edge: `video.currentTime = start`.
- rVFC loop: `const cb = (_, meta) => { if (meta.mediaTime >= end) video.currentTime = start; handle = video.requestVideoFrameCallback(cb); }`.
- **rVFC fallback:** there is **zero** existing rVFC usage in the repo, and it must be confirmed present in the shipped WebView2 runtime. If `'requestVideoFrameCallback' in HTMLVideoElement.prototype` is false, fall back to a `timeupdate` listener (coarser, ~250ms granularity) plus a `setTimeout(end - currentTime)` snap-back. Keep `start` inward-padded so the coarse loop never shows the next scene's first frame.
- Teardown: cancel rVFC, `pause()`, clear `src`, `load()` (TsukyioPlayer.tsx:232-271 teardown pattern).

### 4.2 Grid tile (ClipPreviewTile)

- Replace the `clip-animated-overlay` `<img>` (l155-164) with a `<video muted playsInline preload="metadata">` mounted only when `shouldPlay`, using the shared offset hook with `start=clip.previewStart`, `end=clip.previewEnd`, `src = clip.playbackSrc`.
- **Keep `useWebpThumbnail` + the static-thumbnail base layer unchanged** as poster and as `<video>` `onError` fallback (so a misclassified source degrades to today's WebP, never a black tile).
- **Stay muted in the grid, always** (autoplay policy + UX; never N autoplaying audio tracks).
- Preserve the WebP-decode-cache-friendly remount behavior: only (re)seek to `previewStart` on the genuine `shouldPlay` falseâ†’true edge (reuse `wasPlayingRef`/`playToken`, l122-128). On Virtuoso overscan re-entry, resume rather than re-seek where possible to avoid repeated expensive seeks.
- CSS: `clips.css` needs `<video>` `object-fit: cover` + fade-in styling equivalent to `clip-animated-overlay`; `clip-loop-progress` retained.

### 4.3 Modal (SceneViewerModal)

- On the happy path, **drop the `scene_clip_render` invoke** (l128-153). Resolve `playbackSrc` from the plan; set `<video src={playbackSrc} autoPlay muted={isMuted}>` (remove the native `loop` attr, l279).
- `onLoadedMetadata` (l286-292): `video.currentTime = clip.previewStart`; `setDuration(clip.previewEnd - clip.previewStart)`.
- Drive the rVFC offset-loop (wrap to `previewStart` at `previewEnd`).
- **Rebase scrub math** (`seekFromPointer`, l185-193): `video.currentTime = previewStart + fraction * (previewEnd - previewStart)`; `setCurrentTime(video.currentTime - previewStart)` for display. The progress bar (l225) then measures within the sub-range.
- Audio: modal keeps the existing persisted mute pref (l41-59) and unmutes on user toggle â€” friendly-direct gets original audio for free; proxy gets re-encoded AAC.
- **Fallback:** if no plan/`playbackSrc`, or `<video>` errors, keep the existing `scene_clip_render` mp4 path and WebP poster verbatim.

### 4.4 Concurrency

No new throttle. Reuse `activeGridClipIds` + `MAX_GRID_AUTOPLAYERS=100` + `paused`/`playable` (constants.ts:14-17). The "N seekers on one huge file is janky" trap (doc l844) is mitigated by the short-GOP proxy for unfriendly sources; for friendly-direct, the same 100-player cap bounds concurrent decoders.

---

## 5. Exact integration seams

### Rust
- **`src-tauri/src/video_cmds.rs`** â€” extend probing: add `probe_media_summary(ffprobe, input) -> {videoCodec, pixFmt, width, height, audioCodec}` using the JSON ffprobe form from `downloads.rs:552-599`. Keep `probe_video_codec`/`probe_has_audio_stream` as-is.
- **`src-tauri/src/clips.rs`** â€” add two sibling fns next to `generate_scene_clip` (l1076):
  - `clip_playback_plan(source_path) -> { mode, codec, audioCodec, width, height, pixFmt, container, inScope, reasons }` (probe + friendliness + asset-scope test).
  - `build_source_proxy(window, source_path) -> proxyPath` modeled on `render_scene_clip_job` (l1149) but whole-file, short-GOP, 480p; reuse `H264_NVENC_AVAILABLE` guard + NVENCâ†’libx264 fallback (l1132-1144), `probe_color_metadata`/`setparams_filter`/`color_tag_args` (l80-154), `content_fingerprint`/`short_stable_id` cache keying, atomic tmp+rename, and `run_ffmpeg_with_progress` (video_cmds.rs:442) for the `clip-progress` event stream. PID in a new kill-slot.
- **`src-tauri/src/lib.rs`** â€” register `clip_playback_plan` + `build_source_proxy` in the invoke_handler list (l393-458, alongside `scene_clip_render` at 412).
- **`src-tauri/src/config` (`clear_app_cache`, registered lib.rs:397)** â€” add `source_proxies/` to the cleared dirs.

### Frontend
- **`src/types/clip.ts`** â€” add to `ClipPreviewItem`: `playbackSrc?: string` and `playbackMode?: "direct" | "proxy"`. Add a `PlaybackPlan` type. Optionally add `"proxy-building"` to `ClipPreviewState.status` (l1-7) for the building affordance.
- **`src/features/clips/ClipExtractorPanel.tsx`** â€” in/near the `clips` useMemo (l364-389): attach `playbackSrc`/`playbackMode` from a `playbackPlans` Record (new state, `detectorProxies`-shaped). Add an effect that lazily calls `clip_playback_plan` per distinct `scene.source` and, when `mode==="proxy"`, kicks **one** `build_source_proxy` per source on first preview interaction; thread the resulting `convertFileSrc(proxyPath)` into tiles. Keep the existing `clip_preview_generate_batch` WebP scheduler (l533-647) as the poster pipeline.
- **`src/features/clips/ClipPreviewTile.tsx`** â€” implement Â§4.2; resurrect the spirit of `sourceClipPlaybackRange` (l7-17) but seek to **`previewStart`** (not `sourceStart`) to respect boundary semantics.
- **`src/features/clips/SceneViewerModal.tsx`** â€” implement Â§4.3; keep `scene_clip_render` as fallback.
- **`src/features/clips/DirectStreamPlayer.tsx`** or new `useOffsetLoop` â€” the shared offset/loop primitive.
- **`src/styles/clips.css`** â€” `<video>` cover/fade styling.

### Tests to update
- `SceneViewerModal.test.tsx` currently enforces `scene_clip_render` is called with `previewStart/previewEnd`. The happy-path assertion changes to "no render invoke; `<video>` seeks to `previewStart`"; the **boundary guard** (seek/loop uses `previewStart/previewEnd`, never `sourceStart/sourceEnd`) must be preserved and re-pointed at the offset player.

---

## 6. What stays unchanged

- **Export path** (`run_clip_export`, `run_lossless_cut_merge`, gpu-intra/prores/etc.) â€” entirely untouched. This is preview-only.
- **`scene_clip_render` mp4 modal path** â€” kept as the modal's fallback (plan unavailable / `<video>` error / merged clips).
- **Per-scene WebP baker (`preview.rs`)** â€” kept as the grid poster + "proxy-building" fill + tile `onError` fallback. (It is *not* retired in this plan; the "no asset per scene" goal is achieved for *playback* while the WebP shrinks to a cheap poster role. Fully retiring it is a later optional phase â€” see Â§9.)
- **`previewClipRange` inward padding** (l2332-2347) â€” unchanged; it *is* the boundary-bleed fix and feeds straight into `currentTime`.
- **`activeGridClipIds` windowing + `MAX_GRID_AUTOPLAYERS` cap** â€” unchanged; reused as the decode throttle.
- **Merged/unified preview** (`handleClipClick` merge branch, `clip_preview_merge`) â€” stays on the concat/re-encode path; offset over discontiguous segments isn't expressible as one `[start,end]` on one source.

---

## 7. Phased rollout

**Phase 0 â€” Spike: rVFC + asset-scope reality check (no UI commitment).**
Confirm (a) `requestVideoFrameCallback` exists in the shipped WebView2 runtime, (b) `convertFileSrc` of an in-`$HOME` H.264+AAC mp4 plays and seeks acceptably, and (c) measure seek latency to a scene ~18min into a long-GOP original vs a `-g 12` 480p proxy. These three results decide whether the loop needs the timeupdate fallback and how aggressive the proxy GOP must be.

**Phase 1 â€” Smallest viable: friendly-source MODAL offset playback, behind a flag.**
- Add `clip_playback_plan` (probe + scope check) only.
- In the modal: if `mode==="direct"`, offset-play `clip.sourceSrc` with the rVFC loop + rebased scrub; else fall back to today's `scene_clip_render`. No proxy yet, no grid change.
- This is the lowest-risk, highest-signal slice: one `<video>`, the modal already has scrub/fullscreen/mute, and it validates boundary fidelity on the original.

**Phase 2 â€” The shared proxy (unlocks unfriendly + off-scope sources).**
- Add `build_source_proxy` (NVENC + libx264 parity) + cache + `clear_app_cache` wiring + progress events.
- Modal `mode==="proxy"` offset-plays the proxy; WebP poster covers the build.
- Keep `scene_clip_render` as the error fallback.

**Phase 3 â€” Grid tiles switch to offset `<video>`.**
- Replace the tile WebP `<img>` with the shared offset `<video>`, gated on `shouldPlay`, WebP as poster/fallback. Validate scroll perf against the 100-player cap (this is the perf-riskiest step â€” many simultaneous `<video>` vs `<img>`).

**Phase 4 â€” Polish.**
- Compact proxy-build affordance (reuse the existing clip-run-card/server badge, not a new slab â€” `feedback_ui_taste`), segment-muxer progressive build if Phase 2 latency warrants, optional retirement of the per-scene WebP bake for fingerprints that have a ready proxy.

Ship behind a feature flag through Phase 2; default-on after Phase 3 perf is verified.

---

## 8. Risks + mitigations

| Risk | Mitigation |
| --- | --- |
| **Asset-scope 403** â€” originals on `D:\`/network/non-`$HOME` silently fail in `<video>`. | Asset-scope check is a *mandatory clause* of "friendly". Off-scope â†’ proxy (always in `$APPDATA`). Don't widen scope in v1. |
| **Audio silent-killer** â€” H.264+AC3 looks friendly, plays no audio. | Friendliness gates on audio codec (`aac`/`mp3`/none), not just video. Proxy always normalizes to AAC. |
| **10-bit / 4:2:2 H.264** misclassified friendly â†’ black tile. | Friendliness gates on `pix_fmt âˆˆ {yuv420p, yuvj420p}`. Proxy forces `yuv420p`. |
| **MKV container** â€” H.264+AAC but `<video>` can't demux. | Container clause forces proxy; covers the dominant anime-rip case. |
| **Boundary bleed** â€” seeking to `sourceStart` shows prev scene's last frame. | Always seek/loop on `previewStart/previewEnd` (inward-padded). `-bf 0` + short GOP on the proxy keeps the displayed start frame clean; friendly-direct inherits source GOP (accept slightly coarser, padding absorbs it). |
| **rVFC unsupported in WebView2.** | Feature-detect; `timeupdate` + `setTimeout` fallback. Phase 0 confirms. |
| **N `<video>` decoders regress scroll.** | Reuse `MAX_GRID_AUTOPLAYERS=100` + `shouldPlay` gating; defer grid to Phase 3 and perf-test there; WebP poster keeps off-cap tiles cheap. |
| **CPU-mode proxy build time** (libx264 480p of 22min â‰ˆ minutes). | Lazy/on-demand build, never pre-warm; WebP poster keeps grid live during build; progress UI; consider segment muxer if painful. Honors `feedback_cpu_gpu_parity`. |
| **Short-GOP disk blowup** (`-g 12 -bf 0` â‰ˆ 2-4Ã— â†’ ~200-400MB/episode). | CRF/cq 30, 480p, GC under `clear_app_cache`. Tunable to `-g 24` if size dominates (decide in Â§9). |
| **`+faststart` defers single-file playability to completion.** | v1 uses WebP poster as progressive fill (option B); segment muxer (option A) is the true-progressive upgrade. |
| **Tile remount re-seek churn** on Virtuoso overscan. | Seek only on genuine `shouldPlay` falseâ†’true edge; resume on re-entry. |
| **Color fidelity** â€” WebView2 color handling vs export. | Tag the proxy with `setparams`/`color_tag_args` to match export; friendly-direct accepts the browser's handling (preview, not master). |

---

## 9. Open questions needing your decision before building

1. **Off-`$HOME` policy:** always-proxy off-scope sources (recommended; parity-safe, no security change) **or** widen `assetProtocol.scope` to a user-configurable library root? This sets how often the proxy path runs.
2. **Resolution cap for "friendly":** keep direct playback at â‰¤1080p, or be stricter (â‰¤720p) and proxy everything above?
3. **Proxy targets:** 480p vs 360p; GOP `-g 12` (~0.5s, finer seeks, bigger) vs `-g 24` (~1s, smaller); confirm `-bf 0` is acceptable for preview. Needs a quick empirical size/seek pass on a real episode (Phase 0).
4. **Progressive build:** segment muxer (true progressive, more frontend complexity) **or** single file + determinate progress with WebP-poster fill (recommended v1)?
5. **Grid scope:** do tiles switch to offset `<video>` (Phase 3) or does the grid keep the WebP and only the modal goes offset? The "no asset per scene" goal is fully met for *playback* either way; the WebP-for-grid / video-for-modal hybrid is the lower-perf-risk option.
6. **WebP retirement:** keep the per-scene WebP indefinitely as poster (cheap, recommended) or retire it once a proxy exists for that fingerprint?
7. **Merged/unified clips:** confirm they stay on the existing re-encode path (offset over discontiguous segments isn't a single `[start,end]`).
8. **Proxy cache GC policy:** size cap / LRU for `source_proxies/`? (Derived/temp â†’ silently GC-able per `feedback_no_recovery_nags`; just need a cap so 200-400MB/episode doesn't accumulate unbounded.)

---

**Verified against code:** dead `sourceClipPlaybackRange` blueprint (`ClipPreviewTile.tsx:7-17`); WebP-`<img>` + CSS-loop grid (l148-173); modal `scene_clip_render` invoke with `previewStart/previewEnd` + WebP poster + native-`loop` `<video>` + scrub-over-`duration` (`SceneViewerModal.tsx:128-158, 185-193, 264-294`); `clips` memo sets `sourceSrc/previewStart/previewEnd/path` (`ClipExtractorPanel.tsx:364-389`); inward padding (`previewClipRange`, l2332-2347); `ClipPreviewItem` already carries every offset input (`clip.ts:9-31`); NVENCâ†’libx264 fallback + dual-`-ss` + `yuv420p`/faststart/color-tag template (`clips.rs:1076-1269`); `H264_NVENC_AVAILABLE`/`ffmpeg_listing`/`probe_*`/`run_ffmpeg_with_progress` (`video_cmds.rs:357-440, 442+`); asset scope `["$APPDATA/**","$RESOURCE/**","$HOME/**"]` + media-src CSP (`tauri.conf.json:27-30`).