import React from "react";
import { CheckCircle2, Circle, Layers } from "lucide-react";
import type { ClipPreviewItem, ClipVideoRange } from "../../types/clip";
import { useOffsetLoop } from "./useOffsetLoop";
import { usePlaylistLoop, type PlaylistSegment } from "./usePlaylistLoop";
import {
  clearOffsetMetrics,
  reportOffsetMetrics,
  usePreviewTunables,
} from "../../dev/previewTunables";
// NOTE: the per-tile IntersectionObserver play-area gate (useInPlayArea) has been
// RETIRED from the mount decision. The panel's central, geometry-driven,
// hard-capped mount set (ClipExtractorPanel -> mayMountVideoIds) is now the SOLE
// authority for which tiles may mount a live offset <video>, so the union of
// live decoders can never exceed the decoder ceiling under a fast fling. This
// tile only consults the `mayMountVideo` prop (plus a hover exemption).

// Tiny epsilon (seconds) below which a segment is treated as starting at the
// head of its source file, so we keep its opening frames (no inward start
// margin). Roughly half a frame at 60fps — well under any real scene gap.
const HEAD_START_EPSILON_SEC = 0.008;

/**
 * SHARED MARGIN HELPER — the single source of truth for OffsetVideoLayer's
 * inward-margined loop window.
 *
 * Reproduces VERBATIM the prior inline window math (raw startMarginFrames/fps
 * and endMarginFrames/fps from the tunables, with the degenerate-window guard)
 * and adds ONE head exemption: when the segment's OWN file-relative start is at
 * (or before) the head epsilon, the inward START margin is skipped so a scene
 * that begins at 0 keeps its opening frames. The exemption keys on the
 * file-relative start VALUE only — never on any global index or position.
 *
 * Inputs are file-relative seconds (sourceStart/sourceEnd of ONE segment).
 * Returns the margined [startSec, endSec] to hand to useOffsetLoop.
 */
export function offsetMarginWindow(
  sourceStart: number,
  sourceEnd: number,
  fps: number,
  startMarginFrames: number,
  endMarginFrames: number,
): { startSec: number; endSec: number } {
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 24;
  // Head exemption: a segment that begins at the very head of its file keeps its
  // opening frames (no inward start margin). Keyed on the file-relative start.
  const atHead = sourceStart <= HEAD_START_EPSILON_SEC;
  const startMargin = atHead ? 0 : startMarginFrames / safeFps;
  const rawStart = Math.max(0, sourceStart + startMargin);
  const rawEnd = sourceEnd - endMarginFrames / safeFps;
  // Guard a degenerate window (margins wider than the clip): fall back to the
  // bare source range so we still loop something rather than seek past the end.
  const startSec = rawEnd > rawStart ? rawStart : Math.max(0, sourceStart);
  const endSec = rawEnd > rawStart ? rawEnd : sourceEnd;
  return { startSec, endSec };
}

// Currently dead code : see FINDINGS.md. Moved here unchanged during the
// main.tsx split to keep that work move-only.
function sourceClipPlaybackRange(clip: ClipPreviewItem): ClipVideoRange {
  const safeFps = Number.isFinite(clip.fps) && clip.fps > 0 ? clip.fps : 24;
  const offset = clip.index === 0 || clip.sourceStart <= 0 ? 0 : 1.5 / safeFps;
  return {
    id: `${clip.id}-source`,
    src: clip.sourceSrc,
    start: clip.sourceStart + offset,
    end: clip.sourceEnd,
  };
}
void sourceClipPlaybackRange;

function previewClipPlaybackRange(clip: ClipPreviewItem): ClipVideoRange | null {
  const state = clip.previewState;
  if (state?.status !== "ready" || !state.src || !state.duration) return null;
  return {
    id: `${clip.id}-preview`,
    src: state.src,
    start: 0,
    end: state.duration,
  };
}

// SINGLE-SOURCE MERGES ONLY: shown as a tooltip when a tile from a different
// source can't join the in-progress merge selection.
const MERGE_DISABLED_REASON = "Merge clips from one episode only";

