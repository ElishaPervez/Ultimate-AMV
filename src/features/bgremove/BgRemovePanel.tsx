import React from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Cpu, Film, Sparkles, Upload, Video, Eye, RefreshCw, Sliders, Columns, AlertTriangle, CheckCircle2, Image } from "lucide-react";
import { setDiscordJob } from "../../lib/discord";
import { logFrontend, safeLogValue } from "../../lib/log";
import { fileName, normalizeSelectedPaths } from "../../lib/paths";
import { useFileDrop } from "../../lib/useFileDrop";
import { parseBridgePayload, readBridgeError } from "../../utils/bridge";
import type { BgRemoveProgress, BgRemoveStatus } from "../../types/bgremove";
import { BgRemoveProgressCard } from "./BgRemoveProgressCard";
import { BgRemoveResultCard } from "./BgRemoveResultCard";
import { VideoComparisonCard } from "./VideoComparisonCard";
import { ConversionSourceCard } from "../video/ConversionSourceCard";
import { Dropdown } from "../../components/Dropdown";

const VIDEO_INPUT_EXTENSIONS = ["mp4", "mkv", "avi", "webm", "mov"];
const IMAGE_INPUT_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "bmp"];
const BGREMOVE_INPUT_EXTENSIONS = [...VIDEO_INPUT_EXTENSIONS, ...IMAGE_INPUT_EXTENSIONS];

export type IsolateMode = "video" | "image";

function detectIsolateMode(path: string): IsolateMode | null {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  if (IMAGE_INPUT_EXTENSIONS.includes(ext)) return "image";
  if (VIDEO_INPUT_EXTENSIONS.includes(ext)) return "video";
  return null;
}

// The Python bridge runs one job at a time (a single child PID is tracked for
// cancellation), so the two mounted tab instances coordinate through this
// shared owner slot instead of launching concurrent jobs.
let busyOwner: IsolateMode | null = null;
const busyListeners = new Set<() => void>();
function setBusyOwner(owner: IsolateMode | null) {
  busyOwner = owner;
  busyListeners.forEach((listener) => listener());
}
function subscribeBusyOwner(listener: () => void) {
  busyListeners.add(listener);
  return () => {
    busyListeners.delete(listener);
  };
}
function getBusyOwner() {
  return busyOwner;
}

// Lets one tab hand a dropped/picked file of the other type to its sibling
// instance ("drop a video on the Image tab" → loads in the Video tab).
const fileRouters: Partial<Record<IsolateMode, (path: string) => void>> = {};

// Both tab instances mount at app start; share one hardware-status fetch.
let statusPromise: Promise<string> | null = null;
function fetchBgRemoveStatus(): Promise<string> {
  if (!statusPromise) {
    statusPromise = invoke<string>("bgremove_status").catch((error) => {
      statusPromise = null;
      throw error;
    });
  }
  return statusPromise;
}
const MODEL_LABELS: Record<string, string> = {
  u2netp: "Lightweight Fast (u2netp)",
  silueta: "Fast Silhouette (silueta)",
  anime: "Anime Character (isnet-anime)",
  general: "General Use (isnet-general-use)",
  u2net: "U²-Net Standard (u2net)",
  "birefnet-lite": "BiRefNet Lite (birefnet-general-lite)",
  birefnet: "BiRefNet Standard (birefnet-general)",
  "birefnet-massive": "BiRefNet Massive (birefnet-massive)",
};

