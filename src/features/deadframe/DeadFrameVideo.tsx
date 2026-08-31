import React from "react";
import { AlertTriangle, ExternalLink, Loader2, Maximize, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { openPath } from "@tauri-apps/plugin-opener";
import { usePlayableSource } from "./playableSource";

/**
 * One of the two Dead Frame Remover players.
 *
 * It owns three things the panel used to get wrong:
 *  - it never points the player straight at a file the embedded browser cannot
 *    decode (see playableSource.ts), so no more silent black rectangle;
 *  - while a playable copy is being made it says so, in that box only — the
 *    dial, the queue and the Preview/Export buttons stay live throughout;
 *  - if the file cannot be made playable at all it says that in plain words and
 *    offers to hand the file to the user's own video player, instead of leaving
 *    a black box that looks like the app broke.
 *
 * The transport bar is the app's own (matching SceneViewerModal) rather than
 * the browser's default one. The two players stay deliberately independent:
 * the de-duplicated clip is genuinely shorter, so there is no shared timeline.
 */

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.floor(seconds % 60);
  return `${minutes}:${remaining.toString().padStart(2, "0")}`;
}

export function DeadFrameVideo({
  path,
  emptyMessage,
  label,
}: {
  path: string | null;
  emptyMessage: string;
  label: string;
}) {
  const playable = usePlayableSource(path);
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const scrubRef = React.useRef<HTMLDivElement | null>(null);
  const wasPlayingBeforeScrubRef = React.useRef(false);
  const [isPlaying, setIsPlaying] = React.useState(false);
  const [isMuted, setIsMuted] = React.useState(true);
  const [isScrubbing, setIsScrubbing] = React.useState(false);
  const [currentTime, setCurrentTime] = React.useState(0);
  const [duration, setDuration] = React.useState(0);

  const src = playable.status === "ready" ? playable.src : null;

  // A new file means a new timeline; the old readout would otherwise sit there
  // claiming a position the player no longer has.
  React.useEffect(() => {
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
  }, [src]);

  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
  }

  function toggleMute() {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setIsMuted(video.muted);
  }

  function requestFullscreen() {
    const video = videoRef.current;
    if (video?.requestFullscreen) void video.requestFullscreen().catch(() => undefined);
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
      if (video && wasPlayingBeforeScrubRef.current) void video.play().catch(() => undefined);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isScrubbing, duration]);

  if (playable.status === "empty") {
    return <div className="deadframe-player-empty">{emptyMessage}</div>;
  }

  if (playable.status === "preparing") {
    return (
      <div className="deadframe-player-empty deadframe-player-preparing" role="status">
        <Loader2 size={16} className="audio-spin" />
        <span>Preparing preview…</span>
      </div>
    );
  }

  if (playable.status === "failed") {
    return (
      <div className="deadframe-player-empty deadframe-player-fallback" role="status">
        <AlertTriangle size={16} />
        <span>
          This file is in a format the app can&apos;t show on screen. The clip itself is fine
          and it will still be de-duplicated and exported normally.
        </span>
        <button
          type="button"
          className="conversion-pick-btn"
          onClick={() => void openPath(path as string).catch(() => undefined)}
        >
          <ExternalLink size={14} />
          Open in your video player
        </button>
      </div>
    );
  }

  const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  return (
    <div className="deadframe-video-stage">
      <video
        key={src as string}
        ref={videoRef}
        src={src as string}
        muted={isMuted}
        preload="metadata"
        aria-label={label}
        onClick={togglePlay}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => {
          event.currentTarget.muted = isMuted;
          setDuration(event.currentTarget.duration);
        }}
      />
      <div className="scene-viewer-controls deadframe-video-controls">
        <button
          type="button"
          className="scene-viewer-button"
          onClick={togglePlay}
          aria-label={isPlaying ? `Pause ${label}` : `Play ${label}`}
        >
          {isPlaying ? <Pause size={14} strokeWidth={2.2} /> : <Play size={14} strokeWidth={2.2} />}
        </button>
        <span className="scene-viewer-time">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>
        <div
          ref={scrubRef}
          className={`scene-viewer-scrub ${isScrubbing ? "is-scrubbing" : ""}`}
          onMouseDown={onScrubMouseDown}
          role="slider"
          aria-label={`Seek ${label}`}
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
          aria-label={isMuted ? `Unmute ${label}` : `Mute ${label}`}
        >
          {isMuted ? <VolumeX size={14} strokeWidth={2.2} /> : <Volume2 size={14} strokeWidth={2.2} />}
        </button>
        <button
          type="button"
          className="scene-viewer-button"
          onClick={requestFullscreen}
          aria-label={`Fullscreen ${label}`}
        >
          <Maximize size={14} strokeWidth={2.2} />
        </button>
      </div>
    </div>
  );
}
