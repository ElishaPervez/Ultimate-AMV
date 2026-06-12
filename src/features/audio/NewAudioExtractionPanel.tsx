import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  AudioLines,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Cpu,
  FileAudio,
  FolderOpen,
  HardDrive,
  Loader2,
  Music,
  Upload,
  Zap,
} from "lucide-react";
import { setDiscordJob } from "../../lib/discord";
import { logFrontend, safeLogValue } from "../../lib/log";
import { fileName, normalizeSelectedPaths } from "../../lib/paths";
import { extensionAccept, useFileDrop } from "../../lib/useFileDrop";
import { parseBridgePayload, readBridgeError } from "../../utils/bridge";
import type {
  AudioProgress,
  AudioSetupProgress,
  AudioStatus,
  BatchItemStatus,
} from "../../types/audio";
import { BatchStatusList } from "./BatchStatusList";
import { DepInstallCard } from "./DepInstallCard";
import { ExtractionProgressCard } from "./ExtractionProgressCard";
import { ResultCard } from "./ResultCard";
import { SelectFileButton } from "./SelectFileButton";
import { SetupRunningCard } from "./SetupRunningCard";
import { StemMixerCard } from "./StemMixerCard";
// new-audio.css is loaded via the layered `base` bundle in src/styles.css.
// Importing it directly here would land it UNLAYERED, letting it outrank the
// `theme` layer overrides — so it stays out of this file on purpose.

const AUDIO_INPUT_EXTENSIONS = ["wav", "mp3", "flac", "m4a", "mp4", "mkv", "avi", "webm", "mov"];
const audioInputAccept = extensionAccept(AUDIO_INPUT_EXTENSIONS);

let cachedAudioStatus: AudioStatus | null = null;
let pendingAudioStatus: Promise<AudioStatus> | null = null;

