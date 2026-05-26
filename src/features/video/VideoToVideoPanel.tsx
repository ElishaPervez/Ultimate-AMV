import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, CheckCircle2, FileVideo, Info, Upload } from "lucide-react";
import { setDiscordJob } from "../../lib/discord";
import { clampNumber } from "../../lib/numbers";
import { fileName, normalizeSelectedPaths } from "../../lib/paths";
import { extensionAccept, useFileDrop } from "../../lib/useFileDrop";
import { parseBridgePayload, readBridgeError } from "../../utils/bridge";
import type { BatchItemStatus } from "../../types/audio";
import type { ConversionDone, ConversionProgress, VideoControlSpec, VideoGpuStatus, VideoTranscodePreset } from "../../types/conversion";
import { ConversionRunCard } from "./ConversionRunCard";
import { ConversionSourceCard } from "./ConversionSourceCard";
import { VideoOutputControl } from "./VideoOutputControl";

const VIDEO_INPUT_EXTENSIONS = ["mp4", "mkv", "mov", "webm", "avi", "m4v"];
const videoInputAccept = extensionAccept(VIDEO_INPUT_EXTENSIONS);

function videoPresetInfo(preset: VideoTranscodePreset): { title: string; subtitle: string } {
  switch (preset) {
    case "gpu-intra":
      return {
        title: "GPU Intra MOV",
        subtitle: "GPU-accelerated high-quality conversion for fast editing",
      };
    case "prores-lt":
      return {
        title: "ProRes 422 LT",
        subtitle: "Lighter editing-ready format, good balance of quality and size",
      };
    case "prores-hq":
      return {
        title: "ProRes 422 HQ",
        subtitle: "High-quality editing-ready format for maximum detail",
      };
  }
}

function videoControlSpec(preset: VideoTranscodePreset): VideoControlSpec {
  switch (preset) {
    case "gpu-intra":
      return {
        label: "Constant quality",
        valueLabel: "QP",
        help: "Lower values keep more detail and create larger files.",
        min: 10,
        max: 28,
        step: 1,
        defaultValue: 16,
        suffix: "",
      };
    case "prores-lt":
      return {
        label: "Bitrate density",
        valueLabel: "Density",
        help: "Higher density raises ProRes LT file size and headroom.",
        min: 180,
        max: 700,
        step: 10,
        defaultValue: 360,
        suffix: "",
      };
    case "prores-hq":
      return {
        label: "Bitrate density",
        valueLabel: "Density",
        help: "Higher density raises ProRes HQ file size and headroom.",
        min: 400,
        max: 1400,
        step: 10,
        defaultValue: 800,
        suffix: "",
      };
  }
}

