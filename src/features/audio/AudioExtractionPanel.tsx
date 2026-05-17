import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { CheckCircle2, Upload } from "lucide-react";
import { setDiscordJob } from "../../lib/discord";
import { logFrontend, safeLogValue } from "../../lib/log";
import { fileName, normalizeSelectedPaths } from "../../lib/paths";
import { extensionAccept, useFileDrop } from "../../lib/useFileDrop";
import { parseBridgePayload, readBridgeError } from "../../utils/bridge";

const AUDIO_INPUT_EXTENSIONS = ["wav", "mp3", "flac", "m4a", "mp4", "mkv", "avi", "webm", "mov"];
const audioInputAccept = extensionAccept(AUDIO_INPUT_EXTENSIONS);
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

let cachedAudioStatus: AudioStatus | null = null;
let pendingAudioStatus: Promise<AudioStatus> | null = null;

export function AudioExtractionPanel() {
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
    return () => setDiscordJob("Extracting vocals", false);
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
      setOutputPaths(allOutputs);
      const failures = completed.filter((item) => item.status === "error").length;
      setResultMessage(`${completed.length - failures}/${filePaths.length} files extracted. ${allOutputs.length} stems saved.`);
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
      className={`audio-extract drop-zone${dropZone.hover ? " is-drop-target" : ""}`}
    >
      <div className="drop-zone-overlay">
        <Upload size={32} strokeWidth={1.8} />
        <span>Drop audio or video to extract vocals</span>
        <small>WAV · MP3 · FLAC · M4A · MP4 · MKV · MOV · WEBM · AVI</small>
      </div>
      <div className={`audio-status-line ${status ? "" : "is-pending"}`} aria-hidden={status ? undefined : true}>
        {status && (
          <>
            <span>
              <small>Engine</small>
              {status.hardware.device_short}
            </span>
            <span>
              <small>Model</small>
              {status.model_name}
            </span>
            <span className={depsReady ? "status-ready" : "status-warning"}>
              <small>Status</small>
              {depsReady ? "Ready" : "Setup required"}
            </span>
          </>
        )}
      </div>

      <div className="audio-stage">{stage}</div>

      {!selectedFile && setupNotice && (
        <div className="audio-message is-success">
          <CheckCircle2 size={17} /> {setupNotice}
        </div>
      )}
      {batchItems.length > 0 && <BatchStatusList items={batchItems} />}
    </div>
  );
}