export function NewAudioExtractionPanel() {
  const [status, setStatus] = React.useState<AudioStatus | null>(cachedAudioStatus);
  const [selectedFiles, setSelectedFiles] = React.useState<string[]>([]);
  const [progress, setProgress] = React.useState<AudioProgress | null>(null);
  const [extracting, setExtracting] = React.useState(false);
  const [setupRunning, setSetupRunning] = React.useState<"cpu" | "gpu" | null>(null);
  const [setupProgress, setSetupProgress] = React.useState<AudioSetupProgress | null>(null);
  const [setupNotice, setSetupNotice] = React.useState<string | null>(null);
  const [resultMessage, setResultMessage] = React.useState<string | null>(null);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [outputPaths, setOutputPaths] = React.useState<string[]>([]);
  const [batchItems, setBatchItems] = React.useState<BatchItemStatus[]>([]);
  const audioCancellingRef = React.useRef(false);

  React.useEffect(() => {
    void refreshStatus();
  }, []);

  React.useEffect(() => {
    setDiscordJob("Extracting vocals", extracting);
    return () => {
      setDiscordJob("Extracting vocals", false);
    };
  }, [extracting]);

  React.useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<AudioProgress>("audio-progress", (event) => {
      setProgress(event.payload);
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  React.useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<AudioSetupProgress>("audio-setup-progress", (event) => {
      setSetupProgress(event.payload);
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  async function refreshStatus(force = false) {
    let request: Promise<AudioStatus> | null = null;
    try {
      if (!force && cachedAudioStatus) {
        setStatus(cachedAudioStatus);
        return;
      }

      if (!force && pendingAudioStatus) {
        setStatus(await pendingAudioStatus);
        return;
      }

      request = invoke<string>("audio_status").then((raw) => parseBridgePayload<AudioStatus>(raw));
      pendingAudioStatus = request;
      const nextStatus = await request;
      cachedAudioStatus = nextStatus;
      setStatus(nextStatus);
    } catch (error) {
      setErrorMessage(readBridgeError(error));
    } finally {
      if (!request || pendingAudioStatus === request) {
        pendingAudioStatus = null;
      }
    }
  }

  function startBatch(paths: string[]) {
    if (paths.length === 0) return;
    setSelectedFiles(paths);
    setResultMessage(null);
    setErrorMessage(null);
    setProgress(null);
    setBatchItems([]);
    void runExtraction(paths);
  }

  async function pickFile() {
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [
        {
          name: "Audio or video",
          extensions: AUDIO_INPUT_EXTENSIONS,
        },
      ],
    });
    startBatch(normalizeSelectedPaths(selected));
  }

  async function runExtraction(filePaths: string[]) {
    setExtracting(true);
    setResultMessage(null);
    setErrorMessage(null);
    setBatchItems([]);
    setProgress({ type: "progress", stage: "loading", percent: -1, message: "Loading AI model..." });
    try {
      const completed: BatchItemStatus[] = [];
      const allOutputs: string[] = [];
      for (let index = 0; index < filePaths.length; index += 1) {
        if (audioCancellingRef.current) break;
        const filePath = filePaths[index];
        setProgress({
          type: "progress",
          stage: "loading",
          percent: -1,
          message: `File ${index + 1}/${filePaths.length}: ${fileName(filePath)}`,
        });
        try {
          const raw = await invoke<string>("audio_extract", { inputPath: filePath });
          const payload = parseBridgePayload<{ type: "done"; outputs: string[] }>(raw);
          allOutputs.push(...(payload.outputs ?? []));
          completed.push({ input: filePath, outputs: payload.outputs ?? [], status: "done" });
        } catch (error) {
          if (audioCancellingRef.current) break;
          completed.push({ input: filePath, status: "error", message: readBridgeError(error) });
        }
        setBatchItems([...completed]);
      }
      if (audioCancellingRef.current && allOutputs.length === 0) {
        setSelectedFiles([]);
        setBatchItems([]);
      } else if (audioCancellingRef.current) {
        setOutputPaths(allOutputs);
        const done = completed.filter((item) => item.status === "done").length;
        setResultMessage(`Extraction cancelled. ${done} file${done === 1 ? "" : "s"} saved before cancel.`);
      } else {
        setOutputPaths(allOutputs);
        const failures = completed.filter((item) => item.status === "error").length;
        setResultMessage(`${completed.length - failures}/${filePaths.length} files extracted. ${allOutputs.length} stems saved.`);
      }
      await refreshStatus(true);
    } catch (error) {
      if (!audioCancellingRef.current) {
        setErrorMessage(readBridgeError(error));
      }
    } finally {
      audioCancellingRef.current = false;
      setExtracting(false);
      setProgress(null);
    }
  }

  function reset() {
    setSelectedFiles([]);
    setProgress(null);
    setResultMessage(null);
    setErrorMessage(null);
    setBatchItems([]);
  }

  async function startSetup(mode: "cpu" | "gpu") {
    setSetupRunning(mode);
    setSetupProgress({
      type: "setup-progress",
      step: 0,
      total: 0,
      state: "running",
      message: `Preparing ${mode.toUpperCase()} install...`,
    });
    setSetupNotice(null);
    setErrorMessage(null);
    try {
      await invoke<string>("audio_setup", { mode });
      setSetupNotice(`${mode === "gpu" ? "GPU" : "CPU"} engine ready. Pick a file to extract.`);
      await refreshStatus(true);
    } catch (error) {
      setErrorMessage(readBridgeError(error));
    } finally {
      setSetupRunning(null);
      setSetupProgress(null);
    }
  }

  const depsReady = status?.dependencies.ready ?? true;
  const hasGpu = status?.hardware.gpu_type === "nvidia";
  const gpuSetupBlocked = status ? !hasGpu : false;
  const selectedFile = selectedFiles[0] ?? null;
  const selectedLabel = selectedFiles.length > 1 ? `${selectedFiles.length} files` : selectedFile ? fileName(selectedFile) : "";

  const dropEnabled = depsReady && !extracting && !setupRunning;
  const dropZone = useFileDrop({
    accept: audioInputAccept,
    enabled: dropEnabled,
    onDrop: startBatch,
  });

  /* ------------------------------------------------------------------
     Render helpers
     ------------------------------------------------------------------ */

  const heroStatusItems = status
    ? [
        {
          label: "Engine",
          value: status.hardware.device_short,
          dot: depsReady ? "optimal" : "warning",
          sub: status.hardware.device,
        },
        {
          label: "Model",
          value: status.model_name,
          dot: "optimal",
          sub: "BS-RoFormer",
        },
        {
          label: "Dependencies",
          value: depsReady ? "Ready" : "Setup required",
          dot: depsReady ? "optimal" : "warning",
          sub: depsReady ? "All OK" : "Install needed",
        },
        {
          label: "GPU",
          value: hasGpu ? "NVIDIA" : "None",
          dot: hasGpu ? "optimal" : "neutral",
          sub: hasGpu ? "Accelerated" : "CPU only",
        },
      ]
    : [];

  const engineCard = status
    ? {
        title: "Engine",
        subtitle: status.hardware.device_short,
        dot: depsReady ? "optimal" : "warning",
        meta: status.hardware.device,
        pct: hasGpu ? 85 : 60,
      }
    : null;

  const modelCard = status
    ? {
        title: "Model",
        subtitle: status.model_name,
        dot: "optimal",
        meta: "BS-RoFormer",
        pct: 100,
      }
    : null;

  const statusCard = status
    ? {
        title: "Status",
        subtitle: depsReady ? "Ready" : "Setup",
        dot: depsReady ? "optimal" : "warning",
        meta: depsReady ? "All systems go" : "Install required",
        pct: depsReady ? 100 : 0,
      }
    : null;

  let stage: React.ReactNode;
  if (setupRunning) {
    stage = <SetupRunningCard mode={setupRunning} progress={setupProgress} />;
  } else if (status && !depsReady) {
    stage = (
      <DepInstallCard
        status={status}
        hasGpu={hasGpu}
        gpuSetupBlocked={gpuSetupBlocked}
        onChoose={startSetup}
      />
    );
  } else if (selectedFiles.length > 0 && extracting) {
    stage = (
      <ExtractionProgressCard
        fileName={selectedLabel}
        progress={progress}
        onCancel={() => {
          audioCancellingRef.current = true;
          void invoke("cancel_audio");
        }}
      />
    );
  } else if (selectedFiles.length > 0 && resultMessage) {
    const lastDone = [...batchItems].reverse().find((item) => item.status === "done");
    const previewOutputs = lastDone?.outputs ?? outputPaths;
    const previewInput = lastDone?.input ?? selectedFiles[selectedFiles.length - 1] ?? selectedFiles[0];
    const outputDir = previewOutputs[0]?.replace(/[/\\][^/\\]+$/, "") ?? undefined;
    const previewLabel = previewInput ? fileName(previewInput) : selectedLabel;
    stage = (
      <StemMixerCard
        outputs={previewOutputs}
        fileLabel={previewLabel}
        outputDir={outputDir}
        onAgain={reset}
      />
    );
  } else if (selectedFiles.length > 0 && errorMessage) {
    stage = (
      <ResultCard
        kind="error"
        fileName={selectedLabel}
        message={errorMessage}
        onAgain={reset}
        onRetry={() => runExtraction(selectedFiles)}
      />
    );
  } else {
    stage = <SelectFileButton onClick={pickFile} />;
  }

  return (
    <div
      ref={dropZone.ref}
      className={`new-audio-panel drop-zone${dropZone.hover ? " is-drop-target" : ""}`}
    >
      <div className="drop-zone-overlay">
        <Upload size={32} strokeWidth={1.8} />
        <span>Drop audio or video to extract vocals</span>
        <small>WAV · MP3 · FLAC · M4A · MP4 · MKV · MOV · WEBM · AVI</small>
      </div>

      {/* ── Top dashboard row ── */}
      <div className="dash-top-row">
        {/* Hero card */}
        <div className="dash-hero-card">
          <div className="dash-hero-meta">
            <span className="dash-hero-kicker">Vocal Separation</span>
            <h1 className="dash-hero-title">
              Extract vocals
              <br />
              from any file
            </h1>
            <p className="dash-hero-desc">
              Separate vocals and instrumental using AI. Supports audio and video files.
            </p>
          </div>

          {status && (
            <div className="dash-hero-status-list">
              {heroStatusItems.map((item) => (
                <div key={item.label} className="dash-hero-status-item">
                  <span className={`dash-status-dot is-${item.dot}`} />
                  <div>
                    <div className="dash-status-label">{item.label}</div>
                    <div className="dash-status-value">{item.value}</div>
                  </div>
                </div>
              ))}
            </div>
          )}

          <button
            type="button"
            className="dash-hero-cta"
            onClick={pickFile}
            disabled={!depsReady || extracting || Boolean(setupRunning)}
          >
            <span>Choose files</span>
            <ChevronRight size={16} />
          </button>
        </div>

        {/* Stat cards */}
        <div className="dash-stats-grid">
          {engineCard && (
            <DashStatCard
              icon={<Cpu size={18} />}
              title={engineCard.title}
              value={engineCard.subtitle}
              dot={engineCard.dot}
              meta={engineCard.meta}
              pct={engineCard.pct}
            />
          )}
          {modelCard && (
            <DashStatCard
              icon={<Music size={18} />}
              title={modelCard.title}
              value={modelCard.subtitle}
              dot={modelCard.dot}
              meta={modelCard.meta}
              pct={modelCard.pct}
            />
          )}
          {statusCard && (
            <DashStatCard
              icon={<HardDrive size={18} />}
              title={statusCard.title}
              value={statusCard.subtitle}
              dot={statusCard.dot}
              meta={statusCard.meta}
              pct={statusCard.pct}
            />
          )}
          {/* GPU card */}
          {status && (
            <DashStatCard
              icon={<Zap size={18} />}
              title="Accelerator"
              value={hasGpu ? "GPU" : "CPU"}
              dot={hasGpu ? "optimal" : "neutral"}
              meta={hasGpu ? "NVIDIA" : "No GPU detected"}
              pct={hasGpu ? 90 : 40}
            />
          )}
        </div>
      </div>

      {/* ── Main stage ── */}
      <div className="dash-stage">
        <div className="dash-stage-main">
          {stage}
        </div>

        {/* Right side panel for notices / batch list */}
        <div className="dash-stage-side">
          {!selectedFile && setupNotice && (
            <DashSideCard title="Setup Complete" icon={<CheckCircle2 size={16} />}>
              <div className="dash-side-text is-success">{setupNotice}</div>
            </DashSideCard>
          )}

          {selectedFiles.length > 0 && !extracting && resultMessage && (
            <DashSideCard title="Extraction Complete" icon={<CheckCircle2 size={16} />}>
              <div className="dash-side-text is-success">{resultMessage}</div>
            </DashSideCard>
          )}

          {selectedFiles.length > 0 && errorMessage && (
            <DashSideCard title="Error" icon={<AlertTriangle size={16} />}>
              <div className="dash-side-text is-error">{errorMessage}</div>
            </DashSideCard>
          )}

          {batchItems.length > 0 && (
            <DashSideCard title="Batch Status" icon={<FileAudio size={16} />}>
              <BatchStatusList items={batchItems} />
            </DashSideCard>
          )}

          {/* Info card */}
          <DashSideCard title="Supported Formats" icon={<AudioLines size={16} />}>
            <div className="dash-side-tags">
              {["WAV", "MP3", "FLAC", "M4A", "MP4", "MKV", "MOV", "WEBM", "AVI"].map((fmt) => (
                <span key={fmt} className="dash-side-tag">{fmt}</span>
              ))}
            </div>
          </DashSideCard>

          {/* Quick tip */}
          <div className="dash-tip-card">
            <div className="dash-tip-title">
              <CircleDot size={14} />
              <span>Quick Tip</span>
            </div>
            <p className="dash-tip-text">
              Drag and drop files directly onto this page to start extraction instantly.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Sub-components ── */

function DashStatCard({
  icon,
  title,
  value,
  dot,
  meta,
  pct,
}: {
  icon: React.ReactNode;
  title: string;
  value: string;
  dot: string;
  meta: string;
  pct: number;
}) {
  return (
    <div className="dash-stat-card">
      <div className="dash-stat-header">
        <div>
          <div className="dash-stat-title">{title}</div>
          <div className="dash-stat-value">
            <span className={`dash-status-dot is-${dot}`} />
            {value}
          </div>
        </div>
        <div className="dash-stat-icon">{icon}</div>
      </div>
      <div className="dash-stat-meta">{meta}</div>
      <div className="dash-stat-bar">
        <div
          className="dash-stat-bar-fill"
          style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
        />
      </div>
    </div>
  );
}

function DashSideCard({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="dash-side-card">
      <div className="dash-side-header">
        {icon}
        <span>{title}</span>
      </div>
      <div className="dash-side-body">{children}</div>
    </div>
  );
}
