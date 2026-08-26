# Scene Splitter Processing Responsiveness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep detected scenes responsive while later episodes process by isolating progress updates, starting preview proxies only from active scenes, and preventing proxy progress from entering the conversion channel.

**Architecture:** A feature-local external store owns transient detection, proxy, and compatibility-conversion progress. Small status consumers subscribe to that store, while the large Scene Splitter panel publishes updates without subscribing; the populated grid therefore does not render for progress-only changes. Existing visibility information remains the sole proxy trigger, and the Rust progress reader sends a job either to the general conversion channel or to a dedicated side channel, never both.

**Tech Stack:** React 19, TypeScript 5.9, `useSyncExternalStore`, Vitest, Testing Library, Tauri 2, Rust.

**Spec:** `docs/superpowers/specs/2026-08-26-scene-splitter-processing-responsiveness-design.md`

## Global Constraints

- Once the first episode's scenes appear, scrolling, selection, and preview interaction must remain usable while later episodes are detected.
- Starting detection must not queue a source proxy merely because an episode was selected.
- A source proxy may start only after one of that source's scenes enters the active preview area and its playback plan is usable.
- Detection, source-proxy, compatibility-conversion, and export progress must not overwrite one another.
- High-frequency progress updates must not change props received by existing scene tiles.
- Do not lower `MAX_GRID_AUTOPLAYERS`, `MAX_GRID_VIDEO_PLAYERS_CEILING`, or any other moving-preview limit in this change.
- Do not prewarm previews or proxies.
- Preserve CPU/GPU behavior parity, still-image fallback after proxy failure, scene boundaries, seeking, trimming, export behavior, and cache formats.
- Do not replace the WebView renderer, clip extractor, proxy encoder, or any production engine.
- Do not modify or stage the pre-existing `src-tauri/Cargo.toml` change, `discarded/`, or `docs/export-duration-report.md`.
- Use test-driven development: write each regression test, run it and observe the expected failure, then write production code and rerun it.

## File Structure

- Create `src/features/clips/clipRunProgressStore.ts`: one external store for transient Scene Splitter progress plus its React subscription hook.
- Create `src/features/clips/clipRunProgressStore.test.tsx`: store isolation, independent-channel, reset, and stale-generation tests.
- Create `src/features/clips/ClipRunStatus.tsx`: the only populated-grid sibling that subscribes to live detection/proxy progress; also exports the small empty-state message consumer.
- Create `src/features/clips/ClipRunStatus.test.tsx`: proves store updates render the status consumer without rendering its parent or grid sibling.
- Modify `src/features/clips/ClipExtractorPanel.tsx`: publish progress to the store, remove eager proxy starts, keep compatibility/export routing distinct, and render the isolated consumers.
- Modify `src/features/clips/ClipExtractorPanel.test.tsx`: prove a selected multi-episode batch does not queue proxies before scenes exist and visible-source selection remains one-shot.
- Modify `src/features/clips/ClipCompatConvertModal.tsx`: subscribe to compatibility-conversion progress inside the modal instead of receiving high-frequency text through the large panel.
- Modify `src-tauri/src/video_cmds.rs`: choose one progress destination for each FFmpeg run.
- Modify `src-tauri/src/clips.rs`: remove the source proxy's initial general-conversion event and keep only `proxy-progress` lifecycle events.

---

### Task 1: Deliver the responsiveness fix as one integrated vertical slice

These changes share one event contract and one regression surface, so one worker owns the complete slice and commits each green milestone separately.

**Files:**
- Create: `src/features/clips/clipRunProgressStore.ts`
- Create: `src/features/clips/clipRunProgressStore.test.tsx`
- Create: `src/features/clips/ClipRunStatus.tsx`
- Create: `src/features/clips/ClipRunStatus.test.tsx`
- Modify: `src/features/clips/ClipExtractorPanel.tsx`
- Modify: `src/features/clips/ClipExtractorPanel.test.tsx`
- Modify: `src/features/clips/ClipCompatConvertModal.tsx`
- Modify: `src-tauri/src/video_cmds.rs`
- Modify: `src-tauri/src/clips.rs`

