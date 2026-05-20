import React from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { ArrowRight, CheckCircle2, Clapperboard, Film, Info, Loader2, Scissors, Upload, X, Zap } from "lucide-react";
import { Dropdown } from "../../components/Dropdown";
import { Virtuoso } from "react-virtuoso";
import {
  CLIP_AUDIO_SETTINGS_KEY,
  CLIP_COLUMN_OPTIONS,
  CLIP_PREVIEW_BATCH_SIZE,
  CLIP_PREVIEW_CPU_BATCH_CONCURRENCY,
  CLIP_PREVIEW_GPU_BATCH_CONCURRENCY,
  MAX_GRID_AUTOPLAYERS,
} from "../../lib/constants";
import { setDiscordJob } from "../../lib/discord";
import { logFrontend, safeLogValue } from "../../lib/log";
import { fileName, fileStem, normalizeSelectedPaths } from "../../lib/paths";
import { clampNumber } from "../../lib/numbers";
import { extensionAccept, useFileDrop } from "../../lib/useFileDrop";
import { parseBridgePayload, readBridgeError } from "../../utils/bridge";
import { VideoOutputControl } from "../video/VideoOutputControl";

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
import type { ConversionProgress, VideoControlSpec, VideoGpuStatus } from "../../types/conversion";
import { ClipCompatConvertModal } from "./ClipCompatConvertModal";
import { ClipExportProgressModal } from "./ClipExportProgressModal";
import type { ClipExportRow, ClipExportSession } from "./ClipExportProgressModal";
import { ClipPreviewScroller } from "./ClipPreviewScroller";
import { ClipPreviewTile } from "./ClipPreviewTile";
import { SceneViewerModal } from "./SceneViewerModal";

// Currently dead code : see FINDINGS.md. Moved here unchanged during the
// main.tsx split to keep that work move-only.
void readClipAudioSettings;
void writeClipAudioSettings;
void formatPreciseClipTime;