export function BgRemovePanel({
  mode = "video",
  active = true,
  onRequestTab,
}: {
  mode?: IsolateMode;
  active?: boolean;
  onRequestTab?: (mode: IsolateMode) => void;
}) {
  const isImageTab = mode === "image";

  const [status, setStatus] = React.useState<BgRemoveStatus | null>(null);
  const [selectedFile, setSelectedFile] = React.useState<string>("");
  const [model, setModel] = React.useState<string>("anime");
  const [format, setFormat] = React.useState<string>(isImageTab ? "png" : "mov");
  const [forceCpu, setForceCpu] = React.useState<boolean>(false);
  const [progress, setProgress] = React.useState<BgRemoveProgress | null>(null);
  const [fileTypeWarning, setFileTypeWarning] = React.useState<string | null>(null);
  const [processing, setProcessing] = React.useState(false);
  const [resultMessage, setResultMessage] = React.useState<string | null>(null);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [outputPath, setOutputPath] = React.useState<string>("");
  
  const [isPreviewing, setIsPreviewing] = React.useState<boolean>(false);
  const [previewData, setPreviewData] = React.useState<{
    original: string;
    isolated: string;
    frame: number;
    totalFrames: number;
    elapsedSeconds: number;
  } | null>(null);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  // Video tab: the frame the user scrubbed to; null means the backend's
  // default pick (33% into the video).
  const [previewFrame, setPreviewFrame] = React.useState<number | null>(null);
  // Post-run comparison player: original source + the showcase WebM the
  // backend encodes from the finished export.
  const [showcase, setShowcase] = React.useState<{
    original: string;
    isolated: string;
    fps: number | null;
  } | null>(null);
  // Raw filesystem path to the cached isolated PNG from the last preview.
  // Used by the fast-path download to skip re-running the AI pipeline.
  const [cachedIsolatedPath, setCachedIsolatedPath] = React.useState<string>("");
  // Track which settings produced the current cached preview so we can
  // detect when the cache is stale.
  const previewFileRef = React.useRef<string>("");
  const previewModelRef = React.useRef<string>("");
  const previewCpuRef = React.useRef<boolean>(false);

  const cancellingRef = React.useRef(false);

  const jobOwner = React.useSyncExternalStore(subscribeBusyOwner, getBusyOwner);
  const otherTabBusy = jobOwner !== null && jobOwner !== mode;

  // One auto-preview attempt per (file, model, hardware) combination on the
  // image tab. Re-checks once an in-flight preview or the other tab's job
  // finishes, so attempts deferred by either are picked up.
  const previewAttemptRef = React.useRef<string>("");
  React.useEffect(() => {
    if (!isImageTab || !selectedFile || otherTabBusy || isPreviewing || processing) return;
    if (previewAttemptRef.current === `${selectedFile}|${model}|${forceCpu}`) return;
    void generatePreview();
  }, [selectedFile, model, forceCpu, otherTabBusy, isPreviewing, processing]);

  React.useEffect(() => {
    void refreshStatus();
  }, []);

  React.useEffect(() => {
    setDiscordJob("Isolating background", processing);
    return () => setDiscordJob("Isolating background", false);
  }, [processing]);

  const firstProgressLoggedRef = React.useRef(false);
  React.useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<BgRemoveProgress>("bgremove-progress", (event) => {
      // The progress channel is global; only the tab that owns the running
      // job should react to it.
      if (getBusyOwner() === mode) {
        // DIAGNOSTIC (progress-stuck investigation): confirm events make it
        // from the Rust bridge into the webview listener.
        if (!firstProgressLoggedRef.current) {
          firstProgressLoggedRef.current = true;
          logFrontend("info", "bgremove.progress.received", "First progress event reached the panel", {
            mode,
            payload: safeLogValue(event.payload),
          });
        }
        setProgress(event.payload);
      }
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => {
      unlisten?.();
    };
  }, [mode]);

  async function refreshStatus() {
    try {
      const raw = await fetchBgRemoveStatus();
      const nextStatus = parseBridgePayload<BgRemoveStatus>(raw);
      setStatus(nextStatus);
      // Auto-set force CPU if GPU is not available
      if (nextStatus && nextStatus.hardware && !nextStatus.hardware.hasCuda) {
        setForceCpu(true);
      }
    } catch (error) {
      setErrorMessage(readBridgeError(error));
    }
  }

  function loadFile(path: string) {
    if (processing || isPreviewing) return;
    previewAttemptRef.current = "";
    setSelectedFile(path);
    setResultMessage(null);
    setErrorMessage(null);
    setPreviewData(null);
    setPreviewError(null);
    setPreviewFrame(null);
    setShowcase(null);
    setFileTypeWarning(null);
  }

  // Keep the router pointed at the latest render's state without re-registering.
  const loadFileRef = React.useRef(loadFile);
  loadFileRef.current = loadFile;

  React.useEffect(() => {
    fileRouters[mode] = (path) => {
      loadFileRef.current(path);
    };
    return () => {
      delete fileRouters[mode];
    };
  }, [mode]);

  // Auto-detect the file type: a file matching this tab loads here, anything
  // else switches to the sibling tab and loads there. Files that are neither
  // a supported video nor image surface a warning instead of loading.
  function routeFile(path: string) {
    const target = detectIsolateMode(path);
    if (!target) {
      setFileTypeWarning(
        `"${fileName(path)}" isn't a supported video (${VIDEO_INPUT_EXTENSIONS.join(", ")}) or image (${IMAGE_INPUT_EXTENSIONS.join(", ")}).`,
      );
      return;
    }
    setFileTypeWarning(null);
    if (target === mode) {
      loadFile(path);
      return;
    }
    onRequestTab?.(target);
    fileRouters[target]?.(path);
  }

  async function pickInputFile() {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [
        {
          name: "Video or Image File",
          extensions: BGREMOVE_INPUT_EXTENSIONS,
        },
        {
          name: "Video File",
          extensions: VIDEO_INPUT_EXTENSIONS,
        },
        {
          name: "Image File",
          extensions: IMAGE_INPUT_EXTENSIONS,
        },
      ],
    });

    const paths = normalizeSelectedPaths(selected);
    if (paths && paths.length > 0) {
      routeFile(paths[0]);
    }
  }

  async function runBackgroundRemoval() {
    if (!selectedFile) return;
    const owner = getBusyOwner();
    if (owner !== null && owner !== mode) return;

    setBusyOwner(mode);
    setProcessing(true);
    setResultMessage(null);
    setErrorMessage(null);
    setShowcase(null);
    cancellingRef.current = false;

    // Prompt user for saving location
    const isPngSequence = format === "png";
    
    let destinationPath = "";
    try {
      if (isImage) {
        const proposedName = fileName(selectedFile).replace(/\.[^/.]+$/, "") + "_transparent.png";
        const selectedSave = await save({
          defaultPath: proposedName,
          filters: [
            {
              name: "Transparent PNG",
              extensions: ["png"],
            },
          ],
        });
        if (!selectedSave) {
          setProcessing(false);
          setProgress(null);
          return;
        }
        destinationPath = selectedSave;
      } else if (isPngSequence) {
        // For PNG sequence, let them pick/create a folder
        const selectedDir = await open({
          multiple: false,
          directory: true,
        });
        if (!selectedDir) {
          setProcessing(false);
          setProgress(null);
          return;
        }
        destinationPath = Array.isArray(selectedDir) ? selectedDir[0] : selectedDir;
      } else {
        // Single-file transparent video (ProRes MOV or WebM)
        const extension = format === "webm" ? "webm" : "mov";
        const proposedName = fileName(selectedFile).replace(/\.[^/.]+$/, "") + `_transparent.${extension}`;
        const selectedSave = await save({
          defaultPath: proposedName,
          filters: [
            {
              name: format === "webm" ? "Transparent WebM" : "Transparent ProRes MOV",
              extensions: [extension],
            },
          ],
        });
        if (!selectedSave) {
          setProcessing(false);
          setProgress(null);
          return;
        }
        destinationPath = selectedSave;
      }

      setOutputPath(destinationPath);

      // Fast path: if we're saving an image and have a valid cached preview
      // generated with the same model/hardware settings, just copy the file
      // instead of re-running the entire AI pipeline.
      const canUseCachedPreview =
        isImage &&
        cachedIsolatedPath &&
        previewFileRef.current === selectedFile &&
        previewModelRef.current === model &&
        previewCpuRef.current === forceCpu;

      let raw: string;
      if (canUseCachedPreview) {
        raw = await invoke<string>("bgremove_save_preview", {
          sourcePath: cachedIsolatedPath,
          destinationPath: destinationPath,
        });
      } else {
        // Full pipeline: spawn Python process for video or stale-cache images
        setProgress({
          type: "progress",
          stage: "dependencies",
          percent: -1,
          message: "Verifying background removal tools...",
        });
        raw = await invoke<string>("bgremove_process", {
          inputPath: selectedFile,
          outputPath: destinationPath,
          model: model,
          format: format,
          cpu: forceCpu,
        });
      }

      const payload = parseBridgePayload<{
        type: string;
        output: string;
        frames: number;
        elapsedSeconds: number;
        fps?: number | null;
        showcase?: string | null;
      }>(raw);

      if (cancellingRef.current) {
        setResultMessage("Background removal cancelled.");
      } else {
        const countText = isImage ? "image" : `${payload.frames} frames`;
        setResultMessage(
          `Background removal complete. Processed ${countText} in ${payload.elapsedSeconds}s.`
        );
        if (payload.showcase) {
          // The showcase WebM is rewritten at a fixed path each run; the
          // query param defeats the webview's cache of the previous one.
          setPreviewData(null);
          setShowcase({
            original: convertFileSrc(selectedFile),
            isolated: `${convertFileSrc(payload.showcase)}?v=${Date.now()}`,
            fps: payload.fps ?? null,
          });
        }
      }
    } catch (error) {
      if (!cancellingRef.current) {
        setErrorMessage(readBridgeError(error));
      }
    } finally {
      setProcessing(false);
      setProgress(null);
      cancellingRef.current = false;
      setBusyOwner(null);
    }
  }

  async function cancelProcessing() {
    cancellingRef.current = true;
    setProgress({
      type: "progress",
      stage: "cancelling",
      percent: -1,
      message: "Stopping background removal process...",
    });
    try {
      await invoke("cancel_bgremove");
    } catch (error) {
      logFrontend("error", "bgremove.cancel.error", "Could not cancel background removal", {
        error: safeLogValue(error),
      });
    }
  }

  async function generatePreview(frameOverride?: number) {
    // The busyOwner check below doesn't cover a job running on THIS tab, so
    // guard processing explicitly now that the panel stays interactive.
    if (!selectedFile || processing) return;
    const owner = getBusyOwner();
    if (owner !== null && owner !== mode) return;

    const frame = frameOverride ?? previewFrame ?? -1;
    if (frameOverride !== undefined) {
      setPreviewFrame(frameOverride);
    }

    previewAttemptRef.current = `${selectedFile}|${model}|${forceCpu}`;
    setBusyOwner(mode);
    setIsPreviewing(true);
    setPreviewError(null);
    setPreviewData(null);
    setShowcase(null);

    try {
      const raw = await invoke<string>("bgremove_preview", {
        inputPath: selectedFile,
        model: model,
        cpu: forceCpu,
        cacheTag: mode,
        frame,
      });

      const payload = parseBridgePayload<{
        type: string;
        original: string;
        isolated: string;
        frame: number;
        totalFrames?: number;
        elapsedSeconds: number;
      }>(raw);

      if (payload.type === "preview_done") {
        setPreviewData({
          original: convertFileSrc(payload.original),
          isolated: convertFileSrc(payload.isolated),
          frame: payload.frame,
          totalFrames: payload.totalFrames ?? 1,
          elapsedSeconds: payload.elapsedSeconds,
        });
        // Cache the raw filesystem path + settings for fast-path download
        setCachedIsolatedPath(payload.isolated);
        previewFileRef.current = selectedFile;
        previewModelRef.current = model;
        previewCpuRef.current = forceCpu;
      } else {
        throw new Error("Unexpected response from preview command");
      }
    } catch (error) {
      setPreviewError(readBridgeError(error));
    } finally {
      setIsPreviewing(false);
      setProgress(null);
      setBusyOwner(null);
    }
  }

  const dropEnabled = !processing && !isPreviewing && active;
  const dropZone = useFileDrop({
    // No accept filter: unsupported files must reach routeFile so it can warn
    // instead of the drop silently doing nothing. A wrong-type media drop
    // switches to the matching tab.
    enabled: dropEnabled,
    onDrop: (files) => {
      const supported = files.find((file) => detectIsolateMode(file) !== null);
      routeFile(supported ?? files[0]);
    },
  });

  const isImage = IMAGE_INPUT_EXTENSIONS.includes(selectedFile.split(".").pop()?.toLowerCase() || "");
  // PNG sequences save to a directory the user picked; everything else is a
  // single file whose parent folder is what "Open folder" should reveal.
  const isSingleFileOutput = isImage || format !== "png";
  const outputDir = outputPath ? (isSingleFileOutput ? outputPath.substring(0, outputPath.lastIndexOf("\\")) : outputPath) : "";
  // Both tab instances stay mounted so each keeps its file/preview/progress
  // state; only the active one is shown.
  const hiddenStyle = active ? undefined : { display: "none" as const };

  return (
    <section
      ref={dropZone.ref}
      className={`conversion-panel drop-zone${dropZone.hover ? " is-drop-target" : ""}`}
      style={hiddenStyle}
    >
      <div className="drop-zone-overlay">
        <Upload size={32} strokeWidth={1.8} />
        <span>Drop video or image to remove background</span>
        <small>Files open in the matching tab automatically</small>
      </div>

      <div className="conversion-hero">
        <div>
          <span className="conversion-kicker">Character Isolation</span>
          <h2>{isImageTab ? "Image" : "Video"} Background Removal</h2>
          <p>
            {isImageTab
              ? "Isolate foreground characters and subjects from static images, exporting as a transparent PNG."
              : "Isolate foreground characters and subjects from video files, exporting as transparent ProRes MOV, WebM, or PNG sequence."}
          </p>
        </div>
      </div>

      <div className="conversion-grid">
        {/* Left Side: Source details / preview */}
        <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          <ConversionSourceCard
            icon={isImageTab ? <Image size={22} /> : <Video size={22} />}
            label={isImageTab ? "Input Image" : "Input Video"}
            selectedFiles={selectedFile ? [selectedFile] : []}
            pickLabel={selectedFile ? "Change file" : "Select file"}
            onPick={pickInputFile}
            disabled={processing || isPreviewing}
          />

          {fileTypeWarning && (
            <div
              className="glass"
              style={{
                padding: "16px",
                borderRadius: "12px",
                border: "1px solid rgba(245, 158, 11, 0.2)",
                background: "rgba(245, 158, 11, 0.05)",
                color: "#fbbf24",
                fontSize: "13px",
              }}
            >
              <h4 style={{ margin: "0 0 4px 0", fontWeight: 600 }}>Unsupported file type</h4>
              <p style={{ margin: 0 }} className="dim-text">
                {fileTypeWarning}
              </p>
            </div>
          )}

          {/* Preview loading spinner, error banner, or comparison card */}
          {isPreviewing && (
            <div
              className="glass"
              style={{
                padding: "40px 20px",
                borderRadius: "12px",
                border: "1px solid rgba(255,255,255,0.06)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: "16px",
              }}
            >
              <div
                style={{
                  width: "40px",
                  height: "40px",
                  border: "3px solid rgba(255,255,255,0.1)",
                  borderTopColor: "var(--accent-a)",
                  borderRadius: "50%",
                  animation: "spin 1s linear infinite",
                }}
              />
              <div style={{ textAlign: "center" }}>
                <h4 style={{ margin: "0 0 4px 0", fontSize: "14px" }}>
                  {isImageTab ? "Isolating Background..." : "Isolating AI Preview Frame..."}
                </h4>
                <p className="dim-text" style={{ fontSize: "12px", margin: 0 }}>
                  {isImageTab
                    ? `Running ${MODEL_LABELS[model] || model} AI model on the image.`
                    : "Extracting representative frame and running segmentation model."}
                </p>
              </div>
            </div>
          )}

          {previewError && (
            <div
              className="glass"
              style={{
                padding: "16px",
                borderRadius: "12px",
                border: "1px solid rgba(239, 68, 68, 0.2)",
                background: "rgba(239, 68, 68, 0.05)",
                color: "#f87171",
                fontSize: "13px",
              }}
            >
              <h4 style={{ margin: "0 0 4px 0", fontWeight: 600 }}>
                Failed to {isImageTab ? "isolate image" : "generate frame preview"}
              </h4>
              <p style={{ margin: 0 }} className="dim-text">
                {previewError}
              </p>
              <button
                type="button"
                className="install-btn is-secondary"
                style={{
                  marginTop: "10px",
                  padding: "6px 10px",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  fontSize: "12px",
                }}
                disabled={isPreviewing || processing || otherTabBusy}
                onClick={() => void generatePreview()}
              >
                <RefreshCw size={14} strokeWidth={2.3} />
                <span>Try again</span>
              </button>
            </div>
          )}

          {!isPreviewing && previewData && (
            <PreviewComparisonCard
              original={previewData.original}
              isolated={previewData.isolated}
              frame={previewData.frame}
              totalFrames={previewData.totalFrames}
              elapsedSeconds={previewData.elapsedSeconds}
              model={model}
              isPreviewing={isPreviewing}
              disabled={isPreviewing || processing}
              onRegenerate={() => void generatePreview()}
              onSeekFrame={(frame) => void generatePreview(frame)}
              isImage={isImageTab}
            />
          )}

          {showcase && (
            <VideoComparisonCard
              original={showcase.original}
              isolated={showcase.isolated}
              fps={showcase.fps}
            />
          )}

          {/* Tips Card */}
          <div
            className="glass"
            style={{
              padding: "20px",
              borderRadius: "12px",
              border: "1px solid rgba(255,255,255,0.06)",
              background: "linear-gradient(135deg, rgba(255,255,255,0.02) 0%, rgba(255,255,255,0.01) 100%)",
            }}
          >
            <h4 style={{ margin: "0 0 10px 0", fontSize: "14px", display: "flex", alignItems: "center", gap: "8px" }}>
              <Sparkles size={16} style={{ color: "var(--accent-a)" }} />
              Workflow Tips
            </h4>
            <ul style={{ paddingLeft: "18px", margin: 0, fontSize: "13px", lineHeight: "1.7" }} className="dim-text">
              {isImageTab ? (
                <>
                  <li>
                    <strong>Instant Cutout Preview:</strong> Selecting an image automatically generates a transparency preview with side-by-side and interactive slider comparison modes.
                  </li>
                  <li>
                    <strong>Fast Saving:</strong> Once a preview is generated, saving copies the cached preview file without repeating the AI segmentation process.
                  </li>
                  <li>
                    <strong>Model Options:</strong> Choose lightweight models for fast processing, or detailed models for precise edge boundaries.
                  </li>
                </>
              ) : (
                <>
                  <li>
                    <strong>ProRes 4444 + Alpha:</strong> The transparent video format editors import natively (Premiere, After Effects, DaVinci Resolve). Use WebM only for OBS overlays and web pages.
                  </li>
                  <li>
                    <strong>Frame Check:</strong> Generate an AI preview, then drag the &quot;Check frame&quot; slider to re-test the isolation on any frame of the video.
                  </li>
                  <li>
                    <strong>Anime Characters:</strong> The Anime Character (isnet-anime) model is optimized specifically for cel-shaded boundary outlines.
                  </li>
                  <li>
                    <strong>Hardware Acceleration:</strong> CUDA (GPU) acceleration is recommended to minimize frame processing times.
                  </li>
                </>
              )}
            </ul>
          </div>
        </div>

        {/* Right Side: Options / Action */}
        <div className="conversion-card run-card">
          <div className="conversion-format-card wide">
            {status && (
              <div className={`conversion-compat ${status.hardware && status.hardware.hasCuda ? "is-ready" : "is-locked"}`}>
                {status.hardware && status.hardware.hasCuda ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
                <span>
                  {status.hardware && status.hardware.hasCuda
                    ? "NVIDIA CUDA GPU acceleration enabled"
                    : "NVIDIA CUDA GPU not detected. Running in slow CPU mode."}
                </span>
              </div>
            )}

            {/* Model Select */}
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <label htmlFor="model-select" className="conversion-field-label">
                AI Segmentation Model
              </label>
              <Dropdown<string>
                options={[
                  {
                    value: "u2netp",
                    label: "Lightweight Fast (u2netp)",
                    description: "Ultra-lightweight model. Fast processing, lower boundary accuracy.",
                  },
                  {
                    value: "silueta",
                    label: "Fast Silhouette (silueta)",
                    description: "Optimized for fast silhouette extraction.",
                  },
                  {
                    value: "anime",
                    label: "Anime Character (isnet-anime)",
                    description: "Recommended for anime and cel-shaded illustrations.",
                  },
                  {
                    value: "general",
                    label: "General Use (isnet-general-use)",
                    description: "General-purpose subject and mixed-content isolation.",
                  },
                  {
                    value: "u2net",
                    label: "U²-Net Standard (u2net)",
                    description: "Classic general-purpose model with balanced speed and quality.",
                  },
                  {
                    value: "birefnet-lite",
                    label: "BiRefNet Lite (birefnet-general-lite)",
                    description: "Lighter BiRefNet model with good edge boundaries.",
                  },
                  {
                    value: "birefnet",
                    label: "BiRefNet Standard (birefnet-general)",
                    description: "High-precision edge detail. Slower processing.",
                  },
                  {
                    value: "birefnet-massive",
                    label: "BiRefNet Massive (birefnet-massive)",
                    description: "Maximum precision. Slowest processing, best for fine details.",
                  },
                ]}
                value={model}
                onChange={setModel}
              />
            </div>

            {/* Export Format Select */}
            {!isImageTab && (
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <label htmlFor="format-select" className="conversion-field-label">
                  Export Format
                </label>
                <Dropdown<string>
                  options={[
                    {
                      value: "mov",
                      label: "Editor Video (ProRes 4444 MOV + Alpha)",
                      description: "Transparent video for Premiere, After Effects, and DaVinci Resolve. Large files.",
                    },
                    {
                      value: "webm",
                      label: "Web Video (WebM VP9 + Alpha)",
                      description: "Compact transparent video for OBS overlays and browsers. Most editors can't import it.",
                    },
                    {
                      value: "png",
                      label: "Lossless Image Sequence (PNG Sequence)",
                      description: "Exports directory of transparent PNG frames.",
                    },
                  ]}
                  value={format}
                  onChange={setFormat}
                />
              </div>
            )}

            {/* Hardware Selection */}
            <div style={{ display: "flex", flexDirection: "column", gap: "8px", borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: "12px" }}>
              <span className="conversion-field-label">
                Hardware Accelerator
              </span>
              <div className="conversion-segment">
                <button
                  type="button"
                  className={!forceCpu ? "is-active" : ""}
                  disabled={!!(status && status.hardware && !status.hardware.hasCuda)}
                  onClick={() => setForceCpu(false)}
                >
                  GPU (CUDA)
                </button>
                <button
                  type="button"
                  className={forceCpu ? "is-active" : ""}
                  onClick={() => setForceCpu(true)}
                >
                  CPU Mode
                </button>
              </div>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="conversion-run-actions" style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "24px", paddingTop: "20px", borderTop: "1px solid rgba(255,255,255,0.07)" }}>
            {otherTabBusy && (
              <p className="dim-text" style={{ fontSize: "12px", margin: 0 }}>
                The {isImageTab ? "Video" : "Image"} Isolate tab is processing — one isolation job runs at a time.
              </p>
            )}
            {(resultMessage || errorMessage) && !processing && (
              <BgRemoveResultCard
                kind={errorMessage ? "error" : "success"}
                message={errorMessage || resultMessage || ""}
                outputDir={outputDir}
                onRetry={errorMessage ? runBackgroundRemoval : undefined}
                onDismiss={() => {
                  setResultMessage(null);
                  setErrorMessage(null);
                }}
              />
            )}
            {processing ? (
              <BgRemoveProgressCard
                progress={progress}
                onCancel={cancelProcessing}
                isImage={isImageTab}
              />
            ) : (
              <>
                {/* The image tab auto-previews on select and on model/hardware
                    change, so it gets no manual preview button — error retry
                    lives on the preview-error banner instead. */}
                {!isImageTab && (
                  <button
                    type="button"
                    className="conversion-pick-btn"
                    style={{
                      width: "100%",
                      minHeight: "38px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "8px",
                    }}
                    disabled={!selectedFile || isPreviewing || otherTabBusy}
                    onClick={() => void generatePreview()}
                  >
                    <Eye size={16} />
                    <span>{isPreviewing ? "Generating Preview..." : "Generate AI Preview"}</span>
                  </button>
                )}

                <button
                  type="button"
                  className="conversion-run-btn"
                  style={{
                    width: "100%",
                    minHeight: "38px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "8px",
                  }}
                  disabled={!selectedFile || isPreviewing || otherTabBusy}
                  onClick={runBackgroundRemoval}
                >
                  <Sparkles size={16} />
                  <span>{isImageTab ? "Download Isolated Image" : "Remove Background"}</span>
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

// Scrub through the source video and re-run the single-frame AI preview at
// the chosen frame. Regeneration happens on release, not while dragging —
// every regen is a full model pass on that frame.
function FrameScrubber({
  frame,
  totalFrames,
  disabled,
  onSeek,
}: {
  frame: number;
  totalFrames: number;
  disabled?: boolean;
  onSeek: (frame: number) => void;
}) {
  const [value, setValue] = React.useState(frame);
  // Snap the thumb to the frame the preview actually shows when a new
  // preview lands.
  React.useEffect(() => {
    setValue(frame);
  }, [frame]);

  const commit = () => {
    if (!disabled && value !== frame) onSeek(value);
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
      <span className="dim-text" style={{ fontSize: "11px", whiteSpace: "nowrap" }}>
        Check frame
      </span>
      <input
        type="range"
        aria-label="Preview frame"
        min={0}
        max={Math.max(0, totalFrames - 1)}
        value={value}
        disabled={disabled}
        onChange={(event) => setValue(Number(event.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        style={{ flex: 1, accentColor: "rgb(var(--theme-accent-rgb))" }}
      />
      <span
        className="dim-text"
        style={{ fontSize: "11px", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}
      >
        {value} / {totalFrames - 1}
      </span>
    </div>
  );
}

interface ImageComparisonSliderProps {
  original: string;
  isolated: string;
}

function ImageComparisonSlider({ original, isolated }: ImageComparisonSliderProps) {
  const [sliderPosition, setSliderPosition] = React.useState(50); // percentage (0 to 100)
  const containerRef = React.useRef<HTMLDivElement>(null);

  const handleMove = (clientX: number) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = clientX - rect.left;
    const percentage = Math.max(0, Math.min(100, (x / rect.width) * 100));
    setSliderPosition(percentage);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    handleMove(e.clientX);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length > 0) {
      handleMove(e.touches[0].clientX);
    }
  };

  return (
    <div
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onTouchMove={handleTouchMove}
      style={{
        position: "relative",
        width: "100%",
        height: "360px",
        borderRadius: "8px",
        overflow: "hidden",
        cursor: "ew-resize",
        userSelect: "none",
        background: "#0c0d0e",
        border: "1px solid rgba(255, 255, 255, 0.08)",
      }}
    >
      {/* Original Image (Background) */}
      <img
        src={original}
        alt="Original frame"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          objectFit: "contain",
          pointerEvents: "none",
        }}
      />

      {/* Checkered Transparent Grid Pattern background for the overlay */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          clipPath: `polygon(${sliderPosition}% 0, 100% 0, 100% 100%, ${sliderPosition}% 100%)`,
          pointerEvents: "none",
          backgroundImage: `
            linear-gradient(45deg, rgba(255,255,255,0.03) 25%, transparent 25%),
            linear-gradient(-45deg, rgba(255,255,255,0.03) 25%, transparent 25%),
            linear-gradient(45deg, transparent 75%, rgba(255,255,255,0.03) 75%),
            linear-gradient(-45deg, transparent 75%, rgba(255,255,255,0.03) 75%)
          `,
          backgroundSize: "20px 20px",
          backgroundPosition: "0 0, 0 10px, 10px -10px, -10px 0px",
          backgroundColor: "#131518",
        }}
      />

      {/* Isolated Image (Foreground with Clip-Path) */}
      <img
        src={isolated}
        alt="Isolated frame"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          objectFit: "contain",
          pointerEvents: "none",
          clipPath: `polygon(${sliderPosition}% 0, 100% 0, 100% 100%, ${sliderPosition}% 100%)`,
        }}
      />

      {/* Horizontal Divider Line */}
      <div
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: `${sliderPosition}%`,
          width: "2px",
          backgroundColor: "var(--accent-a, #3b82f6)",
          boxShadow: "0 0 10px rgba(59, 130, 246, 0.8)",
          zIndex: 10,
          pointerEvents: "none",
        }}
      >
        {/* Drag handle ball */}
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            width: "30px",
            height: "30px",
            borderRadius: "50%",
            backgroundColor: "#1f2227",
            border: "2px solid var(--accent-a, #3b82f6)",
            boxShadow: "0 4px 10px rgba(0, 0, 0, 0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff",
            fontSize: "12px",
            fontWeight: "bold",
          }}
        >
          ↔
        </div>
      </div>

      {/* Labels */}
      <div
        style={{
          position: "absolute",
          top: "12px",
          left: "12px",
          background: "rgba(0,0,0,0.6)",
          padding: "4px 8px",
          borderRadius: "4px",
          fontSize: "11px",
          color: "#fff",
          zIndex: 5,
          pointerEvents: "none",
          border: "1px solid rgba(255,255,255,0.1)",
        }}
      >
        Original
      </div>
      <div
        style={{
          position: "absolute",
          top: "12px",
          right: "12px",
          background: "rgba(0,0,0,0.6)",
          padding: "4px 8px",
          borderRadius: "4px",
          fontSize: "11px",
          color: "#fff",
          zIndex: 5,
          pointerEvents: "none",
          border: "1px solid rgba(255,255,255,0.1)",
        }}
      >
        Isolated
      </div>
    </div>
  );
}