**Interfaces:**
- Produces: `ClipRunProgressSnapshot` with `generation`, `detection`, `proxyBySource`, and `compatibility` fields.
- Produces: `beginClipRunProgress(): number`, returning the new generation.
- Produces: `resetClipRunProgress(): number`, clearing all transient channels and returning the new generation.
- Produces: `publishDetectionProgress(generation: number, progress: ClipProgress | null): void`; a stale generation is ignored.
- Produces: `publishProxyProgress(sourcePath: string, percent: number): void` and `removeProxyProgress(sourcePath: string): void`.
- Produces: `publishCompatibilityProgress(progress: ConversionProgress | null): void`.
- Produces: `useClipRunProgressSnapshot(): ClipRunProgressSnapshot` using `useSyncExternalStore`.
- Produces: `ClipRunStatus` and `ClipRunProgressMessage` React components.
- Consumes: existing `ClipProgress`, `ConversionProgress`, active-grid scene ids, playback plans, resolved proxy paths, and per-source in-flight guards.
- Keeps: export progress in the existing export dialog state; the external store must never contain export rows or export percentages.

- [ ] **Step 1: Add failing store tests for independent channels and stale-run rejection**

Create `src/features/clips/clipRunProgressStore.test.tsx` with literal snapshots. Each test names the production break it catches: proxy publication erasing detection, reset retaining old data, and a previous generation changing the new run.

```tsx
import { beforeEach, describe, expect, it } from "vitest";
import {
  beginClipRunProgress,
  getClipRunProgressSnapshot,
  publishCompatibilityProgress,
  publishDetectionProgress,
  publishProxyProgress,
  resetClipRunProgress,
} from "./clipRunProgressStore";

describe("clip run progress channels", () => {
  beforeEach(() => resetClipRunProgress());

  it("keeps detection unchanged when a proxy reports progress", () => {
    const generation = beginClipRunProgress();
    publishDetectionProgress(generation, {
      type: "progress",
      stage: "detecting",
      percent: 37,
      message: "Episode 1/3",
    });
    publishProxyProgress("C:\\episode-1.mkv", 62);
    publishCompatibilityProgress({
      stage: "processing",
      percent: 14,
      message: "Converting episode 3",
    });

    expect(getClipRunProgressSnapshot()).toMatchObject({
      detection: { percent: 37, message: "Episode 1/3" },
      proxyBySource: { "C:\\episode-1.mkv": 62 },
      compatibility: { percent: 14, message: "Converting episode 3" },
    });
  });

  it("clears every transient channel for a new source set", () => {
    const generation = beginClipRunProgress();
    publishDetectionProgress(generation, {
      type: "progress",
      stage: "detecting",
      percent: 45,
      message: "Old run",
    });
    publishProxyProgress("C:\\old.mkv", 20);
    publishCompatibilityProgress({
      stage: "processing",
      percent: 10,
      message: "Old conversion",
    });

    resetClipRunProgress();

    expect(getClipRunProgressSnapshot()).toMatchObject({
      detection: null,
      proxyBySource: {},
      compatibility: null,
    });
  });

  it("ignores detection updates from the previous generation", () => {
    const oldGeneration = beginClipRunProgress();
    const currentGeneration = beginClipRunProgress();
    publishDetectionProgress(oldGeneration, {
      type: "progress",
      stage: "detecting",
      percent: 99,
      message: "Late old event",
    });

    expect(currentGeneration).not.toBe(oldGeneration);
    expect(getClipRunProgressSnapshot().detection).toBeNull();
  });
});
```

- [ ] **Step 2: Run the new store tests and verify the missing module is the only failure**

Run:

```powershell
npx vitest run src/features/clips/clipRunProgressStore.test.tsx
```

Expected: FAIL because `clipRunProgressStore.ts` does not exist. Fix test syntax or fixtures if any unrelated error appears; do not write production code until the failure is specifically the missing behavior.

- [ ] **Step 3: Implement the minimal external store**

Create `src/features/clips/clipRunProgressStore.ts`. Store snapshots must be immutable so `useSyncExternalStore` sees a new object only when a channel actually changes.

