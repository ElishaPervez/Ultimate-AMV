import React from "react";
import { AlertTriangle, Loader2, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { logFrontend, safeLogValue } from "../../lib/log";
import type { TsukyioItem } from "../../types/tsukyio";

// Reusable media player CORE for a single vault clip — extracted from the old
// click-to-open preview modal so it can live inside the persistent right-side
// preview dock (or any host) WITHOUT any modal/dialog chrome (no portal, no
// backdrop, no header, no Download/Close buttons — those belong to the host).
//
// The media is loaded from the local `tsukyio://stream/<id>` proxy protocol
// (built by the caller and passed as `streamSrc`), NOT the remote URL: WebView2
// rejects the cross-origin remote Range stream (MEDIA_ERR_SRC_NOT_SUPPORTED)
// even though the mp4 is decodable, so the Rust backend proxies it from an
// app-trusted origin, adds auth server-side, and forwards Range so seeking
// works. The API key never appears in this URL. Audio assets get a hidden
// <audio> engine driving a custom flat player; video gets the same custom
// control set as an overlay bar (native <video controls> replaced so the
// player matches the app aesthetic, mirroring SceneViewerModal).

type LoadState =
  | { status: "loading" }
  | { status: "ready" }
  | { status: "error"; message: string };

// Persisted player volume/mute, shared by both the <video> and <audio>
// preview elements and survived across app restarts via localStorage. Keyed
// under a single stable key so opening any new clip reuses the user's last
// volume + mute choice instead of resetting to the hardcoded muted default.
const PLAYER_PREFS_KEY = "tsukyio.preview.player";

type PlayerPrefs = { volume: number; muted: boolean };

// First-ever run (nothing stored): full volume but MUTED, which preserves the
// autoplay-safe muted-start behaviour the player had before this was added.
// Once the user touches the volume slider or mute button, their last choice
// (including unmuted) is what gets restored from then on.
const DEFAULT_PLAYER_PREFS: PlayerPrefs = { volume: 1, muted: true };

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_PLAYER_PREFS.volume;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

// Read persisted prefs. Never throws: any parse/shape/storage error falls back
// to the default so a corrupted entry can't break the preview.
function loadPlayerPrefs(): PlayerPrefs {
  try {
    const raw = window.localStorage.getItem(PLAYER_PREFS_KEY);
    if (!raw) return { ...DEFAULT_PLAYER_PREFS };
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_PLAYER_PREFS };
    const obj = parsed as Record<string, unknown>;
    const volume =
      typeof obj.volume === "number" ? clamp01(obj.volume) : DEFAULT_PLAYER_PREFS.volume;
    // Fall back to the default (muted) when the stored value isn't a real
    // boolean — a partial/corrupted entry missing `muted` must not silently
    // become unmuted (which would trigger a surprise unmuted autoplay).
    const muted = typeof obj.muted === "boolean" ? obj.muted : DEFAULT_PLAYER_PREFS.muted;
    return { volume, muted };
  } catch {
    return { ...DEFAULT_PLAYER_PREFS };
  }
}

// Persist prefs. Wrapped in try/catch because localStorage can throw (quota,
// privacy mode, etc.) — a failed save must never disrupt playback.
function savePlayerPrefs(prefs: PlayerPrefs): void {
  try {
    window.localStorage.setItem(
      PLAYER_PREFS_KEY,
      JSON.stringify({ volume: clamp01(prefs.volume), muted: Boolean(prefs.muted) }),
    );
  } catch {
    // Ignore storage failures; playback continues with in-memory state.
  }
}

// Human-readable mapping for HTMLMediaElement.error.code so a persistent
// failure is diagnosable instead of just a black box.
function mediaErrorLabel(code: number | undefined): string {
  switch (code) {
    case 1:
      return "MEDIA_ERR_ABORTED (playback aborted)";
    case 2:
      return "MEDIA_ERR_NETWORK (a network error occurred)";
    case 3:
      return "MEDIA_ERR_DECODE (the media could not be decoded)";
    case 4:
      return "MEDIA_ERR_SRC_NOT_SUPPORTED (source not supported / not found)";
    default:
      return "unknown media error";
  }
}

