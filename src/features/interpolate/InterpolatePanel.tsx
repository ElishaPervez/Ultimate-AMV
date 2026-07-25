import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  FilePlus2,
  FolderOpen,
  Gauge,
  Loader2,
  Sparkles,
  Trash2,
  XCircle,
} from "lucide-react";
import { setDiscordJob } from "../../lib/discord";
import { fileName, fileStem, normalizeSelectedPaths } from "../../lib/paths";
import { parseBridgePayload, readBridgeError } from "../../utils/bridge";
import type {
  InterpolateDone,
  InterpolateFactor,
  InterpolateModelKey,
  InterpolateNamingMode,
  InterpolateProgress,
  InterpolateQueueItem,
  InterpolateStatus,
} from "../../types/interpolate";
import { InterpolateProgressCard } from "./InterpolateProgressCard";

const VIDEO_EXTENSIONS = ["mp4", "mkv", "mov", "webm", "avi", "m4v"];

let interpolationBusy = false;

function parentDirectory(path: string): string {
  const index = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return index >= 0 ? path.slice(0, index) : "";
}

function joinPath(folder: string, name: string): string {
  const separator = folder.includes("\\") ? "\\" : "/";
  return `${folder.replace(/[\\/]+$/, "")}${separator}${name}`;
}

export function buildInterpolationOutput(
  input: string,
  outputFolder: string,
  factor: InterpolateFactor,
  naming: InterpolateNamingMode,
): string {
  const stem = fileStem(input);
  const name = naming === "suffix" ? `${stem}_${factor}x.mp4` : `${stem}.mp4`;
  const output = joinPath(outputFolder, name);
  if (output.toLocaleLowerCase() === input.toLocaleLowerCase()) {
    return joinPath(outputFolder, `${stem}_${factor}x.mp4`);
  }
  return output;
}

export function normalizeInterpolateProgress(payload: InterpolateProgress): InterpolateProgress | null {
  if (payload.type === "progress") return payload;
  const binary = payload.binary?.startsWith("rife") ? "RIFE model" : payload.binary || "model";
  if (payload.type === "download-start") {
    return { ...payload, type: "progress", stage: "model-init", percent: 0, message: `Downloading ${binary}` };
  }
  if (payload.type === "download-progress") {
    const percent = payload.totalBytes
      ? (Number(payload.downloadedBytes || 0) / Number(payload.totalBytes)) * 100
      : -1;
    return { ...payload, type: "progress", stage: "model-init", percent, message: `Downloading ${binary}` };
  }
  if (payload.type === "verify-start") {
    return { ...payload, type: "progress", stage: "model-init", percent: 99, message: `Verifying ${binary}` };
  }
  if (payload.type === "install-step") {
    return { ...payload, type: "progress", stage: "model-init", percent: 100, message: `Installing ${binary}` };
  }
  return null;
}