```ts
import { useSyncExternalStore } from "react";
import type { ClipProgress } from "../../types/clip";
import type { ConversionProgress } from "../../types/conversion";

export type ClipRunProgressSnapshot = {
  generation: number;
  detection: ClipProgress | null;
  proxyBySource: Readonly<Record<string, number>>;
  compatibility: ConversionProgress | null;
};

const listeners = new Set<() => void>();
let snapshot: ClipRunProgressSnapshot = {
  generation: 0,
  detection: null,
  proxyBySource: {},
  compatibility: null,
};

function replace(next: ClipRunProgressSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

export function getClipRunProgressSnapshot(): ClipRunProgressSnapshot {
  return snapshot;
}

export function subscribeClipRunProgress(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetClipRunProgress(): number {
  const generation = snapshot.generation + 1;
  replace({ generation, detection: null, proxyBySource: {}, compatibility: null });
  return generation;
}

export function beginClipRunProgress(): number {
  return resetClipRunProgress();
}

export function publishDetectionProgress(generation: number, detection: ClipProgress | null): void {
  if (generation !== snapshot.generation) return;
  replace({ ...snapshot, detection });
}

export function publishProxyProgress(sourcePath: string, percent: number): void {
  replace({
    ...snapshot,
    proxyBySource: { ...snapshot.proxyBySource, [sourcePath]: percent },
  });
}

export function removeProxyProgress(sourcePath: string): void {
  if (!(sourcePath in snapshot.proxyBySource)) return;
  const { [sourcePath]: _removed, ...proxyBySource } = snapshot.proxyBySource;
  replace({ ...snapshot, proxyBySource });
}

export function publishCompatibilityProgress(compatibility: ConversionProgress | null): void {
  replace({ ...snapshot, compatibility });
}

export function useClipRunProgressSnapshot(): ClipRunProgressSnapshot {
  return useSyncExternalStore(
    subscribeClipRunProgress,
    getClipRunProgressSnapshot,
    getClipRunProgressSnapshot,
  );
}
```

- [ ] **Step 4: Run the store tests, then commit the green store milestone**

Run:

```powershell
npx vitest run src/features/clips/clipRunProgressStore.test.tsx
```

Expected: 3 tests PASS with no warnings.

Commit only the new store and its test:

```powershell
git add -- src/features/clips/clipRunProgressStore.ts src/features/clips/clipRunProgressStore.test.tsx
git commit -m "refactor: isolate scene splitter run progress"
```

- [ ] **Step 5: Add a failing React isolation test before extracting the status UI**

Create `src/features/clips/ClipRunStatus.test.tsx`. Use a real `ClipRunStatus` and a real sibling probe; do not assert on a mocked component. The observed break is a progress update rendering the grid sibling.

```tsx
import React from "react";
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClipRunStatus } from "./ClipRunStatus";
import {
  beginClipRunProgress,
  publishDetectionProgress,
  resetClipRunProgress,
} from "./clipRunProgressStore";

describe("ClipRunStatus render boundary", () => {
  beforeEach(() => resetClipRunProgress());

  it("updates progress without rendering its parent or grid sibling", () => {
    const gridRender = vi.fn();
    const parentRender = vi.fn();
    function GridProbe() {
      gridRender();
      return <div>scene grid</div>;
    }
    function Harness() {
      parentRender();
      return (
        <>
          <ClipRunStatus
            error={null}
            sceneCount={12}
            displayedClipCount={12}
            hasResult
            isExtracting
            featherweightActive
            resolvedProxySources={[]}
            gridPreview
            readyPreviewCount={0}
            settledPreviewCount={0}
          />
          <GridProbe />
        </>
      );
    }

    render(<Harness />);
    act(() => {
      const generation = beginClipRunProgress();
      publishDetectionProgress(generation, {
        type: "progress",
        stage: "detecting",
        percent: 48,
        message: "Episode 2/3",
      });
    });

    expect(screen.getByText("48%")).toBeInTheDocument();
    expect(parentRender).toHaveBeenCalledTimes(1);
    expect(gridRender).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 6: Run the status test and verify it fails because the component is missing**

Run:

```powershell
npx vitest run src/features/clips/ClipRunStatus.test.tsx
```

Expected: FAIL because `ClipRunStatus.tsx` does not exist.

- [ ] **Step 7: Extract the status card and empty-state message into store subscribers**

Create `src/features/clips/ClipRunStatus.tsx` and move the existing run-card presentation from `ClipExtractorPanel.tsx` into it without changing visible labels or CSS classes. The component must subscribe directly through `useClipRunProgressSnapshot()` and calculate the lowest active proxy percentage from `proxyBySource`, excluding entries named in `resolvedProxySources`.

```tsx
import React from "react";
import { useClipRunProgressSnapshot } from "./clipRunProgressStore";