// Render seconds as `m:ss`. Used for the elapsed readout (always a real number
// once playback starts) and the total readout — but the total is only valid
// once metadata arrives. Callers guard the duration separately; this helper
// just refuses to render junk (NaN/Infinity/negative) as `0:00`-ish garbage by
// returning the placeholder for any non-finite input.
function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const remaining = total % 60;
  return `${minutes}:${remaining.toString().padStart(2, "0")}`;
}

// A media element's duration is `NaN` before metadata loads and can be
// `Infinity` for live/seekable-unknown streams. Treat both (and a zero-length
// clip) as "unknown" so the progress bar stays empty and seeking is inert
// until a real duration arrives, instead of dividing by zero / clamping to a
// bogus 100%.
function isKnownDuration(duration: number): boolean {
  return Number.isFinite(duration) && duration > 0;
}

export interface TsukyioPlayerProps {
  item: TsukyioItem;
  // Direct mp4/audio stream URL (no transcode). Built by the caller so the API
  // key never has to be threaded through this component.
  streamSrc: string | null;
  // Whether to attempt autoplay when the source binds. Defaults to true (the
  // original modal behavior). The dock sets this false when merely re-opening a
  // collapsed dock so the same clip comes back paused.
  autoPlay?: boolean;
  // Optional hook letting the host trigger fullscreen on the player's <video>.
  // The player calls this with a function that runs `videoEl.requestFullscreen()`
  // for video clips, and with `null` for audio (which has no picture to expand).
  // The host wires its ⛶ button to the latest registered function.
  registerFullscreen?: (fn: (() => void) | null) => void;
}

