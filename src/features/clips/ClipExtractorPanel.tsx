import React from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { ArrowRight, CheckCircle2, Clapperboard, Film, Info, Loader2, Scissors, Upload, X } from "lucide-react";
import { Virtuoso } from "react-virtuoso";
import {
  CLIP_AUDIO_SETTINGS_KEY,
  CLIP_COLUMN_OPTIONS,
  CLIP_PREVIEW_BATCH_SIZE,
  CLIP_PREVIEW_CPU_BATCH_CONCURRENCY,
  CLIP_PREVIEW_GPU_BATCH_CONCURRENCY,
  MAX_GRID_AUTOPLAYERS,
} from "../../lib/constants";
import { logFrontend, safeLogValue } from "../../lib/log";
import { fileName, fileStem, normalizeSelectedPaths } from "../../lib/paths";
import { extensionAccept, useFileDrop } from "../../lib/useFileDrop";
import { parseBridgePayload, readBridgeError } from "../../utils/bridge";

const CLIP_INPUT_EXTENSIONS = ["mp4", "mkv", "mov", "webm", "avi"];
const clipInputAccept = extensionAccept(CLIP_INPUT_EXTENSIONS);
import type { AppConfig } from "../../types/app";
import type {
  ClipAudioSettings,
  ClipBatchProgressContext,
  ClipExportFormat,
  ClipExtractionResult,
  ClipPreviewBatchResult,
  ClipPreviewItem,
  ClipPreviewState,
  ClipProgress,
  ClipScene,
} from "../../types/clip";
import type { ConversionDone, VideoGpuStatus } from "../../types/conversion";
import { ClipPreviewScroller } from "./ClipPreviewScroller";
import { ClipPreviewTile } from "./ClipPreviewTile";

// Currently dead code — see FINDINGS.md. Moved here unchanged during the
// main.tsx split to keep that work move-only.
void readClipAudioSettings;
void writeClipAudioSettings;
void formatPreciseClipTime;

