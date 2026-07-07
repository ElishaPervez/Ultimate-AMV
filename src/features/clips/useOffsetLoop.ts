import React from "react";

/**
 * useOffsetLoop — featherweight offset-playback loop primitive.
 *
 * Plays a sub-range [startSec, endSec] of one <video> on a tight loop, snapping
 * `currentTime` back to `startSec` the instant playback reaches `endSec`. This is
 * the generalized, production form of the loop logic proven in
 * `src/dev/OffsetSpike.tsx` (rVFC = 0ms overshoot/no bleed in the real WebView2;
 * timeupdate fallback ~1.5 frames, absorbed by the inward margin).
 *
 * BOUNDARY CONTRACT: the caller passes `startSec`/`endSec` WITH the inward margins
 * already applied (endSec = sourceEnd - endMarginFrames/fps, startSec =
 * sourceStart + startMarginFrames/fps). This hook loops the margined window as-is
 * and NEVER touches the raw cut — the only bleed source is looping at the exact
 * seam, which the caller's margin already prevents.
 *
 * Two loop engines, selected at runtime:
 *  - rVFC path (preferred): requestVideoFrameCallback fires per presented frame;
 *    when the frame's mediaTime >= endSec we snap currentTime back to startSec.
 *  - timeupdate fallback (rVFC absent OR forceFallback): a `timeupdate` listener
 *    plus a `setTimeout` snap-back covers the coarser ~250ms granularity.
 *
 * Teardown cancels the rVFC handle, removes every listener, and clears the
 * pending timeout — on unmount and on any param / video-src change.
 */

const RVFC_SUPPORTED =
  typeof HTMLVideoElement !== "undefined" &&
  "requestVideoFrameCallback" in HTMLVideoElement.prototype;

export interface UseOffsetLoopOptions {
  /** Inward-padded start of the loop window, in seconds on the playback source. */
  startSec: number;
  /** Inward-padded end of the loop window, in seconds on the playback source. */
  endSec: number;
  /** When false the loop engine is torn down and the video is left paused. */
  active: boolean;
  /** Force the timeupdate fallback even when rVFC is available (dev tuning). */
  forceFallback?: boolean;
  /** Optional per-frame progress sink, 0..1 within [startSec,endSec]. Fires from
   *  the existing rVFC / timeupdate observations — NO extra timer. Snaps to 0 at
   *  each loop turn. Keep it side-effect-only (write to a DOM node / ref), never
   *  setState, to preserve the zero-rerender hot path. */
  onProgress?: (progress: number) => void;
}

export function useOffsetLoop(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  { startSec, endSec, active, forceFallback = false, onProgress }: UseOffsetLoopOptions,
): void {
  // rVFC unless unsupported by the runtime or the caller forces the fallback.
  const usingRvfc = RVFC_SUPPORTED && !forceFallback;

  React.useEffect(() => {
    const video = videoRef.current;
    if (!video || !active) return undefined;

    let cancelled = false;
    let rvfcHandle = 0;
    let safetyTimer = 0;

    const snapToStart = () => {
      // Seek back to the inward-padded start of the window. Guard against a
      // degenerate window so we never seek to NaN / past the end.
      if (Number.isFinite(startSec)) {
        video.currentTime = startSec;
      }
      // Snap the progress bar back to empty the instant the loop turns, matching
      // the legacy CSS keyframe restart.
      onProgress?.(0);
    };

    // --- rVFC path -----------------------------------------------------------
    const onFrame: VideoFrameRequestCallback = (_now, metadata) => {
      if (cancelled) return;
      const t = metadata.mediaTime ?? video.currentTime;
      if (t >= endSec) {
        snapToStart();
      } else if (onProgress) {
        const span = endSec - startSec;
        const p = span > 0 ? (t - startSec) / span : 0;
        onProgress(p < 0 ? 0 : p > 1 ? 1 : p);
      }
      if (!cancelled && RVFC_SUPPORTED) {
        rvfcHandle = video.requestVideoFrameCallback(onFrame);
      }
    };

    // --- timeupdate fallback path -------------------------------------------
    const onTimeUpdate = () => {
      if (cancelled) return;
      if (video.currentTime >= endSec) {
        snapToStart();
        return;
      }
      if (onProgress) {
        const span = endSec - startSec;
        const p = span > 0 ? (video.currentTime - startSec) / span : 0;
        onProgress(p < 0 ? 0 : p > 1 ? 1 : p);
      }
      // setTimeout safety net: timeupdate granularity is coarse (~250ms), so we
      // arm a snap-back at the remaining wall time to tighten the turn-around.
      const remainingMs = (endSec - video.currentTime) * 1000;
      if (remainingMs > 0 && remainingMs < 1000) {
        window.clearTimeout(safetyTimer);
        safetyTimer = window.setTimeout(() => {
          if (!cancelled && video.currentTime >= endSec - 0.001) {
            snapToStart();
          }
        }, remainingMs);
      }
    };

    // On the active edge / metadata-ready, jump to the window start and play.
    const onLoadedMeta = () => {
      snapToStart();
      void video.play().catch(() => {
        /* autoplay can reject; the caller mutes so this normally resolves. */
      });
    };

    video.addEventListener("loadedmetadata", onLoadedMeta);
    if (usingRvfc) {
      rvfcHandle = video.requestVideoFrameCallback(onFrame);
    } else {
      video.addEventListener("timeupdate", onTimeUpdate);
    }

    // If metadata is already loaded (src unchanged but a param/active changed),
    // kick the seek+play now since loadedmetadata won't fire again.
    if (video.readyState >= 1) {
      onLoadedMeta();
    }

    return () => {
      cancelled = true;
      window.clearTimeout(safetyTimer);
      if (RVFC_SUPPORTED && rvfcHandle) {
        video.cancelVideoFrameCallback(rvfcHandle);
      }
      video.removeEventListener("loadedmetadata", onLoadedMeta);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.pause();
      // NOTE: src lifecycle + decoder release now live in OffsetVideoLayer's
      // imperative-src effect (removeAttribute+load here fought React's declarative
      // `src` and left the element source-less on StrictMode/effect re-runs).
    };
  }, [videoRef, startSec, endSec, active, usingRvfc, onProgress]);
}
