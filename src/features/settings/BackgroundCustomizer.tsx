import React from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Film,
  Image as ImageIcon,
  Loader2,
  Lock,
  Sun,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  DEFAULT_BG_STATE,
  WALLPAPER_FPS_OPTIONS,
  WALLPAPER_VIDEO_EXTENSIONS,
} from "../../lib/constants";
import { clampNumber } from "../../lib/numbers";
import { fileName } from "../../lib/paths";
import { extensionAccept, useFileDrop } from "../../lib/useFileDrop";
import type { BackgroundState } from "../../types/app";
import { readBridgeError } from "../../utils/bridge";
import { Dropdown } from "../../components/Dropdown";

const BG_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "bmp", "gif"];
const bgImageAccept = extensionAccept(BG_IMAGE_EXTENSIONS);
const bgVideoAccept = extensionAccept(WALLPAPER_VIDEO_EXTENSIONS);

const LEGIBILITY_NOTICE_TEXT =
  "Bright wallpapers can make text and buttons hard to see. If you can't read the screen well, make the background darker, add some blur, or choose a darker image.";
const LEGIBILITY_NOTICE_TYPING_MS = 34;
const LEGIBILITY_NOTICE_UNLOCK_MS = 10000;
const LEGIBILITY_NOTICE_LEAVE_MS = 700;
// The notice (and its 10s lock) is shown at most once per this window, so
// reopening the modal to tweak dim/blur/fps doesn't re-pay the wait every
// time. Tracked via a localStorage timestamp.
const LEGIBILITY_NOTICE_SNOOZE_MS = 10 * 60 * 1000;
const LEGIBILITY_NOTICE_SEEN_KEY = "bg.legibilityNotice.lastShown";

// True when the notice was shown within the snooze window. A missing/garbage
// timestamp or a storage failure means "show it" (the safe default); a
// timestamp in the future (clock moved back) also shows it rather than
// suppressing indefinitely.
function legibilityNoticeRecentlyShown(): boolean {
  try {
    const raw = window.localStorage.getItem(LEGIBILITY_NOTICE_SEEN_KEY);
    if (!raw) return false;
    const last = Number(raw);
    if (!Number.isFinite(last)) return false;
    const age = Date.now() - last;
    return age >= 0 && age < LEGIBILITY_NOTICE_SNOOZE_MS;
  } catch {
    return false;
  }
}

function markLegibilityNoticeShown(): void {
  try {
    window.localStorage.setItem(LEGIBILITY_NOTICE_SEEN_KEY, String(Date.now()));
  } catch {
    // Ignore storage failures; the notice just shows again next time.
  }
}

// ---- Wallpaper brightness sniff (drives the "use dark text" SUGGESTION) ----
// Downsample the picked image / a video frame onto a tiny canvas and measure
// perceptual luminance. Drives a dismissible suggestion only — never a forced
// override. Thresholds: a high mean catches uniformly light wallpapers; the
// bright-pixel fraction catches mixed shots whose mean is dragged down by a
// dark region but that are still mostly white where the UI sits.
const BRIGHT_MEAN_THRESHOLD = 0.58;
const BRIGHT_FRACTION_THRESHOLD = 0.45;

function sampleLuminance(
  source: CanvasImageSource,
): { mean: number; brightFraction: number } | null {
  try {
    const w = 48;
    const h = 27;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    let sum = 0;
    let bright = 0;
    const count = w * h;
    for (let i = 0; i < data.length; i += 4) {
      const lum = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
      sum += lum;
      if (lum > 0.82) bright += 1;
    }
    return { mean: sum / count, brightFraction: bright / count };
  } catch {
    // Canvas unavailable (test env) or the source is tainted — the suggestion
    // simply never appears; the manual toggle still works.
    return null;
  }
}

function looksBright(sample: { mean: number; brightFraction: number } | null): boolean {
  if (!sample) return false;
  return sample.mean >= BRIGHT_MEAN_THRESHOLD || sample.brightFraction >= BRIGHT_FRACTION_THRESHOLD;
}

type TabId = "image" | "video";

type WallpaperProgress = {
  stage: string;
  percent: number | null;
  message: string;
};