export function ClipExtractorPanel({ active }: { active: boolean }) {
  const [selectedVideos, setSelectedVideos] = React.useState<string[]>([]);
  const [clipMode, setClipMode] = React.useState<"cpu" | "gpu">("gpu");
  const [gridPreview, setGridPreview] = React.useState(true);
  const [gridCols, setGridCols] = React.useState(4);
  const [mergeMode, setMergeMode] = React.useState(false);
  const [mergeOrder, setMergeOrder] = React.useState<string[]>([]);
  const [selectedClipIds, setSelectedClipIds] = React.useState<Set<string>>(() => new Set());
  const [exportFormat, setExportFormat] = React.useState<ClipExportFormat>("prores-lt");
  const [visibleRowRange, setVisibleRowRange] = React.useState<{ startIndex: number; endIndex: number } | null>(null);
  const [progress, setProgress] = React.useState<ClipProgress | null>(null);
  const [result, setResult] = React.useState<ClipExtractionResult | null>(null);
  const [previewStates, setPreviewStates] = React.useState<Record<string, ClipPreviewState>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [isExtracting, setIsExtracting] = React.useState(false);
  const [serverStatus, setServerStatus] = React.useState<"cold" | "warming" | "ready">("cold");
  const [gpuStatus, setGpuStatus] = React.useState<VideoGpuStatus | null>(null);
  const [clipModeLoaded, setClipModeLoaded] = React.useState(false);
  const previewStatesRef = React.useRef(previewStates);
  const previewInFlightRef = React.useRef<Set<string>>(new Set());
  const previewBatchInFlightRef = React.useRef(0);
  const previewTokenRef = React.useRef(0);
  const clipBatchProgressRef = React.useRef<ClipBatchProgressContext | null>(null);

  React.useEffect(() => {
    void refreshClipMode();
    void refreshGpuStatus();
  }, []);

  async function refreshGpuStatus() {
    try {
      const raw = await invoke<string>("video_gpu_status");
      setGpuStatus(parseBridgePayload<VideoGpuStatus>(raw));
    } catch (e) {
      console.error("Could not load GPU status:", e);
      logFrontend("error", "frontend.clip.gpu_status.error", "Could not load GPU status", {
        error: safeLogValue(e),
      });
    }
  }

  React.useEffect(() => {
    const handler = (e: Event) => {
      setClipMode((e as CustomEvent<{ mode: "cpu" | "gpu" }>).detail.mode);
    };
    window.addEventListener("clipmode-changed", handler);
    return () => window.removeEventListener("clipmode-changed", handler);
  }, []);

  async function refreshClipMode() {
    try {
      const raw = await invoke<string>("get_config");
      const payload = parseBridgePayload<AppConfig>(raw);
      setClipMode(payload.clip_extraction_mode ?? "gpu");
      setClipModeLoaded(true);
    } catch (configError) {
      console.error("Could not load clip extraction mode:", configError);
      setClipModeLoaded(true);
      logFrontend("error", "frontend.clip.config.error", "Could not load clip extraction mode", {
        error: safeLogValue(configError),
      });
    }
  }

  React.useEffect(() => {
    if (!active || !clipModeLoaded || clipMode === "cpu" || serverStatus === "ready") return;
    setServerStatus("warming");
    void invoke("warmup_clip_server").catch((warmupError) => {
      setServerStatus("cold");
      logFrontend("warn", "frontend.clip.server_warmup.warning", "Clip server warmup failed", {
        error: safeLogValue(warmupError),
      });
    });
  }, [active, clipMode, clipModeLoaded, serverStatus]);

  React.useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void listen<ClipProgress>("clip-progress", (event) => {
      if (!cancelled) {
        setProgress(mapClipBatchProgress(event.payload, clipBatchProgressRef.current));
      }
    }).then((cleanup) => {
      if (cancelled) {
        cleanup();
      } else {
        unlisten = cleanup;
      }
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void listen<any>("clip-server-event", (event) => {
      if (cancelled) return;
      const payload = event.payload;
      if (payload.type === "ready") {
        setServerStatus("ready");
      } else if (payload.type === "stopped") {
        setServerStatus("cold");
      } else if (payload.type === "log" && payload.message.includes("warming up")) {
        setServerStatus("warming");
      }
    }).then((cleanup) => {
      if (cancelled) {
        cleanup();
      } else {
        unlisten = cleanup;
      }
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  React.useEffect(() => {
    previewStatesRef.current = previewStates;
  }, [previewStates]);

  React.useEffect(() => {
    previewTokenRef.current += 1;
    previewInFlightRef.current.clear();
    previewBatchInFlightRef.current = 0;
    setPreviewStates({});
  }, [result?.input]);

  function acceptVideos(paths: string[]) {
    if (paths.length === 0) return;
    setSelectedVideos(paths);
    setSelectedClipIds(new Set());
    setMergeOrder([]);
    setResult(null);
    setPreviewStates({});
    setProgress(null);
    setError(null);
    setMergeMode(false);

    // Video picked, high intent to extract - warm up the server
    if (clipMode !== "cpu") {
      void invoke("warmup_clip_server").catch(() => {});
    }
  }

  async function pickVideo() {
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [
        {
          name: "Video",
          extensions: CLIP_INPUT_EXTENSIONS,
        },
      ],
    });
    acceptVideos(normalizeSelectedPaths(selected));
  }

  const dropZone = useFileDrop({
    accept: clipInputAccept,
    enabled: !isExtracting,
    onDrop: acceptVideos,
  });

  const selectedVideo = selectedVideos[0] ?? null;
  const displayName = selectedVideos.length > 1
    ? `${selectedVideos.length} episodes selected`
    : selectedVideo ? fileName(selectedVideo) : "No episode selected";
  const clips = React.useMemo<ClipPreviewItem[]>(() => {
    if (!result) return [];

    return result.scenes.map((scene) => {
      const sourceStart = Math.max(0, scene.start);
      const sourceEnd = Math.max(sourceStart + 0.2, scene.end);
      const previewRange = previewClipRange(sourceStart, sourceEnd, result.fps, scene.index);
      const sourceName = fileStem(scene.source);
      const id = `${sourceName}-${scene.index}-${scene.start.toFixed(3)}`;
      return {
        id,
        index: scene.index,
        label: scene.label,
        range: `${formatClipTime(sourceStart)} - ${formatClipTime(sourceEnd)}`,
        sourceName,
        sourceSrc: convertFileSrc(scene.source),
        sourceStart,
        sourceEnd,
        previewStart: previewRange.start,
        previewEnd: previewRange.end,
        previewState: previewStates[id],
        fps: result.fps,
        path: scene.source,
      };
    });
  }, [result, previewStates]);

  const hasClips = clips.length > 0;
  const selectedCount = selectedClipIds.size;
  const canExtract = selectedVideos.length > 0 && !isExtracting;
  const clipCancellingRef = React.useRef(false);
  const readyPreviewCount = React.useMemo(
    () => clips.reduce((count, clip) => count + (clip.previewState?.status === "ready" ? 1 : 0), 0),
    [clips],
  );
  const exportOptions = React.useMemo(
    () => clipExportOptions(clipMode, gpuStatus),
    [clipMode, gpuStatus],
  );
  const selectedExportOption = exportOptions.find((option) => option.value === exportFormat);

  React.useEffect(() => {
    const current = clipExportOptions(clipMode, gpuStatus);
    const active = current.find((option) => option.value === exportFormat);
    if (!active || active.disabled) {
      setExportFormat(current.find((option) => !option.disabled)?.value ?? "prores-lt");
    }
  }, [clipMode, exportFormat, gpuStatus]);

  const clipRows = React.useMemo<ClipPreviewItem[][]>(() => {
    if (!hasClips) return [];
    const rows: ClipPreviewItem[][] = [];
    for (let i = 0; i < clips.length; i += gridCols) {
      rows.push(clips.slice(i, i + gridCols));
    }
    return rows;
  }, [clips, gridCols, hasClips]);

  const activeGridClipIds = React.useMemo(() => {
    const active = new Set<string>();
    if (!gridPreview) return active;
    if (clipRows.length <= 0) return active;

    const autoplayLimit = MAX_GRID_AUTOPLAYERS;
    const startRow = Math.max(0, Math.min(visibleRowRange?.startIndex ?? 0, clipRows.length - 1));
    const minimumEndRow = startRow + Math.ceil(autoplayLimit / gridCols) - 1;
    const endRow = Math.min(
      clipRows.length - 1,
      Math.max(visibleRowRange?.endIndex ?? minimumEndRow, minimumEndRow),
    );

    for (let rowIndex = startRow; rowIndex <= endRow; rowIndex += 1) {
      for (const clip of clipRows[rowIndex] ?? []) {
        active.add(clip.id);
        if (active.size >= autoplayLimit) break;
      }
      if (active.size >= autoplayLimit) break;
    }
    return active;
  }, [clipRows, gridCols, gridPreview, visibleRowRange]);

  React.useEffect(() => {
    setVisibleRowRange(null);
  }, [result, gridCols]);

  function startPreviewRenderBatch(batch: ClipPreviewItem[], token: number) {
    const renderable = batch.filter((clip) => clip.path);
    if (renderable.length === 0) return;
    previewBatchInFlightRef.current += 1;
    for (const clip of renderable) {
      previewInFlightRef.current.add(clip.id);
    }
    setPreviewStates((current) => {
      let next = current;
      for (const clip of renderable) {
        const existing = next[clip.id];
        if (existing?.status === "ready" || existing?.status === "rendering") continue;
        next = { ...next, [clip.id]: { status: "rendering" } };
      }
      return next;
    });

    void invoke<string>("clip_preview_generate_batch", {
      jobs: renderable.map((clip) => ({
        sceneId: clip.id,
        sourcePath: clip.path,
        start: clip.previewStart,
        end: clip.previewEnd,
        fps: clip.fps,
      })),
    })
      .then((raw) => {
        if (token !== previewTokenRef.current) return;
        const payload = parseBridgePayload<ClipPreviewBatchResult>(raw);
        const byId = new Map(payload.items.map((item) => [item.sceneId, item]));
        setPreviewStates((current) => {
          let next = current;
          for (const clip of renderable) {
            const item = byId.get(clip.id);
            if (!item) {
              next = {
                ...next,
                [clip.id]: { status: "error", error: "Preview renderer did not return this clip." },
              };
              continue;
            }
            if (item.error || !item.path) {
              next = {
                ...next,
                [clip.id]: { status: "error", error: item.error || "Preview renderer did not create a cache file." },
              };
              continue;
            }
            const duration = Math.max(0.08, Number(item.duration) || clip.previewEnd - clip.previewStart);
            next = {
              ...next,
              [clip.id]: {
                status: "ready",
                path: item.path,
                src: convertFileSrc(item.path),
                duration,
              },
            };
          }
          return next;
        });
      })
      .catch((previewError) => {
        if (token !== previewTokenRef.current) return;
        const error = readBridgeError(previewError);
        setPreviewStates((current) => {
          let next = current;
          for (const clip of renderable) {
            next = { ...next, [clip.id]: { status: "error", error } };
          }
          return next;
        });
      })
      .finally(() => {
        previewBatchInFlightRef.current = Math.max(0, previewBatchInFlightRef.current - 1);
        for (const clip of renderable) {
          previewInFlightRef.current.delete(clip.id);
        }
      });
  }

  React.useEffect(() => {
    if (!hasClips || !gridPreview) return;

    const token = previewTokenRef.current;
    const ordered = [...clips].sort((left, right) => {
      const leftVisible = activeGridClipIds.has(left.id) ? 0 : 1;
      const rightVisible = activeGridClipIds.has(right.id) ? 0 : 1;
      if (leftVisible !== rightVisible) return leftVisible - rightVisible;
      return left.index - right.index;
    });

    const batchConcurrency = clipMode === "gpu"
      ? CLIP_PREVIEW_GPU_BATCH_CONCURRENCY
      : CLIP_PREVIEW_CPU_BATCH_CONCURRENCY;
    let availableBatches = batchConcurrency - previewBatchInFlightRef.current;
    let nextBatch: ClipPreviewItem[] = [];

    for (const clip of ordered) {
      if (availableBatches <= 0) break;
      if (previewInFlightRef.current.has(clip.id)) continue;
      const status = previewStatesRef.current[clip.id]?.status;
      if (status === "ready" || status === "rendering" || status === "error") continue;
      nextBatch.push(clip);
      if (nextBatch.length >= CLIP_PREVIEW_BATCH_SIZE) {
        startPreviewRenderBatch(nextBatch, token);
        nextBatch = [];
        availableBatches -= 1;
      }
    }

    if (availableBatches > 0 && nextBatch.length > 0) {
      startPreviewRenderBatch(nextBatch, token);
    }
  }, [activeGridClipIds, clipMode, clips, gridPreview, hasClips, previewStates]);

  async function startExtraction() {
    if (selectedVideos.length === 0 || isExtracting) return;
    setIsExtracting(true);
    setResult(null);
    setPreviewStates({});
    previewTokenRef.current += 1;
    previewInFlightRef.current.clear();
    previewBatchInFlightRef.current = 0;
    setError(null);
    setSelectedClipIds(new Set());
    setMergeOrder([]);
    setMergeMode(false);
    setProgress({
      type: "progress",
      stage: "starting",
      percent: 0,
      message: selectedVideos.length > 1
        ? `Starting ${selectedVideos.length} episode batch...`
        : clipMode === "gpu" ? "Starting RTX TransNetV2 extraction..." : "Starting PySceneDetect CPU extraction...",
    });

    try {
      if (clipMode === "gpu") {
        setServerStatus("warming");
        setProgress({
          type: "progress",
          stage: "dependencies",
          percent: 0,
          message: "Warming RTX clip server for batch extraction...",
        });
        await invoke("warmup_clip_server").catch((warmupError) => {
          setServerStatus("cold");
          logFrontend("warn", "frontend.clip.server_warmup.warning", "Clip server warmup failed; falling back to one-shot extraction", {
            error: safeLogValue(warmupError),
          });
        });
      }

      const results: ClipExtractionResult[] = [];
      for (let index = 0; index < selectedVideos.length; index += 1) {
        if (clipCancellingRef.current) break;
        const inputPath = selectedVideos[index];
        clipBatchProgressRef.current = {
          activeIndex: index,
          total: selectedVideos.length,
          inputPath,
        };
        setProgress({
          type: "progress",
          stage: "starting",
          percent: Math.round((index / selectedVideos.length) * 100),
          message: `Episode ${index + 1}/${selectedVideos.length}: ${fileName(inputPath)}`,
        });
        const raw = await invoke<string>("clip_extract", { inputPath, mode: clipMode });
        const payload = raw.includes("server_task_started")
          ? await waitForClipServerResult()
          : parseBridgePayload<ClipExtractionResult>(raw);
        results.push(payload);
        setResult(combineClipResults(results, clipMode));
        setProgress({
          type: "progress",
          stage: "complete",
          percent: Math.round(((index + 1) / selectedVideos.length) * 100),
          message: `Episode ${index + 1}/${selectedVideos.length} complete: ${fileName(inputPath)}`,
          elapsedSeconds: results.reduce((total, item) => total + (item.totalSeconds || 0), 0),
        });
      }

      if (results.length === 0) return;
      const payload = combineClipResults(results, clipMode);
      setResult(payload);
      setProgress({
        type: "progress",
        stage: "complete",
        percent: 100,
        message: `Detected ${payload.sceneCount} scenes in ${formatDuration(payload.totalSeconds)} with ${clipMode.toUpperCase()}`,
        elapsedSeconds: payload.totalSeconds,
      });
    } catch (clipError) {
      if (!clipCancellingRef.current) {
        setError(readBridgeError(clipError));
      }
    } finally {
      clipBatchProgressRef.current = null;
      clipCancellingRef.current = false;
      setIsExtracting(false);
    }
  }

  function toggleClipSelection(clipId: string) {
    setSelectedClipIds((current) => {
      const next = new Set(current);
      if (next.has(clipId)) {
        next.delete(clipId);
      } else {
        next.add(clipId);
      }
      return next;
    });
  }

  function toggleAllClipSelection() {
    if (!hasClips) return;
    setSelectedClipIds((current) => {
      if (current.size === clips.length) {
        return new Set();
      }
      return new Set(clips.map((clip) => clip.id));
    });
  }

  function handleClipClick(clip: ClipPreviewItem) {
    if (mergeMode) {
      toggleMergeOrder(clip.id);
    } else {
      toggleClipSelection(clip.id);
    }
  }

  function toggleMergeOrder(clipId: string) {
    setMergeOrder((prev) => {
      if (prev.includes(clipId)) return prev.filter((id) => id !== clipId);
      return [...prev, clipId];
    });
  }

  function toggleMergeMode() {
    setMergeMode((value) => {
      if (value) {
        setMergeOrder([]);
      } else {
        setSelectedClipIds(new Set());
      }
      return !value;
    });
  }

  const mergePositions = React.useMemo(() => {
    const map = new Map<string, number>();
    mergeOrder.forEach((id, index) => map.set(id, index + 1));
    return map;
  }, [mergeOrder]);

  const mergeOrderedClips = React.useMemo(
    () =>
      mergeOrder
        .map((id) => clips.find((clip) => clip.id === id))
        .filter((clip): clip is ClipPreviewItem => Boolean(clip)),
    [mergeOrder, clips],
  );

  const mergeFilenameStem = React.useMemo(
    () => mergeOrderedClips.map((clip) => clip.index + 1).join("+"),
    [mergeOrderedClips],
  );

  async function startMergeExport() {
    if (mergeOrderedClips.length < 2 || isExtracting) return;
    if (selectedExportOption?.disabled) {
      setError(selectedExportOption.reason ?? "This export format is not available on the current hardware/mode.");
      return;
    }

    const selected = await open({
      multiple: false,
      directory: true,
      title: "Select output folder for merged clip",
    });
    if (!selected || Array.isArray(selected)) return;

    const exportClips = mergeOrderedClips.map((clip) => ({
      source: clip.path,
      start: clip.sourceStart,
      end: clip.sourceEnd,
      index: clip.index,
      fps: clip.fps,
    }));

    setIsExtracting(true);
    setError(null);
    setProgress({
      type: "progress",
      stage: "starting",
      percent: 0,
      message: `Merging ${exportClips.length} clips into ${mergeFilenameStem}.mov...`,
    });

    try {
      const raw = await invoke<string>("clip_export_merged", {
        clips: exportClips,
        outputDir: selected,
        preset: exportFormat,
      });
      const payload = parseBridgePayload<ConversionDone>(raw);
      setProgress({
        type: "progress",
        stage: "complete",
        percent: 100,
        message: `Merged clip saved to ${payload.output}`,
      });
      setMergeOrder([]);
      setMergeMode(false);
    } catch (e) {
      setError(readBridgeError(e));
      setProgress(null);
    } finally {
      setIsExtracting(false);
    }
  }

  async function startExport() {
    if (selectedClipIds.size === 0 || isExtracting) return;
    if (selectedExportOption?.disabled) {
      setError(selectedExportOption.reason ?? "This export format is not available on the current hardware/mode.");
      return;
    }

    const selected = await open({
      multiple: false,
      directory: true,
      title: "Select output folder for exported clips",
    });

    if (!selected || Array.isArray(selected)) return;

    const outDir = selected;
    const exportClips = clips
      .filter((clip) => selectedClipIds.has(clip.id))
      .map((clip, index) => ({
        source: clip.path,
        start: clip.sourceStart,
        end: clip.sourceEnd,
        index: index,
        fps: clip.fps,
      }));

    setIsExtracting(true);
    setProgress({
      type: "progress",
      stage: "starting",
      percent: 0,
      message: `Preparing to export ${exportClips.length} clips...`,
    });
    setError(null);

    try {
      const raw = await invoke<string>("clip_export", {
        clips: exportClips,
        outputDir: outDir,
        preset: exportFormat,
      });
      const payload = parseBridgePayload<ConversionDone>(raw);
      setProgress({
        type: "progress",
        stage: "complete",
        percent: 100,
        message: `Exported ${exportClips.length} clips to ${payload.output}`,
      });
      setSelectedClipIds(new Set());
    } catch (e) {
      setError(readBridgeError(e));
      setProgress(null);
    } finally {
      setIsExtracting(false);
    }
  }

  const runMessage = error
    ?? (result
      ? `${result.sceneCount} scenes ready - ${readyPreviewCount}/${clips.length} previews cached`
      : progress?.message ?? "");

  return (
    <section
      ref={dropZone.ref}
      className={`clip-extractor drop-zone${dropZone.hover ? " is-drop-target" : ""}`}
    >
      <div className="drop-zone-overlay">
        <Upload size={32} strokeWidth={1.8} />
        <span>Drop video(s) to scan for clips</span>
        <small>MP4 · MKV · MOV · WEBM · AVI — multiple files accepted</small>
      </div>
      <div className="clip-extractor-rail">
        <button type="button" className="clip-import-button" onClick={pickVideo}>
          <span className="clip-import-mark">
            <Scissors size={32} strokeWidth={1.9} />
          </span>
          <span>{selectedVideos.length > 0 ? "Change episodes" : "Select episodes"}</span>
        </button>

        <div className="clip-source-card">
          <div className="clip-source-header">
            <div className="clip-source-info">
              <small>Source</small>
              <strong>{displayName}</strong>
            </div>
          <div
            className={`clip-server-badge ${serverStatus === "ready" ? "is-ready" : serverStatus === "warming" ? "is-warming" : ""}`}
            title={serverStatus === "ready" ? "Clip Server is warm and ready" : serverStatus === "warming" ? "Clip Server is warming up..." : "Clip Server is cold"}
          >
            {serverStatus === "ready" ? "Ready" : serverStatus === "warming" ? "Warming" : "Cold"}
          </div>
          </div>
          {selectedVideos.length > 0 && (
            <span>{selectedVideos.length === 1 ? selectedVideos[0] : selectedVideos.map(fileName).join(" / ")}</span>
          )}
          <em>{clipMode === "gpu" ? "GPU mode · RTX TransNetV2" : "CPU mode · PySceneDetect"}</em>
        </div>

        <div className="clip-tool-stack" aria-label="Clip extractor actions">
          <button
            type="button"
            className={`clip-tool-button ${gridPreview ? "is-active" : ""}`}
            onClick={() => setGridPreview((value) => !value)}
          >
            <Film size={18} strokeWidth={2} />
            <span>Grid preview</span>
          </button>

          <div className="clip-cols-control">
            <div className="clip-cols-label">
              <span>Columns</span>
              <strong>{gridCols}</strong>
            </div>
            <input
              type="range"
              className="clip-cols-slider"
              min={1}
              max={4}
              step={1}
              value={gridCols}
              onChange={(e) => setGridCols(Math.min(4, Math.max(1, Number(e.currentTarget.value))))}
              aria-label="Grid column count"
            />
            <div className="clip-cols-ticks">
              {CLIP_COLUMN_OPTIONS.map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`clip-cols-tick ${gridCols === n ? "is-active" : ""}`}
                  onClick={() => setGridCols(n)}
                  aria-label={`${n} column${n === 1 ? "" : "s"}`}
                >{n}</button>
              ))}
            </div>
          </div>

          <div className="clip-cols-control">
            <div className="clip-cols-label">
              <span>Export Format</span>
            </div>
            <select
              value={exportFormat}
              onChange={(e) => setExportFormat(e.target.value as ClipExportFormat)}
              className="clip-export-format-select"
              title={selectedExportOption?.reason ?? selectedExportOption?.label}
            >
              {exportOptions.map((option) => (
                <option key={option.value} value={option.value} disabled={option.disabled}>
                  {option.label}{option.disabled ? " unavailable" : ""}
                </option>
              ))}
            </select>
            {selectedExportOption?.reason && <small className="stream-warning">{selectedExportOption.reason}</small>}
          </div>

          {!mergeMode && (
            <>
              <button
                type="button"
                className={`clip-tool-button ${selectedCount > 0 ? 'is-active-primary' : ''}`}
                disabled={selectedCount === 0 || isExtracting}
                onClick={startExport}
              >
                <ArrowRight size={18} strokeWidth={2} />
                <span>{selectedCount === 0 ? "Select clips to export" : `Export ${selectedCount} clips`}</span>
              </button>

              <button
                type="button"
                className={`clip-tool-button ${hasClips && selectedCount === clips.length ? "is-active" : ""}`}
                disabled={!hasClips || isExtracting}
                onClick={toggleAllClipSelection}
              >
                <CheckCircle2 size={18} strokeWidth={2} />
                <span>{hasClips && selectedCount === clips.length ? "Clear selection" : "Select all clips"}</span>
              </button>
            </>
          )}

          <button
            type="button"
            className={`clip-tool-button ${mergeMode ? "is-active" : ""}`}
            disabled={!hasClips}
            onClick={toggleMergeMode}
          >
            <Scissors size={18} strokeWidth={2} />
            <span>{mergeMode ? "Cancel merge" : "Merge clip"}</span>
          </button>

          {mergeMode && (
            <button
              type="button"
              className="clip-confirm-button"
              disabled={mergeOrder.length < 2 || isExtracting}
              onClick={startMergeExport}
              title={mergeOrder.length < 2 ? "Select at least 2 clips to merge" : `Merge into ${mergeFilenameStem}.mov`}
            >
              <CheckCircle2 size={17} strokeWidth={2.1} />
              <span>
                {mergeOrder.length < 2
                  ? "Select 2+ clips"
                  : `Merge into ${mergeFilenameStem}.mov`}
              </span>
            </button>
          )}
        </div>

        {(progress || error || result) && (
          <div className={`clip-run-card ${error ? "is-error" : ""}`}>
            <div className="clip-run-line">
              <strong>{error ? "Extraction failed" : formatClipProgressStage(progress?.stage)}</strong>
              {progress && <span>{Math.round(progress.percent)}%</span>}
            </div>
            {progress && (
              <div className={`clip-progress-track ${isExtracting && progress.percent <= 0 ? "is-indeterminate" : ""}`}>
                <span style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }} />
              </div>
            )}
            <p>{runMessage}</p>
          </div>
        )}

        <div className="clip-format-note">
          <Info size={14} strokeWidth={2.5} />
          <span>ProRes and Intra frame formats are best for After Effects responsiveness.</span>
        </div>

        <button type="button" className="clip-primary-action" disabled={!canExtract} onClick={startExtraction}>
          {isExtracting ? "Extracting..." : hasClips ? "Extract again" : "Extract clips"}
        </button>
        {isExtracting && (
          <button
            type="button"
            className="clip-cancel-action"
            onClick={() => {
              clipCancellingRef.current = true;
              void invoke("cancel_clip");
            }}
          >
            <X size={14} strokeWidth={2.3} />
            Cancel
          </button>
        )}
      </div>

      <div className="clip-extractor-stage">
        {hasClips ? (
          <Virtuoso
            data={clipRows}
            overscan={1000}
            increaseViewportBy={1000}
            style={{ '--clip-cols': gridCols } as React.CSSProperties}
            components={{ Scroller: ClipPreviewScroller }}
            computeItemKey={(index, row) => `row-${gridCols}-${index}-${row[0]?.id ?? ""}`}
            rangeChanged={setVisibleRowRange}
            itemContent={(_index, row) => (
              <div
                className="clip-preview-grid-row"
                style={{ '--clip-cols': gridCols } as React.CSSProperties}
              >
                {row.map((clip) => (
                  <ClipPreviewTile
                    key={clip.id}
                    clip={clip}
                    mergeMode={mergeMode}
                    mergePosition={mergePositions.get(clip.id) ?? null}
                    paused={!gridPreview}
                    playable={activeGridClipIds.has(clip.id)}
                    selected={mergeMode ? mergePositions.has(clip.id) : selectedClipIds.has(clip.id)}
                    onClick={() => handleClipClick(clip)}
                    onToggleSelect={() =>
                      mergeMode ? toggleMergeOrder(clip.id) : toggleClipSelection(clip.id)
                    }
                  />
                ))}
              </div>
            )}
          />
        ) : !gridPreview ? null : (
          <div
            className="clip-preview-grid is-placeholder-grid"
            aria-label="Clip previews"
            style={
              {
                '--clip-cols': gridCols,
                '--clip-rows': Math.ceil(12 / gridCols),
              } as React.CSSProperties
            }
          >
            {Array.from({ length: 12 }, (_, index) => <div key={index} className="clip-preview-skeleton" />)}
          </div>
        )}

        {!hasClips && !gridPreview && (
          <div className="clip-preview-disabled">
            <Film size={34} strokeWidth={1.7} />
            <h2>Grid preview off</h2>
          </div>
        )}

        {!hasClips && gridPreview && (
          <div className="clip-empty-state">
            {isExtracting ? <Loader2 className="is-spinning" size={36} strokeWidth={1.8} /> : <Clapperboard size={36} strokeWidth={1.7} />}
            <h2>{isExtracting ? "Extracting clips" : "Clip extractor"}</h2>
            <p>{progress?.message ?? error ?? (selectedVideos.length > 0 ? "Ready for RTX TransNetV2." : "No clips yet.")}</p>
          </div>
        )}

        {mergeMode && (
          <div className={`merge-strip ${mergeOrderedClips.length > 0 ? "is-active" : "is-empty"}`} aria-live="polite">
            <div className="merge-strip-header">
              <strong>Merge order</strong>
              <span>
                {mergeOrderedClips.length === 0
                  ? "Click clips in the order they should play"
                  : mergeOrderedClips.length < 2
                    ? "Pick at least 2 clips"
                    : `→ ${mergeFilenameStem}.mov`}
              </span>
              {mergeOrderedClips.length > 0 && (
                <button
                  type="button"
                  className="merge-strip-clear"
                  onClick={() => setMergeOrder([])}
                  title="Clear merge order"
                >
                  Clear
                </button>
              )}
            </div>
            {mergeOrderedClips.length > 0 && (
              <ol className="merge-strip-list">
                {mergeOrderedClips.map((clip, index) => (
                  <li key={clip.id} className="merge-strip-item">
                    <span className="merge-strip-num">{index + 1}</span>
                    <span className="merge-strip-name" title={clip.label}>{clip.label}</span>
                    <button
                      type="button"
                      className="merge-strip-remove"
                      onClick={() => toggleMergeOrder(clip.id)}
                      aria-label={`Remove ${clip.label} from merge`}
                    >
                      <X size={12} strokeWidth={2.4} />
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

async function waitForClipServerResult(): Promise<ClipExtractionResult> {
  return new Promise((resolve, reject) => {
    let unlisten: (() => void) | null = null;
    void listen<any>("clip-server-event", (event) => {
      const payload = event.payload;
      if (payload.type === "done") {
        unlisten?.();
        resolve(payload as ClipExtractionResult);
      } else if (payload.type === "error") {
        unlisten?.();
        reject(new Error(payload.message ?? "Clip extraction failed."));
      }
    }).then((cleanup) => {
      unlisten = cleanup;
    }).catch(reject);
  });
}

function mapClipBatchProgress(progress: ClipProgress, context: ClipBatchProgressContext | null): ClipProgress {
  if (!context || context.total <= 1) return progress;

  const episodeSpan = 100 / context.total;
  const basePercent = context.activeIndex * episodeSpan;
  const episodePercent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
  const aggregatePercent = basePercent + (episodePercent / 100) * episodeSpan;
  return {
    ...progress,
    percent: Math.max(0, Math.min(100, aggregatePercent)),
    message: `Episode ${context.activeIndex + 1}/${context.total} · ${fileName(context.inputPath)} · ${progress.message}`,
  };
}

function formatClipProgressStage(stage?: string): string {
  switch (stage) {
    case "starting":
      return "Starting";
    case "dependencies":
      return "Checking Dependencies";
    case "probe":
      return "Reading Source";
    case "decode":
      return "Decoding";
    case "analyze":
      return "Analyzing";
    case "scenes":
      return "Building Scenes";
    case "complete":
      return "Complete";
    default:
      return stage ? titleCaseStage(stage) : "Ready";
  }
}

function titleCaseStage(stage: string): string {
  return stage
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function combineClipResults(results: ClipExtractionResult[], mode: "cpu" | "gpu"): ClipExtractionResult {
  const scenes: ClipScene[] = [];
  let sceneOffset = 0;
  let totalSeconds = 0;
  let duration = 0;
  let fps = 24;

  for (const result of results) {
    fps = result.fps || fps;
    duration += result.duration || 0;
    totalSeconds += result.totalSeconds || 0;
    for (const scene of result.scenes) {
      scenes.push({
        ...scene,
        index: sceneOffset + scene.index,
        label: `${fileStem(scene.source)} · ${scene.label}`,
      });
    }
    sceneOffset += result.scenes.length;
  }

  return {
    type: "done",
    mode,
    input: results.length === 1 ? results[0].input : `${results.length} files`,
    scenes,
    cuts: results.flatMap((result) => result.cuts ?? []),
    sceneCount: scenes.length,
    fps,
    duration,
    totalSeconds,
  };
}

type ClipExportOption = {
  value: ClipExportFormat;
  label: string;
  disabled: boolean;
  reason?: string;
};

function clipExportOptions(mode: "cpu" | "gpu", gpuStatus: VideoGpuStatus | null): ClipExportOption[] {
  const cpuModeReason = "GPU export presets are hidden in CPU clip mode. Switch clip extraction to GPU mode to use NVENC presets.";
  const gpuIntraReady = Boolean(gpuStatus?.hasHevcNvenc);
  const statusMessage = gpuStatus?.message ?? "Checking GPU export support...";
  const h264NvencReady = Boolean(gpuStatus?.hasH264Nvenc);
  const av1NvencReady = Boolean(gpuStatus?.hasAv1Nvenc);
  const gpuMode = mode === "gpu";

  return [
    {
      value: "prores-lt",
      label: "ProRes LT MOV",
      disabled: false,
    },
    {
      value: "prores-hq",
      label: "ProRes HQ MOV",
      disabled: false,
    },
    {
      value: "h264-cpu",
      label: "H.264 CPU MOV",
      disabled: false,
    },
    {
      value: "hevc-cpu",
      label: "HEVC CPU MOV",
      disabled: false,
    },
    {
      value: "gpu-intra",
      label: "GPU Intra MOV",
      disabled: !gpuMode || !gpuIntraReady,
      reason: !gpuMode ? cpuModeReason : gpuIntraReady ? undefined : statusMessage,
    },
    {
      value: "h264-nvenc",
      label: "H.264 NVENC MOV",
      disabled: !gpuMode || !h264NvencReady,
      reason: !gpuMode ? cpuModeReason : h264NvencReady ? undefined : "Bundled FFmpeg does not expose h264_nvenc on this machine.",
    },
    {
      value: "av1-nvenc",
      label: "AV1 NVENC MOV",
      disabled: !gpuMode || !av1NvencReady,
      reason: !gpuMode ? cpuModeReason : av1NvencReady ? undefined : "Bundled FFmpeg does not expose av1_nvenc on this machine.",
    },
  ];
}

function previewClipRange(start: number, end: number, fps: number, index: number): { start: number; end: number } {
  const duration = Math.max(0, end - start);
  if (duration <= 0.2) return { start, end };

  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 24;
  const startFramePad = Math.min(0.16, Math.max(0.08, 3 / safeFps));
  const endFramePad = Math.min(0.22, Math.max(0.12, 5 / safeFps));
  const maxTotalPad = Math.max(0, duration - 0.2);
  const startPad = index === 0 || start <= 0 ? 0 : Math.min(startFramePad, maxTotalPad / 2);
  const endPad = Math.min(endFramePad, maxTotalPad - startPad);

  return {
    start: start + startPad,
    end: end - endPad,
  };
}



function formatClipTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function formatPreciseClipTime(seconds: number): string {
  const safeSeconds = Math.max(0, seconds);
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = Math.floor(safeSeconds % 60);
  const tenths = Math.floor((safeSeconds % 1) * 10);
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}.${tenths}`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  return formatClipTime(Math.max(0, seconds));
}

function readClipAudioSettings(): ClipAudioSettings {
  if (typeof window === "undefined") return { muted: true, volume: 0.6 };
  try {
    const raw = window.localStorage.getItem(CLIP_AUDIO_SETTINGS_KEY);
    if (!raw) return { muted: true, volume: 0.6 };
    const parsed = JSON.parse(raw) as Partial<ClipAudioSettings>;
    return {
      muted: Boolean(parsed.muted),
      volume: Math.max(0, Math.min(1, Number(parsed.volume ?? 0.6))),
    };
  } catch {
    return { muted: true, volume: 0.6 };
  }
}

function writeClipAudioSettings(settings: ClipAudioSettings) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    CLIP_AUDIO_SETTINGS_KEY,
    JSON.stringify({
      muted: settings.muted,
      volume: Math.max(0, Math.min(1, settings.volume)),
    }),
  );
}
