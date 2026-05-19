import React from "react";
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
import type { ClipPreviewItem } from "../../types/clip";

type RenderResult = {
  type: "done";
  sceneId: string;
  path: string;
  duration: number;
  cached: boolean;
};

type RenderState =
  | { status: "rendering" }
  | { status: "ready"; src: string; cached: boolean }
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

    void invoke<string>("scene_clip_render", {
      sceneId: clip.id,
      sourcePath: clip.path,
      // previewStart/previewEnd are pre-padded inward by previewClipRange() in
      // ClipExtractorPanel; the raw sourceStart sits on the previous scene's
      // last frame (TransNetV2 boundary semantics) and bleeds.
      start: clip.previewStart,
      end: clip.previewEnd,
    })
      .then((raw) => {
        if (cancelled) return;
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
        if (cancelled) return;
        setRender({ status: "error", error: readBridgeError(error) });
      });

    return () => {
      cancelled = true;
    };
  }, [clip?.id, clip?.path, clip?.previewStart, clip?.previewEnd]);

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

  function seekFromPointer(event: MouseEvent | React.MouseEvent, target: HTMLDivElement) {
    const video = videoRef.current;
    if (!video || !duration) return;
    const rect = target.getBoundingClientRect();
    const x = Math.min(Math.max(0, event.clientX - rect.left), rect.width);
    const fraction = rect.width === 0 ? 0 : x / rect.width;
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
  }, [isScrubbing, duration]);

  if (!clip) return null;

  const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  return (
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
          {render.status === "ready" ? (
            <>
              <video
                key={render.src}
                ref={videoRef}
                src={render.src}
                autoPlay
                loop
                muted={isMuted}
                preload="auto"
                onClick={togglePlay}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
                onLoadedMetadata={(event) => {
                  // Belt-and-suspenders: React's muted prop isn't always
                  // reflected to the DOM on initial mount in every WebView
                  // version, so set it imperatively too.
                  event.currentTarget.muted = isMuted;
                  setDuration(event.currentTarget.duration);
                }}
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
                  {formatTime(currentTime)} / {formatTime(duration)}
                </span>
                <div
                  ref={scrubRef}
                  className={`scene-viewer-scrub ${isScrubbing ? "is-scrubbing" : ""}`}
                  onMouseDown={onScrubMouseDown}
                  role="slider"
                  aria-label="Seek"
                  aria-valuemin={0}
                  aria-valuemax={duration || 0}
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
            <div className="scene-viewer-loading">
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
    </div>
  );
}
