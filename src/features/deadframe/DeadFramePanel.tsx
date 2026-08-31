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
  Loader2,
  Play,
  Scissors,
  Trash2,
  Upload,
  X,
  XCircle,
} from "lucide-react";
import { setDiscordJob } from "../../lib/discord";
import { useFileDrop } from "../../lib/useFileDrop";
import { fileName, normalizeSelectedPaths } from "../../lib/paths";
import { acceptsDroppedPath, isSupportedVideoPath, VIDEO_EXTENSIONS } from "../../lib/videoPaths";
import { parseBridgePayload, readBridgeError } from "../../utils/bridge";
import type { InterpolateStatus } from "../../types/interpolate";
import type {
  DeadFrameAnalysis,
  DeadFrameDone,
  DeadFrameExportFps,
  DeadFrameOutputFormat,
  DeadFramePreview,
  DeadFramePreviewDone,
  DeadFrameProgress,
  DeadFrameQueueItem,
  DeadFrameRateMode,
} from "../../types/deadframe";
import { DeadFrameVideo } from "./DeadFrameVideo";
import { FrameRibbon } from "./FrameRibbon";
import { VideoOutputControl } from "../video/VideoOutputControl";
import { OUTPUT_FORMATS } from "../video/outputFormats";
import { Dropdown } from "../../components/Dropdown";
import type { DropdownOption } from "../../components/Dropdown";
import type { VideoControlSpec } from "../../types/conversion";

export { acceptsDroppedPath, isSupportedVideoPath };

export const DEFAULT_SENSITIVITY = 18;
export const DEFAULT_SUFFIX = "_nodead";

// Removing frames never creates new ones, so a chosen rate is a re-timing of
// the survivors: above the source it plays faster and shorter, below it slower
// and longer. Smoothing to a higher rate is Frame Interpolation's job.
const EXPORT_FPS_OPTIONS: DropdownOption<DeadFrameExportFps>[] = [
  {
    value: "source",
    label: "Source fps",
    description: "Each clip keeps its own rate; only the removed frames shorten it.",
  },
  ...[23.976, 24, 30, 48, 60, 120].map((value) => ({
    value,
    label: `${value} fps`,
  })),
];

// Backend events keep arriving while a run is in flight; this flag is what
// stops a stale one from repainting a panel that is no longer working. It is
// deliberately separate from the interpolation panel's flag — sharing one would
// let either feature's progress land in the other's queue.
let deadFrameBusy = false;

/**
 * The dial is an absolute amount of change, not a per-clip percentile: the user
 * tunes on one clip and exports the whole queue, so 18 has to mean the same
 * physical amount of movement on every file.
 */
export function removalThreshold(sensitivity: number): number {
  const dial = Math.max(0, Math.min(100, sensitivity));
  return 0.001 + (dial / 100) * 0.029;
}

/**
 * One entry per frame: true where the frame survives at this dial position.
 *
 * Frame 0 has nothing before it to compare against, so it is never removable.
 * A frame sitting exactly on the threshold is kept — the comparison is strict,
 * matching `removal_set()` in `amv_deadframe/analyzer.py` (which drops on
 * `index > 0 and score < threshold`), so the live count and the export agree.
 *
 * The ribbon and the kept/removed numbers are both drawn from this one array,
 * which is the only reason the picture cannot drift away from the count.
 */
export function keptFrameFlags(scores: number[], sensitivity: number): boolean[] {
  const threshold = removalThreshold(sensitivity);
  return scores.map((score, index) => index === 0 || score >= threshold);
}

export function keptFrameCount(scores: number[], sensitivity: number): number {
  return keptFrameFlags(scores, sensitivity).filter(Boolean).length;
}

