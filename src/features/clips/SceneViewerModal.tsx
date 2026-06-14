import React from "react";
import { createPortal } from "react-dom";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  Loader2,
  Maximize,
  Pause,
  Play,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { parseBridgePayload, readBridgeError } from "../../utils/bridge";
import type { AppConfig } from "../../types/app";
import type { ClipPreviewItem } from "../../types/clip";
import { useOffsetLoop } from "./useOffsetLoop";
import {
  clearOffsetMetrics,
  reportOffsetMetrics,
  usePreviewTunables,
} from "../../dev/previewTunables";

type RenderResult = {
  type: "done";
  sceneId: string;
  path: string;
  duration: number;
  cached: boolean;
};

// `offset` is the featherweight path: play `clip.playbackSrc` directly and loop
// the margined sub-window in JS (no scene_clip_render re-encode). Every other
// status is the unchanged scene_clip_render mp4 path, kept verbatim as the
// fallback (flag off, no playbackSrc, merged clips, or <video> error).
type RenderState =
  | { status: "rendering" }
  | { status: "ready"; src: string; cached: boolean }
  | { status: "offset"; src: string }
  | { status: "error"; error: string };

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.floor(seconds % 60);
  return `${minutes}:${remaining.toString().padStart(2, "0")}`;
}

// Mute preference persists across clips and across app restarts so the user
// doesn't have to re-mute every time. Default is unmuted (audio is the point
// of the scene viewer); only writes happen on explicit user toggle, not on
// browser-initiated mute (autoplay policy, OS keys, etc.).
const SCENE_VIEWER_MUTED_KEY = "ultimate-amv.scene-viewer.muted";

function readMutedPref(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SCENE_VIEWER_MUTED_KEY) === "true";
  } catch {
    return false;
  }
}

function writeMutedPref(muted: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SCENE_VIEWER_MUTED_KEY, muted ? "true" : "false");
  } catch {
    // localStorage may be unavailable in some contexts; non-fatal.
  }
}