export type ClipRunStatusProps = {
  error: string | null;
  sceneCount: number;
  displayedClipCount: number;
  hasResult: boolean;
  isExtracting: boolean;
  featherweightActive: boolean;
  resolvedProxySources: readonly string[];
  gridPreview: boolean;
  readyPreviewCount: number;
  settledPreviewCount: number;
};

function formatStage(stage?: string): string {
  switch (stage) {
    case "starting": return "Starting";
    case "dependencies": return "Checking Dependencies";
    case "probe": return "Reading Source";
    case "decode": return "Decoding";
    case "analyze": return "Analyzing";
    case "scenes": return "Building Scenes";
    case "complete": return "Complete";
    default:
      return stage
        ? stage
          .split(/[-_\s]+/)
          .filter(Boolean)
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(" ")
        : "Ready";
  }
}

export function ClipRunStatus(props: ClipRunStatusProps) {
  const { detection, proxyBySource } = useClipRunProgressSnapshot();
  const resolved = React.useMemo(
    () => new Set(props.resolvedProxySources),
    [props.resolvedProxySources],
  );
  const proxyPercent = React.useMemo(() => {
    let lowest: number | null = null;
    for (const [source, percent] of Object.entries(proxyBySource)) {
      if (resolved.has(source)) continue;
      if (lowest === null || percent < lowest) lowest = percent;
    }
    return lowest;
  }, [proxyBySource, resolved]);
  const prepBar = React.useMemo(() => {
    if (props.featherweightActive) {
      if (proxyPercent === null && props.resolvedProxySources.length === 0) return null;
      if (proxyPercent === null) {
        return { label: "Preview proxy", percent: 100, indeterminate: false };
      }
      return {
        label: "Building preview proxy",
        percent: Math.max(0, Math.min(100, proxyPercent)),
        indeterminate: proxyPercent <= 0,
      };
    }
    if (!props.gridPreview || props.displayedClipCount === 0) return null;
    return {
      label: `Caching previews (${props.readyPreviewCount}/${props.displayedClipCount})`,
      percent: Math.round((props.settledPreviewCount / props.displayedClipCount) * 100),
      indeterminate: false,
    };
  }, [
    props.featherweightActive,
    props.resolvedProxySources.length,
    props.gridPreview,
    props.displayedClipCount,
    props.readyPreviewCount,
    props.settledPreviewCount,
    proxyPercent,
  ]);
  if (!detection && !props.error && !props.hasResult) return null;
  const detectionIndeterminate = props.isExtracting && (!detection || detection.percent <= 0);
  const message = props.error ?? (props.hasResult
    ? (props.featherweightActive
      ? `${props.displayedClipCount} scenes ready - live previews`
      : `${props.sceneCount} scenes ready`)
    : detection?.message ?? "");

  return (
    <div className={`clip-run-card glass ${props.error ? "is-error" : ""}`}>
      {(detection || props.error) && (
        <div className="clip-bar-row">
          <div className="clip-run-line">
            <strong>{props.error ? "Extraction failed" : formatStage(detection?.stage)}</strong>
            {detection && !props.error && <span>{Math.round(detection.percent)}%</span>}
          </div>
          {detection && !props.error && (
            <div className={`clip-progress-track ${detectionIndeterminate ? "is-indeterminate" : ""}`}>
              <span
                className="spring-motion"
                style={{ width: `${Math.max(0, Math.min(100, detection.percent))}%` }}
              />
            </div>
          )}
        </div>
      )}
      {!props.error && prepBar && (
        <div className="clip-bar-row">
          <div className="clip-run-line">
            <strong>{prepBar.label}</strong>
            {!prepBar.indeterminate && <span>{prepBar.percent}%</span>}
          </div>
          <div className={`clip-progress-track ${prepBar.indeterminate ? "is-indeterminate" : ""}`}>
            <span className="spring-motion" style={{ width: `${prepBar.percent}%` }} />
          </div>
        </div>
      )}
      <p>{message}</p>
    </div>
  );
}