export function DeadFramePanel({ active }: { active: boolean }) {
  const [status, setStatus] = React.useState<InterpolateStatus | null>(null);
  const [queue, setQueue] = React.useState<DeadFrameQueueItem[]>([]);
  const [selectedInput, setSelectedInput] = React.useState("");
  const [sensitivity, setSensitivity] = React.useState(DEFAULT_SENSITIVITY);
  const [outputFormat, setOutputFormat] = React.useState<DeadFrameOutputFormat>("h264-mp4");
  const [rateMode, setRateMode] = React.useState<DeadFrameRateMode>("quality");
  const [quality, setQuality] = React.useState(18);
  const [bitrateMbps, setBitrateMbps] = React.useState(20);
  const [keepAudio, setKeepAudio] = React.useState(false);
  const [exportFps, setExportFps] = React.useState<DeadFrameExportFps>("source");
  const [suffix, setSuffix] = React.useState(DEFAULT_SUFFIX);
  const [preview, setPreview] = React.useState<DeadFramePreview | null>(null);
  const [previewing, setPreviewing] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const [cancelling, setCancelling] = React.useState(false);
  const [progress, setProgress] = React.useState<DeadFrameProgress | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<DeadFrameDone | null>(null);
  const statusFetched = React.useRef(false);
  const queueRef = React.useRef<DeadFrameQueueItem[]>([]);
  const measuring = React.useRef(false);
  const exportInputs = React.useRef<string[]>([]);
  // The run that is already in flight closed over the old `cancelling` value,
  // so it would report the killed child's failure as a real error. The ref is
  // what the catch blocks read instead.
  const cancellingRef = React.useRef(false);
  queueRef.current = queue;

  const busy = previewing || exporting;

  React.useEffect(() => () => {
    deadFrameBusy = false;
  }, []);

  // A crash mid-preview leaves its render behind. It is swept up here without
  // a word: the house rule is never to ask the user about leftover files.
  React.useEffect(() => {
    void invoke("deadframe_clear_previews").catch(() => undefined);
  }, []);

  React.useEffect(() => {
    if (!active || statusFetched.current) return;
    statusFetched.current = true;
    void invoke<string>("interpolate_status")
      .then((raw) => setStatus(parseBridgePayload<InterpolateStatus>(raw)))
      .catch(() => {
        // Hardware detection only decides whether the export may use the
        // NVIDIA encoder and whether the dial reads CQ or CRF. Failing it means
        // CPU, which every machine can do — not an error worth showing.
        setStatus(null);
      });
  }, [active]);

  React.useEffect(() => {
    setDiscordJob("Removing dead frames", exporting);
    return () => setDiscordJob("Removing dead frames", false);
  }, [exporting]);

  React.useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<DeadFrameProgress>("deadframe-preview-progress", (event) => {
      if (!deadFrameBusy) return;
      setProgress(event.payload);
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => unlisten?.();
  }, []);

  React.useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<DeadFrameProgress>("deadframe-export-progress", (event) => {
      if (!deadFrameBusy) return;
      const next = event.payload;
      setProgress(next);
      const index = next.clipIndex || 0;
      const input = index > 0 ? exportInputs.current[index - 1] : undefined;
      if (!input) return;
      const finished = next.stage === "encode" && (next.percent || 0) >= 100;
      setQueue((items) => items.map((item) => item.input === input
        ? { ...item, status: finished ? "done" : "running" }
        : item));
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => unlisten?.();
  }, []);

  // Clips are measured one at a time as they arrive. The loop keeps its own
  // record of what it has already picked up, so a queue update that has not
  // repainted yet can never hand it the same clip twice.
  const measureQueue = React.useCallback(async () => {
    if (measuring.current) return;
    measuring.current = true;
    const started = new Set<string>();
    try {
      for (;;) {
        const next = queueRef.current.find(
          (item) => item.status === "queued" && !started.has(item.input),
        );
        if (!next) return;
        started.add(next.input);
        setQueue((items) => items.map((item) =>
          item.input === next.input ? { ...item, status: "measuring" } : item));
        try {
          const raw = await invoke<string>("deadframe_analyze", { input: next.input });
          const analysis = parseBridgePayload<DeadFrameAnalysis>(raw);
          setQueue((items) => items.map((item) => item.input === next.input
            ? {
              ...item,
              status: "ready",
              frameCount: analysis.frameCount,
              fps: analysis.fps,
              scores: analysis.scores,
              message: undefined,
            }
            : item));
        } catch (cause) {
          setQueue((items) => items.map((item) => item.input === next.input
            ? { ...item, status: "failed", message: readBridgeError(cause) || "Couldn't read this file." }
            : item));
        }
      }
    } finally {
      measuring.current = false;
    }
  }, []);

  React.useEffect(() => {
    void measureQueue();
  }, [queue, measureQueue]);

  function acceptFiles(paths: string[]) {
    const unique = paths.filter((path, index, all) =>
      all.findIndex((candidate) => candidate.toLocaleLowerCase() === path.toLocaleLowerCase()) === index
    );
    if (unique.length === 0) return;
    setQueue((existing) => {
      const known = new Set(existing.map((item) => item.input.toLocaleLowerCase()));
      const added = unique
        .filter((path) => !known.has(path.toLocaleLowerCase()))
        .map((input) => ({ input, status: "queued" as const }));
      return [...existing, ...added];
    });
    // Adding clips never disturbs the export gate; it only fills the empty
    // selection so the players have something to show.
    setSelectedInput((current) => current || unique[0]);
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
      const paths = await invoke<string[]>("deadframe_list_folder", { folder: selected });
      if (paths.length === 0) {
        setError("That folder contains no supported video files.");
        return;
      }
      acceptFiles(paths);
    } catch (cause) {
      setError(readBridgeError(cause));
    }
  }

  async function acceptDroppedPaths(paths: string[]) {
    const clips = paths.filter(isSupportedVideoPath);
    const folders = paths.filter((path) => !isSupportedVideoPath(path));
    for (const folder of folders) {
      try {
        clips.push(...await invoke<string[]>("deadframe_list_folder", { folder }));
      } catch {
        // Not a readable folder — the remaining drops still go through.
      }
    }
    if (clips.length === 0) {
      setError("Nothing in that drop was a supported video clip.");
      return;
    }
    acceptFiles(clips);
  }

  const dropZone = useFileDrop({
    accept: acceptsDroppedPath,
    enabled: !busy,
    onDrop: (paths) => void acceptDroppedPaths(paths),
  });

  // Both players must always show the same clip. A preview of one clip sitting
  // beside the original of another is the one way this panel could lie, so the
  // preview is dropped the moment the selection moves.
  function selectClip(input: string) {
    if (input === selectedInput) return;
    setSelectedInput(input);
    setPreview(null);
    setError(null);
  }

  function removeClip(input: string) {
    const remaining = queue.filter((item) => item.input !== input);
    setQueue(remaining);
    if (input !== selectedInput) return;
    // The removed clip was the one on screen, so the preview beside it no
    // longer has an original to sit next to.
    setSelectedInput(remaining[0]?.input || "");
    setPreview(null);
  }

  function updateSensitivity(next: number) {
    setSensitivity(next);
    // The preview attested to the old dial position, so it is now stale. It
    // stays on screen — it is still a real render — but the gate closes.
    setError(null);
  }

  async function runPreview() {
    const item = queue.find((candidate) => candidate.input === selectedInput);
    if (!item || !item.scores || busy) return;
    deadFrameBusy = true;
    cancellingRef.current = false;
    setPreviewing(true);
    setError(null);
    setResult(null);
    setProgress({ type: "progress", stage: "measure", percent: -1, message: "Reading the selected clip" });
    // Release the previous render before the backend wipes the preview folder:
    // Windows will not delete a file the player still holds open.
    setPreview(null);
    try {
      const raw = await invoke<string>("deadframe_preview", { input: item.input, sensitivity });
      const done = parseBridgePayload<DeadFramePreviewDone>(raw);
      setPreview({
        input: item.input,
        sensitivity,
        output: done.output,
        sourceFrames: done.sourceFrames,
        keptFrames: done.keptFrames,
      });
    } catch (cause) {
      // A cancelled run fails by design; the cancel path already said so.
      if (!cancellingRef.current) setError(readBridgeError(cause));
      setPreview(null);
    } finally {
      deadFrameBusy = false;
      setPreviewing(false);
      setCancelling(false);
      setProgress(null);
    }
  }

  async function runExport() {
    if (!gateOpen || exportable.length === 0 || busy) return;
    const inputs = exportable.map((item) => item.input);
    exportInputs.current = inputs;
    deadFrameBusy = true;
    cancellingRef.current = false;
    setExporting(true);
    setCancelling(false);
    setError(null);
    setResult(null);
    setProgress({ type: "progress", stage: "measure", percent: -1, message: "Starting the export queue" });
    setQueue((items) => items.map((item) =>
      inputs.includes(item.input) ? { ...item, status: "ready", message: undefined } : item));
    try {
      const raw = await invoke<string>("deadframe_export", {
        inputs,
        sensitivity,
        suffix,
        outputFormat,
        rateMode,
        quality,
        bitrateMbps,
        keepAudio,
        fps: exportFps === "source" ? null : exportFps,
        gpu: useGpu,
      });
      const done = parseBridgePayload<DeadFrameDone>(raw);
      setResult(done);
      setQueue((items) => items.map((item) => {
        const outcome = done.outcomes.find((candidate) =>
          candidate.input.toLocaleLowerCase() === item.input.toLocaleLowerCase()
        );
        if (!outcome) return item;
        return {
          ...item,
          output: outcome.output || item.output,
          status: outcome.ok ? "done" : "failed",
          message: outcome.error,
        };
      }));
    } catch (cause) {
      // Same as the preview: the killed child's failure is not news.
      if (!cancellingRef.current) setError(readBridgeError(cause));
    } finally {
      deadFrameBusy = false;
      setExporting(false);
      setCancelling(false);
      setProgress(null);
    }
  }

  async function cancelRun() {
    if (!busy || cancelling) return;
    cancellingRef.current = true;
    setCancelling(true);
    setProgress((current) => ({
      ...(current || { type: "progress" }),
      stage: "cancelling",
      percent: -1,
      message: "Stopping the current clip and keeping finished files",
    }));
    try {
      await invoke("cancel_deadframe");
    } finally {
      deadFrameBusy = false;
      setPreviewing(false);
      setExporting(false);
      setCancelling(false);
      setProgress(null);
      setError("Cancelled. Files that had already finished were kept.");
      setQueue((items) => items.map((item) =>
        item.status === "running" ? { ...item, status: "ready" } : item));
    }
  }

  const selectedItem = queue.find((item) => item.input === selectedInput) || null;
  // The ribbon and the two numbers under it both come off this array, so they
  // are the same measurement rendered twice rather than two calculations.
  const selectedFlags = selectedItem?.scores
    ? keptFrameFlags(selectedItem.scores, sensitivity)
    : null;
  const selectedKept = selectedFlags ? selectedFlags.filter(Boolean).length : 0;
  const selectedRemoved = selectedFlags ? selectedFlags.length - selectedKept : 0;
  // A clip whose measurement failed is skipped by the export; it has no scores,
  // so there is nothing to remove from it.
  const exportable = queue.filter((item) => Array.isArray(item.scores));
  const previewMatches = Boolean(
    preview && preview.input === selectedInput && preview.sensitivity === sensitivity,
  );
  const gateOpen = previewMatches && exportable.length > 0 && !busy;
  const gateMessage = !preview || preview.input !== selectedInput
    ? "no preview yet"
    : preview.sensitivity !== sensitivity
      ? "dial moved - preview again"
      : `preview matches the dial - ready to export ${exportable.length} clip${exportable.length === 1 ? "" : "s"}`;

  const useGpu = Boolean(status?.hardware.hasCuda);
  const supportsRateControl = OUTPUT_FORMATS.find((entry) => entry.key === outputFormat)?.rateControl ?? true;
  // The one-line hint each format used to print on screen moves inside the
  // menu, where it is read once while choosing instead of sitting there.
  const formatOptions: DropdownOption<DeadFrameOutputFormat>[] = OUTPUT_FORMATS.map((entry) => ({
    value: entry.key,
    label: entry.label,
    description: entry.hint,
  }));
  const outputSpec: VideoControlSpec = rateMode === "quality"
    ? {
      label: "Constant quality",
      valueLabel: useGpu ? "CQ" : "CRF",
      help: "Lower values preserve more detail and create larger files.",
      min: 14,
      max: 28,
      step: 1,
      defaultValue: 18,
      suffix: "",
    }
    : {
      label: rateMode === "cbr" ? "Constant bitrate" : "Target bitrate",
      valueLabel: "Mbps",
      help: rateMode === "cbr"
        ? "The encoder holds this bitrate throughout the clip."
        : "The encoder averages around this bitrate.",
      min: 1,
      max: 200,
      step: 1,
      defaultValue: 20,
      suffix: "",
    };

  const percent = progress?.percent ?? -1;
  const indeterminate = percent < 0;

  return (
    <section
      ref={dropZone.ref}
      className={`conversion-panel deadframe-panel drop-zone${dropZone.hover ? " is-drop-target" : ""}`}
    >
      <div className="drop-zone-overlay">
        <Upload size={32} strokeWidth={1.8} />
        <span>Drop clips or a folder to de-duplicate</span>
        <small>MP4 · MKV · MOV · WEBM · AVI · M4V</small>
      </div>
      <header className="conversion-hero deadframe-hero">
        <h2>Dead frame remover</h2>
        <div className={`conversion-compat ${useGpu ? "is-ready" : "is-locked"}`}>
          {useGpu ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
          <span>
            {useGpu
              ? `${status?.hardware.device || "NVIDIA GPU"} · hardware encoding`
              : "CPU encoding · detection is CPU-only either way"}
          </span>
        </div>
      </header>

      <div className="deadframe-layout">
        <div className="interpolate-queue-column">
          <section className="interpolate-queue-pane" aria-label="Dead frame queue">
            <div className="interpolate-queue-toolbar">
              <div>
                <span className="conversion-field-label">Clip queue</span>
                <strong>{queue.length === 0 ? "No clips yet" : `${queue.length} clip${queue.length === 1 ? "" : "s"}`}</strong>
              </div>
              <div className="interpolate-add-actions">
                <button type="button" className="conversion-pick-btn" disabled={busy} onClick={() => void pickFiles()}>
                  <FilePlus2 size={15} /> Add clips
                </button>
                <button type="button" className="conversion-pick-btn" disabled={busy} onClick={() => void pickFolderInputs()}>
                  <FolderOpen size={15} /> Add folder
                </button>
              </div>
            </div>

            {queue.length === 0 ? (
              <button type="button" className="interpolate-empty" onClick={() => void pickFiles()}>
                <Scissors size={24} />
                <strong>Build a de-duplication queue</strong>
                <span>Drop clips or a folder here, or click to browse.</span>
              </button>
            ) : (
              <div className="interpolate-queue-list">
                {queue.map((item, index) => {
                  const kept = item.scores ? keptFrameCount(item.scores, sensitivity) : 0;
                  const collapsed = Boolean(item.scores && item.scores.length > 1 && kept <= 1);
                  return (
                    <div
                      className={`interpolate-queue-item deadframe-queue-item is-${item.status}${item.input === selectedInput ? " is-selected" : ""}`}
                      key={item.input}
                    >
                      <span className="interpolate-queue-index">{String(index + 1).padStart(2, "0")}</span>
                      <button
                        type="button"
                        className="interpolate-queue-copy deadframe-queue-select"
                        aria-pressed={item.input === selectedInput}
                        onClick={() => selectClip(item.input)}
                      >
                        <strong title={item.input}>{fileName(item.input)}</strong>
                        <span title={item.message}>
                          {item.message
                            || (item.scores ? `${item.scores.length} → ${kept}` : "Measuring…")}
                        </span>
                      </button>
                      <span className="interpolate-queue-state">
                        {item.status === "running" || item.status === "measuring"
                          ? <Loader2 size={14} className="audio-spin" />
                          : item.status === "done" ? <Check size={14} />
                            : item.status === "failed" ? <XCircle size={14} />
                              : collapsed ? <AlertTriangle size={14} aria-label={`${fileName(item.input)} collapses to a single frame`} />
                                : "Ready"}
                      </span>
                      <button
                        type="button"
                        className="interpolate-remove"
                        aria-label={`Remove ${fileName(item.input)}`}
                        disabled={busy}
                        onClick={() => removeClip(item.input)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        <div className="deadframe-main">
          <div className="deadframe-players">
            <figure className="deadframe-player">
              <figcaption>
                <strong>Source</strong>
                <span>{selectedItem ? fileName(selectedItem.input) : "Nothing selected"}</span>
              </figcaption>
              <DeadFrameVideo
                path={selectedItem?.input || null}
                label="the source clip"
                emptyMessage="Add a clip to see it here."
              />
            </figure>
            <figure className="deadframe-player">
              <figcaption>
                <strong>Duplicates removed</strong>
                <span>
                  {preview
                    ? `${preview.keptFrames} of ${preview.sourceFrames} frames kept`
                    : "Nothing rendered yet"}
                </span>
              </figcaption>
              <DeadFrameVideo
                path={preview?.output || null}
                label="the de-duplicated clip"
                emptyMessage="Press Preview to render the selected clip."
              />
            </figure>
          </div>

          <section className="deadframe-dial" aria-label="Detection">
            <div className="deadframe-dial-head">
              <span className="conversion-field-label">Sensitivity</span>
              <strong>{sensitivity}</strong>
            </div>
            <input
              className="video-output-slider"
              type="range"
              min={0}
              max={100}
              step={1}
              value={sensitivity}
              disabled={busy}
              aria-label="Sensitivity"
              style={{ "--fill": `${sensitivity}%` } as React.CSSProperties}
              onChange={(event) => updateSensitivity(Number(event.currentTarget.value))}
            />
            <FrameRibbon
              flags={selectedFlags}
              action={(
                <button
                  type="button"
                  className="conversion-pick-btn deadframe-preview-btn"
                  disabled={!selectedItem?.scores || busy}
                  onClick={() => void runPreview()}
                >
                  <Play size={14} />
                  Preview
                </button>
              )}
            />
            {selectedFlags && selectedRemoved === 0 && (
              <p className="deadframe-dial-note">Nothing is being removed at this setting.</p>
            )}
          </section>

          <section className="interpolate-encoding deadframe-encoding" aria-label="Output encoding">
            <div className="deadframe-encoding-row">
              <Dropdown<DeadFrameOutputFormat>
                className="deadframe-format-dropdown"
                options={formatOptions}
                value={outputFormat}
                disabled={busy}
                onChange={setOutputFormat}
              />
              {supportsRateControl ? (
                <>
                  <div className="conversion-segment interpolate-rate-mode">
                    {(["quality", "vbr", "cbr"] as DeadFrameRateMode[]).map((value) => (
                      <button
                        type="button"
                        className={rateMode === value ? "is-active" : ""}
                        disabled={busy}
                        onClick={() => setRateMode(value)}
                        key={value}
                      >
                        {value === "quality" ? "Quality" : value.toUpperCase()}
                      </button>
                    ))}
                  </div>
                  <VideoOutputControl
                    spec={outputSpec}
                    value={rateMode === "quality" ? quality : bitrateMbps}
                    disabled={busy}
                    onChange={rateMode === "quality" ? setQuality : setBitrateMbps}
                  />
                </>
              ) : (
                <p className="interpolate-encoding-note">
                  ProRes is near-lossless — nothing to tune.
                </p>
              )}
            </div>
            <div className="deadframe-encoding-row is-files">
              <div className="deadframe-field">
                <span
                  className="conversion-field-label"
                  title="The rate the surviving frames play at. No new frames are created, so a rate above the source plays the clip faster and shorter, and a rate below it slower and longer. For smoothing, use Frame Interpolation instead."
                >
                  Frame rate
                </span>
                <Dropdown<DeadFrameExportFps>
                  className="deadframe-fps-dropdown"
                  options={EXPORT_FPS_OPTIONS}
                  value={exportFps}
                  disabled={busy}
                  onChange={setExportFps}
                />
              </div>
              <div className="deadframe-field">
                <span
                  className="conversion-field-label"
                  title="Every file lands beside its own source. Audio kept from a shorter video no longer lines up with the picture, which is why dropping it is the default."
                >
                  Audio
                </span>
                <div className="conversion-segment">
                  <button type="button" className={keepAudio ? "" : "is-active"} disabled={busy} onClick={() => setKeepAudio(false)}>
                    Drop
                  </button>
                  <button type="button" className={keepAudio ? "is-active" : ""} disabled={busy} onClick={() => setKeepAudio(true)}>
                    Keep
                  </button>
                </div>
              </div>
              <div className="deadframe-field">
                <span className="conversion-field-label">Suffix</span>
                <input
                  className="deadframe-suffix"
                  type="text"
                  value={suffix}
                  disabled={busy}
                  aria-label="File suffix"
                  onChange={(event) => setSuffix(event.currentTarget.value)}
                />
              </div>
            </div>
          </section>

          {error && <div className="interpolate-result is-error">{error}</div>}
          {result && !busy && (
            <div className={`interpolate-result ${result.failed ? "is-warning" : "is-success"}`}>
              {result.succeeded} finished{result.failed ? ` · ${result.failed} failed` : ""} ·{" "}
              {result.removedFrames.toLocaleString()} frames removed.
            </div>
          )}

          {busy && (
            <div className="deadframe-progress" aria-live="polite">
              <div className="deadframe-progress-heading">
                <Loader2 size={15} className="audio-spin" />
                <div>
                  <strong>{progress?.clipName || (exporting ? "Exporting the queue" : "Rendering the preview")}</strong>
                  <span>{progress?.message || "Starting"}</span>
                </div>
                <strong>{indeterminate ? "—" : `${Math.round(percent)}%`}</strong>
              </div>
              <div className={`audio-progress-track ${indeterminate ? "is-indeterminate" : ""}`}>
                <div
                  className="audio-progress-fill"
                  style={indeterminate ? undefined : { width: `${Math.max(0, Math.min(100, percent))}%` }}
                />
              </div>
              <button
                type="button"
                className="conversion-run-btn is-cancel"
                disabled={cancelling}
                onClick={() => void cancelRun()}
              >
                <X size={15} />
                {cancelling ? "Stopping…" : "Cancel"}
              </button>
            </div>
          )}

          <div className="deadframe-bottom-bar">
            <span className={`deadframe-gate ${gateOpen ? "is-open" : "is-locked"}`} role="status">
              {gateMessage}
            </span>
            <div className="deadframe-actions">
              <button
                type="button"
                className="conversion-run-btn deadframe-export"
                disabled={!gateOpen}
                onClick={() => void runExport()}
              >
                <Scissors size={16} />
                Export queue
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