// The media engine + controls + lifecycle for one clip, with NO host chrome.
// Renders the player, the loading spinner, and the error overlay.
export function TsukyioPlayer({
  item,
  streamSrc,
  autoPlay = true,
  registerFullscreen,
}: TsukyioPlayerProps) {
  const isAudio = item.type === "audio";
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const [load, setLoad] = React.useState<LoadState>({ status: "loading" });

  // ---- Custom player UI state -----------------------------------------------
  // These mirror the active media element's live state (audio OR video) for
  // rendering only. The element remains the single source of truth: every
  // setter here is driven by a media event (play/pause/timeupdate/
  // durationchange/loadedmetadata/ended/volumechange), and every control writes
  // back to the element imperatively. We do NOT persist from here — the
  // existing `volumechange` listener in the source effect owns persistence. We
  // only REFLECT volume/muted so the UI shows the restored level.
  const [isPlaying, setIsPlaying] = React.useState(false);
  const [currentTime, setCurrentTime] = React.useState(0);
  const [duration, setDuration] = React.useState(0);
  const [mediaVolume, setMediaVolume] = React.useState(DEFAULT_PLAYER_PREFS.volume);
  const [mediaMuted, setMediaMuted] = React.useState(DEFAULT_PLAYER_PREFS.muted);
  // True only while the user is actively dragging the seek thumb. While set, we
  // suppress `timeupdate`-driven currentTime writes so the element's playback
  // position can't yank the thumb out from under the pointer.
  const [isScrubbing, setIsScrubbing] = React.useState(false);
  const isScrubbingRef = React.useRef(false);
  const wasPlayingBeforeScrubRef = React.useRef(false);
  const scrubRef = React.useRef<HTMLDivElement | null>(null);

  // The active playback element for this clip — only one of the two refs is
  // ever mounted (audio engine or <video>), so all control handlers and the
  // event-sync effect go through this instead of assuming audio.
  function getMedia(): HTMLMediaElement | null {
    return isAudio ? audioRef.current : videoRef.current;
  }

  // Mirror `autoPlay` into a ref so the source effect (keyed only on
  // item.id/streamSrc, so it doesn't tear down + rebind on an autoPlay change)
  // reads the latest value when it binds the fresh element.
  const autoPlayRef = React.useRef(autoPlay);
  autoPlayRef.current = autoPlay;

  // Reset the transient player UI whenever the clip/source changes so no stale
  // time or play state from a previous clip flashes before the fresh element's
  // events fire. Volume/muted are intentionally NOT reset here — they're
  // reflected from the element by the sync effect after the source effect
  // restores the persisted prefs.
  React.useEffect(() => {
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setIsScrubbing(false);
    isScrubbingRef.current = false;
    wasPlayingBeforeScrubRef.current = false;
  }, [item.id, streamSrc]);

  // Reset the load state whenever the previewed item / source changes.
  React.useEffect(() => {
    setLoad({ status: "loading" });
  }, [item.id, streamSrc]);

  // Stall guard: if the stream never reaches canplay/loadeddata and never fires
  // an error (e.g. the socket hangs after headers, or a throttle holds it open),
  // flip to an error after a timeout instead of spinning forever.
  React.useEffect(() => {
    if (!streamSrc) return undefined;
    const timer = window.setTimeout(() => {
      setLoad((prev) =>
        prev.status === "loading"
          ? {
              status: "error",
              message:
                "Preview timed out — the stream did not start. Check your connection, or that your API key is valid.",
            }
          : prev,
      );
    }, 15000);
    return () => window.clearTimeout(timer);
  }, [item.id, streamSrc]);

  // Apply the stream source imperatively (not via the JSX `src` prop) and tear
  // it down on unmount / source change: pause, drop src, load() so the
  // connection closes. Driving src from the effect keeps it correct under React
  // StrictMode's mount→unmount→remount double-invoke in dev — a cleanup-only
  // teardown strips src from the reused element and leaves the preview blank.
  //
  // This effect also restores the persisted volume/mute (so a new clip opens at
  // the user's last-used level instead of the hardcoded muted default) and
  // attaches a `volumechange` listener that persists subsequent user changes.
  // `key={streamSrc}` mounts a FRESH media element per clip, so restore must run
  // each time the source changes — which this effect's deps guarantee.
  React.useEffect(() => {
    const media = videoRef.current ?? audioRef.current;
    if (!media || !streamSrc) return undefined;

    media.src = streamSrc;

    // Restore the persisted volume/mute onto the fresh element. Setting these
    // programmatically queues a `volumechange` (the event is dispatched async,
    // after this effect body), so the listener below WILL see it — but by then
    // the element already holds the restored values, so it just re-persists the
    // same prefs (a harmless no-op). Only a genuine user slider/mute change
    // writes a different value. Restoring before attaching keeps the ordering
    // obvious; it is not load-bearing for correctness given the async dispatch.
    const prefs = loadPlayerPrefs();
    media.volume = prefs.volume;
    media.muted = prefs.muted;

    const onVolumeChange = () => {
      savePlayerPrefs({ volume: media.volume, muted: media.muted });
    };
    media.addEventListener("volumechange", onVolumeChange);

    media.load();

    // Drive autoplay imperatively (the JSX `autoPlay`/`muted` attributes were
    // removed). A blocked autoplay-with-sound rejects the play() promise —
    // swallow it so it neither surfaces as an unhandled rejection nor flips the
    // load state into an error; the user can press the visible native play
    // button. We deliberately do NOT force-mute to bypass the block, which
    // would defeat a restored unmuted preference. Skipped entirely when the
    // host asks for a paused mount (e.g. re-opening a collapsed dock).
    if (autoPlayRef.current) void media.play()?.catch(() => {});

    return () => {
      media.removeEventListener("volumechange", onVolumeChange);
      media.pause();
      media.removeAttribute("src");
      media.load();
    };
  }, [item.id, streamSrc]);

  // Sync the custom player UI from the active media element's events (audio
  // engine or <video> — both branches use the same custom controls). This is a
  // presentational mirror only — the element stays the source of truth. Keyed
  // to the same deps as the source effect so it re-binds to the fresh per-clip
  // element (both elements use `key={streamSrc}`) and tears every listener
  // down on unmount / clip switch. Fully StrictMode-safe: the cleanup removes
  // exactly the listeners this run added.
  //
  // It also seeds the UI from the element's CURRENT values on attach. Because
  // the source effect above runs first (same deps, declared earlier) it has
  // already restored the persisted volume/muted, so reading them here reflects
  // the restored level — and the subsequent `volumechange` keeps it in sync.
  React.useEffect(() => {
    if (!streamSrc) return undefined;
    const media: HTMLMediaElement | null = isAudio ? audioRef.current : videoRef.current;
    if (!media) return undefined;

    // Seed from the element's current state so the UI is correct immediately,
    // even for events that already fired before this listener attached.
    setIsPlaying(!media.paused && !media.ended);
    setCurrentTime(media.currentTime);
    setDuration(media.duration);
    setMediaVolume(clamp01(media.volume));
    setMediaMuted(media.muted);

    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onEnded = () => {
      setIsPlaying(false);
      // Reflect a replayable end-state: snap the readout to the end so the
      // bar shows full rather than freezing mid-track.
      if (isKnownDuration(media.duration)) setCurrentTime(media.duration);
    };
    const onTimeUpdate = () => {
      // Don't fight the thumb while the user is dragging it.
      if (isScrubbingRef.current) return;
      setCurrentTime(media.currentTime);
    };
    const onDurationChange = () => setDuration(media.duration);
    const onLoadedMetadata = () => {
      setDuration(media.duration);
      setCurrentTime(media.currentTime);
    };
    const onVolumeChange = () => {
      setMediaVolume(clamp01(media.volume));
      setMediaMuted(media.muted);
    };

    media.addEventListener("play", onPlay);
    media.addEventListener("pause", onPause);
    media.addEventListener("ended", onEnded);
    media.addEventListener("timeupdate", onTimeUpdate);
    media.addEventListener("durationchange", onDurationChange);
    media.addEventListener("loadedmetadata", onLoadedMetadata);
    media.addEventListener("volumechange", onVolumeChange);

    return () => {
      media.removeEventListener("play", onPlay);
      media.removeEventListener("pause", onPause);
      media.removeEventListener("ended", onEnded);
      media.removeEventListener("timeupdate", onTimeUpdate);
      media.removeEventListener("durationchange", onDurationChange);
      media.removeEventListener("loadedmetadata", onLoadedMetadata);
      media.removeEventListener("volumechange", onVolumeChange);
    };
  }, [isAudio, item.id, streamSrc]);

  // Register/unregister the host fullscreen affordance. Video clips expose a
  // function that fullscreens the <video>; audio clips register `null` so the
  // host hides its ⛶ button. Re-run when the type / source changes so the host
  // always holds a function bound to the current element (or null for audio).
  React.useEffect(() => {
    if (!registerFullscreen) return undefined;
    if (isAudio) {
      registerFullscreen(null);
      return () => registerFullscreen(null);
    }
    registerFullscreen(() => {
      const video = videoRef.current;
      if (video) void video.requestFullscreen?.().catch(() => {});
    });
    return () => registerFullscreen(null);
  }, [isAudio, item.id, streamSrc, registerFullscreen]);

  // While the user drags the seek thumb, track pointer motion on the window so
  // the drag continues even if the pointer leaves the thin track. Mirrors the
  // SceneViewerModal scrubber. Only armed during an active drag.
  React.useEffect(() => {
    if (!isScrubbing) return undefined;
    const onMove = (event: MouseEvent) => {
      const track = scrubRef.current;
      if (track) seekFromPointer(event, track);
    };
    const onUp = () => {
      setIsScrubbing(false);
      isScrubbingRef.current = false;
      const media = getMedia();
      if (media && wasPlayingBeforeScrubRef.current) void media.play()?.catch(() => {});
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // seekFromPointer reads refs/state via closure; duration in deps keeps the
    // fraction→time mapping current if metadata arrives mid-drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isScrubbing, duration]);

  function handleReady() {
    setLoad({ status: "ready" });
  }

  function handleError(media: HTMLMediaElement) {
    const code = media.error?.code;
    const detail = `${mediaErrorLabel(code)}${media.error?.message ? ` — ${media.error.message}` : ""}`;
    setLoad({ status: "error", message: detail });
    logFrontend("error", "tsukyio.preview.error", "Tsukyio preview stream failed", {
      assetId: item.id,
      type: item.type,
      errorCode: code ?? null,
      detail: safeLogValue(media.error?.message ?? null),
    });
  }

  // ---- Custom control handlers ----------------------------------------------
  // Each writes to the active media element imperatively; the element's events
  // then drive the UI state back through the sync effect. Volume/mute writes
  // flow through the element so the existing `volumechange` persistence
  // listener (in the source effect) picks them up — we add NO second
  // persistence path.
  function toggleMediaPlay() {
    const media = getMedia();
    if (!media) return;
    if (media.paused || media.ended) void media.play()?.catch(() => {});
    else media.pause();
  }

  function toggleMediaMute() {
    const media = getMedia();
    if (!media) return;
    const nextMuted = !media.muted;
    media.muted = nextMuted;
    // If unmuting a clip whose volume was dragged to 0, nudge it audible so the
    // unmute is actually heard instead of being silently zero.
    if (!nextMuted && media.volume === 0) media.volume = DEFAULT_PLAYER_PREFS.volume;
    // Reflect immediately (don't wait for the async `volumechange`) so the icon
    // and slider flip the instant the user clicks.
    setMediaMuted(nextMuted);
    setMediaVolume(clamp01(media.volume));
  }

  function setMediaVolumeFromSlider(next: number) {
    const media = getMedia();
    if (!media) return;
    const value = clamp01(next);
    media.volume = value;
    // Dragging the volume to a non-zero level implies the user wants sound;
    // clear mute so the change is audible. Setting to 0 leaves it as-is (the
    // element treats 0 volume as silent without needing the muted flag).
    if (value > 0 && media.muted) media.muted = false;
    // Optimistically reflect the new level NOW so the controlled <input> thumb
    // tracks the drag smoothly, instead of snapping back for a frame while it
    // waits for the async `volumechange` round-trip (most visible when dragging
    // up from a muted/zero state). The `volumechange` listener then re-sets the
    // same values — a harmless no-op.
    setMediaVolume(value);
    if (value > 0) setMediaMuted(false);
  }

  function seekFromPointer(event: MouseEvent | React.MouseEvent, track: HTMLDivElement) {
    const media = getMedia();
    if (!media || !isKnownDuration(duration)) return;
    const rect = track.getBoundingClientRect();
    const x = Math.min(Math.max(0, event.clientX - rect.left), rect.width);
    const fraction = rect.width === 0 ? 0 : x / rect.width;
    const nextTime = fraction * duration;
    media.currentTime = nextTime;
    setCurrentTime(nextTime);
  }

  function onScrubMouseDown(event: React.MouseEvent<HTMLDivElement>) {
    const media = getMedia();
    if (!media || !isKnownDuration(duration)) return;
    wasPlayingBeforeScrubRef.current = !media.paused && !media.ended;
    media.pause();
    setIsScrubbing(true);
    isScrubbingRef.current = true;
    seekFromPointer(event, event.currentTarget);
  }

  function onScrubKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const media = getMedia();
    // Gate on the same condition as the pointer path (duration known AND the
    // clip is actually ready), so arrow keys can't seek a not-yet-loaded clip.
    if (!media || !isKnownDuration(duration) || load.status !== "ready") return;
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = media.currentTime - 5;
    else if (event.key === "ArrowRight") next = media.currentTime + 5;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = duration;
    if (next === null) return;
    event.preventDefault();
    const clamped = Math.min(Math.max(0, next), duration);
    media.currentTime = clamped;
    setCurrentTime(clamped);
  }

  const knownDuration = isKnownDuration(duration);
  const seekDisabled = !knownDuration || load.status !== "ready";
  const progressPct = knownDuration
    ? Math.min(100, Math.max(0, (currentTime / duration) * 100))
    : 0;

  // Stage state classes drive the video control bar's visibility: the bar is
  // hidden during playback and revealed on hover, while paused, or mid-scrub
  // (the pointer can leave the stage during a drag).
  const stageClass = [
    "scene-viewer-stage",
    "tsukyio-player-stage",
    isAudio ? "is-audio" : "",
    !isAudio && !isPlaying ? "is-paused" : "",
    isScrubbing ? "is-scrubbing" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={stageClass}>
      {!streamSrc ? (
        <div className="scene-viewer-error direct-stream-error">
          <AlertTriangle size={16} />
          <span>No stream available for this clip.</span>
        </div>
      ) : isAudio ? (
        <>
          {/* Bare <audio> is the playback ENGINE only — `controls` removed,
              visually hidden. All UI below is bound to it via audioRef. */}
          <audio
            key={streamSrc}
            ref={audioRef}
            className="tsukyio-audio-engine"
            onCanPlay={handleReady}
            onLoadedData={handleReady}
            onError={(event) => handleError(event.currentTarget)}
          />
          <div
            className={`tsukyio-audio-player ${
              load.status === "ready" ? "is-ready" : "is-inert"
            }`}
            aria-hidden={load.status !== "ready"}
          >
            <div className="tsukyio-audio-controls">
              <button
                type="button"
                className="scene-viewer-button tsukyio-audio-play"
                onClick={toggleMediaPlay}
                disabled={load.status !== "ready"}
                aria-label={isPlaying ? "Pause" : "Play"}
              >
                {isPlaying ? (
                  <Pause size={16} strokeWidth={2.2} />
                ) : (
                  <Play size={16} strokeWidth={2.2} />
                )}
              </button>

              <span className="scene-viewer-time tsukyio-audio-time">
                {formatTime(currentTime)} / {knownDuration ? formatTime(duration) : "--:--"}
              </span>

              <div
                ref={scrubRef}
                className={`scene-viewer-scrub tsukyio-player-scrub ${
                  isScrubbing ? "is-scrubbing" : ""
                } ${seekDisabled ? "is-disabled" : ""}`}
                onMouseDown={seekDisabled ? undefined : onScrubMouseDown}
                onKeyDown={onScrubKeyDown}
                role="slider"
                tabIndex={seekDisabled ? -1 : 0}
                aria-label="Seek"
                aria-valuemin={0}
                aria-valuemax={knownDuration ? Math.floor(duration) : 0}
                aria-valuenow={Math.floor(currentTime)}
                aria-valuetext={`${formatTime(currentTime)} of ${
                  knownDuration ? formatTime(duration) : "unknown"
                }`}
                aria-disabled={seekDisabled}
              >
                <div className="scene-viewer-scrub-track">
                  <div
                    className="scene-viewer-scrub-fill"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
              </div>

              <div className="tsukyio-player-volume">
                <button
                  type="button"
                  className="scene-viewer-button"
                  onClick={toggleMediaMute}
                  disabled={load.status !== "ready"}
                  aria-label={mediaMuted || mediaVolume === 0 ? "Unmute" : "Mute"}
                >
                  {mediaMuted || mediaVolume === 0 ? (
                    <VolumeX size={16} strokeWidth={2.2} />
                  ) : (
                    <Volume2 size={16} strokeWidth={2.2} />
                  )}
                </button>
                <input
                  type="range"
                  className="tsukyio-player-vol-slider"
                  min={0}
                  max={1}
                  step={0.01}
                  value={mediaMuted ? 0 : mediaVolume}
                  disabled={load.status !== "ready"}
                  onChange={(event) =>
                    setMediaVolumeFromSlider(Number(event.currentTarget.value))
                  }
                  aria-label="Volume"
                />
              </div>
            </div>
          </div>
          {load.status === "loading" && (
            <div className="scene-viewer-loading" role="status">
              <Loader2 className="is-spinning" size={24} strokeWidth={2.1} />
              <span>Loading preview…</span>
            </div>
          )}
        </>
      ) : (
        <>
          {/* Native `controls` removed — the overlay bar below replaces them
              so the player matches the app aesthetic (same custom control set
              as audio, presented like SceneViewerModal's). Clicking the
              picture toggles playback, like a real player. */}
          <video
            key={streamSrc}
            ref={videoRef}
            playsInline
            preload="auto"
            onClick={load.status === "ready" ? toggleMediaPlay : undefined}
            onCanPlay={handleReady}
            onLoadedData={handleReady}
            onError={(event) => handleError(event.currentTarget)}
          />
          {load.status === "ready" && (
            <div className="scene-viewer-controls tsukyio-video-controls">
              <button
                type="button"
                className="scene-viewer-button"
                onClick={toggleMediaPlay}
                aria-label={isPlaying ? "Pause" : "Play"}
              >
                {isPlaying ? (
                  <Pause size={15} strokeWidth={2.2} />
                ) : (
                  <Play size={15} strokeWidth={2.2} />
                )}
              </button>

              <span className="scene-viewer-time">
                {formatTime(currentTime)} / {knownDuration ? formatTime(duration) : "--:--"}
              </span>

              <div
                ref={scrubRef}
                className={`scene-viewer-scrub tsukyio-player-scrub ${
                  isScrubbing ? "is-scrubbing" : ""
                } ${seekDisabled ? "is-disabled" : ""}`}
                onMouseDown={seekDisabled ? undefined : onScrubMouseDown}
                onKeyDown={onScrubKeyDown}
                role="slider"
                tabIndex={seekDisabled ? -1 : 0}
                aria-label="Seek"
                aria-valuemin={0}
                aria-valuemax={knownDuration ? Math.floor(duration) : 0}
                aria-valuenow={Math.floor(currentTime)}
                aria-valuetext={`${formatTime(currentTime)} of ${
                  knownDuration ? formatTime(duration) : "unknown"
                }`}
                aria-disabled={seekDisabled}
              >
                <div className="scene-viewer-scrub-track">
                  <div
                    className="scene-viewer-scrub-fill"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
              </div>

              <div className="tsukyio-player-volume">
                <button
                  type="button"
                  className="scene-viewer-button"
                  onClick={toggleMediaMute}
                  aria-label={mediaMuted || mediaVolume === 0 ? "Unmute" : "Mute"}
                >
                  {mediaMuted || mediaVolume === 0 ? (
                    <VolumeX size={15} strokeWidth={2.2} />
                  ) : (
                    <Volume2 size={15} strokeWidth={2.2} />
                  )}
                </button>
                <input
                  type="range"
                  className="tsukyio-player-vol-slider"
                  min={0}
                  max={1}
                  step={0.01}
                  value={mediaMuted ? 0 : mediaVolume}
                  onChange={(event) =>
                    setMediaVolumeFromSlider(Number(event.currentTarget.value))
                  }
                  aria-label="Volume"
                />
              </div>
            </div>
          )}
          {load.status === "loading" && (
            <div className="scene-viewer-loading" role="status">
              <Loader2 className="is-spinning" size={24} strokeWidth={2.1} />
              <span>Loading preview…</span>
            </div>
          )}
        </>
      )}
      {load.status === "error" && streamSrc && (
        <div className="scene-viewer-error direct-stream-error">
          <AlertTriangle size={16} />
          <span>Preview could not be played: {load.message}</span>
        </div>
      )}
    </div>
  );
}