const THUMBNAIL_CACHE = new Map<string, string>();

function useWebpThumbnail(src: string | undefined) {
  const [thumbnail, setThumbnail] = React.useState<string | null>(() =>
    src ? (THUMBNAIL_CACHE.get(src) ?? null) : null,
  );

  React.useEffect(() => {
    if (!src) {
      setThumbnail(null);
      return;
    }
    const cached = THUMBNAIL_CACHE.get(src);
    if (cached) {
      setThumbnail(cached);
      return;
    }

    let cancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (cancelled) return;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth || 426;
        canvas.height = img.naturalHeight || 240;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.75);
        THUMBNAIL_CACHE.set(src, dataUrl);
        setThumbnail(dataUrl);
      } catch (e) {
        console.error("Failed to generate clip thumbnail:", e);
      }
    };
    img.src = src;

    return () => {
      cancelled = true;
      img.onload = null;
    };
  }, [src]);

  return thumbnail;
}

export function ClipPreviewTile({
  clip,
  selected,
  mergeMode,
  mergeDisabled = false,
  mergePosition,
  paused,
  playable,
  activationEpoch,
  clipHoverPreview,
  featherweightEnabled,
  playbackPending = false,
  mayMountVideo = false,
  onClick,
  onToggleSelect,
}: {
  clip: ClipPreviewItem;
  selected: boolean;
  mergeMode: boolean;
  /* SINGLE-SOURCE MERGES ONLY: true while a merge is locked to a different
   * source, so this tile can't join. The corner-select renders disabled with a
   * reason tooltip and its add interaction is a no-op. Already-selected tiles
   * are never passed mergeDisabled, so removal still works. */
  mergeDisabled?: boolean;
  mergePosition: number | null;
  paused: boolean;
  playable: boolean;
  activationEpoch: number;
  clipHoverPreview: boolean;
  /* DEV TOOLS: featherweight flag (config-gated; prod default false). When off,
   * the tile renders byte-for-byte as before — pure WebP grid. */
  featherweightEnabled: boolean;
  /* STEP D — GRACEFUL POSTER. featherweight only: true while a playback source
   * for this tile is genuinely being resolved/built (plan probe in flight or the
   * shared proxy still building). When false AND there's no playbackSrc, a merge
   * shows a STATIC "Merged · N clips" card instead of an indefinite spinner.
   * Ignored entirely flag-off. */
  playbackPending?: boolean;
  /* DEV TOOLS (featherweight only): the SOLE authoritative mount permission for
   * this tile's live offset <video>. Computed by the panel's central,
   * geometry-driven, hard-capped mount set (ClipExtractorPanel -> mayMountVideoIds):
   * the nearest-to-viewport-center tiles within the pre-play band, capped at the
   * decoder ceiling and held (no NEW grants) during a fast fling. This REPLACES
   * the retired per-tile IntersectionObserver decision, so the live-<video> union
   * can never exceed the ceiling. A hovered tile gets a +1 exemption in the gate
   * below so hover-to-play still works for a tile outside the capped set. Defaults
   * false so flag-off and existing callers/tests are byte-for-byte unchanged. */
  mayMountVideo?: boolean;
  onClick: (modifiers: { ctrl: boolean; shift: boolean }) => void;
  onToggleSelect: () => void;
}) {
  const [isHovered, setIsHovered] = React.useState(false);
  const tunables = usePreviewTunables();
  const tileRef = React.useRef<HTMLDivElement | null>(null);

  const previewRange = previewClipPlaybackRange(clip);
  const isPlayActive = !clipHoverPreview || isHovered;
  const shouldPlay = Boolean(previewRange) && playable && !paused && isPlayActive;
  // In featherweight mode the tile never shows a baked WebP, so don't bake a
  // thumbnail from one (previewRange is null anyway). Flag-off path unchanged.
  const thumbnail = useWebpThumbnail(featherweightEnabled ? undefined : previewRange?.src);

  // Featherweight offset <video> gate — DECOUPLED from WebP readiness. The live
  // <video> mounts on PLAYBACK readiness, not on the baked WebP existing:
  //   - the featherweight flag is on (config-gated; prod default false),
  //   - the panel's central geometry-driven mount set granted this tile a slot
  //     (mayMountVideo), so the live-<video> union is hard-capped at the decoder
  //     ceiling and never spikes past Chromium's ~75 limit under a fast fling,
  //   - grid preview is running (!paused) and hover-gating (if any) is satisfied,
  //   - and the source's PlaybackPlan has resolved a playbackSrc.
  // `videoErrored` latches a <video> failure back to the neutral placeholder for
  // the life of this clip so a misclassified source never shows a black tile.
  const [videoErrored, setVideoErrored] = React.useState(false);
  React.useEffect(() => {
    setVideoErrored(false);
  }, [clip.playbackSrc]);
  // Central, hard-capped mount permission (mayMountVideo) is the SOLE authority
  // for the steady-state set; the per-tile IntersectionObserver was retired. The
  // `|| isHovered` is a deliberate +1 exemption so a HOVERED tile that fell
  // outside the capped set still plays on hover (at most one extra decoder beyond
  // the cap, which the ceiling is chosen conservatively to absorb).
  const featherweightPlayReady = (mayMountVideo || isHovered) && !paused && isPlayActive;
  // STEP C — a NON-contiguous single-source merge (jumping playlist) is the only
  // case routed through OffsetPlaylistLayer: a unified clip that is NOT contiguous.
  // Single clips and contiguous merges keep OffsetVideoLayer. The two gates are
  // mutually exclusive (useOffsetVideo excludes the non-contiguous-merge case).
  const isNonContiguousMerge =
    clip.isUnified === true && clip.isContiguous !== true;
  const useOffsetPlaylist =
    featherweightEnabled &&
    isNonContiguousMerge &&
    featherweightPlayReady &&
    Boolean(clip.playbackSrc) &&
    !videoErrored;
  const useOffsetVideo =
    featherweightEnabled &&
    !isNonContiguousMerge &&
    featherweightPlayReady &&
    Boolean(clip.playbackSrc) &&
    !videoErrored;
  // Either live layer counts as "the video is up" for the neutral placeholder.
  const useOffsetLive = useOffsetVideo || useOffsetPlaylist;
  // STEP D — GRACEFUL POSTER. A featherweight MERGE with no resolvable
  // playbackSrc and nothing pending (proxy not yet built / unplayable source)
  // must NOT spin forever: show a static "Merged · N clips" card instead. The
  // spinner is reserved for a build that is genuinely in-flight (playbackPending).
  // Single clips and contiguous merges keep their current loading behavior.
  // FIX B — also cover the built-then-errored merge: a proxy that built
  // (clip.playbackSrc set) but whose <video> then errored latches videoErrored,
  // so the live layer is torn down. Without `|| videoErrored` here neither the
  // live layer nor the poster would show -> spinner forever. Single clips
  // (isUnified !== true) are unaffected, and flag-off is unchanged.
  const isMergeWithoutSource =
    featherweightEnabled &&
    clip.isUnified === true &&
    (!clip.playbackSrc || videoErrored);
  const showMergedPoster = isMergeWithoutSource && !playbackPending;
  // Featherweight: the base layer is always the neutral placeholder (never a
  // baked WebP). It "loads" whenever this tile is in the play window but the
  // live <video> isn't up yet (load gap / beyond budget / plan not resolved)
  // — EXCEPT a merge with no source and no pending build, which shows the static
  // merged poster (no spinner) instead. Flag-off keeps the WebP-driven
  // placeholderLoading verbatim.
  const placeholderLoading = featherweightEnabled
    ? featherweightPlayReady && !useOffsetLive && !showMergedPoster
    : playable && clip.previewState?.status !== "error";
  const loopDuration = previewRange
    ? Math.max(0.45, previewRange.end - previewRange.start)
    : 0;
  const [isReady, setIsReady] = React.useState(false);

  // Bumps on every shouldPlay false→true transition inside this mounted
  // tile (hover replay, playable cap flips). Combined with activationEpoch
  // it forces Chromium to re-decode from frame 0 so the animated image
  // and the CSS progress bar restart in lockstep. Init is 0 (NOT
  // Date.now()) so Virtuoso scroll-recycle remounts reuse the browser's
  // disk-decoded WebP cache instead of re-fetching every time a tile
  // re-enters the overscan window — a per-mount-unique URL would
  // re-decode the entire visible grid on every long scroll.
  const [playToken, setPlayToken] = React.useState(0);
  const wasPlayingRef = React.useRef(shouldPlay);
  React.useLayoutEffect(() => {
    if (shouldPlay && !wasPlayingRef.current) {
      setPlayToken((value) => value + 1);
    }
    wasPlayingRef.current = shouldPlay;
  }, [shouldPlay]);

  React.useEffect(() => {
    setIsReady(false);
  }, [previewRange?.src, activationEpoch, playToken]);

  return (
    <div
      ref={tileRef}
      className={`clip-preview-tile-wrapper ${selected ? "is-selected" : ""}`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <button
        type="button"
        className={`clip-preview-tile spring-motion ${selected ? "is-selected" : ""} ${mergeMode ? "is-selectable" : ""} ${mergeMode && mergeDisabled ? "is-merge-disabled" : ""}`}
        title={mergeMode && mergeDisabled ? MERGE_DISABLED_REASON : undefined}
        onClick={(e) => {
          // SINGLE-SOURCE MERGES ONLY: in merge mode a cross-source tile can't
          // join, so its click is a no-op (the panel guards adds too).
          if (mergeMode && mergeDisabled) return;
          onClick({ ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
        }}
      >
        {/* Base layer: the static thumbnail when we have one, placeholder otherwise. */}
        {/* Stays mounted while shouldPlay flips so the animated WebP fades in over */}
        {/* a matching frame instead of an empty/stale slot — fixes hover ghost-morph. */}
        {thumbnail ? (
          <img src={thumbnail} alt="" className="is-ready clip-static-thumbnail" />
        ) : (
          <span
            className={`clip-video-placeholder ${((!featherweightEnabled && shouldPlay && !isReady) || placeholderLoading) ? "is-loading" : ""}`}
          />
        )}
        {/* STEP D — GRACEFUL POSTER. A featherweight merge with no resolvable */}
        {/* playbackSrc and nothing building shows a neutral static card instead */}
        {/* of an indefinite spinner (fixes the reported infinite-spinner). */}
        {showMergedPoster && (
          <span className="clip-merged-poster" aria-hidden="true">
            <span className="clip-merged-poster-mark">
              <Layers size={22} strokeWidth={2.25} />
            </span>
            <span className="clip-merged-poster-label">
              Merged · {clip.segmentCount ?? clip.segments?.length ?? 0} clips
            </span>
          </span>
        )}
        {/* DEV TOOLS: featherweight offset <video> — replaces the animated WebP */}
        {/* overlay for this tile when the flag is on, this tile is inside the */}
        {/* IntersectionObserver play area, and the source's playbackSrc resolved. */}
        {/* On any <video> error it latches back to the WebP path below. */}
        {useOffsetVideo && clip.playbackSrc ? (
          <OffsetVideoLayer
            metricId={clip.id}
            src={clip.playbackSrc}
            sourceStart={clip.sourceStart}
            sourceEnd={clip.sourceEnd}
            fps={clip.fps}
            /* STEP D — CONTIGUOUS MERGE: a unified clip's sourceStart/sourceEnd
             * are a SYNTHETIC summary range, not real file times, so the layer's
             * own margin math would window the wrong span. Hand it the explicit
             * [previewStart, previewEnd] window (the joined continuous range on the
             * single shared source) instead. Single clips pass nothing here, so
             * they keep using the margin helper on their real source times —
             * byte-for-byte unchanged. */
            previewStart={clip.isContiguous ? clip.previewStart : undefined}
            previewEnd={clip.isContiguous ? clip.previewEnd : undefined}
            onError={() => setVideoErrored(true)}
          />
        ) : useOffsetPlaylist && clip.playbackSrc ? (
          /* STEP C — NON-CONTIGUOUS MERGE: a jumping single-source playlist. ONE
           * <video> on the shared playbackSrc, driven through usePlaylistLoop over
           * the stored-order per-segment [previewStart, previewEnd] windows. Mutually
           * exclusive with OffsetVideoLayer above (a unified non-contiguous clip is
           * never routed to OffsetVideoLayer). Latches back to the WebP path on error. */
          <OffsetPlaylistLayer
            metricId={clip.id}
            src={clip.playbackSrc}
            segments={clip.segments ?? []}
            onError={() => setVideoErrored(true)}
          />
        ) : (
          /* Legacy animated-WebP overlay — flag-off only. In featherweight mode
           * the live <video> above is the sole motion layer; non-playing tiles
           * keep the neutral placeholder. */
          !featherweightEnabled &&
          shouldPlay &&
          previewRange && (
            <img
              key={`${previewRange.id}-${activationEpoch}-${playToken}`}
              src={`${previewRange.src}?v=${activationEpoch}-${playToken}`}
              alt=""
              className={`clip-animated-overlay ${isReady ? "is-ready" : "is-loading"}`}
              onLoad={() => setIsReady(true)}
              onError={() => setIsReady(false)}
            />
          )
        )}
        {!featherweightEnabled && !useOffsetVideo && shouldPlay && previewRange && isReady && (
          <span
            className="clip-loop-progress"
            style={{ "--clip-loop-duration": `${loopDuration}s` } as React.CSSProperties}
            aria-hidden="true"
          >
            <span key={`${previewRange.id}-${activationEpoch}-${playToken}`} />
          </span>
        )}
        <span className="clip-tile-scrim" />
        <span className="clip-source-badge">
          {clip.isUnified
            ? /* STEP D — featherweight surfaces the merge fan-in count ("Merged
               * x3"); flag-off keeps the literal "Merged" badge byte-for-byte. */
              featherweightEnabled
              ? `Merged x${clip.segmentCount ?? clip.segments?.length ?? 0}`
              : "Merged"
            : clip.sourceName}
        </span>
        <span className="clip-tile-meta">
          <strong>{clip.label}</strong>
          <small>{clip.range}</small>
        </span>
        {mergeMode && mergePosition != null && (
          <span key={mergePosition} className="clip-merge-badge" aria-hidden="true">
            {mergePosition}
          </span>
        )}
      </button>
      <button
        type="button"
        className={`clip-corner-select spring-motion ${selected ? "is-selected" : ""} ${mergeMode && mergePosition != null ? "is-merge" : ""} ${mergeMode && mergeDisabled ? "is-merge-disabled" : ""}`}
        disabled={mergeMode && mergeDisabled}
        title={mergeMode && mergeDisabled ? MERGE_DISABLED_REASON : undefined}
        onClick={(e) => {
          e.stopPropagation();
          // SINGLE-SOURCE MERGES ONLY: cross-source tile can't be added.
          if (mergeMode && mergeDisabled) return;
          onToggleSelect();
        }}
        aria-label={
          mergeMode
            ? mergeDisabled
              ? MERGE_DISABLED_REASON
              : mergePosition != null
                ? `Remove from merge (position ${mergePosition})`
                : "Add to merge"
            : selected
              ? "Deselect clip"
              : "Select clip"
        }
      >
        {mergeMode ? (
          mergePosition != null ? (
            <span className="clip-corner-num">{mergePosition}</span>
          ) : (
            <Circle size={20} strokeWidth={2.5} />
          )
        ) : selected ? (
          <CheckCircle2 size={20} strokeWidth={2.5} />
        ) : (
          <Circle size={20} strokeWidth={2.5} />
        )}
      </button>
    </div>
  );
}

/* DEV TOOLS: featherweight offset <video> layer. Mounts a single muted,
 * playsInline <video> on the resolved playbackSrc and loops the margined window
 * [sourceStart + startMargin, sourceEnd - endMargin] via the PROVEN useOffsetLoop
 * hook (rVFC, timeupdate fallback). Reads margins / forceFallback from the shared
 * tunables store — in prod that store equals the baked constants, so this is a
 * constant read; in DEV the panel live-edits it. Reports its boundary overshoot
 * to the DEV metrics registry so the panel's live readout works. */
function OffsetVideoLayer({
  metricId,
  src,
  sourceStart,
  sourceEnd,
  fps,
  previewStart,
  previewEnd,
  onError,
}: {
  metricId: string;
  src: string;
  sourceStart: number;
  sourceEnd: number;
  fps: number;
  /* OPTIONAL explicit inward-padded loop window (seconds on the playback
   * source). When BOTH are finite this window is used verbatim; otherwise the
   * layer falls back to its own sourceStart/sourceEnd margin computation. A
   * caller that passes neither behaves byte-for-byte as before — pure superset. */
  previewStart?: number;
  previewEnd?: number;
  onError: () => void;
}) {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const tunables = usePreviewTunables();

  // Per-clip progress bar fill: driven imperatively from the offset-video's real
  // rVFC position (useOffsetLoop onProgress) — zero React re-render per frame.
  const progressFillRef = React.useRef<HTMLSpanElement | null>(null);
  const handleProgress = React.useCallback((p: number) => {
    const el = progressFillRef.current;
    if (el) el.style.transform = `scaleX(${p})`;
  }, []);

  // Window selection (PURE SUPERSET of the prior behavior):
  //  - PREFER an explicit [previewStart, previewEnd] window when both are passed
  //    and finite (the contiguous-merge / previewStart-aware path).
  //  - Otherwise fall back to the shared margin helper, which reproduces the
  //    prior inline math (raw startMargin/endMargin from the tunables + the
  //    degenerate-window guard) plus the head exemption. A caller that passes no
  //    previewStart/End behaves byte-for-byte as before.
  // Either way useOffsetLoop receives the margined window and never touches the
  // raw seam — turn the loop around a few frames BEFORE the cut, start a few
  // frames AFTER it, so the loop never shows the adjacent scene's frame.
  const hasExplicitWindow =
    Number.isFinite(previewStart) &&
    Number.isFinite(previewEnd) &&
    (previewEnd as number) > (previewStart as number);
  const margined = offsetMarginWindow(
    sourceStart,
    sourceEnd,
    fps,
    tunables.startMarginFrames,
    tunables.endMarginFrames,
  );
  const startSec = hasExplicitWindow ? (previewStart as number) : margined.startSec;
  const endSec = hasExplicitWindow ? (previewEnd as number) : margined.endSec;

  // Manage the <video> src IMPERATIVELY (not via a declarative `src` prop) so the
  // decoder-release on unmount can't fight React's reconciliation. Prior bug: a
  // cleanup elsewhere stripped the src (removeAttribute + load) to free the
  // decoder, but on any effect re-run / React StrictMode remount React did NOT
  // re-apply the unchanged `src` prop, leaving the element permanently
  // source-less (networkState NO_SOURCE, readyState 0 -> black tile). Setting src
  // here on every mount restores it after a StrictMode fake-unmount; the cleanup
  // still releases the decoder on a real unmount or src change.
  React.useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    if (video.getAttribute("src") !== src) {
      video.src = src;
      video.load();
    }
    return () => {
      // SYNCHRONOUS decoder release: pause BEFORE detaching the source so the
      // decode pipeline stops in THIS tick rather than on a later abort task.
      // Under fling churn (doubled by StrictMode's mount->cleanup->mount in DEV),
      // an async release backlog let in-flight decoders pile up past Chromium's
      // ~75 limit. Pausing first shortens that release window.
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [src]);

  useOffsetLoop(videoRef, {
    startSec,
    endSec,
    active: true,
    forceFallback: tunables.forceTimeupdateFallback,
    onProgress: handleProgress,
  });

  // Feed the DEV panel's live readout: report this player as active and measure
  // its worst boundary overshoot (how far currentTime drifts past the margined
  // end before the loop snaps back). Cleared on unmount so activeCount is exact.
  React.useEffect(() => {
    const video = videoRef.current;
    reportOffsetMetrics(metricId, { maxOvershootMs: 0 });
    if (!video) return () => clearOffsetMetrics(metricId);
    let maxOvershootMs = 0;
    const id = window.setInterval(() => {
      const overshoot = (video.currentTime - endSec) * 1000;
      if (overshoot > maxOvershootMs) {
        maxOvershootMs = overshoot;
        reportOffsetMetrics(metricId, { maxOvershootMs });
      }
    }, 100);
    return () => {
      window.clearInterval(id);
      clearOffsetMetrics(metricId);
    };
  }, [metricId, endSec]);

  return (
    <>
      <video
        ref={videoRef}
        muted
        playsInline
        preload="metadata"
        className="clip-offset-video"
        onError={onError}
      />
      {/* Per-clip progress bar, driven imperatively (scaleX) from the offset-video's
          real loop position via handleProgress — no CSS animation, no per-frame React. */}
      <span className="clip-offset-progress" aria-hidden="true">
        <span ref={progressFillRef} className="clip-offset-progress-fill" />
      </span>
    </>
  );
}

/* DEV TOOLS: featherweight offset PLAYLIST layer — the OffsetVideoLayer sibling for
 * a NON-contiguous single-source merge. Mounts ONE muted, playsInline <video> on the
 * merge's single shared playbackSrc and plays the clip's per-segment
 * [previewStart, previewEnd] windows back-to-back (STORED array order authoritative)
 * via the STANDALONE usePlaylistLoop hook (rVFC + timeupdate, duplicated engine — it
 * does NOT touch useOffsetLoop / single-clip playback). Because USER DECISIONS lock
 * merges to a single source, every advance is a same-file seek — no src swap.
 *
 * Uses the SAME imperative-src management as OffsetVideoLayer (set video.src in a [src]
 * effect, removeAttribute('src')+load() in its cleanup; NO declarative src prop) — this
 * preserves the black-tile fix where a declarative src stripped on a StrictMode /
 * effect re-run was never re-applied. onError latches videoErrored in the parent. */
function OffsetPlaylistLayer({
  metricId,
  src,
  segments,
  onError,
}: {
  metricId: string;
  src: string;
  /* The unified clip's stored segments. Only ones with a finite
   * [previewStart, previewEnd] window are played, in stored order. */
  segments: NonNullable<ClipPreviewItem["segments"]>;
  onError: () => void;
}) {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const tunables = usePreviewTunables();

  // Map the clip's stored segments (stored order preserved) to the hook's window
  // shape, keeping only those with a finite, non-degenerate [previewStart, previewEnd]
  // (Step A populates these for every non-contiguous-merge segment). Memoized so a
  // stable window set never re-arms the loop engine on a parent re-render.
  const playlistSegments = React.useMemo<PlaylistSegment[]>(
    () =>
      segments
        .filter(
          (seg) =>
            Number.isFinite(seg.previewStart) &&
            Number.isFinite(seg.previewEnd) &&
            (seg.previewEnd as number) > (seg.previewStart as number),
        )
        .map((seg) => ({
          previewStart: seg.previewStart as number,
          previewEnd: seg.previewEnd as number,
        })),
    [segments],
  );
  const segCount = playlistSegments.length;

  // STEP D — SEGMENTED FILMSTRIP + NOW-PLAYING PILL, driven imperatively from the
  // playlist loop's real rVFC position (usePlaylistLoop onProgress) — zero React
  // re-render per frame, mirroring the single-clip clip-offset-progress approach.
  //  - cellFillRefs: one fill <span> per segment cell (STRICT clip.segments order).
  //    Cells BEFORE the active index render full (scaleX 1), the ACTIVE cell fills
  //    to `fraction`, cells AFTER render empty (scaleX 0). On a wrap (segIndex drops
  //    below the last index we saw) everything resets to 0 first.
  //  - pillRef: the 'i/N' now-playing indicator text (1-based), shown on hover via CSS.
  const cellFillRefs = React.useRef<Array<HTMLSpanElement | null>>([]);
  const pillRef = React.useRef<HTMLSpanElement | null>(null);
  const lastSegIndexRef = React.useRef<number>(-1);
  // Keep the cell-ref array length in lockstep with the rendered cell count so the
  // handler's `cells.length` never counts stale slots from a longer previous render.
  cellFillRefs.current.length = segCount;

  const handleProgress = React.useCallback(
    (segIndex: number, fraction: number) => {
      const cells = cellFillRefs.current;
      const n = cells.length;
      if (n === 0) return;
      const clamped = segIndex < 0 ? 0 : segIndex >= n ? n - 1 : segIndex;
      // Wrap detection: when the playlist loops back to an earlier segment, clear
      // every cell first so trailing fills from the previous pass don't linger.
      if (clamped < lastSegIndexRef.current) {
        for (let i = 0; i < n; i++) {
          const el = cells[i];
          if (el) el.style.transform = "scaleX(0)";
        }
      }
      lastSegIndexRef.current = clamped;
      for (let i = 0; i < n; i++) {
        const el = cells[i];
        if (!el) continue;
        const scale = i < clamped ? 1 : i > clamped ? 0 : fraction;
        el.style.transform = `scaleX(${scale})`;
      }
      const pill = pillRef.current;
      if (pill) pill.textContent = `${clamped + 1}/${n}`;
    },
    [],
  );

  // Manage the <video> src IMPERATIVELY (see OffsetVideoLayer for the full rationale):
  // a declarative `src` prop gets stripped by the unmount decoder-release and is not
  // re-applied on a StrictMode / effect re-run, leaving the element source-less (black
  // tile). Setting src here on every mount restores it; the cleanup releases the
  // decoder on a real unmount or src change.
  React.useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    if (video.getAttribute("src") !== src) {
      video.src = src;
      video.load();
    }
    return () => {
      // SYNCHRONOUS decoder release (see OffsetVideoLayer): pause BEFORE
      // detaching the source so the decode stops this tick, shortening the
      // async-release backlog under fling churn / StrictMode remounts.
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [src]);

  usePlaylistLoop(videoRef, {
    segments: playlistSegments,
    active: true,
    forceFallback: tunables.forceTimeupdateFallback,
    onProgress: handleProgress,
  });

  // Feed the DEV panel's live readout: report this player as active (overshoot is the
  // playlist's drift past the current segment's end before it advances). Cleared on
  // unmount so activeCount stays exact.
  React.useEffect(() => {
    reportOffsetMetrics(metricId, { maxOvershootMs: 0 });
    return () => clearOffsetMetrics(metricId);
  }, [metricId]);

  return (
    <>
      <video
        ref={videoRef}
        muted
        playsInline
        preload="metadata"
        className="clip-offset-video"
        onError={onError}
      />
      {/* STEP D — SEGMENTED FILMSTRIP: one proportional cell per playlist segment
          (STRICT clip.segments order), thin dividers between. The active cell fills
          imperatively (scaleX) via handleProgress; cells before it are full, after it
          empty. Cell flex-basis is proportional to each window's duration (nice-to-have);
          equal widths would be acceptable. Same imperative, zero-rerender approach as the
          single-clip clip-offset-progress bar. */}
      <span className="clip-offset-filmstrip" aria-hidden="true">
        {playlistSegments.map((seg, i) => (
          <span
            key={i}
            className="clip-offset-filmstrip-cell"
            style={{ flexGrow: Math.max(0.0001, seg.previewEnd - seg.previewStart) }}
          >
            <span
              ref={(el) => {
                cellFillRefs.current[i] = el;
              }}
              className="clip-offset-filmstrip-fill"
            />
          </span>
        ))}
      </span>
      {/* STEP D — NOW-PLAYING PILL: 'i/N' indicator shown on hover (CSS-gated on the
          tile's :hover). Text updated imperatively from handleProgress. */}
      {segCount > 1 && (
        <span className="clip-now-playing-pill" aria-hidden="true">
          <span ref={pillRef}>1/{segCount}</span>
        </span>
      )}
    </>
  );
}