interface PreviewComparisonCardProps {
  original: string;
  isolated: string;
  frame: number;
  totalFrames: number;
  elapsedSeconds: number;
  model: string;
  isPreviewing: boolean;
  disabled?: boolean;
  onRegenerate: () => void;
  onSeekFrame: (frame: number) => void;
  isImage?: boolean;
}

function PreviewComparisonCard({
  original,
  isolated,
  frame,
  totalFrames,
  elapsedSeconds,
  model,
  isPreviewing,
  disabled,
  onRegenerate,
  onSeekFrame,
  isImage,
}: PreviewComparisonCardProps) {
  const [layoutMode, setLayoutMode] = React.useState<"slider" | "side-by-side">("slider");

  const modelLabels: Record<string, string> = MODEL_LABELS;

  return (
    <div
      className="glass"
      style={{
        padding: "20px",
        borderRadius: "12px",
        border: "1px solid rgba(255,255,255,0.06)",
        background: "linear-gradient(135deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.01) 100%)",
        display: "flex",
        flexDirection: "column",
        gap: "16px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h4 style={{ margin: "0 0 4px 0", fontSize: "14px", display: "flex", alignItems: "center", gap: "8px" }}>
            <Eye size={16} style={{ color: "var(--accent-a)" }} />
            AI Isolation Preview
          </h4>
          <p className="dim-text" style={{ fontSize: "12px", margin: 0 }}>
            {isImage ? "Image" : `Frame ${frame}`} isolated with <strong>{modelLabels[model] || model}</strong> in {elapsedSeconds}s
          </p>
        </div>

        {/* View Mode Toggle & Regenerate */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <div
            style={{
              display: "flex",
              background: "rgba(0,0,0,0.2)",
              padding: "2px",
              borderRadius: "6px",
              border: "1px solid rgba(255,255,255,0.05)",
            }}
          >
            <button
              type="button"
              onClick={() => setLayoutMode("slider")}
              style={{
                background: layoutMode === "slider" ? "rgba(255,255,255,0.08)" : "transparent",
                border: "none",
                borderRadius: "4px",
                padding: "6px 10px",
                color: layoutMode === "slider" ? "#fff" : "rgba(255,255,255,0.4)",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: "4px",
                fontSize: "11px",
              }}
              title="Interactive Before/After Slider"
            >
              <Sliders size={12} />
              <span>Slider</span>
            </button>
            <button
              type="button"
              onClick={() => setLayoutMode("side-by-side")}
              style={{
                background: layoutMode === "side-by-side" ? "rgba(255,255,255,0.08)" : "transparent",
                border: "none",
                borderRadius: "4px",
                padding: "6px 10px",
                color: layoutMode === "side-by-side" ? "#fff" : "rgba(255,255,255,0.4)",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: "4px",
                fontSize: "11px",
              }}
              title="Side-by-Side Comparison"
            >
              <Columns size={12} />
              <span>Side-by-Side</span>
            </button>
          </div>

          <button
            type="button"
            className="install-btn is-secondary"
            style={{ padding: "6px 10px", display: "flex", alignItems: "center", gap: "6px", fontSize: "11px" }}
            disabled={disabled || isPreviewing}
            onClick={onRegenerate}
          >
            <RefreshCw size={12} className={isPreviewing ? "spin" : ""} />
            <span>Regen</span>
          </button>
        </div>
      </div>

      {!isImage && totalFrames > 1 && (
        <FrameScrubber
          frame={frame}
          totalFrames={totalFrames}
          disabled={disabled}
          onSeek={onSeekFrame}
        />
      )}

      {layoutMode === "slider" ? (
        <ImageComparisonSlider original={original} isolated={isolated} />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
          {/* Original */}
          <div
            style={{
              background: "#0c0d0e",
              borderRadius: "8px",
              overflow: "hidden",
              height: "260px",
              position: "relative",
              border: "1px solid rgba(255,255,255,0.06)",
            }}
          >
            <img src={original} alt="Original" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
            <div
              style={{
                position: "absolute",
                bottom: "8px",
                left: "8px",
                background: "rgba(0,0,0,0.6)",
                padding: "2px 6px",
                borderRadius: "4px",
                fontSize: "10px",
                border: "1px solid rgba(255,255,255,0.1)",
              }}
            >
              Original Frame
            </div>
          </div>
          {/* Isolated */}
          <div
            style={{
              background: "#131518",
              borderRadius: "8px",
              overflow: "hidden",
              height: "260px",
              position: "relative",
              border: "1px solid rgba(255,255,255,0.06)",
              backgroundImage: `
                linear-gradient(45deg, rgba(255,255,255,0.03) 25%, transparent 25%),
                linear-gradient(-45deg, rgba(255,255,255,0.03) 25%, transparent 25%),
                linear-gradient(45deg, transparent 75%, rgba(255,255,255,0.03) 75%),
                linear-gradient(-45deg, transparent 75%, rgba(255,255,255,0.03) 75%)
              `,
              backgroundSize: "16px 16px",
              backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0px",
            }}
          >
            <img src={isolated} alt="Isolated" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
            <div
              style={{
                position: "absolute",
                bottom: "8px",
                left: "8px",
                background: "rgba(0,0,0,0.6)",
                padding: "2px 6px",
                borderRadius: "4px",
                fontSize: "10px",
                border: "1px solid rgba(255,255,255,0.1)",
              }}
            >
              Isolated Character
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