export function SceneViewerModal({
  clip,
  onClose,
}: {
  clip: ClipPreviewItem | null;
  onClose: () => void;
}) {
  const [render, setRender] = React.useState<RenderState>({ status: "rendering" });
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const scrubRef = React.useRef<HTMLDivElement | null>(null);
  const wasPlayingBeforeScrubRef = React.useRef(false);

  const [isPlaying, setIsPlaying] = React.useState(false);
  const [isMuted, setIsMuted] = React.useState<boolean>(() => readMutedPref());
  const [currentTime, setCurrentTime] = React.useState(0);
  const [duration, setDuration] = React.useState(0);
  const [isScrubbing, setIsScrubbing] = React.useState(false);
  // Latches when the offset <video> errors so we fall back to scene_clip_render
  // for this clip instead of looping forever on a black/broken element.
  const [offsetFailed, setOffsetFailed] = React.useState(false);

  // Tunables (DEV panel live-edits these; in prod they equal the baked
  // constants since nothing mutates the store). Margins turn the loop around
  // a few frames inside the cut so the seam never shows.
  const tunables = usePreviewTunables();

  // Is this clip eligible for the featherweight offset path? Requires the flag
  // on (resolved async below), a resolved playbackSrc, and a single contiguous
  // window — merged/unified clips stay on the concat/re-encode mp4 path because
  // an offset over discontiguous segments isn't a single [start,end].
  const isMergedClip = clip?.id === "merged-preview" || clip?.isUnified === true;
  const hasPlaybackSrc = Boolean(clip?.playbackSrc);

  // The margined offset window on the playback source timeline. Because the
  // proxy is a whole-file transcode (no -ss) and the direct source is the
  // original, sourceStart/sourceEnd map 1:1 onto playbackSrc. The caller of
  // useOffsetLoop must apply the inward margins (per the hook contract).
  const fps = clip && Number.isFinite(clip.fps) && clip.fps > 0 ? clip.fps : 24;
  const startSec = clip ? clip.sourceStart + tunables.startMarginFrames / fps : 0;
  const endSec = clip ? clip.sourceEnd - tunables.endMarginFrames / fps : 0;
  const windowDuration = Math.max(0, endSec - startSec);

  const isOffsetActive = render.status === "offset";

  // Keyboard: ESC closes, Space toggles play. Space is the universal expected
  // shortcut; we also defer to the browser's own ESC if we're in fullscreen so
  // the user can exit fullscreen without dismissing the modal.
  React.useEffect(() => {
    if (!clip) return undefined;
    const handler = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || (target as HTMLElement | null)?.isContentEditable
      ) {
        return;
      }
      if (event.key === "Escape") {
        if (document.fullscreenElement) return;
        event.preventDefault();
        onClose();
        return;
      }
      if (event.code === "Space") {
        event.preventDefault();
        const video = videoRef.current;
        if (!video) return;
        if (video.paused) void video.play().catch(() => {});
        else video.pause();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [clip, onClose]);

  React.useEffect(() => {
    if (!clip || !clip.path) return undefined;
    let cancelled = false;
    setRender({ status: "rendering" });
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
    setOffsetFailed(false);

    if (clip.id === "merged-preview") {
      setRender({
        status: "ready",
        src: convertFileSrc(clip.path),
        cached: true,
      });
      return undefined;
    }

    // Featherweight offset path: when the flag is on AND this clip has a
    // resolved playbackSrc (direct original or shared proxy) AND it's a single
    // contiguous window, play that source directly and loop the margined
    // sub-window in JS — no scene_clip_render re-encode. The flag is read live
    // (default-on) so only an explicit `false` routes back to the classic path.
    if (hasPlaybackSrc && !isMergedClip && !offsetFailed && clip.playbackSrc) {
      const offsetSrc = clip.playbackSrc;
      void invoke<string>("get_config")
        .then((raw) => {
          if (cancelled) return;
          let enabled = true;
          try {
            const payload = parseBridgePayload<AppConfig>(raw);
            enabled = payload.featherweight_previews !== false;
          } catch {
            enabled = true;
          }
          if (cancelled) return;
          if (enabled) {
            setRender({ status: "offset", src: offsetSrc });
          } else {
            renderViaSceneClip(clip, () => cancelled, setRender);
          }
        })
        .catch(() => {
          if (cancelled) return;
          // Config read failed -> safest default is today's behavior.
          renderViaSceneClip(clip, () => cancelled, setRender);
        });
      return () => {
        cancelled = true;
      };
    }

    renderViaSceneClip(clip, () => cancelled, setRender);

    return () => {
      cancelled = true;
    };
    // offsetFailed is intentionally a dep: when the offset <video> errors we
    // re-run this effect, the offset branch is skipped (latched), and we fall
    // through to the scene_clip_render path for this clip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip?.id, clip?.path, clip?.previewStart, clip?.previewEnd, clip?.playbackSrc, offsetFailed]);

  // Drive the featherweight loop. Inactive (and thus a no-op teardown) on every
  // non-offset status, so the scene_clip_render path is untouched.
  useOffsetLoop(videoRef, {
    startSec,
    endSec,
    active: isOffsetActive && windowDuration > 0,
    forceFallback: tunables.forceTimeupdateFallback,
  });

  // Feed the DEV panel's live readout (active offset-video count + max
  // overshoot). No-op cost in prod: the panel that polls these is DEV-gated and
  // never mounts, and the registry is a plain Map. Report on the active edge,
  // clear on teardown.
  React.useEffect(() => {
    if (!import.meta.env.DEV) return undefined;
    if (!isOffsetActive || !clip) return undefined;
    const video = videoRef.current;
    if (!video) return undefined;
    const metricId = `scene-viewer:${clip.id}`;
    let maxOvershootMs = 0;
    const onTime = () => {
      const overshoot = (video.currentTime - endSec) * 1000;
      if (overshoot > maxOvershootMs) {
        maxOvershootMs = overshoot;
        reportOffsetMetrics(metricId, { maxOvershootMs });
      }
    };
    reportOffsetMetrics(metricId, { maxOvershootMs: 0 });
    video.addEventListener("timeupdate", onTime);
    return () => {
      video.removeEventListener("timeupdate", onTime);
      clearOffsetMetrics(metricId);
    };
  }, [isOffsetActive, clip, endSec]);

  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  }

  function toggleMute() {
    const video = videoRef.current;
    if (!video) return;
    const next = !video.muted;
    video.muted = next;
    setIsMuted(next);
    // Persist on user toggle only - onVolumeChange fires for non-user-initiated
    // changes too (autoplay policy, OS mute keys) and persisting those would
    // surprise the user.
    writeMutedPref(next);
  }

  function requestFullscreen() {
    const video = videoRef.current;
    if (!video) return;
    if (video.requestFullscreen) void video.requestFullscreen().catch(() => {});
  }

  // Display/seek timeline. On the offset path everything is rebased onto the
  // margined window [startSec, endSec]: the displayed time is `currentTime -
  // startSec`, the displayed duration is the window length, and a seek maps the
  // pointer fraction back onto the absolute source time. On the
  // scene_clip_render path the mp4 is already trimmed, so it's a plain 1:1.
  const displayDuration = isOffsetActive ? windowDuration : duration;

  function seekFromPointer(event: MouseEvent | React.MouseEvent, target: HTMLDivElement) {
    const video = videoRef.current;
    if (!video) return;
    const rect = target.getBoundingClientRect();
    const x = Math.min(Math.max(0, event.clientX - rect.left), rect.width);
    const fraction = rect.width === 0 ? 0 : x / rect.width;
    if (isOffsetActive) {
      if (windowDuration <= 0) return;
      const absolute = startSec + fraction * windowDuration;
      video.currentTime = absolute;
      setCurrentTime(absolute - startSec);
      return;
    }
    if (!duration) return;
    video.currentTime = fraction * duration;
    setCurrentTime(video.currentTime);
  }

  function onScrubMouseDown(event: React.MouseEvent<HTMLDivElement>) {
    const video = videoRef.current;
    if (!video) return;
    wasPlayingBeforeScrubRef.current = !video.paused;
    video.pause();
    setIsScrubbing(true);
    seekFromPointer(event, event.currentTarget);
  }

  React.useEffect(() => {
    if (!isScrubbing) return undefined;
    function onMove(event: MouseEvent) {
      const track = scrubRef.current;
      if (track) seekFromPointer(event, track);
    }
    function onUp() {
      setIsScrubbing(false);
      const video = videoRef.current;
      if (video && wasPlayingBeforeScrubRef.current) void video.play().catch(() => {});
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isScrubbing, duration, isOffsetActive, startSec, windowDuration]);

  // The offset <video> errored (codec misclassified, proxy gone, etc.): latch
  // the failure so the effect above re-runs and falls back to scene_clip_render
  // for this clip — never leave the user staring at a black element.
  function onOffsetVideoError() {
    if (!offsetFailed) setOffsetFailed(true);
  }

  if (!clip) return null;

  const isVideoReady = render.status === "ready" || render.status === "offset";
  const videoSrc =
    render.status === "ready" || render.status === "offset" ? render.src : "";
  const progress = displayDuration > 0 ? Math.min(100, (currentTime / displayDuration) * 100) : 0;

  return createPortal(
    <div
      className="episode-label-backdrop scene-viewer-backdrop"
      role="dialog"
      aria-label="Scene preview"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="episode-label-modal scene-viewer-modal">
        <div className="episode-label-header">
          <div>
            <span className="episode-label-kicker">Scene preview</span>
            <h2>{clip.label}</h2>
            <p>
              {clip.sourceName} : {clip.range}
            </p>
          </div>
          <button
            type="button"
            className="episode-label-close"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="scene-viewer-stage">
          {/* The WebP preview this clip already used in the grid is in
              WebView2's renderer cache (preview.rs generates it before the
              user can click). Rendering it whenever we don't yet have the
              mp4 - both during scene_clip_render AND on error - keeps the
              user oriented on the right clip instead of staring at black.
              The WebP is animated (looping ~12 fps mini-preview), not a
              still frame, so the poster is a quiet loop behind the spinner
              rather than a freeze frame; that's intentional. */}
          {!isVideoReady && clip.previewState?.src && (
            <img
              className="scene-viewer-poster"
              src={clip.previewState.src}
              alt=""
              aria-hidden="true"
            />
          )}
          {isVideoReady ? (
            <>
              <video
                key={videoSrc}
                ref={videoRef}
                src={videoSrc}
                autoPlay
                /* Featherweight path loops the margined sub-window in JS via
                   useOffsetLoop; the native loop attr would loop the whole
                   file, so it's removed there. The scene_clip_render mp4 is a
                   trimmed clip, so it keeps the native loop. */
                loop={!isOffsetActive}
                muted={isMuted}
                preload="auto"
                onClick={togglePlay}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onTimeUpdate={(event) => {
                  const t = event.currentTarget.currentTime;
                  setCurrentTime(isOffsetActive ? t - startSec : t);
                }}
                onLoadedMetadata={(event) => {
                  // Belt-and-suspenders: React's muted prop isn't always
                  // reflected to the DOM on initial mount in every WebView
                  // version, so set it imperatively too.
                  event.currentTarget.muted = isMuted;
                  // On the offset path the timeline is the margined window, so
                  // the displayed duration is the window length, not the whole
                  // source. useOffsetLoop owns the seek-to-start + play.
                  setDuration(
                    isOffsetActive ? windowDuration : event.currentTarget.duration,
                  );
                }}
                onError={isOffsetActive ? onOffsetVideoError : undefined}
                onVolumeChange={(event) => setIsMuted(event.currentTarget.muted)}
              />
              <div className="scene-viewer-controls">
                <button
                  type="button"
                  className="scene-viewer-button"
                  onClick={togglePlay}
                  aria-label={isPlaying ? "Pause" : "Play"}
                >
                  {isPlaying ? <Pause size={15} strokeWidth={2.2} /> : <Play size={15} strokeWidth={2.2} />}
                </button>
                <span className="scene-viewer-time">
                  {formatTime(currentTime)} / {formatTime(displayDuration)}
                </span>
                <div
                  ref={scrubRef}
                  className={`scene-viewer-scrub ${isScrubbing ? "is-scrubbing" : ""}`}
                  onMouseDown={onScrubMouseDown}
                  role="slider"
                  aria-label="Seek"
                  aria-valuemin={0}
                  aria-valuemax={displayDuration || 0}
                  aria-valuenow={currentTime}
                >
                  <div className="scene-viewer-scrub-track">
                    <div className="scene-viewer-scrub-fill" style={{ width: `${progress}%` }} />
                  </div>
                </div>
                <button
                  type="button"
                  className="scene-viewer-button"
                  onClick={toggleMute}
                  aria-label={isMuted ? "Unmute" : "Mute"}
                >
                  {isMuted ? <VolumeX size={15} strokeWidth={2.2} /> : <Volume2 size={15} strokeWidth={2.2} />}
                </button>
                <button
                  type="button"
                  className="scene-viewer-button"
                  onClick={requestFullscreen}
                  aria-label="Fullscreen"
                >
                  <Maximize size={15} strokeWidth={2.2} />
                </button>
              </div>
            </>
          ) : render.status === "rendering" ? (
            <div className="scene-viewer-loading" role="status">
              <Loader2 className="is-spinning" size={24} strokeWidth={2.1} />
              <span>Rendering scene preview...</span>
            </div>
          ) : (
            <div className="direct-stream-error scene-viewer-error">
              <AlertTriangle size={16} />
              <span>{render.error}</span>
            </div>
          )}
        </div>

        <div className="episode-label-actions">
          <div className="episode-label-actions-right">
            <button type="button" className="episode-label-confirm" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

// The unchanged scene_clip_render mp4 path, factored out so both the
// flag-off / no-playbackSrc branch and the offset-<video>-error fallback reach
// it. Invokes scene_clip_render with previewStart/previewEnd (the inward-padded
// boundary-correct range — the raw sourceStart sits on the previous scene's
// last frame and bleeds) and renders the resulting trimmed mp4.
function renderViaSceneClip(
  clip: ClipPreviewItem,
  isCancelled: () => boolean,
  setRender: React.Dispatch<React.SetStateAction<RenderState>>,
) {
  setRender({ status: "rendering" });
  void invoke<string>("scene_clip_render", {
    sceneId: clip.id,
    sourcePath: clip.path,
    start: clip.previewStart,
    end: clip.previewEnd,
  })
    .then((raw) => {
      if (isCancelled()) return;
      const payload = parseBridgePayload<RenderResult>(raw);
      if (!payload.path) {
        setRender({ status: "error", error: "Scene renderer did not return a file." });
        return;
      }
      setRender({
        status: "ready",
        src: convertFileSrc(payload.path),
        cached: payload.cached,
      });
    })
    .catch((error) => {
      if (isCancelled()) return;
      setRender({ status: "error", error: readBridgeError(error) });
    });
}
