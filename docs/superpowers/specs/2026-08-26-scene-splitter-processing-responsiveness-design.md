# Scene Splitter Processing Responsiveness

## Outcome

Once the first episode's scenes appear, the user can keep scrolling, selecting, and previewing them while later episodes are still being detected. Progress continues to update, but those updates do not repeatedly redraw the scene grid or start preview work for episodes the user has not reached.

## Current failure

The grid becomes uneven while a batch is still running because three independent jobs all update the large Scene Splitter panel:

- Detection sends frequent progress updates. Each update changes state owned by the whole panel, so React revisits the populated grid even though no scene changed.
- Lightweight source proxies are queued for every selected episode as soon as detection starts. Unseen episodes therefore consume decoding, encoding, disk, and event capacity before their scenes need to move.
- A source-proxy job also reports through the general conversion channel. Its message can replace the detection message, so the user sees one job's progress under another job's label.

## Approved scope

This change makes three targeted corrections:

1. Isolate live processing progress from the populated scene grid.
2. Build lightweight source proxies only when scenes from that source enter the active preview area.
3. Keep detection, proxy preparation, conversion, and export progress on separate paths.

The first pass does not lower the number of moving previews. A lower temporary limit remains a follow-up only if direct measurement shows video decoding still causes stutter after these three corrections.

## Design

### 1. Progress updates redraw only the status UI

High-frequency processing updates will live in a small Scene Splitter status boundary instead of state owned by the full panel. When a detection or proxy percentage changes, the status text and bars update; existing scene tiles receive no changed props and do not render again.

A feature-local progress store will hold transient progress for:

- scene detection across the current episode batch;
- lightweight proxy preparation, keyed by source episode;
- compatibility conversion when an unsupported source must be converted.

The status boundary subscribes to this store. The main Scene Splitter panel publishes progress and keeps only durable orchestration state: selected sources, detected scenes, selection, playback preparation results, export state, errors, and whether a run is active.

The progress store is reset when the user chooses a new source set or begins a new detection run. Old events cannot reappear in a later run. Proxy entries are removed when that source finishes, fails, or is invalidated.

Export progress remains owned by the export dialog because it changes export rows and controls that dialog only.

### 2. Proxies start when their scenes become relevant

Starting detection will no longer queue a source proxy for every selected episode.

The existing visibility-driven path remains the only automatic trigger. After scenes exist, a source receives one proxy request when at least one of its tiles enters the active preview area and the source has a usable playback plan. Repeated visibility changes do not queue duplicates while that source is building or after its proxy is ready.

Observable batch behavior:

1. Detection starts for episode 1; no source proxy starts merely because the episode was selected.
2. Episode 1 scenes appear.
3. When episode 1 scenes enter the active preview area, episode 1's proxy can start.
4. Detection continues for episode 2 and later episodes.
5. No later episode proxy starts until one of that episode's scenes enters the active preview area.

This rule applies in CPU and GPU setup modes. Hardware acceleration may make a proxy faster, but it does not change when work is allowed to start. If proxy creation fails, affected tiles retain their existing still-image fallback and the rest of the grid remains usable.

### 3. Each job reports only its own progress

The source-proxy runner will emit only source-proxy progress. It will stop emitting the general conversion stream.

The UI will route progress as follows:

| Job | Visible result | Must not change |
| --- | --- | --- |
| Scene detection | Detection bar, episode label, and detection message | Proxy, conversion, or export state |
| Lightweight source proxy | Preview-preparation bar for that source | Detection message or percentage |
| Compatibility conversion | Compatibility-conversion UI | Detection and export state |
| Clip export or interpolation | Export dialog rows and bars | Detection and proxy state |

If detection and a visible source proxy run at the same time, both bars can move independently. Completing or failing one job does not mark the other complete, erase it, or move it backward.

### 4. Cancellation and stale events

Cancelling detection stops the detection run and leaves already discovered scenes usable, matching current behavior. It does not delete a completed proxy.

Every transient progress update is associated with the current source set or run. When the user starts again, changes sources, or closes the relevant flow, late events from the previous work are ignored or removed rather than appearing in the new status.

## Files expected to change

- `src/features/clips/ClipExtractorPanel.tsx` — remove eager proxy queueing, publish transient progress without subscribing the whole panel, and keep export routing separate.
- `src/features/clips/ClipRunStatus.tsx` — render detection and preview-preparation progress inside the isolated status boundary.
- `src/features/clips/clipRunProgressStore.ts` — own and reset transient Scene Splitter progress.
- `src/features/clips/ClipExtractorPanel.test.tsx` — cover visible-only proxy creation and progress separation.
- `src/features/clips/ClipRunStatus.test.tsx` or `src/features/clips/clipRunProgressStore.test.ts` — cover isolated updates and stale-progress reset.
- `src-tauri/src/video_cmds.rs` and `src-tauri/src/clips.rs` — let source proxies report through their dedicated channel without also reporting as conversions.

Exact file boundaries may be combined if the same observable separation is achieved with less code. The status boundary must remain independently subscribable; merely throttling updates or wrapping the entire grid in memoization does not meet the design.

## Verification

### Automated

- A regression test loads detected scenes, sends repeated detection progress, and proves existing scene tiles do not render again.
- A batch test proves detection does not immediately request proxies for all selected episodes.
- A visibility test proves only the source represented in the active preview area receives a proxy request and that repeated visibility does not duplicate it.
- A progress-routing test proves proxy updates do not replace detection text or percentage.
- A reset test proves a new run cannot display progress left by the previous run.
- Frontend tests, the TypeScript build, and relevant Rust tests pass.

### Manual acceptance

Use at least three episodes with lightweight moving previews enabled:

1. Start batch detection and wait for episode 1 scenes to appear.
2. While episode 2 is processing, scroll through episode 1 and select several scenes.
3. Confirm scrolling and selection stay responsive while the detection bar continues to move.
4. Confirm the detection label remains detection progress if a visible episode 1 proxy starts.
5. Confirm no proxy job starts for episode 2 or 3 before their scenes enter the active preview area.
6. Scroll to later episode scenes and confirm their proxies start on demand and their previews become live when ready.
7. Repeat in CPU and GPU modes. The output and fallback behavior must match; only speed may differ.

## Non-goals

- Replacing the React/WebView Scene Splitter with GPUI.
- Changing scene detection, scene boundaries, seeking, trimming, export encoding, or cache formats.
- Prewarming previews or proxies.
- Reducing the live-preview limit in the first pass.
- Replacing the clip-extraction or proxy engine.

## Follow-up threshold

Only consider a temporary lower moving-preview limit if the manual acceptance run still shows stutter after this change and measurement shows concurrent video decoding—not React grid redraws or unseen proxy work—is the remaining bottleneck. That follow-up must preserve scrolling, selection, still-image fallbacks, and CPU/GPU parity.