export function ClipExtractorPanel({ active }: { active: boolean }) {
  const [selectedVideos, setSelectedVideos] = React.useState<string[]>([]);
  const [clipMode, setClipMode] = React.useState<"cpu" | "gpu">("gpu");
  const [gridPreview, setGridPreview] = React.useState(true);
  const [hoverPlayOnly, setHoverPlayOnly] = React.useState<boolean>(false);

  React.useEffect(() => {
    const handler = (e: Event) => {
      setHoverPlayOnly((e as CustomEvent<{ enabled: boolean }>).detail.enabled);
    };
    window.addEventListener("clip-hover-preview-changed", handler);
    return () => window.removeEventListener("clip-hover-preview-changed", handler);
  }, []);
  const [gridCols, setGridCols] = React.useState(4);
  const [mergeMode, setMergeMode] = React.useState(false);
  const [mergeOrder, setMergeOrder] = React.useState<string[]>([]);
  const [selectedClipIds, setSelectedClipIds] = React.useState<Set<string>>(() => new Set());
  const [exportFormat, setExportFormat] = React.useState<ClipExportFormat>("prores-lt");
  const [exportQuality, setExportQuality] = React.useState<Record<ClipExportFormat, number>>({
    "gpu-intra": 16,
    "h264-nvenc": 18,
    "av1-nvenc": 24,
    "h264-cpu": 18,
    "hevc-cpu": 18,
    "prores-lt": 0,
    "prores-hq": 0,
  });
  const [visibleRowRange, setVisibleRowRange] = React.useState<{ startIndex: number; endIndex: number } | null>(null);
  const [progress, setProgress] = React.useState<ClipProgress | null>(null);
  const [result, setResult] = React.useState<ClipExtractionResult | null>(null);
  const [previewStates, setPreviewStates] = React.useState<Record<string, ClipPreviewState>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [isExtracting, setIsExtracting] = React.useState(false);
  const [serverStatus, setServerStatus] = React.useState<"cold" | "warming" | "ready">("cold");
  const [gpuStatus, setGpuStatus] = React.useState<VideoGpuStatus | null>(null);
  const [compatModal, setCompatModal] = React.useState<{
    failedPath: string;
    failedIndex: number;
    rawError: string;
  } | null>(null);
  const [isConverting, setIsConverting] = React.useState(false);
  const [convertMessage, setConvertMessage] = React.useState<string | null>(null);
  // Maps a converted cache path -> the original filename it replaced (for the badge).
  const [convertedSources, setConvertedSources] = React.useState<Record<string, string>>({});
  const [clipModeLoaded, setClipModeLoaded] = React.useState(false);
  const [activationEpoch, setActivationEpoch] = React.useState(0);
  // Store the viewer's selection by id (not by value): the `clips` array
  // gets re-derived on every render with fresh `previewState` updates as
  // WebPs finish rendering, and the modal needs to see those updates so it
  // can swap a stale "previewState: rendering" snapshot for the live
  // "previewState: ready" with the WebP src. Stashing the full object
  // froze the snapshot at click time and meant the modal's poster image
  // never appeared for clips clicked before their WebP was ready - the
  // very case the poster was meant to help with.
  const [viewerClipId, setViewerClipId] = React.useState<string | null>(null);
  const [exportSession, setExportSession] = React.useState<ClipExportSession | null>(null);
  const exportSessionRef = React.useRef<ClipExportSession | null>(null);
  React.useEffect(() => {
    exportSessionRef.current = exportSession;
  }, [exportSession]);

  // Bump activationEpoch when the viewer closes so the grid's WebPs and CSS
  // progress bars re-key together and resync. Otherwise both keep running in
  // the background while the modal is up and drift relative to each other -
  // same root cause as the tab-switch desync the activation epoch already
  // fixes, just from a different entry point.
  function closeViewer() {
    setViewerClipId(null);
    setActivationEpoch((value) => value + 1);
  }
  const wasActiveRef = React.useRef(active);
  React.useEffect(() => {
    if (active && !wasActiveRef.current) {
      setActivationEpoch((value) => value + 1);
    }
    wasActiveRef.current = active;
  }, [active]);
  React.useEffect(() => {
    setDiscordJob("Extracting clips", isExtracting);
    return () => setDiscordJob("Extracting clips", false);
  }, [isExtracting]);
  React.useEffect(() => {
    setDiscordJob("Converting clips", isConverting);
    return () => setDiscordJob("Converting clips", false);
  }, [isConverting]);
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
      setHoverPlayOnly(payload.clip_hover_preview ?? false);
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
    void listen<ConversionProgress>("conversion-progress", (event) => {
      if (cancelled) return;
      const payload = event.payload;
      // Route to the export modal when an export session is active so the
      // per-clip bar and overall bar both reflect real ffmpeg progress.
      // Otherwise fall through to the legacy inline progress card that the
      // codec-conversion path still uses.
      if (exportSessionRef.current) {
        const percent = typeof payload.percent === "number" ? payload.percent : 0;
        setExportSession((current) =>
          current
            ? {
                ...current,
                activePercent: Math.max(0, Math.min(100, percent)),
                activeFps: payload.fps ?? current.activeFps,
                activeSpeed: payload.speed ?? current.activeSpeed,
                activeMessage: payload.message || current.activeMessage,
              }
            : current,
        );
        return;
      }
      setProgress({
        type: "progress",
        stage: payload.stage,
        percent: typeof payload.percent === "number" ? payload.percent : 0,
        message: payload.message + (payload.speed ? ` (${payload.speed})` : ""),
      });
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
    setCompatModal(null);
    setConvertedSources({});

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
  const viewerClip = React.useMemo(
    () => (viewerClipId ? clips.find((c) => c.id === viewerClipId) ?? null : null),
    [viewerClipId, clips],
  );
  const selectedCount = selectedClipIds.size;
  const canExtract = selectedVideos.length > 0 && !isExtracting;
  const clipCancellingRef = React.useRef(false);
  const clipAbortRef = React.useRef<((reason: Error) => void) | null>(null);
  const readyPreviewCount = React.useMemo(
    () => clips.reduce((count, clip) => count + (clip.previewState?.status === "ready" ? 1 : 0), 0),
    [clips],
  );
  const exportOptions = React.useMemo(
    () => clipExportOptions(clipMode, gpuStatus),
    [clipMode, gpuStatus],
  );

  const dropdownOptions = React.useMemo(() => {
    return exportOptions.map((opt) => ({
      value: opt.value,
      label: opt.label,
      disabled: opt.disabled,
      description: opt.reason,
    }));
  }, [exportOptions]);
  const selectedExportOption = exportOptions.find((option) => option.value === exportFormat);
  const qualitySpec = React.useMemo(() => clipQualitySpec(exportFormat), [exportFormat]);

  React.useEffect(() => {
    if (!qualitySpec) return;
    setExportQuality((current) => {
      const existing = current[exportFormat];
      if (existing && existing >= qualitySpec.min && existing <= qualitySpec.max) {
        return current;
      }
      return { ...current, [exportFormat]: qualitySpec.defaultValue };
    });
  }, [exportFormat, qualitySpec]);

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

  async function startExtraction(overrideVideos?: string[]) {
    const videos = overrideVideos ?? selectedVideos;
    if (videos.length === 0 || isExtracting) return;

    // Preflight codec check : only the GPU path is codec-fragile. nelux+NVDEC
    // can hang in native code on anything outside the supported set; CPU mode
    // goes through ffmpeg directly and handles every codec ffmpeg knows.
    if (clipMode === "gpu") {
      const unsupported = await findFirstUnsupportedGpuCodec(videos);
      if (unsupported) {
        setCompatModal({
          failedPath: unsupported.path,
          failedIndex: unsupported.index,
          rawError: unsupported.codec === "unknown"
            ? `Couldn't read this file's metadata : it may be corrupted or use an exotic container. Convert it to a compatible format to try again.`
            : `Codec "${unsupported.codec}" isn't supported by the GPU clip extractor. Only H.264, HEVC, and AV1 work directly on the GPU path. Convert to a compatible format, or switch the clip extractor to CPU mode in Settings.`,
        });
        return;
      }
    }

    setIsExtracting(true);
    setResult(null);
    setPreviewStates({});
    previewTokenRef.current += 1;
    previewInFlightRef.current.clear();
    previewBatchInFlightRef.current = 0;
    setError(null);
    setCompatModal(null);
    setSelectedClipIds(new Set());
    setMergeOrder([]);
    setMergeMode(false);
    setProgress({
      type: "progress",
      stage: "starting",
      percent: 0,
      message: videos.length > 1
        ? `Starting ${videos.length} episode batch...`
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
      for (let index = 0; index < videos.length; index += 1) {
        if (clipCancellingRef.current) break;
        const inputPath = videos[index];
        clipBatchProgressRef.current = {
          activeIndex: index,
          total: videos.length,
          inputPath,
        };
        setProgress({
          type: "progress",
          stage: "starting",
          percent: Math.round((index / videos.length) * 100),
          message: `Episode ${index + 1}/${videos.length}: ${fileName(inputPath)}`,
        });
        const raw = await invoke<string>("clip_extract", { inputPath, mode: clipMode });
        const payload = raw.includes("server_task_started")
          ? await waitForClipServerResult(clipAbortRef)
          : parseBridgePayload<ClipExtractionResult>(raw);
        results.push(payload);
        setResult(combineClipResults(results, clipMode));
        setProgress({
          type: "progress",
          stage: "complete",
          percent: Math.round(((index + 1) / videos.length) * 100),
          message: `Episode ${index + 1}/${videos.length} complete: ${fileName(inputPath)}`,
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
        const errorText = readBridgeError(clipError);
        setError(errorText);
        const failed = clipBatchProgressRef.current;
        const failedPath = failed?.inputPath ?? videos[0];
        const failedIndex = failed?.activeIndex ?? 0;
        if (failedPath) {
          setCompatModal({ failedPath, failedIndex, rawError: errorText });
        }
      }
    } finally {
      clipAbortRef.current = null;
      clipBatchProgressRef.current = null;
      clipCancellingRef.current = false;
      setIsExtracting(false);
    }
  }

  async function handleConvertCompat() {
    if (!compatModal || isConverting) return;
    const { failedPath, failedIndex } = compatModal;
    setIsConverting(true);
    setConvertMessage("Converting to compatible format...");
    setError(null);
    setProgress({
      type: "progress",
      stage: "starting",
      percent: 0,
      message: `Converting ${fileName(failedPath)} to compatible format...`,
    });
    try {
      const raw = await invoke<string>("clip_compat_convert", { inputPath: failedPath });
      const payload = parseBridgePayload<{ output: string; cached: boolean }>(raw);
      const convertedPath = payload.output;
      const originalName = fileName(failedPath);
      setConvertedSources((current) => ({ ...current, [convertedPath]: originalName }));
      const nextVideos = [...selectedVideos];
      if (nextVideos[failedIndex] === failedPath) {
        nextVideos[failedIndex] = convertedPath;
      } else {
        const swapIndex = nextVideos.indexOf(failedPath);
        if (swapIndex >= 0) nextVideos[swapIndex] = convertedPath;
      }
      setSelectedVideos(nextVideos);
      setCompatModal(null);
      setConvertMessage(null);
      setIsConverting(false);
      void startExtraction(nextVideos);
    } catch (convertError) {
      const errorText = readBridgeError(convertError);
      setError(errorText);
      setProgress(null);
      setConvertMessage(null);
      setIsConverting(false);
      setCompatModal((current) =>
        current ? { ...current, rawError: errorText } : current,
      );
      logFrontend("error", "frontend.clip.compat.error", "Compatibility conversion failed", {
        error: safeLogValue(convertError),
      });
    }
  }

  function dismissCompatModal() {
    if (isConverting) return;
    setCompatModal(null);
  }

  function openCompatModalForCurrent() {
    const active = clipBatchProgressRef.current;
    const failedPath = active?.inputPath ?? selectedVideos[0];
    const failedIndex = active?.activeIndex ?? 0;
    if (!failedPath) return;
    setCompatModal({
      failedPath,
      failedIndex,
      rawError: "Extraction was running too long. The source may use a codec the extractor can't read.",
    });
    clipCancellingRef.current = true;
    void invoke("cancel_clip");
    clipAbortRef.current?.(new Error("USER_REQUESTED_CONVERT"));
    clipAbortRef.current = null;
  }

  const convertedBadgeNames = React.useMemo(
    () => selectedVideos
      .map((path) => convertedSources[path])
      .filter((name): name is string => Boolean(name)),
    [selectedVideos, convertedSources],
  );

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
      // Tile click opens the scene viewer with audio. Selection lives on the
      // corner button (clip-corner-select) so the two actions don't collide.
      setViewerClipId(clip.id);
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

    setError(null);
    setIsExtracting(true);
    const mergeRow: ClipExportRow = {
      id: `merge-${mergeFilenameStem}`,
      label: `${mergeFilenameStem}.mov`,
      range: `${mergeOrderedClips.length} clips`,
      status: "active",
    };
    setExportSession({
      mode: "merge",
      rows: [mergeRow],
      activeIndex: 0,
      activePercent: 0,
      activeFps: null,
      activeSpeed: null,
      activeMessage: `Merging ${exportClips.length} clips into ${mergeFilenameStem}.mov...`,
      phase: "running",
      outputDir: selected,
    });

    let cancelled = false;
    let failed = false;
    let errorText: string | null = null;

    try {
      await invoke<string>("clip_export_merged", {
        clips: exportClips,
        outputDir: selected,
        preset: exportFormat,
        qualityValue: clipQualitySpec(exportFormat) ? exportQuality[exportFormat] : null,
      });
      setExportSession((current) =>
        current
          ? {
              ...current,
              activePercent: 100,
              rows: current.rows.map((row, idx) =>
                idx === 0 ? { ...row, status: "done" } : row,
              ),
            }
          : current,
      );
    } catch (e) {
      if (clipCancellingRef.current) {
        cancelled = true;
      } else {
        failed = true;
        errorText = readBridgeError(e);
      }
      setExportSession((current) =>
        current
          ? {
              ...current,
              rows: current.rows.map((row, idx) =>
                idx === 0
                  ? {
                      ...row,
                      status: cancelled ? "cancelled" : "error",
                      errorMessage: errorText ?? row.errorMessage,
                    }
                  : row,
              ),
            }
          : current,
      );
    } finally {
      const finalPhase = cancelled ? "cancelled" : failed ? "error" : "complete";
      setExportSession((current) =>
        current ? { ...current, phase: finalPhase } : current,
      );
      if (!cancelled && !failed) {
        setMergeOrder([]);
        setMergeMode(false);
      }
      if (failed && errorText) {
        setError(errorText);
      }
      clipCancellingRef.current = false;
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
    const selectedClips = clips.filter((clip) => selectedClipIds.has(clip.id));
    if (selectedClips.length === 0) return;

    const rows: ClipExportRow[] = selectedClips.map((clip) => ({
      id: clip.id,
      label: clip.label,
      range: clip.range,
      status: "pending",
    }));

    setError(null);
    setIsExtracting(true);
    setExportSession({
      mode: "single",
      rows,
      activeIndex: 0,
      activePercent: 0,
      activeFps: null,
      activeSpeed: null,
      activeMessage: null,
      phase: "running",
      outputDir: outDir,
    });

    let cancelled = false;
    let failed = false;
    let firstError: string | null = null;

    try {
      for (let index = 0; index < selectedClips.length; index += 1) {
        if (clipCancellingRef.current) {
          cancelled = true;
          break;
        }
        const clip = selectedClips[index];
        setExportSession((current) =>
          current
            ? {
                ...current,
                activeIndex: index,
                activePercent: 0,
                activeFps: null,
                activeSpeed: null,
                activeMessage: null,
                rows: current.rows.map((row, rowIdx) =>
                  rowIdx === index ? { ...row, status: "active" } : row,
                ),
              }
            : current,
        );

        try {
          await invoke<string>("clip_export", {
            clips: [
              {
                source: clip.path,
                start: clip.sourceStart,
                end: clip.sourceEnd,
                index,
                fps: clip.fps,
              },
            ],
            outputDir: outDir,
            preset: exportFormat,
            qualityValue: clipQualitySpec(exportFormat) ? exportQuality[exportFormat] : null,
          });
          setExportSession((current) =>
            current
              ? {
                  ...current,
                  activePercent: 100,
                  rows: current.rows.map((row, rowIdx) =>
                    rowIdx === index ? { ...row, status: "done" } : row,
                  ),
                }
              : current,
          );
        } catch (e) {
          if (clipCancellingRef.current) {
            cancelled = true;
            setExportSession((current) =>
              current
                ? {
                    ...current,
                    rows: current.rows.map((row, rowIdx) =>
                      rowIdx === index ? { ...row, status: "cancelled" } : row,
                    ),
                  }
                : current,
            );
            break;
          }
          failed = true;
          const errorText = readBridgeError(e);
          if (!firstError) firstError = errorText;
          setExportSession((current) =>
            current
              ? {
                  ...current,
                  rows: current.rows.map((row, rowIdx) =>
                    rowIdx === index
                      ? { ...row, status: "error", errorMessage: errorText }
                      : row,
                  ),
                }
              : current,
          );
        }
      }
    } finally {
      const finalPhase = cancelled
        ? "cancelled"
        : failed
          ? "error"
          : "complete";
      setExportSession((current) =>
        current
          ? {
              ...current,
              phase: finalPhase,
              rows: current.rows.map((row) =>
                row.status === "pending"
                  ? { ...row, status: cancelled ? "cancelled" : row.status }
                  : row,
              ),
            }
          : current,
      );
      if (!cancelled && !failed) {
        setSelectedClipIds(new Set());
      }
      if (failed && firstError) {
        setError(firstError);
      }
      clipCancellingRef.current = false;
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
        <small>MP4 · MKV · MOV · WEBM · AVI : multiple files accepted</small>
      </div>
      <div className="clip-extractor-rail">
        <button type="button" className="clip-import-button glass spring-motion" onClick={pickVideo}>
          <span className="clip-import-mark">
            <Scissors size={32} strokeWidth={1.9} />
          </span>
          <span>{selectedVideos.length > 0 ? "Change episodes" : "Select episodes"}</span>
        </button>

        <div className="clip-source-card glass">
          <div className="clip-source-header">
            <div className="clip-source-info">
              <small>Source</small>
              <strong>{displayName}</strong>
            </div>
          <div
            className={`clip-server-badge spring-motion ${serverStatus === "ready" ? "is-ready" : serverStatus === "warming" ? "is-warming" : ""}`}
            title={serverStatus === "ready" ? "Clip Server is warm and ready" : serverStatus === "warming" ? "Clip Server is warming up..." : "Clip Server is cold"}
          >
            {serverStatus === "ready" ? "Ready" : serverStatus === "warming" ? "Warming" : "Cold"}
          </div>
          </div>
          {selectedVideos.length > 0 && (
            <span>{selectedVideos.length === 1 ? selectedVideos[0] : selectedVideos.map(fileName).join(" / ")}</span>
          )}
          <em>{clipMode === "gpu" ? "GPU mode · RTX TransNetV2" : "CPU mode · PySceneDetect"}</em>
          {convertedBadgeNames.length > 0 && (
            <span className="clip-compat-badge" title="The clip extractor is reading a converted copy stored in the app's cache. The original file is untouched.">
              {convertedBadgeNames.length === 1
                ? `Using converted copy of ${convertedBadgeNames[0]}`
                : `Using converted copies for ${convertedBadgeNames.length} files`}
            </span>
          )}
        </div>

        <div className="clip-tool-stack" aria-label="Clip extractor actions">
          <button
            type="button"
            className={`clip-tool-button spring-motion ${gridPreview ? "is-active" : ""}`}
            onClick={() => setGridPreview((value) => !value)}
          >
            <Film size={18} strokeWidth={2} />
            <span>Grid preview</span>
          </button>

          <button
            type="button"
            className={`clip-tool-button spring-motion ${hoverPlayOnly ? "is-active" : ""}`}
            onClick={() => {
              const next = !hoverPlayOnly;
              setHoverPlayOnly(next);
              void invoke("set_config", { key: "clip_hover_preview", value: next ? "true" : "false" });
              window.dispatchEvent(
                new CustomEvent("clip-hover-preview-changed", { detail: { enabled: next } }),
              );
            }}
            title={hoverPlayOnly ? "Only plays previews on hover (Lighter on system)" : "Plays all visible previews simultaneously"}
          >
            <Zap size={18} strokeWidth={2} />
            <span>Hover preview only</span>
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
            <Dropdown<ClipExportFormat>
              value={exportFormat}
              onChange={(next) => setExportFormat(next)}
              options={dropdownOptions}
              className="clip-export-format-dropdown"
            />
            {selectedExportOption?.reason && <small className="stream-warning">{selectedExportOption.reason}</small>}
            {qualitySpec && (
              <VideoOutputControl
                spec={qualitySpec}
                value={exportQuality[exportFormat] || qualitySpec.defaultValue}
                disabled={isExtracting}
                onChange={(value) => {
                  const clamped = clampNumber(value, qualitySpec.min, qualitySpec.max);
                  setExportQuality((current) => ({ ...current, [exportFormat]: clamped }));
                }}
              />
            )}
          </div>

          {!mergeMode && (
            <>
              <button
                type="button"
                className={`clip-tool-button spring-motion ${selectedCount > 0 ? 'is-active-primary' : ''}`}
                disabled={selectedCount === 0 || isExtracting}
                onClick={startExport}
              >
                <ArrowRight size={18} strokeWidth={2} />
                <span>{selectedCount === 0 ? "Select clips to export" : `Export ${selectedCount} clips`}</span>
              </button>

              <button
                type="button"
                className={`clip-tool-button spring-motion ${hasClips && selectedCount === clips.length ? "is-active" : ""}`}
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
            className={`clip-tool-button spring-motion ${mergeMode ? "is-active" : ""}`}
            disabled={!hasClips}
            onClick={toggleMergeMode}
          >
            <Scissors size={18} strokeWidth={2} />
            <span>{mergeMode ? "Cancel merge" : "Merge clip"}</span>
          </button>

          {mergeMode && (
            <button
              type="button"
              className="clip-confirm-button spring-motion accent-glow"
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

        {!exportSession && (progress || error || result) && (
          <div className={`clip-run-card glass ${error ? "is-error" : ""}`}>
            <div className="clip-run-line">
              <strong>{error ? "Extraction failed" : formatClipProgressStage(progress?.stage)}</strong>
              {progress && <span>{Math.round(progress.percent)}%</span>}
            </div>
            {progress && (
              <div className={`clip-progress-track ${isExtracting && progress.percent <= 0 ? "is-indeterminate" : ""}`}>
                <span className="spring-motion" style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }} />
              </div>
            )}
            <p>{runMessage}</p>
          </div>
        )}

        <div className="clip-format-note">
          <Info size={14} strokeWidth={2.5} />
          <span>ProRes and Intra frame formats are best for After Effects responsiveness.</span>
        </div>

        <button type="button" className="clip-primary-action spring-motion accent-glow" disabled={!canExtract} onClick={() => void startExtraction()}>
          {isExtracting ? "Extracting..." : hasClips ? "Extract again" : "Extract clips"}
        </button>
        {isExtracting && !exportSession && (
          <button
            type="button"
            className="clip-cancel-action"
            onClick={() => {
              clipCancellingRef.current = true;
              void invoke("cancel_clip");
              clipAbortRef.current?.(new Error("USER_CANCELLED"));
              clipAbortRef.current = null;
            }}
          >
            <X size={14} strokeWidth={2.3} />
            Cancel
          </button>
        )}
        {isExtracting && !exportSession && !isConverting && (
          <button
            type="button"
            className="clip-convert-suggest"
            onClick={() => openCompatModalForCurrent()}
            title="If this is taking too long, the source may use a codec the extractor can't read. Convert it to a compatible format."
          >
            Stuck? Convert to compatible format
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
                    paused={!gridPreview || Boolean(viewerClip)}
                    playable={activeGridClipIds.has(clip.id)}
                    selected={mergeMode ? mergePositions.has(clip.id) : selectedClipIds.has(clip.id)}
                    activationEpoch={activationEpoch}
                    clipHoverPreview={hoverPlayOnly}
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

        <ClipCompatConvertModal
          open={Boolean(compatModal)}
          failedPath={compatModal?.failedPath ?? null}
          rawError={compatModal?.rawError ?? null}
          isConverting={isConverting}
          convertMessage={isConverting ? (progress?.message ?? convertMessage) : convertMessage}
          onConvert={() => void handleConvertCompat()}
          onCancel={dismissCompatModal}
        />

        <SceneViewerModal clip={viewerClip} onClose={closeViewer} />

        <ClipExportProgressModal
          session={exportSession}
          onCancel={() => {
            clipCancellingRef.current = true;
            void invoke("cancel_clip");
          }}
          onClose={() => setExportSession(null)}
        />

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

// nelux+NVDEC reliably decodes only these codecs. Anything else either errors
// out or hangs in native code without raising : so we refuse the GPU path
// upfront and prompt the user to convert. Keep this list in sync with
// cuvid_decoder() in backend/clip_cli.py.
const GPU_SUPPORTED_CODECS = new Set(["h264", "hevc", "av1"]);

async function findFirstUnsupportedGpuCodec(
  videos: string[],
): Promise<{ path: string; index: number; codec: string } | null> {
  for (let index = 0; index < videos.length; index += 1) {
    const path = videos[index];
    let codec = "unknown";
    try {
      const raw = await invoke<string>("video_source_codec", { inputPath: path });
      codec = raw.trim().toLowerCase();
    } catch (probeError) {
      logFrontend("warn", "frontend.clip.codec_probe.warning", "Could not probe codec; treating as unsupported", {
        path,
        error: safeLogValue(probeError),
      });
      return { path, index, codec: "unknown" };
    }
    if (!GPU_SUPPORTED_CODECS.has(codec)) {
      return { path, index, codec };
    }
  }
  return null;
}

async function waitForClipServerResult(
  abortRef: React.MutableRefObject<((reason: Error) => void) | null>,
): Promise<ClipExtractionResult> {
  return new Promise((resolve, reject) => {
    let unlisten: (() => void) | null = null;
    abortRef.current = (reason) => {
      unlisten?.();
      reject(reason);
    };
    void listen<any>("clip-server-event", (event) => {
      const payload = event.payload;
      if (payload.type === "done") {
        unlisten?.();
        abortRef.current = null;
        resolve(payload as ClipExtractionResult);
      } else if (payload.type === "error") {
        unlisten?.();
        abortRef.current = null;
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

function clipQualitySpec(format: ClipExportFormat): VideoControlSpec | null {
  switch (format) {
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
    case "h264-nvenc":
      return {
        label: "Constant quality",
        valueLabel: "CQ",
        help: "Lower values keep more detail and create larger files.",
        min: 14,
        max: 28,
        step: 1,
        defaultValue: 18,
        suffix: "",
      };
    case "av1-nvenc":
      return {
        label: "Constant quality",
        valueLabel: "CQ",
        help: "Lower values keep more detail and create larger files.",
        min: 18,
        max: 34,
        step: 1,
        defaultValue: 24,
        suffix: "",
      };
    case "h264-cpu":
      return {
        label: "Constant rate factor",
        valueLabel: "CRF",
        help: "Lower values keep more detail and create larger files.",
        min: 14,
        max: 28,
        step: 1,
        defaultValue: 18,
        suffix: "",
      };
    case "hevc-cpu":
      return {
        label: "Constant rate factor",
        valueLabel: "CRF",
        help: "Lower values keep more detail and create larger files.",
        min: 14,
        max: 28,
        step: 1,
        defaultValue: 18,
        suffix: "",
      };
    case "prores-lt":
    case "prores-hq":
    default:
      return null;
  }
}

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
      label: "H.264 CPU MP4",
      disabled: false,
    },
    {
      value: "hevc-cpu",
      label: "HEVC CPU MP4",
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
      label: "H.264 NVENC MP4",
      disabled: !gpuMode || !h264NvencReady,
      reason: !gpuMode ? cpuModeReason : h264NvencReady ? undefined : "Bundled FFmpeg does not expose h264_nvenc on this machine.",
    },
    {
      value: "av1-nvenc",
      label: "AV1 NVENC MP4",
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