export function ClipRunProgressMessage({ fallback }: { fallback: string }) {
  const { detection } = useClipRunProgressSnapshot();
  return <>{detection?.message ?? fallback}</>;
}
```

The implementation must copy the existing calculations, not invent new roll-ups: detection uses only `detection.percent`; proxy preparation uses only `proxyBySource`; still-image cache progress uses only ready/settled preview counts.

- [ ] **Step 8: Run the status and store tests, then commit the green UI-boundary milestone**

Run:

```powershell
npx vitest run src/features/clips/clipRunProgressStore.test.tsx src/features/clips/ClipRunStatus.test.tsx
```

Expected: all tests PASS and the parent/grid probes each render exactly once.

Commit only this milestone:

```powershell
git add -- src/features/clips/ClipRunStatus.tsx src/features/clips/ClipRunStatus.test.tsx
git commit -m "refactor: isolate scene splitter status rendering"
```

- [ ] **Step 9: Add failing panel tests for no eager proxy work and one visible source**

Extend `src/features/clips/ClipExtractorPanel.test.tsx`. Import `dispatchTauriEvent` from `tests/setup/tauri` if the file does not already import it.

First test: select `C:\\episode-1.mkv` and `C:\\episode-2.mkv`, enable `featherweight_previews`, and return a pending promise from the first `clip_extract` call. After the extraction command begins but before resolving it, assert that no `build_source_proxy` invocation occurred. This must FAIL against the current eager loop, which requests proxies for both selected files before the first detection result exists.

```tsx
it("does not queue proxies for selected episodes before scenes are visible", async () => {
  let resolveDetection!: (value: string) => void;
  mockInvoke("get_config", () => JSON.stringify({
    clip_extraction_mode: "cpu",
    clip_hover_preview: false,
    featherweight_previews: true,
  }));
  mockInvoke("video_gpu_status", () => JSON.stringify({
    hasHevcNvenc: false,
    hasH264Nvenc: false,
    hasAv1Nvenc: false,
  }));
  mockInvoke("discord_set_state", () => null);
  mockInvoke("discord_clear", () => null);
  mockInvoke("build_source_proxy", () => "C:\\proxy.mp4");
  mockInvoke("clip_extract", () => new Promise<string>((resolve) => {
    resolveDetection = resolve;
  }));
  mockDialogOpen.mockResolvedValueOnce(["C:\\episode-1.mkv", "C:\\episode-2.mkv"]);

  const user = userEvent.setup();
  render(<ClipExtractorPanel active />);
  await user.click(await screen.findByRole("button", { name: /select episodes/i }));
  await user.click(await screen.findByRole("button", { name: /extract clips/i }));
  await waitFor(() => expect(
    mockInvokeFn.mock.calls.some(([command]) => command === "clip_extract"),
  ).toBe(true));

  expect(mockInvokeFn.mock.calls.filter(([command]) => command === "build_source_proxy")).toHaveLength(0);

  resolveDetection(JSON.stringify({
    type: "done",
    mode: "cpu",
    input: "C:\\episode-1.mkv",
    scenes: [],
    cuts: [],
    sceneCount: 0,
    fps: 24,
    duration: 60,
    totalSeconds: 1,
  }));
});
```

Second test: exercise the pure source-selection helper used by the visibility effect. Give it clips from two sources, mark only an episode-1 clip active, and expect exactly `C:\\episode-1.mkv`. Call it again with episode 1 already in flight and expect no sources. The expected arrays must be literal; do not calculate them using the helper.

```tsx
it("requests proxies only for active sources and never duplicates an in-flight source", () => {
  const baseClip = {
    index: 0,
    label: "Scene 1",
    range: "00:01 - 00:03",
    sourceName: "episode",
    sourceSrc: "asset",
    sourceStart: 1,
    sourceEnd: 3,
    previewStart: 1,
    previewEnd: 3,
    fps: 24,
  };
  const episode1Clip = {
    ...baseClip,
    id: "episode-1-scene-1",
    path: "C:\\episode-1.mkv",
  };
  const episode2Clip = {
    ...baseClip,
    id: "episode-2-scene-1",
    path: "C:\\episode-2.mkv",
  };
  const plan = {
    mode: "proxy" as const,
    videoCodec: "hevc",
    audioCodec: "aac",
    width: 1920,
    height: 1080,
    pixFmt: "yuv420p10le",
    container: "matroska",
    inScope: true,
    reasons: ["codec"],
  };
  const input = {
    clips: [episode1Clip, episode2Clip],
    activeClipIds: new Set([episode1Clip.id]),
    playbackPlans: {
      "C:\\episode-1.mkv": plan,
      "C:\\episode-2.mkv": plan,
    },
    resolvedSources: new Set<string>(),
    inFlightSources: new Set<string>(),
  };

  expect(collectProxySourcesForActiveClips(input)).toEqual(["C:\\episode-1.mkv"]);
  expect(collectProxySourcesForActiveClips({
    ...input,
    inFlightSources: new Set(["C:\\episode-1.mkv"]),
  })).toEqual([]);
});
```

- [ ] **Step 10: Run the two panel regressions and verify their expected failures**

Run:

```powershell
npx vitest run src/features/clips/ClipExtractorPanel.test.tsx -t "proxies"
```

Expected: the pre-scene test FAILS because the current extraction start queues proxies, and the active-source test FAILS because the pure helper is not yet exported.

- [ ] **Step 11: Wire the panel to the store and make active visibility the only proxy trigger**

Modify `src/features/clips/ClipExtractorPanel.tsx`:

1. Remove the panel's `progress` and `proxyProgress` React state.
2. Add a `clipProgressGenerationRef` initialized from `getClipRunProgressSnapshot().generation`.
3. In the `clip-progress` listener, ignore events when no detection batch is active; otherwise publish the mapped progress with the current generation. Do not call any React state setter.
4. In `startExtraction`, assign `clipProgressGenerationRef.current = beginClipRunProgress()` and replace every manual detection `setProgress(...)` with `publishDetectionProgress(clipProgressGenerationRef.current, ...)`.
5. In `acceptVideos`, call `resetClipRunProgress()` and store the returned generation.
6. In the `proxy-progress` listener, accept only sources currently present in the proxy in-flight set, then call `publishProxyProgress`. Remove the entry when the proxy resolves, fails, or is invalidated.
7. Remove the loop that calls the proxy builder for every selected video before detection.
8. Extract and export `collectProxySourcesForActiveClips(...)`; make the existing active-visibility effect call it and then request each returned source once.
9. Replace the inline run card with `ClipRunStatus` and the empty-state message with `ClipRunProgressMessage`.
10. Keep result, error, extraction lifecycle, playback plan, proxy path, preview, selection, and export state in the panel.

Use this exact helper contract so the test and effect share the production decision:

```ts
export function collectProxySourcesForActiveClips({
  clips,
  activeClipIds,
  playbackPlans,
  resolvedSources,
  inFlightSources,
}: {
  clips: readonly ClipPreviewItem[];
  activeClipIds: ReadonlySet<string>;
  playbackPlans: Readonly<Record<string, PlaybackPlan>>;
  resolvedSources: ReadonlySet<string>;
  inFlightSources: ReadonlySet<string>;
}): string[] {
  const sources = new Set<string>();
  for (const clip of clips) {
    if (!clip.path || !activeClipIds.has(clip.id)) continue;
    if (!playbackPlans[clip.path]) continue;
    if (resolvedSources.has(clip.path) || inFlightSources.has(clip.path)) continue;
    sources.add(clip.path);
  }
  return [...sources];
}
```

- [ ] **Step 12: Route compatibility conversion inside its modal without rendering the panel**

In the panel's `conversion-progress` listener:

- If an export session is active, retain the existing export-row update and return.
- Else, publish the event to `compatibility` only while compatibility conversion is active.
- Otherwise ignore it; a source proxy is not a compatibility conversion.

Mirror `isConverting` into a ref so the event listener reads current state without resubscribing. Remove the panel's high-frequency `convertMessage` state. At conversion start, publish a `starting` compatibility message; clear compatibility progress on success, failure, modal dismissal, source replacement, and new detection start.

Modify `ClipCompatConvertModal.tsx` to call `useClipRunProgressSnapshot()` and render `compatibility?.message ?? "Converting to compatible format..."` while converting. Remove its `convertMessage` prop.

- [ ] **Step 13: Run the focused frontend tests, then commit the green frontend integration**

Run:

```powershell
npx vitest run src/features/clips/clipRunProgressStore.test.tsx src/features/clips/ClipRunStatus.test.tsx src/features/clips/ClipExtractorPanel.test.tsx
```

Expected: all focused tests PASS. The pre-scene batch test reports zero proxy requests; the helper returns only the active source; status updates leave the grid probe at one render.

Commit only the frontend integration files:

```powershell
git add -- src/features/clips/ClipExtractorPanel.tsx src/features/clips/ClipExtractorPanel.test.tsx src/features/clips/ClipCompatConvertModal.tsx
git commit -m "fix: keep scene grid responsive during detection"
```

- [ ] **Step 14: Add a failing Rust policy test for exclusive progress routing**

Append a test module to `src-tauri/src/video_cmds.rs` before changing the FFmpeg runner. The test must prove an ordinary conversion uses the general channel while a run with a dedicated progress tap suppresses it.

```rust
#[cfg(test)]
mod tests {
    use super::should_emit_shared_conversion_progress;