export function BackgroundCustomizer({
  initial,
  onPreview,
  onCommit,
  onCancel,
}: {
  initial: BackgroundState;
  onPreview: (state: BackgroundState) => void;
  onCommit: (state: BackgroundState) => void;
  onCancel: () => void;
}) {
  const [tab, setTab] = React.useState<TabId>(initial.videoPath ? "video" : "image");
  const [draft, setDraft] = React.useState<BackgroundState>(initial);
  const [busy, setBusy] = React.useState(false);
  const [encoding, setEncoding] = React.useState(false);
  const [sourceFps, setSourceFps] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [transcodeProgress, setTranscodeProgress] = React.useState<WallpaperProgress | null>(null);
  // Snoozed = the notice already ran inside the snooze window, so this mount
  // skips it entirely (no banner, no lock). Decided once at mount.
  const legibilitySnoozedRef = React.useRef(legibilityNoticeRecentlyShown());
  const [legibilityPhase, setLegibilityPhase] = React.useState<"counting" | "ready" | "leaving" | "gone">(
    legibilitySnoozedRef.current ? "gone" : "counting",
  );
  const [typedChars, setTypedChars] = React.useState(1);
  const [unlockSecondsLeft, setUnlockSecondsLeft] = React.useState(
    Math.round(LEGIBILITY_NOTICE_UNLOCK_MS / 1000),
  );
  React.useEffect(() => {
    if (legibilitySnoozedRef.current) return undefined;
    // Stamp at show time (not dismiss) so closing the modal mid-countdown
    // still counts — the user saw the warning either way.
    markLegibilityNoticeShown();
    let idx = 1;
    const typeId = window.setInterval(() => {
      idx += 1;
      setTypedChars(idx);
      if (idx >= LEGIBILITY_NOTICE_TEXT.length) {
        window.clearInterval(typeId);
      }
    }, LEGIBILITY_NOTICE_TYPING_MS);
    const tickId = window.setInterval(() => {
      setUnlockSecondsLeft((prev) => Math.max(0, prev - 1));
    }, 1000);
    const readyId = window.setTimeout(() => {
      setLegibilityPhase("ready");
      window.clearInterval(tickId);
    }, LEGIBILITY_NOTICE_UNLOCK_MS);
    return () => {
      window.clearInterval(typeId);
      window.clearInterval(tickId);
      window.clearTimeout(readyId);
    };
  }, []);
  const dismissLegibilityNotice = React.useCallback(() => {
    setLegibilityPhase((phase) => {
      if (phase !== "ready") return phase;
      window.setTimeout(() => setLegibilityPhase("gone"), LEGIBILITY_NOTICE_LEAVE_MS);
      return "leaving";
    });
  }, []);
  const legibilityLocked = legibilityPhase !== "gone";
  const legibilityTyping = typedChars < LEGIBILITY_NOTICE_TEXT.length;
  // Bright-wallpaper suggestion state. `brightSuggest` arms the dismissible
  // "use dark text?" row; dismissals are remembered per source path so
  // re-previewing the same file doesn't re-nag within this modal session.
  const [brightSuggest, setBrightSuggest] = React.useState(false);
  const brightDismissedRef = React.useRef<Set<string>>(new Set());
  const frameRef = React.useRef<HTMLDivElement | null>(null);
  const dragRef = React.useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null);
  const draftRef = React.useRef(draft);
  React.useEffect(() => { draftRef.current = draft; }, [draft]);
  // Bumped per transcode trigger so a slow encode can't overwrite the preview
  // when the user has since picked a different fps or source.
  const transcodeGenRef = React.useRef(0);
  // Synchronous mirror of `encoding` so startTranscode can decide whether to
  // cancel a prior ffmpeg without waiting for React state to commit.
  const encodingRef = React.useRef(false);

  // FPS dropdown choices clamped to the source's native rate. Encoding above
  // the source rate would just duplicate frames - bad UX, no quality gain.
  // The 15 fps floor stays available even for sub-15-fps sources. When
  // sourceFps is unknown (still probing, or probe couldn't read it), the
  // cap defaults to 30 rather than offering 60 - 60fps for a 24fps source
  // is exactly the bad UX the cap exists to prevent.
  const availableFpsOptions = React.useMemo(() => {
    const cap =
      sourceFps && Number.isFinite(sourceFps) && sourceFps > 0
        ? Math.max(15, Math.round(sourceFps))
        : 30;
    const filtered = WALLPAPER_FPS_OPTIONS.filter((fps) => fps <= cap);
    return filtered.length > 0 ? filtered : [15];
  }, [sourceFps]);

  const update = React.useCallback((patch: Partial<BackgroundState>) => {
    setDraft((current) => {
      const next = { ...current, ...patch };
      onPreview(next);
      return next;
    });
  }, [onPreview]);

  const previewUrl = draft.imagePath ? convertFileSrc(draft.imagePath) : "";
  const videoPreviewUrl = draft.videoPath ? convertFileSrc(draft.videoPath) : "";

  // Measure a wallpaper and arm the dark-text suggestion if it reads bright.
  // No-op when dark text is already on or this source was already dismissed.
  const evaluateBrightness = React.useCallback((source: CanvasImageSource, key: string) => {
    if (!key || brightDismissedRef.current.has(key)) return;
    if (draftRef.current.brightText) return;
    setBrightSuggest(looksBright(sampleLuminance(source)));
  }, []);

  function dismissBrightSuggest() {
    const key = tab === "video" ? draftRef.current.videoPath : draftRef.current.imagePath;
    if (key) brightDismissedRef.current.add(key);
    setBrightSuggest(false);
  }

  // Sniff picked images. (Videos are sniffed from the preview element's first
  // decoded frame via onLoadedData — see the <video> below.) The cancelled
  // flag drops a stale decode that lands after the user picked another file.
  React.useEffect(() => {
    setBrightSuggest(false);
    if (!draft.imagePath) return undefined;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled) evaluateBrightness(img, draft.imagePath);
    };
    img.src = convertFileSrc(draft.imagePath);
    return () => {
      cancelled = true;
    };
  }, [draft.imagePath, evaluateBrightness]);

  async function ingestImagePath(source: string) {
    setError(null);
    setBusy(true);
    try {
      const savedPath = await invoke<string>("save_background_image", { source });
      update({
        imagePath: savedPath,
        scale: 1,
        offsetX: 50,
        offsetY: 50,
      });
    } catch (e) {
      setError(readBridgeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function chooseImage() {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: "Image", extensions: BG_IMAGE_EXTENSIONS }],
      });
      if (!selected || typeof selected !== "string") return;
      await ingestImagePath(selected);
    } catch (e) {
      setError(readBridgeError(e));
    }
  }

  async function startTranscode(source: string, fps: number) {
    // Generation token lets a faster (cache-hit) result overtake a slower
    // running encode without one clobbering the other in setState. We also
    // explicitly cancel any prior in-flight ffmpeg so rapid replace-video
    // or FPS-flip clicks don't pile up parallel encodes burning CPU.
    if (encodingRef.current) {
      try {
        await invoke("wallpaper_cancel");
      } catch {
        // best-effort - even if cancel fails the gen token will discard the
        // stale result and the new encode will overwrite WALLPAPER_CHILD_PID
        // when its own ffmpeg starts.
      }
    }
    const gen = ++transcodeGenRef.current;
    setError(null);
    setEncoding(true);
    encodingRef.current = true;
    setTranscodeProgress({ stage: "starting", percent: 0, message: "Starting compression..." });
    try {
      const result = await invoke<{ path: string; source: string; cached: boolean; fps: number }>(
        "wallpaper_transcode",
        { source, fps },
      );
      if (gen !== transcodeGenRef.current) return;
      // Pair videoSource with the path the backend actually produced - the
      // backend echoes the source it transcoded, so we can never end up
      // with background_video pointing at one file while
      // background_video_source claims another.
      update({ videoPath: result.path, videoSource: result.source, videoFps: result.fps });
      setTranscodeProgress(null);
    } catch (e) {
      if (gen !== transcodeGenRef.current) return;
      setError(readBridgeError(e));
      setTranscodeProgress(null);
    } finally {
      if (gen === transcodeGenRef.current) {
        setEncoding(false);
        encodingRef.current = false;
      }
    }
  }

  async function ingestVideoPath(selected: string) {
    setError(null);
    // Probe the source rate first so the fps dropdown reflects the real
    // ceiling before we pick a default. The probe is cheap (~50ms) and
    // surfaces "unsupported codec" errors right away instead of after a
    // multi-second encode.
    let probeFps = 0;
    try {
      const probe = await invoke<{ sourceFps: number; durationSeconds: number }>(
        "wallpaper_probe",
        { source: selected },
      );
      probeFps = probe.sourceFps;
    } catch (e) {
      setError(readBridgeError(e));
      return;
    }
    // probeFps=0 means ffmpeg couldn't surface a frame rate (VFR, no fps tag,
    // exotic container). Falling back to "allow 60fps" defeats the whole
    // cap; 30 is the safe middle ground that won't bloat the file for what
    // is usually a 24/25/30fps source in disguise.
    const cap = probeFps > 0 ? Math.max(15, Math.round(probeFps)) : 30;
    const optionsForSource = WALLPAPER_FPS_OPTIONS.filter((fps) => fps <= cap);
    const pickFromOptions = optionsForSource.length > 0 ? optionsForSource : [15];
    const defaultFps = pickFromOptions.includes(30)
      ? 30
      : pickFromOptions[pickFromOptions.length - 1];
    setSourceFps(probeFps);
    update({ videoSource: selected, videoPath: "", videoFps: defaultFps });
    await startTranscode(selected, defaultFps);
  }

  async function chooseVideo() {
    setError(null);
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: "Video", extensions: [...WALLPAPER_VIDEO_EXTENSIONS] }],
      });
      if (!selected || typeof selected !== "string") return;
      await ingestVideoPath(selected);
    } catch (e) {
      setError(readBridgeError(e));
    }
  }

  async function changeFps(nextFps: number) {
    // Clear videoPath synchronously: until the new fps's encode lands, there
    // is no valid wallpaper to commit, and Apply's `!draft.videoPath` guard
    // depends on this to reject the previous fps's file under the new fps
    // number.
    update({ videoFps: nextFps, videoPath: "" });
    if (draftRef.current.videoSource) {
      await startTranscode(draftRef.current.videoSource, nextFps);
    }
  }

  // Probe the existing source on first mount so the dropdown opens with the
  // correct cap when the user is editing an already-configured wallpaper.
  // If the stored videoFps is now above the source's cap (config from an
  // older session, or source file replaced with a lower-fps version), snap
  // it down so the <select> doesn't render with a value not in its options.
  React.useEffect(() => {
    if (!initial.videoSource) return;
    let cancelled = false;
    void invoke<{ sourceFps: number; durationSeconds: number }>("wallpaper_probe", {
      source: initial.videoSource,
    })
      .then((probe) => {
        if (cancelled) return;
        setSourceFps(probe.sourceFps);
        const cap =
          probe.sourceFps > 0 ? Math.max(15, Math.round(probe.sourceFps)) : 30;
        const valid = WALLPAPER_FPS_OPTIONS.filter((fps) => fps <= cap);
        const pool = valid.length > 0 ? valid : [15];
        if (!pool.includes(draftRef.current.videoFps)) {
          const snapped = pool[pool.length - 1];
          update({ videoFps: snapped });
        }
      })
      .catch(() => {
        // Stale source path (file moved/deleted). Leave sourceFps null - the
        // dropdown will fall back to the conservative 30fps cap above.
      });
    return () => {
      cancelled = true;
    };
  }, [initial.videoSource, update]);

  const imageDropZone = useFileDrop({
    accept: bgImageAccept,
    enabled: !busy && tab === "image",
    onDrop: (paths) => {
      const first = paths[0];
      if (first) void ingestImagePath(first);
    },
  });

  const videoDropZone = useFileDrop({
    accept: bgVideoAccept,
    enabled: !busy && !encoding && tab === "video",
    onDrop: (paths) => {
      const first = paths[0];
      if (first) void ingestVideoPath(first);
    },
  });

  // Remove edits the DRAFT only. Deleting files here would be destructive
  // before commit: the persisted config still references them until Apply,
  // so a Remove followed by Cancel/close left config pointing at deleted
  // files — every surface goes transparent for a wallpaper that can't load,
  // and the whole app renders white. Files are GC'd at Apply time instead.
  function clearImage() {
    setError(null);
    update({ imagePath: "" });
  }

  function clearVideo() {
    setError(null);
    // Invalidate any in-flight transcode so its result can't repopulate
    // videoPath after the user explicitly removed the wallpaper.
    transcodeGenRef.current += 1;
    setSourceFps(null);
    update({ videoPath: "", videoSource: "", videoFps: DEFAULT_BG_STATE.videoFps });
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (tab !== "image" || !draft.imagePath) return;
    const frame = frameRef.current;
    if (!frame) return;
    frame.setPointerCapture(event.pointerId);
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      offsetX: draftRef.current.offsetX,
      offsetY: draftRef.current.offsetY,
    };
  }
  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const frame = frameRef.current;
    if (!drag || !frame) return;
    const rect = frame.getBoundingClientRect();
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    const scale = draftRef.current.scale;
    // At scale=1 the image covers the frame exactly; the translate-based
    // pan has zero overhang to sweep, so dragging is a no-op. The cropper
    // only has something to pan once the user zooms in.
    if (scale <= 1) return;
    const step = (scale - 1);
    const nextX = clampNumber(drag.offsetX - (dx / rect.width) * 100 / step, 0, 100);
    const nextY = clampNumber(drag.offsetY - (dy / rect.height) * 100 / step, 0, 100);
    update({ offsetX: nextX, offsetY: nextY });
  }
  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    dragRef.current = null;
    frameRef.current?.releasePointerCapture(event.pointerId);
  }
  function handleWheel(event: React.WheelEvent<HTMLDivElement>) {
    if (tab !== "image" || !draft.imagePath) return;
    event.preventDefault();
    const delta = -event.deltaY * 0.0015;
    const next = clampNumber(draftRef.current.scale + delta, 1, 5);
    update({ scale: Number(next.toFixed(3)) });
  }

  function reset() {
    // "Reset position" only — the dark-text preference is not positional.
    update({ ...DEFAULT_BG_STATE, imagePath: draft.imagePath, videoPath: draft.videoPath, videoSource: draft.videoSource, videoFps: draft.videoFps, brightText: draft.brightText });
  }

  async function applyImage() {
    const fields: Array<[string, string]> = [
      ["background_image", draft.imagePath],
      ["background_scale", String(draft.scale)],
      ["background_offset_x", String(draft.offsetX)],
      ["background_offset_y", String(draft.offsetY)],
      ["background_dim", String(Math.round(draft.dim))],
      ["background_blur", String(Math.round(draft.blur))],
      ["background_bright_text", draft.brightText ? "1" : "0"],
    ];
    // Picking image clears any active video so the two stay mutually
    // exclusive at render time (image won't ever shadow the video field).
    if (draft.imagePath) {
      fields.push(["background_video", ""]);
      fields.push(["background_video_source", ""]);
    }
    for (const [key, value] of fields) {
      await invoke<string>("set_config", { key, value });
    }
    // GC only AFTER the config writes above stop referencing the files:
    // wallpaper cache when an image displaced the video, ingested image
    // copies when the user removed the image. Best-effort — a failure just
    // leaves orphans for the next apply to sweep.
    try {
      if (draft.imagePath) {
        await invoke("wallpaper_clear");
      } else {
        await invoke("clear_background_image");
      }
    } catch {
      // Pruning is best-effort.
    }
    const next: BackgroundState = draft.imagePath
      ? { ...draft, videoPath: "", videoSource: "" }
      : draft;
    onCommit(next);
  }

  async function applyVideo() {
    if (!draft.videoPath && draft.videoSource) {
      // The transcode for this source + fps never produced a file - either
      // it's still running or it errored out earlier. Apply has nothing to
      // commit yet.
      setError("Wallpaper is still being prepared. Wait for the preview, then Apply.");
      return;
    }
    const fields: Array<[string, string]> = [
      ["background_video", draft.videoPath],
      ["background_video_source", draft.videoSource],
      ["background_video_fps", String(draft.videoFps)],
      ["background_dim", String(Math.round(draft.dim))],
      ["background_blur", String(Math.round(draft.blur))],
      ["background_bright_text", draft.brightText ? "1" : "0"],
    ];
    if (draft.videoPath) {
      // Setting a wallpaper hides the image background.
      fields.push(["background_image", ""]);
    }
    for (const [key, value] of fields) {
      await invoke<string>("set_config", { key, value });
    }
    // Cache GC, only AFTER config no longer references the swept files.
    // Settled on a wallpaper: prune sibling transcodes from this session
    // (other fps values the user previewed). Removed the wallpaper: sweep
    // the whole cache.
    try {
      if (draft.videoPath) {
        await invoke("wallpaper_commit", { keep: draft.videoPath });
      } else {
        await invoke("wallpaper_clear");
      }
    } catch {
      // Pruning is best-effort - failing here just leaves an orphan file
      // that the next commit will sweep, so don't surface it to the user.
    }
    const next: BackgroundState = draft.videoPath
      ? { ...draft, imagePath: "" }
      : draft;
    onCommit(next);
  }

  async function apply() {
    setError(null);
    setBusy(true);
    try {
      if (tab === "video") {
        await applyVideo();
      } else {
        await applyImage();
      }
    } catch (e) {
      setError(readBridgeError(e));
    } finally {
      setBusy(false);
      setTranscodeProgress(null);
    }
  }

  async function cancelTranscode() {
    // Bump the generation token BEFORE killing ffmpeg, so the catch branch
    // in startTranscode sees gen mismatch and silently bails instead of
    // surfacing the resulting "ffmpeg exited with code 1" as a red error.
    transcodeGenRef.current += 1;
    setEncoding(false);
    encodingRef.current = false;
    setTranscodeProgress(null);
    try {
      await invoke("wallpaper_cancel");
    } catch (e) {
      setError(readBridgeError(e));
    }
  }

  // Subscribe to transcode progress only while a transcode is running, so we
  // don't keep a Tauri listener alive for the whole modal lifetime.
  React.useEffect(() => {
    if (!encoding) return;
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    void listen<WallpaperProgress>("wallpaper-transcode-progress", (event) => {
      if (!cancelled) setTranscodeProgress(event.payload);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [encoding]);

  const sharedFrameProps = {
    onPointerDown: handlePointerDown,
    onPointerMove: handlePointerMove,
    onPointerUp: handlePointerUp,
    onPointerCancel: handlePointerUp,
    onWheel: handleWheel,
  };

  const videoSourceName = draft.videoSource ? fileName(draft.videoSource) : "";

  return (
    <div className="bg-customizer-backdrop" role="dialog" aria-label="Background customizer">
      <div className={`bg-customizer${legibilityLocked ? " is-locked" : ""}`}>
        <div className="bg-customizer-header">
          <span>Customize background</span>
          <button type="button" className="bg-customizer-close" onClick={onCancel} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {legibilityPhase !== "gone" && (
          <div className={`bg-customizer-warning${legibilityPhase === "leaving" ? " is-leaving" : ""}`}>
            <AlertTriangle size={15} strokeWidth={2.2} />
            <span className="bg-customizer-warning-text" role="status" aria-live="polite">
              {LEGIBILITY_NOTICE_TEXT.slice(0, typedChars)}
              {legibilityTyping && (
                <span className="bg-customizer-warning-caret" aria-hidden="true" />
              )}
            </span>
            <button
              type="button"
              className={`bg-customizer-warning-dismiss${legibilityPhase !== "counting" ? " is-ready" : ""}`}
              onClick={dismissLegibilityNotice}
              disabled={legibilityPhase !== "ready"}
              aria-label={
                legibilityPhase === "counting"
                  ? `Dismiss available in ${unlockSecondsLeft} seconds`
                  : "Got it, dismiss and unlock controls"
              }
            >
              {legibilityPhase === "counting" ? (
                <>
                  <Lock size={11} strokeWidth={2.4} aria-hidden="true" />
                  <span aria-hidden="true">{unlockSecondsLeft}s</span>
                </>
              ) : (
                <Check size={14} strokeWidth={2.8} aria-hidden="true" />
              )}
            </button>
          </div>
        )}

        <div className="bg-customizer-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "image"}
            className={`bg-customizer-tab spring-motion ${tab === "image" ? "is-active" : ""}`}
            onClick={() => setTab("image")}
          >
            <ImageIcon size={14} strokeWidth={2.2} />
            <span>Image</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "video"}
            className={`bg-customizer-tab spring-motion ${tab === "video" ? "is-active" : ""}`}
            onClick={() => setTab("video")}
          >
            <Film size={14} strokeWidth={2.2} />
            <span>Video wallpaper</span>
          </button>
        </div>

        {tab === "image" ? (
          <div
            ref={(node) => {
              frameRef.current = node;
              imageDropZone.ref.current = node;
            }}
            className={`bg-cropper-frame drop-zone ${draft.imagePath ? "is-active" : "is-empty"}${imageDropZone.hover ? " is-drop-target" : ""}`}
            role={draft.imagePath ? undefined : "button"}
            tabIndex={draft.imagePath ? undefined : 0}
            onClick={draft.imagePath || busy ? undefined : () => void chooseImage()}
            onKeyDown={
              draft.imagePath
                ? undefined
                : (event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      if (!busy) void chooseImage();
                    }
                  }
            }
            {...sharedFrameProps}
          >
            {draft.imagePath ? (
              <div
                className="bg-cropper-image"
                style={{
                  backgroundImage: `url("${previewUrl}")`,
                  backgroundPosition: "center",
                  transform: `scale(${draft.scale}) translate(${draft.scale > 1 ? (50 - draft.offsetX) * (draft.scale - 1) / draft.scale : 0}%, ${draft.scale > 1 ? (50 - draft.offsetY) * (draft.scale - 1) / draft.scale : 0}%)`,
                  filter: draft.blur > 0 ? `blur(${draft.blur * 0.4}px)` : undefined,
                }}
              />
            ) : (
              <div className="bg-cropper-empty">
                <ImageIcon size={28} strokeWidth={1.6} />
                <span>Click to pick an image · or drop one here</span>
              </div>
            )}
            {draft.imagePath && (
              <div
                className="bg-cropper-overlay"
                style={{ background: `rgba(5, 5, 7, ${draft.dim / 100})` }}
              />
            )}
            <div className="drop-zone-overlay">
              <Upload size={28} strokeWidth={1.8} />
              <span>Drop image to {draft.imagePath ? "replace" : "use"}</span>
              <small>PNG · JPG · WEBP · BMP · GIF</small>
            </div>
          </div>
        ) : (
          <div
            ref={(node) => {
              videoDropZone.ref.current = node;
            }}
            className={`bg-cropper-frame drop-zone ${draft.videoSource ? "is-active" : "is-empty"}${videoDropZone.hover ? " is-drop-target" : ""}`}
            role={draft.videoSource ? undefined : "button"}
            tabIndex={draft.videoSource ? undefined : 0}
            onClick={draft.videoSource || busy ? undefined : () => void chooseVideo()}
            onKeyDown={
              draft.videoSource
                ? undefined
                : (event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      if (!busy) void chooseVideo();
                    }
                  }
            }
          >
            {draft.videoPath ? (
              <video
                className="bg-cropper-video"
                src={videoPreviewUrl}
                autoPlay
                muted
                loop
                playsInline
                preload="auto"
                onLoadedData={(e) => evaluateBrightness(e.currentTarget, draft.videoPath)}
                style={{ filter: draft.blur > 0 ? `blur(${draft.blur * 0.4}px)` : undefined }}
              />
            ) : draft.videoSource ? (
              <div className="bg-cropper-empty">
                <Film size={28} strokeWidth={1.6} />
                <span>{encoding ? "Compressing" : "Preparing"} {videoSourceName}</span>
                <small>Preview will start as soon as the video is ready.</small>
              </div>
            ) : (
              <div className="bg-cropper-empty">
                <Film size={28} strokeWidth={1.6} />
                <span>Click to pick a video · or drop one here</span>
                <small>MP4 · MKV · WEBM · MOV · M4V</small>
              </div>
            )}
            {draft.videoPath && (
              <div
                className="bg-cropper-overlay"
                style={{ background: `rgba(5, 5, 7, ${draft.dim / 100})` }}
              />
            )}
            <div className="drop-zone-overlay">
              <Upload size={28} strokeWidth={1.8} />
              <span>Drop video to {draft.videoSource ? "replace" : "use"}</span>
              <small>MP4 · MKV · WEBM · MOV · M4V</small>
            </div>
          </div>
        )}

        <div className="bg-customizer-hint">
          {tab === "image"
            ? draft.imagePath
              ? "Drag to move the image · scroll to zoom"
              : ""
            : draft.videoSource
              ? sourceFps && sourceFps > 0
                ? `Video is ${sourceFps.toFixed(2)} frames per second · changing FPS converts the video again (cached after the first time).`
                : "Changing FPS converts the video again (cached after the first time)."
              : ""}
        </div>

        <div className="bg-customizer-controls">
          {tab === "image" && (
            <label className="bg-control">
              <span>Zoom <em>{draft.scale.toFixed(2)}×</em></span>
              <input
                type="range"
                min={1}
                max={5}
                step={0.01}
                value={draft.scale}
                onChange={(e) => update({ scale: Number(e.currentTarget.value) })}
                disabled={!draft.imagePath}
              />
            </label>
          )}
          {tab === "video" && (
            <label className="bg-control">
              <span>Frames per second <em>{draft.videoFps}</em></span>
              <Dropdown<number>
                value={draft.videoFps}
                onChange={(next) => void changeFps(next)}
                disabled={!draft.videoSource || busy || encoding}
                options={availableFpsOptions.map((fps) => ({ value: fps, label: `${fps} fps` }))}
              />
            </label>
          )}
          <label className="bg-control">
            <span>Dim <em>{Math.round(draft.dim)}%</em></span>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={draft.dim}
              onChange={(e) => update({ dim: Number(e.currentTarget.value) })}
            />
          </label>
          <label className="bg-control">
            <span>Blur <em>{Math.round(draft.blur)}px</em></span>
            <input
              type="range"
              min={0}
              max={40}
              step={1}
              value={draft.blur}
              onChange={(e) => update({ blur: Number(e.currentTarget.value) })}
            />
          </label>
          <div className="bg-control bg-control-toggle">
            <span>Dark text</span>
            <button
              type="button"
              className="bg-toggle"
              role="switch"
              aria-checked={draft.brightText}
              aria-label="Dark text for bright wallpapers"
              data-on={draft.brightText ? "true" : "false"}
              onClick={() => {
                const next = !draft.brightText;
                if (next) setBrightSuggest(false);
                update({ brightText: next });
              }}
              title={
                draft.brightText
                  ? "Switch the app back to light text"
                  : "Switch app text to dark for bright wallpapers"
              }
            >
              <span className="bg-toggle-knob" aria-hidden="true" />
            </button>
          </div>
        </div>

        {brightSuggest &&
          !draft.brightText &&
          (tab === "image" ? Boolean(draft.imagePath) : Boolean(draft.videoPath)) && (
            <div className="bg-bright-suggest" role="status">
              <Sun size={15} strokeWidth={2.2} aria-hidden="true" />
              <span className="bg-bright-suggest-text">
                This wallpaper looks bright — switch the app to dark text for readability?
              </span>
              <button
                type="button"
                className="install-btn is-secondary bg-bright-suggest-accept"
                onClick={() => {
                  setBrightSuggest(false);
                  update({ brightText: true });
                }}
              >
                <span>Use dark text</span>
              </button>
              <button
                type="button"
                className="bg-bright-suggest-dismiss"
                onClick={dismissBrightSuggest}
                aria-label="Dismiss dark text suggestion"
              >
                <X size={14} />
              </button>
            </div>
          )}

        {transcodeProgress && (
          <div className="bg-customizer-progress">
            <div className="bg-customizer-progress-bar" aria-hidden="true">
              <div
                className="bg-customizer-progress-fill"
                style={{ width: `${transcodeProgress.percent ?? 0}%` }}
              />
            </div>
            <div className="bg-customizer-progress-row">
              <span>{transcodeProgress.message}</span>
              {busy && (
                <button
                  type="button"
                  className="install-btn is-secondary"
                  onClick={() => void cancelTranscode()}
                >
                  <span>Cancel</span>
                </button>
              )}
            </div>
          </div>
        )}

        {error && (
          <div className="settings-notice is-error">
            <AlertTriangle size={16} /> {error}
          </div>
        )}

        <div className="bg-customizer-actions">
          <div className="bg-customizer-actions-left">
            {tab === "image" && draft.imagePath && (
              <button type="button" className="install-btn is-secondary" onClick={chooseImage} disabled={busy}>
                <ImageIcon size={16} strokeWidth={2.2} />
                <span>Replace image</span>
              </button>
            )}
            {tab === "image" && draft.imagePath && (
              <button type="button" className="install-btn is-secondary" onClick={clearImage} disabled={busy}>
                <Trash2 size={16} strokeWidth={2.2} />
                <span>Remove</span>
              </button>
            )}
            {tab === "image" && draft.imagePath && (
              <button type="button" className="install-btn is-secondary" onClick={reset} disabled={busy}>
                <span>Reset position</span>
              </button>
            )}
            {tab === "video" && draft.videoSource && (
              <button type="button" className="install-btn is-secondary" onClick={chooseVideo} disabled={busy || encoding}>
                <Film size={16} strokeWidth={2.2} />
                <span>Replace video</span>
              </button>
            )}
            {tab === "video" && (draft.videoPath || draft.videoSource) && (
              <button type="button" className="install-btn is-secondary" onClick={clearVideo} disabled={busy || encoding}>
                <Trash2 size={16} strokeWidth={2.2} />
                <span>Remove</span>
              </button>
            )}
          </div>
          <div className="bg-customizer-actions-right">
            <button type="button" className="install-btn is-secondary" onClick={onCancel} disabled={busy}>
              <span>Cancel</span>
            </button>
            <button
              type="button"
              className="install-btn is-primary"
              onClick={() => void apply()}
              disabled={busy || encoding || (tab === "video" && !draft.videoPath && Boolean(draft.videoSource))}
            >
              {busy || encoding ? <Loader2 size={16} className="audio-spin" /> : <CheckCircle2 size={16} strokeWidth={2.3} />}
              <span>{encoding ? "Compressing..." : busy ? "Saving..." : "Apply"}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
