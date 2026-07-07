import React from "react";

/**
 * usePlaylistLoop — STANDALONE multi-segment playlist loop primitive.
 *
 * The sibling of `useOffsetLoop`, but for a NON-contiguous single-source merge:
 * instead of looping ONE window, it plays an ordered list of windows
 * [previewStart, previewEnd] back-to-back on ONE <video>, seeking between them.
 * Because USER DECISIONS lock merges to a SINGLE source, every advance is a
 * same-file seek — there is NEVER an src swap here. The owning component manages
 * the <video> src imperatively (see OffsetVideoLayer's pattern); this hook only
 * drives currentTime / play / seek.
 *
 * DELIBERATE DUPLICATION: this re-implements the rVFC + timeupdate loop engine
 * rather than importing `useOffsetLoop` (which is single-window and must stay
 * untouched). Precedent: `src/dev/OffsetSpike.tsx` duplicates the same engine.
 *
 * Two loop engines, selected at runtime:
 *  - rVFC path (preferred): requestVideoFrameCallback fires per presented frame;
 *    when the frame's mediaTime >= the current segment's previewEnd we advance.
 *  - timeupdate fallback (rVFC absent OR forceFallback): a `timeupdate` listener
 *    plus a `setTimeout` safety net covers the coarser ~250ms granularity.
 *
 * The #1 hazard is double-advance after a seek: a stale presented frame whose
 * mediaTime is still past the OLD previewEnd would immediately advance again and
 * skip a whole segment. Two guards prevent it:
 *  - awaitingSeek: set true before every advance-seek (and the rVFC handle is
 *    cancelled / the safety timer cleared first); the frame/timeupdate callback
 *    EARLY-RETURNS while it's true. It clears ONLY on the 'seeked' event OR once a
 *    presented frame's mediaTime lands inside the NEW [previewStart, previewEnd].
 *  - minimum-dwell: an advance is forbidden until at least one presented frame
 *    has been observed INSIDE the current window, so a sub-margin / 1-frame
 *    segment actually shows its frame instead of being instantly skipped.
 */

const RVFC_SUPPORTED =
  typeof HTMLVideoElement !== "undefined" &&
  "requestVideoFrameCallback" in HTMLVideoElement.prototype;

// Tolerance (seconds) for treating a presented frame's mediaTime as "inside" the
// new window right after a seek — covers the sub-frame undershoot a decoder can
// land at when seeking to an exact previewStart. ~half a frame at 60fps.
const SEEK_LANDING_EPSILON_SEC = 0.008;

export interface PlaylistSegment {
  /** Inward-padded start of this segment's window, seconds on the shared source. */
  previewStart: number;
  /** Inward-padded end of this segment's window, seconds on the shared source. */
  previewEnd: number;
}

export interface UsePlaylistLoopOptions {
  /** Ordered windows to play back-to-back. STORED array order is authoritative. */
  segments: PlaylistSegment[];
  /** When false the loop engine is torn down and the video is left paused. */
  active: boolean;
  /** Force the timeupdate fallback even when rVFC is available (dev tuning). */
  forceFallback?: boolean;
  /** Per-presented-frame progress sink: (segIndex, fractionWithinSegment 0..1).
   *  SIDE-EFFECT-ONLY — write to a DOM node / ref, NEVER setState, to preserve
   *  the zero-rerender hot path. Snaps fraction to 0 at each advance. */
  onProgress?: (segIndex: number, fraction: number) => void;
}