export function VideoToVideoPanel() {
  const [preset, setPreset] = React.useState<VideoTranscodePreset>("prores-lt");
  const [qualityValues, setQualityValues] = React.useState<Record<VideoTranscodePreset, number>>({
    "gpu-intra": 16,
    "prores-lt": 360,
    "prores-hq": 800,
  });
  const [selectedFiles, setSelectedFiles] = React.useState<string[]>([]);
  const [gpuStatus, setGpuStatus] = React.useState<VideoGpuStatus | null>(null);
  const [progress, setProgress] = React.useState<ConversionProgress | null>(null);
  const [result, setResult] = React.useState<ConversionDone | null>(null);
  const [batchItems, setBatchItems] = React.useState<BatchItemStatus[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [running, setRunning] = React.useState(false);
  const videoCancellingRef = React.useRef(false);

  React.useEffect(() => {
    void refreshGpuStatus();
  }, []);

  React.useEffect(() => {
    setDiscordJob("Converting video", running);
    return () => setDiscordJob("Converting video", false);
  }, [running]);

  React.useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<ConversionProgress>("conversion-progress", (event) => {
      setProgress(event.payload);
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  React.useEffect(() => {
    if (gpuStatus && !gpuStatus.compatible && preset === "gpu-intra") {
      setPreset("prores-lt");
    }
  }, [gpuStatus, preset]);

  async function refreshGpuStatus() {
    try {
      const raw = await invoke<string>("video_gpu_status");
      setGpuStatus(parseBridgePayload<VideoGpuStatus>(raw));
    } catch (statusError) {
      setGpuStatus({
        compatible: false,
        gpuName: null,
        hasNvidiaGpu: false,
        hasFfmpeg: false,
        hasFfprobe: false,
        hasH264Cuvid: false,
        hasHevcCuvid: false,
        hasHevcNvenc: false,
        hasH264Nvenc: false,
        hasAv1Nvenc: false,
        message: readBridgeError(statusError),
      });
    }
  }

  function acceptFiles(paths: string[]) {
    if (paths.length === 0) return;
    setSelectedFiles(paths);
    setProgress(null);
    setResult(null);
    setBatchItems([]);
    setError(null);
  }

  async function pickFile() {
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [
        {
          name: "Video",
          extensions: VIDEO_INPUT_EXTENSIONS,
        },
      ],
    });
    acceptFiles(normalizeSelectedPaths(selected));
  }

  const dropZone = useFileDrop({
    accept: videoInputAccept,
    enabled: !running,
    onDrop: acceptFiles,
  });

  async function startTranscode() {
    if (selectedFiles.length === 0 || running) return;
    if (preset === "gpu-intra" && gpuIntraLocked) {
      setError(gpuStatus?.message ?? "Compatible GPU not found.");
      return;
    }
    if (preset === "gpu-intra") {
      for (const inputPath of selectedFiles) {
        try {
          const codec = await invoke<string>("video_source_codec", { inputPath });
          if (!["h264", "hevc"].includes(codec)) {
            setError(`GPU Intra only works with certain video formats. ${fileName(inputPath)} uses ${codec}, which isn't supported. Choose ProRes LT or ProRes HQ for this file.`);
            return;
          }
        } catch (codecError) {
          setError(readBridgeError(codecError));
          return;
        }
      }
    }
    setRunning(true);
    videoCancellingRef.current = false;
    setResult(null);
    setBatchItems([]);
    setError(null);
    setProgress({
      stage: "starting",
      percent: 0,
      message: selectedFiles.length > 1 ? `Preparing ${selectedFiles.length} video conversions...` : "Preparing conversion...",
    });
    try {
      const completed: BatchItemStatus[] = [];
      for (let index = 0; index < selectedFiles.length; index += 1) {
        if (videoCancellingRef.current) break;
        const inputPath = selectedFiles[index];
        setProgress({
          stage: "starting",
          percent: Math.round((index / selectedFiles.length) * 100),
          message: `File ${index + 1}/${selectedFiles.length}: ${fileName(inputPath)}`,
        });
        try {
          const raw = await invoke<string>("video_transcode", {
            inputPath,
            preset,
            qualityValue: qualityValues[preset],
          });
          const payload = parseBridgePayload<ConversionDone>(raw);
          completed.push({ input: inputPath, output: payload.output, status: "done" });
          setResult(payload);
        } catch (conversionError) {
          if (videoCancellingRef.current) {
            completed.push({ input: inputPath, status: "error", message: "Cancelled" });
            break;
          }
          completed.push({ input: inputPath, status: "error", message: readBridgeError(conversionError) });
        }
        setBatchItems([...completed]);
      }
      if (videoCancellingRef.current) {
        setError("Video conversion cancelled.");
        setProgress({
          stage: "cancelled",
          percent: null,
          message: "Video conversion cancelled.",
        });
        return;
      }
      setProgress({
        stage: "complete",
        percent: 100,
        message: `Converted ${completed.filter((item) => item.status === "done").length}/${selectedFiles.length} files.`,
      });
    } catch (conversionError) {
      setError(readBridgeError(conversionError));
    } finally {
      setRunning(false);
      videoCancellingRef.current = false;
    }
  }

  const presetInfo = videoPresetInfo(preset);
  const controlSpec = videoControlSpec(preset);
  const gpuIntraLocked = gpuStatus ? !gpuStatus.compatible : true;
  const qualityValue = qualityValues[preset];

  function setPresetQuality(value: number) {
    const clamped = clampNumber(value, controlSpec.min, controlSpec.max);
    setQualityValues((current) => ({ ...current, [preset]: clamped }));
  }

  return (
    <section
      ref={dropZone.ref}
      className={`conversion-panel drop-zone${dropZone.hover ? " is-drop-target" : ""}`}
    >
      <div className="drop-zone-overlay">
        <Upload size={32} strokeWidth={1.8} />
        <span>Drop video to convert</span>
        <small>MP4 · MKV · MOV · WEBM · AVI · M4V</small>
      </div>
      <div className="conversion-hero">
        <div>
          <span className="conversion-kicker">Video Conversion</span>
          <h2>Convert footage for editing</h2>
        </div>
        <div className="conversion-format-card wide">
          {gpuStatus && (
            <div className={`conversion-compat ${gpuStatus.compatible ? "is-ready" : "is-locked"}`}>
              {gpuStatus.compatible ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
              <span>{gpuStatus.message}</span>
            </div>
          )}
          {preset === "gpu-intra" && (
            <div className="conversion-compat is-locked">
              <Info size={15} />
              <span>GPU Intra only works with certain video formats. ProRes presets accept a wider range of inputs.</span>
            </div>
          )}
          <span>Preset</span>
          <div className="conversion-segment video-presets" aria-label="Video transcode preset">
            <button
              type="button"
              className={preset === "gpu-intra" ? "is-active" : ""}
              onClick={() => setPreset("gpu-intra")}
              disabled={running || gpuIntraLocked}
              title={gpuStatus?.message ?? "Checking GPU Intra compatibility..."}
            >
              GPU Intra
            </button>
            <button type="button" className={preset === "prores-lt" ? "is-active" : ""} onClick={() => setPreset("prores-lt")} disabled={running}>
              ProRes LT
            </button>
            <button type="button" className={preset === "prores-hq" ? "is-active" : ""} onClick={() => setPreset("prores-hq")} disabled={running}>
              ProRes HQ
            </button>
          </div>
          <VideoOutputControl
            spec={controlSpec}
            value={qualityValue}
            disabled={running}
            onChange={setPresetQuality}
          />
        </div>
      </div>

      <div className="conversion-grid">
        <ConversionSourceCard
          icon={<FileVideo size={24} strokeWidth={1.9} />}
          label="Source video"
          selectedFiles={selectedFiles}
          pickLabel={selectedFiles.length > 0 ? "Change videos" : "Select videos"}
          onPick={pickFile}
          disabled={running}
          actionTitle={presetInfo.title}
          actionSubtitle={presetInfo.subtitle}
        />
        <ConversionRunCard
          canRun={selectedFiles.length > 0 && !running && !(preset === "gpu-intra" && gpuIntraLocked)}
          running={running}
          progress={progress}
          result={result}
          error={error}
          batchItems={batchItems}
          onRun={startTranscode}
          onCancel={() => {
            videoCancellingRef.current = true;
            void invoke("cancel_video");
          }}
        />
      </div>
    </section>
  );
}