    #[test]
    fn dedicated_progress_tap_suppresses_shared_conversion_events() {
        assert!(should_emit_shared_conversion_progress(false));
        assert!(!should_emit_shared_conversion_progress(true));
    }
}
```

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml dedicated_progress_tap_suppresses_shared_conversion_events
```

Expected: FAIL because `should_emit_shared_conversion_progress` does not exist.

- [ ] **Step 15: Make FFmpeg progress choose one destination and remove the proxy's shared start event**

In `src-tauri/src/video_cmds.rs`, add:

```rust
fn should_emit_shared_conversion_progress(has_progress_tap: bool) -> bool {
    !has_progress_tap
}
```

Inside `run_ffmpeg_with_progress_tap`, calculate the policy once:

```rust
let emit_shared_progress = should_emit_shared_conversion_progress(progress_tap.is_some());
```

Guard all three general-channel emissions in that function—processing, finalizing, and complete—with `if emit_shared_progress`. Continue sending all tapped processing/finalizing updates exactly as before. The wrapper without a tap must preserve current conversion behavior.

In `src-tauri/src/clips.rs`, delete the source proxy's initial call that emits `"Building preview proxy..."` through `conversion-progress`. Keep the existing source-specific starting, processing, finalizing, complete, and error lifecycle on `proxy-progress`.