export function InterpolatePanel({ active }: { active: boolean }) {
  const [status, setStatus] = React.useState<InterpolateStatus | null>(null);
  const [queue, setQueue] = React.useState<InterpolateQueueItem[]>([]);
  const [factor, setFactor] = React.useState<InterpolateFactor>(2);
  const [model, setModel] = React.useState<InterpolateModelKey>("rife4.25");
  const [outputFolder, setOutputFolder] = React.useState("");
  const [naming, setNaming] = React.useState<InterpolateNamingMode>("suffix");
  const [useGpu, setUseGpu] = React.useState(true);
  const [running, setRunning] = React.useState(false);
  const [cancelling, setCancelling] = React.useState(false);
  const [progress, setProgress] = React.useState<InterpolateProgress | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<InterpolateDone | null>(null);
  const [etaSeconds, setEtaSeconds] = React.useState<number | null>(null);
  const statusFetched = React.useRef(false);
  const clipStartedAt = React.useRef(0);
  const currentClipIndex = React.useRef(0);
  const measuredClipSeconds = React.useRef<number[]>([]);

  React.useEffect(() => () => {
    interpolationBusy = false;
  }, []);

  const refreshOutputs = React.useCallback((
    items: InterpolateQueueItem[],
    folder = outputFolder,
    selectedFactor = factor,
    selectedNaming = naming,
  ) => items.map((item) => ({
    ...item,
    output: folder ? buildInterpolationOutput(item.input, folder, selectedFactor, selectedNaming) : "",
  })), [factor, naming, outputFolder]);

  React.useEffect(() => {
    if (!active || statusFetched.current) return;
    statusFetched.current = true;
    void invoke<string>("interpolate_status")
      .then((raw) => {
        const next = parseBridgePayload<InterpolateStatus>(raw);
        setStatus(next);
        setUseGpu(Boolean(next.hardware.hasCuda));
      })
      .catch((cause) => {
        setError(readBridgeError(cause));
        setUseGpu(false);
      });
  }, [active]);

  React.useEffect(() => {
    setDiscordJob("Interpolating frames", running);
    return () => setDiscordJob("Interpolating frames", false);
  }, [running]);

  React.useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<InterpolateProgress>("interpolate-progress", (event) => {
      if (!interpolationBusy) return;
      const next = normalizeInterpolateProgress(event.payload);
      if (!next) return;
      setProgress(next);
      const index = next.clipIndex || 0;
      if (index > 0 && index !== currentClipIndex.current) {
        currentClipIndex.current = index;
        clipStartedAt.current = performance.now();
        setQueue((items) => items.map((item, itemIndex) => ({
          ...item,
          status: itemIndex === index - 1 ? "running" : item.status,
        })));
      }
      if (index > 0 && next.stage === "encode" && (next.percent || 0) >= 100) {
        const elapsed = Math.max(0, (performance.now() - clipStartedAt.current) / 1000);
        if (index > 1) measuredClipSeconds.current.push(elapsed);
        const samples = measuredClipSeconds.current;
        if (samples.length > 0) {
          const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
          setEtaSeconds(average * Math.max(0, queue.length - index));
        }
        setQueue((items) => items.map((item, itemIndex) => ({
          ...item,
          status: itemIndex === index - 1 ? "done" : item.status,
        })));
      }
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => unlisten?.();
  }, [queue.length]);

  function acceptFiles(paths: string[]) {
    const unique = paths.filter((path, index, all) =>
      all.findIndex((candidate) => candidate.toLocaleLowerCase() === path.toLocaleLowerCase()) === index
    );
    if (unique.length === 0) return;
    const folder = outputFolder || parentDirectory(unique[0]);
    if (!outputFolder) setOutputFolder(folder);
    setQueue((existing) => {
      const known = new Set(existing.map((item) => item.input.toLocaleLowerCase()));
      const added = unique
        .filter((path) => !known.has(path.toLocaleLowerCase()))
        .map((input) => ({
          input,
          output: buildInterpolationOutput(input, folder, factor, naming),
          status: "queued" as const,
        }));
      return [...existing, ...added];
    });
    setError(null);
    setResult(null);
  }

  async function pickFiles() {
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [{ name: "Video", extensions: VIDEO_EXTENSIONS }],
    });
    acceptFiles(normalizeSelectedPaths(selected));
  }

  async function pickFolderInputs() {
    const selected = await open({ multiple: false, directory: true });
    if (!selected || Array.isArray(selected)) return;
    try {
      const paths = await invoke<string[]>("interpolate_list_folder", { folder: selected });
      if (paths.length === 0) {
        setError("That folder contains no supported video files.");
        return;
      }
      acceptFiles(paths);
    } catch (cause) {
      setError(readBridgeError(cause));
    }
  }

  async function pickOutputFolder() {
    const selected = await open({ multiple: false, directory: true });
    if (!selected || Array.isArray(selected)) return;
    setOutputFolder(selected);
    setQueue((items) => refreshOutputs(items, selected));
  }

  function updateFactor(next: InterpolateFactor) {
    setFactor(next);
    setQueue((items) => refreshOutputs(items, outputFolder, next, naming));
  }

  function updateNaming(next: InterpolateNamingMode) {
    setNaming(next);
    setQueue((items) => refreshOutputs(items, outputFolder, factor, next));
  }

  async function runInterpolation() {
    if (running || interpolationBusy || queue.length === 0 || !outputFolder || !status) return;
    interpolationBusy = true;
    setRunning(true);
    setCancelling(false);
    setError(null);
    setResult(null);
    setEtaSeconds(null);
    setProgress({ type: "progress", stage: "dependencies", percent: -1, message: "Preparing the interpolation queue" });
    measuredClipSeconds.current = [];
    currentClipIndex.current = 0;
    const jobs = refreshOutputs(queue).map((item) => ({ input: item.input, output: item.output }));
    setQueue((items) => refreshOutputs(items).map((item) => ({ ...item, status: "queued", message: undefined })));
    try {
      const raw = await invoke<string>("interpolate_run", {
        jobs,
        factor,
        model,
        gpu: useGpu,
        half: useGpu,
      });
      const done = parseBridgePayload<InterpolateDone>(raw);
      setResult(done);
      setQueue((items) => items.map((item) => {
        const outcome = done.outcomes.find((candidate) =>
          candidate.input.toLocaleLowerCase() === item.input.toLocaleLowerCase()
        );
        return {
          ...item,
          output: outcome?.output || item.output,
          status: outcome?.ok ? "done" : "failed",
          message: outcome?.error,
        };
      }));
    } catch (cause) {
      if (!cancelling) setError(readBridgeError(cause));
    } finally {
      interpolationBusy = false;
      setRunning(false);
      setCancelling(false);
      setProgress(null);
    }
  }

  async function cancelInterpolation() {
    if (!running || cancelling) return;
    setCancelling(true);
    setProgress((current) => ({
      ...(current || { type: "progress" }),
      stage: "cancelling",
      percent: -1,
      message: "Stopping the active clip and keeping finished files",
    }));
    try {
      await invoke("cancel_interpolate");
    } finally {
      interpolationBusy = false;
      setRunning(false);
      setCancelling(false);
      setProgress(null);
      setError("Interpolation cancelled. Finished clips were kept.");
      setQueue((items) => items.map((item) =>
        item.status === "running" ? { ...item, status: "queued" } : item
      ));
    }
  }

  const completed = queue.filter((item) => item.status === "done").length;
  const currentPercent = progress?.percent && progress.percent > 0 ? progress.percent : 0;
  const currentIndex = progress?.clipIndex || completed;
  const overallPercent = queue.length
    ? ((Math.max(0, currentIndex - 1) + currentPercent / 100) / queue.length) * 100
    : 0;
  const gpuReady = Boolean(status?.hardware.hasCuda);

  return (
    <section className="conversion-panel interpolate-panel">
      <header className="conversion-hero interpolate-hero">
        <div>
          <span className="conversion-kicker">Motion synthesis</span>
          <h2>Smooth the shot, keep the cut.</h2>
          <p>Add short AMV clips as a batch. The model loads once, inserts new frames, and keeps the original audio aligned.</p>
        </div>
        <div className={`conversion-compat ${useGpu && gpuReady ? "is-ready" : "is-locked"}`}>
          {useGpu && gpuReady ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
          <span>
            {!status ? "Checking hardware" : useGpu && gpuReady
              ? `${status.hardware.device || "NVIDIA GPU"} · half precision`
              : "CPU mode · substantially slower"}
          </span>
        </div>
      </header>

      <div className="interpolate-layout">
        <section className="interpolate-queue-pane" aria-label="Interpolation queue">
          <div className="interpolate-queue-toolbar">
            <div>
              <span className="conversion-field-label">Clip queue</span>
              <strong>{queue.length === 0 ? "No clips yet" : `${queue.length} clip${queue.length === 1 ? "" : "s"}`}</strong>
            </div>
            <div className="interpolate-add-actions">
              <button type="button" className="conversion-pick-btn" disabled={running} onClick={() => void pickFiles()}>
                <FilePlus2 size={15} /> Add clips
              </button>
              <button type="button" className="conversion-pick-btn" disabled={running} onClick={() => void pickFolderInputs()}>
                <FolderOpen size={15} /> Add folder
              </button>
            </div>
          </div>

          {queue.length === 0 ? (
            <button type="button" className="interpolate-empty" onClick={() => void pickFiles()}>
              <Sparkles size={24} />
              <strong>Build a smoothing queue</strong>
              <span>Pick 1–40 short clips. MP4, MKV, MOV, WebM, AVI, and M4V are accepted.</span>
            </button>
          ) : (
            <div className="interpolate-queue-list">
              {queue.map((item, index) => (
                <div className={`interpolate-queue-item is-${item.status}`} key={item.input}>
                  <span className="interpolate-queue-index">{String(index + 1).padStart(2, "0")}</span>
                  <div className="interpolate-queue-copy">
                    <strong title={item.input}>{fileName(item.input)}</strong>
                    <span title={item.output}>{item.message || (item.output ? fileName(item.output) : "Choose an output folder")}</span>
                  </div>
                  <span className="interpolate-queue-state">
                    {item.status === "running" ? <Loader2 size={14} className="audio-spin" />
                      : item.status === "done" ? <Check size={14} />
                        : item.status === "failed" ? <XCircle size={14} />
                          : "Queued"}
                  </span>
                  <button
                    type="button"
                    className="interpolate-remove"
                    aria-label={`Remove ${fileName(item.input)}`}
                    disabled={running}
                    onClick={() => setQueue((items) => items.filter((candidate) => candidate.input !== item.input))}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <aside className="interpolate-controls">
          <div className="interpolate-control">
            <span className="conversion-field-label">Speed factor</span>
            <div className="conversion-segment interpolate-factor">
              {([2, 3, 4] as InterpolateFactor[]).map((value) => (
                <button
                  type="button"
                  className={factor === value ? "is-active" : ""}
                  disabled={running}
                  onClick={() => updateFactor(value)}
                  key={value}
                >
                  {value}x
                </button>
              ))}
            </div>
          </div>

          <div className="interpolate-control">
            <span className="conversion-field-label">Model</span>
            <div className="interpolate-models">
              {(["rife4.25", "rife4.6"] as InterpolateModelKey[]).map((value) => (
                <button
                  type="button"
                  className={model === value ? "is-active" : ""}
                  disabled={running}
                  aria-pressed={model === value}
                  onClick={() => setModel(value)}
                  key={value}
                >
                  <strong>{value === "rife4.25" ? "RIFE 4.25" : "RIFE 4.6"}</strong>
                  <span>{value === "rife4.25" ? "Best anime detail" : "Lower memory"}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="interpolate-control">
            <span className="conversion-field-label">Output folder</span>
            <button type="button" className="interpolate-folder" disabled={running} onClick={() => void pickOutputFolder()}>
              <FolderOpen size={15} />
              <span title={outputFolder}>{outputFolder || "Choose folder"}</span>
            </button>
          </div>

          <div className="interpolate-control">
            <span className="conversion-field-label">File naming</span>
            <div className="conversion-segment">
              <button type="button" className={naming === "suffix" ? "is-active" : ""} disabled={running} onClick={() => updateNaming("suffix")}>
                Add _{factor}x
              </button>
              <button type="button" className={naming === "source-name" ? "is-active" : ""} disabled={running} onClick={() => updateNaming("source-name")}>
                Source name
              </button>
            </div>
          </div>

          <div className="interpolate-hardware-toggle">
            <div>
              <Gauge size={15} />
              <span>Processing</span>
            </div>
            <div className="conversion-segment">
              <button type="button" className={useGpu ? "is-active" : ""} disabled={running || !gpuReady} onClick={() => setUseGpu(true)}>GPU</button>
              <button type="button" className={!useGpu ? "is-active" : ""} disabled={running} onClick={() => setUseGpu(false)}>CPU</button>
            </div>
          </div>

          {!useGpu && (
            <div className="interpolate-warning">
              <AlertTriangle size={16} />
              <span>At 1080p, CPU interpolation can take several minutes for each clip. The queue remains usable, but GPU mode is the practical path for batches.</span>
            </div>
          )}

          {error && <div className="interpolate-result is-error">{error}</div>}
          {result && !running && (
            <div className={`interpolate-result ${result.failed ? "is-warning" : "is-success"}`}>
              {result.succeeded} finished{result.failed ? ` · ${result.failed} failed` : ""}.
              {result.sceneHolds > 0 ? ` ${result.sceneHolds} hard cut${result.sceneHolds === 1 ? "" : "s"} held cleanly.` : ""}
            </div>
          )}

          {running ? (
            <InterpolateProgressCard
              progress={progress}
              overallPercent={overallPercent}
              completed={completed}
              total={queue.length}
              factor={factor}
              etaSeconds={etaSeconds}
              cancelling={cancelling}
              onCancel={() => void cancelInterpolation()}
            />
          ) : (
            <button
              type="button"
              className="conversion-run-btn interpolate-run"
              disabled={!status || queue.length === 0 || !outputFolder}
              onClick={() => void runInterpolation()}
            >
              <Sparkles size={16} />
              Interpolate {queue.length || ""} clip{queue.length === 1 ? "" : "s"}
            </button>
          )}
        </aside>
      </div>
    </section>
  );
}