export function usePlaylistLoop(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  { segments, active, forceFallback = false, onProgress }: UsePlaylistLoopOptions,
): void {
  // rVFC unless unsupported by the runtime or the caller forces the fallback.
  const usingRvfc = RVFC_SUPPORTED && !forceFallback;

  // Snapshot the windows into a stable JSON key so the loop effect only re-arms
  // when the actual segment boundaries change, not on every parent re-render that
  // hands us a fresh array identity.
  const segmentsKey = React.useMemo(
    () =>
      segments
        .map((s) => `${s.previewStart}:${s.previewEnd}`)
        .join("|"),
    [segments],
  );

  // Keep the latest segments / onProgress reachable from the loop without making
  // them effect dependencies (the effect keys on segmentsKey instead, so a stable
  // window set never re-arms the engine even if the array identity changes).
  const segmentsRef = React.useRef(segments);
  segmentsRef.current = segments;
  const onProgressRef = React.useRef(onProgress);
  onProgressRef.current = onProgress;

  React.useEffect(() => {
    const video = videoRef.current;
    if (!video || !active) return undefined;
    const segs = segmentsRef.current;
    if (segs.length === 0) return undefined;
    // Degenerate-window self-protection: if NOT ONE segment has a finite,
    // non-degenerate (previewEnd > previewStart) window, there is nothing this
    // engine can ever dwell inside or advance through — arming it would only
    // spin. Bail early and leave the video paused.
    const hasFiniteWindow = segs.some(
      (s) =>
        Number.isFinite(s.previewStart) &&
        Number.isFinite(s.previewEnd) &&
        s.previewEnd > s.previewStart,
    );
    if (!hasFiniteWindow) return undefined;

    let cancelled = false;
    let rvfcHandle = 0;
    let safetyTimer = 0;
    // Bounded seek watchdog: a dropped 'seeked' event or a decode stall must not
    // wedge the playlist permanently. Armed when a seek goes in flight; force-
    // clears awaitingSeek (and marks the seek landed) if it hasn't cleared.
    let seekWatchdog = 0;

    // segIndex is the currently-playing window; awaitingSeek blocks advancing
    // while a snap-seek is in flight; dwelled guards minimum-dwell (an advance is
    // only allowed once we've seen a frame INSIDE the current window); seekLanded
    // records that the seek's destination was reached (its 'seeked' fired OR a
    // frame landed in-window) even when the window is too short to ever dwell in.
    let segIndex = 0;
    let awaitingSeek = false;
    let dwelled = false;
    let seekLanded = false;

    const clampIndex = (i: number) => {
      const n = segmentsRef.current.length;
      return n > 0 ? ((i % n) + n) % n : 0;
    };

    const currentWindow = () => {
      const list = segmentsRef.current;
      const seg = list[clampIndex(segIndex)];
      return seg ?? { previewStart: 0, previewEnd: 0 };
    };

    const cancelPending = () => {
      window.clearTimeout(safetyTimer);
      safetyTimer = 0;
      window.clearTimeout(seekWatchdog);
      seekWatchdog = 0;
      if (RVFC_SUPPORTED && rvfcHandle) {
        video.cancelVideoFrameCallback(rvfcHandle);
        rvfcHandle = 0;
      }
    };

    // Seek to a segment's window start. Used both for the advance and for the
    // initial seek to segment 0. Sets awaitingSeek so the next stale frame can't
    // double-advance, and resets minimum-dwell AND seek-landed for the
    // freshly-entered window so neither carries over from the previous segment.
    const seekToSegment = (index: number) => {
      segIndex = clampIndex(index);
      const { previewStart } = currentWindow();
      awaitingSeek = true;
      dwelled = false;
      seekLanded = false;
      onProgressRef.current?.(segIndex, 0);
      // Bounded watchdog: covers a dropped/late 'seeked' while frames may not be
      // presenting (decode stall). Force-clear awaitingSeek (and mark the seek
      // landed), then DRIVE forward progress by advancing so a totally dropped
      // 'seeked' + no further frames can't leave the playlist stalled. advance()
      // calls cancelPending() first and seekToSegment resets seekLanded, so a late
      // stale onSeeked / onFrame for the abandoned seek is harmless (no double-advance).
      window.clearTimeout(seekWatchdog);
      seekWatchdog = window.setTimeout(() => {
        if (cancelled || !awaitingSeek) return;
        awaitingSeek = false;
        seekLanded = true;
        seekWatchdog = 0;
        advance();
      }, 600);
      if (Number.isFinite(previewStart)) {
        video.currentTime = previewStart;
      }
    };

    // ADVANCE: cancel any in-flight frame/timer FIRST (so a queued rVFC can't run
    // against the new window before the seek lands), then snap to the next window.
    const advance = () => {
      cancelPending();
      seekToSegment(segIndex + 1);
      // In the timeupdate fallback there is no rVFC re-arm; the listener stays
      // attached. In the rVFC path, re-arm the per-frame callback so the loop
      // keeps observing the new window.
      if (!cancelled && usingRvfc && RVFC_SUPPORTED) {
        rvfcHandle = video.requestVideoFrameCallback(onFrame);
      }
    };

    // Shared per-observation step. `t` is the best mediaTime we have. Returns
    // after handling the awaitingSeek guard, minimum-dwell, progress, and advance.
    const handleTime = (t: number) => {
      const { previewStart, previewEnd } = currentWindow();

      // Degenerate-window self-protection: a non-finite or zero/negative-length
      // window can never be dwelled inside, so the advance gate would never fire
      // and the playlist would stall here forever. Auto-advance off it instead
      // (but only once any in-flight seek has settled, so we don't double-skip).
      if (!(previewEnd > previewStart)) {
        if (!awaitingSeek) advance();
        return;
      }

      // awaitingSeek guard: ignore frames until the seek lands. We also clear it
      // optimistically here if a presented frame already sits inside the new
      // window (covers runtimes where 'seeked' is slow/absent for tiny seeks).
      // Reaching the window counts as the seek having landed.
      if (awaitingSeek) {
        if (t >= previewStart - SEEK_LANDING_EPSILON_SEC && t < previewEnd) {
          awaitingSeek = false;
          seekLanded = true;
        } else {
          return;
        }
      }

      // Minimum-dwell: only after a frame is observed INSIDE the window do we
      // permit an advance. A 1-frame / sub-margin segment lands here, shows its
      // frame, and only THEN becomes eligible to advance on a later frame.
      if (t >= previewStart && t < previewEnd) {
        dwelled = true;
      }

      // Advance once we're past the window AND either we dwelled inside it (the
      // normal hold-a-frame path) OR the seek landed (its destination was
      // reached but the window was too short to ever sit inside — without this,
      // a sub-overshoot window would wedge because `dwelled` never flips true).
      if (t >= previewEnd && (dwelled || seekLanded)) {
        advance();
        return;
      }

      if (onProgressRef.current) {
        const span = previewEnd - previewStart;
        const p = span > 0 ? (t - previewStart) / span : 0;
        onProgressRef.current(segIndex, p < 0 ? 0 : p > 1 ? 1 : p);
      }
    };

    // --- rVFC path -----------------------------------------------------------
    const onFrame: VideoFrameRequestCallback = (_now, metadata) => {
      if (cancelled) return;
      // The handle this invocation consumed is now spent; clear it so the re-arm
      // bookkeeping below (and advance()'s own re-arm) tracks a single live handle.
      rvfcHandle = 0;
      const t = metadata.mediaTime ?? video.currentTime;
      handleTime(t);
      // If handleTime advanced, advance() already re-armed (rvfcHandle !== 0) and
      // we must NOT re-arm a second time. Otherwise re-arm to keep observing the
      // current window. (We re-arm even while awaitingSeek so the optimistic
      // landing check in handleTime can clear the guard from a presented frame.)
      if (!cancelled && RVFC_SUPPORTED && rvfcHandle === 0) {
        rvfcHandle = video.requestVideoFrameCallback(onFrame);
      }
    };

    // --- timeupdate fallback path -------------------------------------------
    const onTimeUpdate = () => {
      if (cancelled) return;
      handleTime(video.currentTime);
      if (awaitingSeek) return;
      const { previewEnd } = currentWindow();
      // setTimeout safety net: timeupdate granularity is coarse (~250ms), so we
      // arm an advance at the remaining wall time to tighten the turn-around.
      const remainingMs = (previewEnd - video.currentTime) * 1000;
      if (remainingMs > 0 && remainingMs < 1000) {
        window.clearTimeout(safetyTimer);
        safetyTimer = window.setTimeout(() => {
          if (cancelled || awaitingSeek) return;
          const w = currentWindow();
          // Mirror handleTime's advance gate: dwell OR a landed seek, so a window
          // too short to ever dwell inside still turns over from the safety net.
          if ((dwelled || seekLanded) && video.currentTime >= w.previewEnd - 0.001) {
            advance();
          }
        }, remainingMs);
      }
    };

    // The seek lands: clear awaitingSeek, record that the destination was
    // reached (so a too-short window can still advance), disarm the watchdog,
    // and re-arm minimum-dwell observation.
    const onSeeked = () => {
      window.clearTimeout(seekWatchdog);
      seekWatchdog = 0;
      if (!awaitingSeek) return;
      awaitingSeek = false;
      seekLanded = true;
    };

    // On metadata-ready (or active edge with metadata already present): reset to
    // segment 0, seek to its window start, and start playback.
    const onLoadedMeta = () => {
      cancelPending();
      seekToSegment(0);
      if (usingRvfc && RVFC_SUPPORTED) {
        rvfcHandle = video.requestVideoFrameCallback(onFrame);
      }
      void video.play().catch(() => {
        /* autoplay can reject; the caller mutes so this normally resolves. */
      });
    };

    video.addEventListener("loadedmetadata", onLoadedMeta);
    video.addEventListener("seeked", onSeeked);
    if (!usingRvfc) {
      video.addEventListener("timeupdate", onTimeUpdate);
    }

    // If metadata is already loaded (src unchanged but a param/active changed),
    // kick the seek+play now since loadedmetadata won't fire again.
    if (video.readyState >= 1) {
      onLoadedMeta();
    }

    return () => {
      cancelled = true;
      cancelPending();
      video.removeEventListener("loadedmetadata", onLoadedMeta);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.pause();
      // NOTE: src lifecycle + decoder release live in the owning component's
      // imperative-src effect — do NOT removeAttribute('src')+load() here.
    };
  }, [videoRef, segmentsKey, active, usingRvfc]);
}
