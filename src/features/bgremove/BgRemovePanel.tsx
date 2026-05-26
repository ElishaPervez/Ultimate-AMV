import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Cpu, Film, Sparkles, Upload, Video } from "lucide-react";
import { setDiscordJob } from "../../lib/discord";
import { logFrontend, safeLogValue } from "../../lib/log";
import { fileName, normalizeSelectedPaths } from "../../lib/paths";
import { extensionAccept, useFileDrop } from "../../lib/useFileDrop";
import { parseBridgePayload, readBridgeError } from "../../utils/bridge";
import type { BgRemoveProgress, BgRemoveStatus } from "../../types/bgremove";
import { BgRemoveProgressCard } from "./BgRemoveProgressCard";
import { BgRemoveResultCard } from "./BgRemoveResultCard";

const VIDEO_INPUT_EXTENSIONS = ["mp4", "mkv", "avi", "webm", "mov"];
const videoInputAccept = extensionAccept(VIDEO_INPUT_EXTENSIONS);

export function BgRemovePanel() {
  const [status, setStatus] = React.useState<BgRemoveStatus | null>(null);
  const [selectedFile, setSelectedFile] = React.useState<string>("");
  const [model, setModel] = React.useState<string>("anime");
  const [format, setFormat] = React.useState<string>("webm");
  const [forceCpu, setForceCpu] = React.useState<boolean>(false);
  const [progress, setProgress] = React.useState<BgRemoveProgress | null>(null);
  const [processing, setProcessing] = React.useState(false);
  const [resultMessage, setResultMessage] = React.useState<string | null>(null);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [outputPath, setOutputPath] = React.useState<string>("");
  
  const cancellingRef = React.useRef(false);

  React.useEffect(() => {
    void refreshStatus();
  }, []);

  React.useEffect(() => {
    setDiscordJob("Isolating background", processing);
    return () => setDiscordJob("Isolating background", false);
  }, [processing]);

  React.useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<BgRemoveProgress>("bgremove-progress", (event) => {
      setProgress(event.payload);
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  async function refreshStatus() {
    try {
      const raw = await invoke<string>("bgremove_status");
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

  async function pickInputFile() {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [
        {
          name: "Video file",
          extensions: VIDEO_INPUT_EXTENSIONS,
        },
      ],
    });
    
    const paths = normalizeSelectedPaths(selected);
    if (paths && paths.length > 0) {
      setSelectedFile(paths[0]);
      setResultMessage(null);
      setErrorMessage(null);
    }
  }

  async function runBackgroundRemoval() {
    if (!selectedFile) return;
    
    setProcessing(true);
    setResultMessage(null);
    setErrorMessage(null);
    setProgress({
      type: "progress",
      stage: "dependencies",
      percent: -1,
      message: "Verifying background removal tools...",
    });
    cancellingRef.current = false;

    // Prompt user for saving location
    const extension = format === "webm" ? "webm" : "";
    const isPngSequence = format === "png";
    
    let destinationPath = "";
    try {
      if (isPngSequence) {
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
        // For WebM, prompt where to save the file
        const proposedName = fileName(selectedFile).replace(/\.[^/.]+$/, "") + "_transparent.webm";
        const selectedSave = await save({
          defaultPath: proposedName,
          filters: [
            {
              name: "Transparent WebM",
              extensions: ["webm"],
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

      // Invoke Tauri command
      const raw = await invoke<string>("bgremove_process", {
        inputPath: selectedFile,
        outputPath: destinationPath,
        model: model,
        format: format,
        cpu: forceCpu,
      });

      const payload = parseBridgePayload<{
        type: string;
        output: string;
        frames: number;
        elapsedSeconds: number;
      }>(raw);

      if (cancellingRef.current) {
        setResultMessage("Background isolation was cancelled.");
      } else {
        setResultMessage(
          `Background isolation completed successfully! Isolated ${payload.frames} frames in ${payload.elapsedSeconds}s.`
        );
      }
    } catch (error) {
      if (!cancellingRef.current) {
        setErrorMessage(readBridgeError(error));
      }
    } finally {
      setProcessing(false);
      setProgress(null);
      cancellingRef.current = false;
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

  function reset() {
    setSelectedFile("");
    setProgress(null);
    setResultMessage(null);
    setErrorMessage(null);
    setOutputPath("");
  }

  const { dropActive, dropProps } = useFileDrop({
    accept: videoInputAccept,
    onDrop: (files) => {
      if (files.length > 0) {
        setSelectedFile(files[0]);
        setResultMessage(null);
        setErrorMessage(null);
      }
    },
    disabled: processing,
  });

  const selectedName = selectedFile ? fileName(selectedFile) : "";
  const isWebM = format === "webm";
  const outputDir = outputPath ? (isWebM ? outputPath.substring(0, outputPath.lastIndexOf("\\")) : outputPath) : "";

  // Progress UI rendering
  if (processing || progress) {
    return (
      <div className="panel-flex-center">
        <BgRemoveProgressCard
          fileName={selectedName}
          progress={progress}
          onCancel={cancelProcessing}
        />
      </div>
    );
  }

  // Result UI rendering
  if (resultMessage || errorMessage) {
    return (
      <div className="panel-flex-center">
        <BgRemoveResultCard
          kind={errorMessage ? "error" : "success"}
          fileName={selectedName}
          message={errorMessage || resultMessage || ""}
          onAgain={reset}
          onRetry={runBackgroundRemoval}
          outputDir={outputDir}
        />
      </div>
    );
  }

  return (
    <div className="video-converter-panel" style={{ height: "100%", overflowY: "auto", padding: "20px" }}>
      <header className="panel-header" style={{ marginBottom: "24px" }}>
        <span className="accent-text" style={{ fontSize: "12px", textTransform: "uppercase", letterSpacing: "1px", fontWeight: 600 }}>
          AI Character Isolation
        </span>
        <h1 style={{ fontSize: "24px", margin: "4px 0 8px 0" }}>One-Click Video Background Removal</h1>
        <p className="dim-text" style={{ fontSize: "14px" }}>
          Isolate characters from video files with transparent alpha channels (WebM/PNG sequences), powered by SkyTNT isnet-anime.
        </p>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: "24px" }}>
        {/* Left Side: Upload / Selector */}
        <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          {!selectedFile ? (
            <div
              {...dropProps}
              className={`dropzone spring-motion ${dropActive ? "is-active" : ""}`}
              style={{
                height: "280px",
                border: "2px dashed rgba(255,255,255,0.15)",
                borderRadius: "12px",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                background: dropActive ? "rgba(var(--primary-rgb), 0.05)" : "transparent",
              }}
              onClick={pickInputFile}
            >
              <Upload size={38} strokeWidth={1.8} className="dropzone-icon" style={{ marginBottom: "16px", color: "rgba(255,255,255,0.4)" }} />
              <h3 style={{ margin: "0 0 6px 0", fontSize: "16px" }}>Drag & Drop video file here</h3>
              <p className="dim-text" style={{ fontSize: "13px", margin: 0 }}>
                Supports MP4, WebM, MKV, AVI, MOV
              </p>
            </div>
          ) : (
            <div
              className="glass"
              style={{
                padding: "24px",
                borderRadius: "12px",
                display: "flex",
                alignItems: "center",
                gap: "16px",
                border: "1px solid rgba(255,255,255,0.06)",
              }}
            >
              <div
                style={{
                  width: "48px",
                  height: "48px",
                  background: "rgba(255,255,255,0.05)",
                  borderRadius: "8px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--accent-a)",
                }}
              >
                <Video size={24} />
              </div>
              <div style={{ flex: 1, overflow: "hidden" }}>
                <h3 style={{ margin: "0 0 4px 0", fontSize: "16px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {selectedName}
                </h3>
                <p className="dim-text" style={{ fontSize: "13px", margin: 0 }}>
                  Ready for background removal
                </p>
              </div>
              <button
                type="button"
                className="install-btn is-secondary"
                style={{ padding: "8px 12px" }}
                onClick={() => setSelectedFile("")}
              >
                Change file
              </button>
            </div>
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
              <li>
                <strong>WebM VP9 + Alpha:</strong> Fully compatible with After Effects, Premiere, and Resolve. Perfect overlay!
              </li>
              <li>
                <strong>Anime Characters:</strong> Use the default <em>Anime Character</em> model. It isolations flat cel-shaded outlines perfectly.
              </li>
              <li>
                <strong>Processing Speeds:</strong> Isolating frame-by-frame on CPU can take a few seconds per frame. Prioritize CUDA (GPU) if available.
              </li>
            </ul>
          </div>
        </div>

        {/* Right Side: Settings / Action */}
        <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          {/* Options Card */}
          <div
            className="glass"
            style={{
              padding: "20px",
              borderRadius: "12px",
              border: "1px solid rgba(255,255,255,0.06)",
              display: "flex",
              flexDirection: "column",
              gap: "16px",
            }}
          >
            <h3 style={{ margin: "0 0 4px 0", fontSize: "16px" }}>Options</h3>

            {/* Model Select */}
            <div>
              <label htmlFor="model-select" style={{ display: "block", fontSize: "13px", marginBottom: "6px" }} className="dim-text">
                AI Segmentation Model
              </label>
              <select
                id="model-select"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                style={{
                  width: "100%",
                  padding: "10px",
                  borderRadius: "6px",
                  background: "rgba(0,0,0,0.25)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  color: "#fff",
                  fontSize: "13px",
                }}
              >
                <option value="anime">Anime Character (isnet-anime) — Best</option>
                <option value="general">General Use (isnet-general-use)</option>
                <option value="birefnet">High Quality (birefnet-general) — Slower</option>
              </select>
            </div>

            {/* Export Format Select */}
            <div>
              <label htmlFor="format-select" style={{ display: "block", fontSize: "13px", marginBottom: "6px" }} className="dim-text">
                Export Format
              </label>
              <select
                id="format-select"
                value={format}
                onChange={(e) => setFormat(e.target.value)}
                style={{
                  width: "100%",
                  padding: "10px",
                  borderRadius: "6px",
                  background: "rgba(0,0,0,0.25)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  color: "#fff",
                  fontSize: "13px",
                }}
              >
                <option value="webm">Transparent Video (WebM VP9 + Alpha)</option>
                <option value="png">Lossless Image Sequence (PNG Sequence)</option>
              </select>
            </div>

            {/* Hardware Selection */}
            <div style={{ display: "flex", flexDirection: "column", gap: "8px", borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: "12px" }}>
              <span style={{ fontSize: "13px" }} className="dim-text">
                Hardware Accelerator
              </span>
              <div style={{ display: "flex", gap: "10px" }}>
                <button
                  type="button"
                  className={`install-btn ${!forceCpu ? "is-primary" : "is-secondary"}`}
                  style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", padding: "8px" }}
                  disabled={status && status.hardware && !status.hardware.hasCuda}
                  onClick={() => setForceCpu(false)}
                >
                  <Film size={14} />
                  <span>GPU (CUDA)</span>
                </button>
                <button
                  type="button"
                  className={`install-btn ${forceCpu ? "is-primary" : "is-secondary"}`}
                  style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", padding: "8px" }}
                  onClick={() => setForceCpu(true)}
                >
                  <Cpu size={14} />
                  <span>CPU Mode</span>
                </button>
              </div>
              {status && status.hardware && !status.hardware.hasCuda && (
                <p className="dim-text" style={{ fontSize: "11px", margin: "4px 0 0 0", color: "#f4c267" }}>
                  NVIDIA GPU (CUDA) not detected. Defaulting to CPU.
                </p>
              )}
            </div>
          </div>

          {/* Action Button */}
          <button
            type="button"
            className="install-btn is-primary"
            style={{ width: "100%", padding: "12px", borderRadius: "8px", fontSize: "15px", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" }}
            disabled={!selectedFile}
            onClick={runBackgroundRemoval}
          >
            <Sparkles size={16} />
            <span>Remove Background</span>
          </button>
        </div>
      </div>
    </div>
  );
}
