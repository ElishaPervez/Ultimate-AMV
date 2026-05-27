import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { FileAudio, Upload } from "lucide-react";
import { setDiscordJob } from "../../lib/discord";
import { fileName, normalizeSelectedPaths } from "../../lib/paths";
import { extensionAccept, useFileDrop } from "../../lib/useFileDrop";
import { parseBridgePayload, readBridgeError } from "../../utils/bridge";
import type { AudioOutputFormat, BatchItemStatus } from "../../types/audio";
import type { ConversionDone, ConversionProgress } from "../../types/conversion";
import { ConversionRunCard } from "../video/ConversionRunCard";
import { ConversionSourceCard } from "../video/ConversionSourceCard";

const MEDIA_INPUT_EXTENSIONS = [
  "wav", "mp3", "flac", "m4a", "ogg", "aac", "opus", "wma",
  "mp4", "mkv", "avi", "webm", "mov",
];
const mediaInputAccept = extensionAccept(MEDIA_INPUT_EXTENSIONS);

export function MediaToAudioPanel() {
  const [format, setFormat] = React.useState<AudioOutputFormat>("wav");
  const [selectedFiles, setSelectedFiles] = React.useState<string[]>([]);
  const [progress, setProgress] = React.useState<ConversionProgress | null>(null);
  const [result, setResult] = React.useState<ConversionDone | null>(null);
  const [batchItems, setBatchItems] = React.useState<BatchItemStatus[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [running, setRunning] = React.useState(false);

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
    setDiscordJob("Converting audio", running);
    return () => setDiscordJob("Converting audio", false);
  }, [running]);

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
          name: "Audio or video",
          extensions: MEDIA_INPUT_EXTENSIONS,
        },
      ],
    });
    acceptFiles(normalizeSelectedPaths(selected));
  }

  const dropZone = useFileDrop({
    accept: mediaInputAccept,
    enabled: !running,
    onDrop: acceptFiles,
  });

  async function startConversion() {
    if (selectedFiles.length === 0 || running) return;
    setRunning(true);
    setResult(null);
    setBatchItems([]);
    setError(null);
    setProgress({
      stage: "starting",
      percent: 0,
      message: selectedFiles.length > 1 ? `Preparing ${selectedFiles.length} audio conversions...` : `Preparing ${format.toUpperCase()} conversion...`,
    });
    try {
      const completed: BatchItemStatus[] = [];
      for (let index = 0; index < selectedFiles.length; index += 1) {
        const inputPath = selectedFiles[index];
        setProgress({
          stage: "starting",
          percent: Math.round((index / selectedFiles.length) * 100),
          message: `File ${index + 1}/${selectedFiles.length}: ${fileName(inputPath)}`,
        });
        try {
          const raw = await invoke<string>("media_to_audio", { inputPath, outputFormat: format });
          const payload = parseBridgePayload<ConversionDone>(raw);
          completed.push({ input: inputPath, output: payload.output, status: "done" });
          setResult(payload);
        } catch (conversionError) {
          completed.push({ input: inputPath, status: "error", message: readBridgeError(conversionError) });
        }
        setBatchItems([...completed]);
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
    }
  }

  return (
    <section
      ref={dropZone.ref}
      className={`conversion-panel drop-zone${dropZone.hover ? " is-drop-target" : ""}`}
    >
      <div className="drop-zone-overlay">
        <Upload size={32} strokeWidth={1.8} />
        <span>Drop media to convert to {format.toUpperCase()}</span>
        <small>Audio or video : batches are queued together</small>
      </div>
      <div className="conversion-hero">
        <div>
          <span className="conversion-kicker">Audio Conversion</span>
          <h2>Extract a clean edit-ready audio file</h2>
        </div>
        <div className="conversion-format-card">
          <span>Output</span>
          <div className="conversion-segment" aria-label="Audio output format">
            <button type="button" className={format === "wav" ? "is-active" : ""} onClick={() => setFormat("wav")} disabled={running}>
              WAV
            </button>
            <button type="button" className={format === "mp3" ? "is-active" : ""} onClick={() => setFormat("mp3")} disabled={running}>
              MP3
            </button>
          </div>
        </div>
      </div>

      <div className="conversion-grid">
        <ConversionSourceCard
          icon={<FileAudio size={24} strokeWidth={1.9} />}
          label="Source media"
          selectedFiles={selectedFiles}
          pickLabel={selectedFiles.length > 0 ? "Change files" : "Select files"}
          onPick={pickFile}
          disabled={running}
          actionTitle={`Convert to ${format.toUpperCase()}`}
          actionSubtitle={format === "wav" ? "PCM 16-bit, 44.1 kHz stereo" : "LAME V0 MP3, 44.1 kHz stereo"}
        />
        <ConversionRunCard
          canRun={selectedFiles.length > 0 && !running}
          running={running}
          progress={progress}
          result={result}
          error={error}
          batchItems={batchItems}
          onRun={startConversion}
        />
      </div>
    </section>
  );
}