Update nearby comments so they state that a tapped run replaces the shared conversion stream; do not leave comments claiming both streams fire.

- [ ] **Step 16: Run Rust verification, then commit the green backend routing milestone**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml dedicated_progress_tap_suppresses_shared_conversion_events
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: the policy test and full Rust suite PASS.

Commit only the two Rust source files; do not stage the dirty manifest:

```powershell
git add -- src-tauri/src/video_cmds.rs src-tauri/src/clips.rs
git commit -m "fix: separate proxy and conversion progress"
```

- [ ] **Step 17: Run the complete verification gate**

Run each command fresh and read the complete result:

```powershell
npm run test:js
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
git diff --check HEAD~4..HEAD
git status --short
```

Expected:

- All frontend tests pass with zero failures.
- TypeScript and Vite build successfully.
- All Rust tests pass with zero failures.
- The implementation commits contain no whitespace errors.
- `src-tauri/Cargo.toml`, `discarded/`, and `docs/export-duration-report.md` remain present exactly as pre-existing uncommitted work and are absent from every implementation commit.

- [ ] **Step 18: Perform the manual acceptance run if the desktop app and three episodes are available**

Start the existing desktop development command; do not build an installer:

```powershell
npm run desktop
```

With three episodes and lightweight previews enabled, observe:

1. No proxy starts before the first scenes exist.
2. Episode 1 scenes scroll and select normally while episode 2 detection continues.
3. The detection label and percentage remain detection data while episode 1's visible proxy builds.
4. Episodes 2 and 3 do not start proxies until their own scenes enter the active preview area.
5. A failed proxy leaves still images usable.
6. Repeat the same run once in CPU mode and once in GPU mode; only elapsed time may differ.

If representative episodes or a usable desktop runtime are unavailable, record that manual acceptance was not run; do not claim it passed. Automated verification remains mandatory.
