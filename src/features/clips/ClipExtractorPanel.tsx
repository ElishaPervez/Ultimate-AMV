import React from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { ArrowRight, CheckCircle2, ChevronDown, ChevronUp, Clapperboard, Film, Info, Loader2, Play, Scissors, Upload, X, Zap } from "lucide-react";
import { Dropdown } from "../../components/Dropdown";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
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
    "lossless-cut": 0,
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
  // Maps a RAW source path -> a converted proxy path used ONLY to feed the GPU
  // detector. The proxy is a lossy 8-bit transcode, so it must never reach
  // preview or export — those always read the raw. Scene timecodes from the
  // proxy align with the raw because the convert is a straight full transcode
  // (same fps/duration, no trimming). See clip_compat_convert in clips.rs.
  const [detectorProxies, setDetectorProxies] = React.useState<Record<string, string>>({});
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
  const [isPreviewMerging, setIsPreviewMerging] = React.useState(false);
  const [mergedPreviewClip, setMergedPreviewClip] = React.useState<ClipPreviewItem | null>(null);
  const [activeGridItems, setActiveGridItems] = React.useState<string[][] | null>(null);
  const [unifiedPreviews, setUnifiedPreviews] = React.useState<Record<string, ClipPreviewItem>>({});
  const [exportSession, setExportSession] = React.useState<ClipExportSession | null>(null);
  const [exportMinimized, setExportMinimized] = React.useState(false);
  const exportSessionRef = React.useRef<ClipExportSession | null>(null);
  const lastSelectedIdRef = React.useRef<string | null>(null);
  const virtuosoRef = React.useRef<VirtuosoHandle | null>(null);
  const selectionCursorIdRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    exportSessionRef.current = exportSession;
    if (!exportSession) setExportMinimized(false);
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
    // Stale anchor would otherwise point into the previous extraction's
    // clip ids, making the first jump-to-selection click after a new
    // extraction land on the wrong end of the list.
    selectionCursorIdRef.current = null;
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
    setActiveGridItems(null);
    setUnifiedPreviews({});

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

  const displayedClips = React.useMemo<ClipPreviewItem[]>(() => {
    if (!clips || clips.length === 0) return [];
    if (!activeGridItems) return clips;

    return activeGridItems.map((ids) => {
      if (ids.length === 1) {
        return clips.find((c) => c.id === ids[0])!;
      } else {
        const constituentClips = ids.map(id => clips.find(c => c.id === id)!).filter(Boolean);
        if (constituentClips.length === 0) return null as any;

        const first = constituentClips[0];
        const combinedDuration = constituentClips.reduce((sum, c) => sum + (c.sourceEnd - c.sourceStart), 0);
        const indices = constituentClips.map((c) => c.index + 1).join("+");
        const combinedId = `unified-${constituentClips.map((c) => c.id).join("_")}`;

        return {
          id: combinedId,
          index: first.index,
          label: `Merged Clip (${indices})`,
          range: `${constituentClips.length} clips merged · ${combinedDuration.toFixed(1)}s`,
          sourceName: first.sourceName,
          sourceSrc: first.sourceSrc,
          sourceStart: first.sourceStart,
          sourceEnd: first.sourceStart + combinedDuration,
          previewStart: first.previewStart,
          previewEnd: first.previewEnd,
          previewState: previewStates[combinedId] || first.previewState,
          fps: first.fps,
          path: first.path,
          isUnified: true,
          segments: constituentClips.flatMap((c) =>
            c.isUnified && c.segments
              ? c.segments
              : [{
                  source: c.path!,
                  start: c.sourceStart,
                  end: c.sourceEnd,
                  index: c.index,
                  fps: c.fps,
                }]
          ),
        };
      }
    }).filter(Boolean);
  }, [clips, activeGridItems, previewStates]);

  const hasClips = displayedClips.length > 0;
  const viewerClip = React.useMemo(
    () => {
      if (viewerClipId === "merged-preview") return mergedPreviewClip;
      return viewerClipId ? displayedClips.find((c) => c.id === viewerClipId) ?? null : null;
    },
    [viewerClipId, displayedClips, mergedPreviewClip],
  );
  const selectedCount = selectedClipIds.size;
  const canExtract = selectedVideos.length > 0 && !isExtracting;
  const clipCancellingRef = React.useRef(false);
  const clipAbortRef = React.useRef<((reason: Error) => void) | null>(null);
  const readyPreviewCount = React.useMemo(
    () => displayedClips.reduce((count, clip) => count + (clip.previewState?.status === "ready" ? 1 : 0), 0),
    [displayedClips],
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
      description: opt.description ?? opt.reason,
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
    for (let i = 0; i < displayedClips.length; i += gridCols) {
      rows.push(displayedClips.slice(i, i + gridCols));
    }
    return rows;
  }, [displayedClips, gridCols, hasClips]);

  const activeGridClipIds = React.useMemo(() => {
    const active = new Set<string>();
    if (!gridPreview) return active;
    if (clipRows.length <= 0) return active;

    // Play exactly the rows the user can see, plus one row above and one
    // below as a scroll buffer so the next row is already animating when
    // it enters view (avoids the warm-up flash). Scales naturally with
    // gridCols because Virtuoso reports visible *rows* and the count of
    // active clips becomes rows × cols. Old logic walked downward until
    // it hit MAX_GRID_AUTOPLAYERS=100, which meant ~33 rows of animated
    // WebPs were compositing on every frame at 3 columns — visible cause
    // of the grid lag at large clip counts. MAX_GRID_AUTOPLAYERS stays
    // as a hard ceiling for unusually tall viewports but rarely fires.
    const OVERSCAN_ROWS = 1;
    const lastRow = clipRows.length - 1;
    const baseStart = visibleRowRange?.startIndex ?? 0;
    const baseEnd = visibleRowRange?.endIndex ?? baseStart;
    const startRow = Math.max(0, baseStart - OVERSCAN_ROWS);
    const endRow = Math.min(lastRow, baseEnd + OVERSCAN_ROWS);

    for (let rowIndex = startRow; rowIndex <= endRow; rowIndex += 1) {
      for (const clip of clipRows[rowIndex] ?? []) {
        active.add(clip.id);
        if (active.size >= MAX_GRID_AUTOPLAYERS) break;
      }
      if (active.size >= MAX_GRID_AUTOPLAYERS) break;
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

  async function startExtraction(overrideVideos?: string[], options?: { force?: boolean }) {
    const videos = overrideVideos ?? selectedVideos;
    if (videos.length === 0 || isExtracting) return;
    const force = options?.force ?? false;

    // GPU mode no longer blocks on a codec preflight. The Python backend
    // routes any codec NVDEC/nelux can't decode straight to software decode ->
    // the same TransNetV2 model (mode stays "gpu"), so detection quality is
    // unchanged and we avoid both the lossy forced-convert AND the nelux
    // native-hang risk on unsupported codecs. We still probe here purely to
    // surface a heads-up log line when the slower software-decode route will
    // kick in; we do NOT pop the convert modal or abort.
    if (clipMode === "gpu") {
      const unsupported = await findFirstUnsupportedGpuCodec(videos);
      if (unsupported) {
        logFrontend(
          "info",
          "frontend.clip.gpu_software_decode",
          "Unsupported GPU codec detected; backend will use software decode -> TransNetV2",
          { path: unsupported.path, codec: unsupported.codec },
        );
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
    setActiveGridItems(null);
    setUnifiedPreviews({});
    setProgress({
      type: "progress",
      stage: "starting",
      percent: 0,
      message: videos.length > 1
        ? `Starting ${videos.length} episode batch...`
        : clipMode === "gpu" ? "Starting GPU scene detection..." : "Starting CPU scene detection...",
    });

    try {
      if (clipMode === "gpu") {
        setServerStatus("warming");
        setProgress({
          type: "progress",
          stage: "dependencies",
          percent: 0,
          message: "Preparing GPU clip server for batch extraction...",
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
        const rawPath = videos[index];
        // Feed the detector the proxy if one exists for this raw (manual
        // last-resort convert), but everything user-facing stays on the raw.
        const detectInput = detectorProxies[rawPath] ?? rawPath;
        const inputPath = detectInput;
        clipBatchProgressRef.current = {
          activeIndex: index,
          total: videos.length,
          inputPath: rawPath,
        };
        setProgress({
          type: "progress",
          stage: "starting",
          percent: Math.round((index / videos.length) * 100),
          message: `Episode ${index + 1}/${videos.length}: ${fileName(rawPath)}`,
        });
        const raw = await invoke<string>("clip_extract", { inputPath, mode: clipMode, force });
        // Strict type check rather than substring — the cached "done" payload
        // returned for a cache hit is the same shape as a real done event and
        // could theoretically contain the literal string in a path, scene
        // label, or error field. Substring matching would route those to the
        // server-wait branch and the frontend would hang forever.
        let isServerTask = false;
        try {
          const peek = JSON.parse(raw) as { type?: string } | null;
          isServerTask = peek?.type === "server_task_started";
        } catch {
          isServerTask = false;
        }
        const rawPayload = isServerTask
          ? await waitForClipServerResult(clipAbortRef)
          : parseBridgePayload<ClipExtractionResult>(raw);
        // If detection ran on a proxy, rewrite every scene's source (and the
        // top-level input) back to the RAW so preview + export read the
        // original file, never the lossy proxy. Timecodes are unchanged
        // because the proxy is a straight full transcode of the raw.
        const payload: ClipExtractionResult = detectInput !== rawPath
          ? {
              ...rawPayload,
              input: rawPath,
              scenes: rawPayload.scenes.map((scene) => ({ ...scene, source: rawPath })),
            }
          : rawPayload;
        results.push(payload);
        setResult(combineClipResults(results, clipMode));
        setProgress({
          type: "progress",
          stage: "complete",
          percent: Math.round(((index + 1) / videos.length) * 100),
          message: `Episode ${index + 1}/${videos.length} complete: ${fileName(rawPath)}`,
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
    const { failedPath } = compatModal;
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
      // Keep selectedVideos on the RAW. Register the proxy as a detector-only
      // input keyed by the raw path: the next extraction feeds the proxy to
      // the detector, but scene sources are rewritten back to the raw so
      // preview/export never touch the lossy proxy. The badge keys off the
      // raw path so the user still sees the "converted for detection" marker.
      setConvertedSources((current) => ({ ...current, [failedPath]: originalName }));
      setDetectorProxies((current) => ({ ...current, [failedPath]: convertedPath }));
      setCompatModal(null);
      setConvertMessage(null);
      setIsConverting(false);
      // selectedVideos already holds the raw at failedIndex; just re-run.
      void startExtraction(selectedVideos, { force: true });
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
      rawError: "Extraction was running too long. The source may use a format the extractor can't read.",
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

  function selectClip(clipId: string) {
    setSelectedClipIds((current) => {
      if (current.has(clipId)) return current;
      const next = new Set(current);
      next.add(clipId);
      return next;
    });
    lastSelectedIdRef.current = clipId;
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
    lastSelectedIdRef.current = clipId;
  }

  function selectRange(fromId: string, toId: string, addToExisting = false) {
    const fromIndex = displayedClips.findIndex((c) => c.id === fromId);
    const toIndex = displayedClips.findIndex((c) => c.id === toId);
    if (fromIndex === -1 || toIndex === -1) return;

    const start = Math.min(fromIndex, toIndex);
    const end = Math.max(fromIndex, toIndex);

    setSelectedClipIds((current) => {
      const next = addToExisting ? new Set(current) : new Set<string>();
      for (let i = start; i <= end; i++) {
        next.add(displayedClips[i].id);
      }
      return next;
    });
    lastSelectedIdRef.current = toId;
  }

  function jumpToSelection(direction: "next" | "prev") {
    if (selectedClipIds.size === 0) return;
    const ordered: { id: string; index: number }[] = [];
    for (let i = 0; i < displayedClips.length; i++) {
      if (selectedClipIds.has(displayedClips[i].id)) ordered.push({ id: displayedClips[i].id, index: i });
    }
    if (ordered.length === 0) return;
    const cursorId = selectionCursorIdRef.current;
    const cursorPos = cursorId ? ordered.findIndex((e) => e.id === cursorId) : -1;
    let targetPos: number;
    if (cursorPos === -1) {
      targetPos = direction === "next" ? 0 : ordered.length - 1;
    } else if (direction === "next") {
      targetPos = (cursorPos + 1) % ordered.length;
    } else {
      targetPos = (cursorPos - 1 + ordered.length) % ordered.length;
    }
    const target = ordered[targetPos];
    selectionCursorIdRef.current = target.id;
    const rowIndex = Math.floor(target.index / gridCols);
    virtuosoRef.current?.scrollToIndex({ index: rowIndex, align: "center", behavior: "smooth" });
  }

  function toggleAllClipSelection() {
    if (!hasClips) return;
        setSelectedClipIds((current) => {
      if (current.size === displayedClips.length) {
        return new Set();
      }
      return new Set(displayedClips.map((clip) => clip.id));
    });
  }

  const mergeOrderedClips = React.useMemo(
    () =>
      mergeOrder
        .map((id) => displayedClips.find((clip) => clip.id === id))
        .filter((clip): clip is ClipPreviewItem => Boolean(clip)),
    [mergeOrder, displayedClips],
  );

  const mergeFilenameStem = React.useMemo(
    () => {
      const parts: number[] = [];
      mergeOrderedClips.forEach((clip) => {
        if (clip.isUnified && clip.segments) {
          clip.segments.forEach((s) => parts.push(s.index + 1));
        } else {
          parts.push(clip.index + 1);
        }
      });
      if (parts.length === 0) return "";

      const fullJoin = parts.join("+");
      if (fullJoin.length <= 30) {
        return fullJoin;
      }

      const min = Math.min(...parts);
      const max = Math.max(...parts);
      return `${min}-${max} (${parts.length} clips)`;
    },
    [mergeOrderedClips],
  );
  // Container extension the backend will actually write for the current
  // preset, so the merge UI labels match the real output file.
  const mergeExt = clipPresetExtension(exportFormat);

  async function handleClipClick(
    clip: ClipPreviewItem,
    modifiers: { ctrl: boolean; shift: boolean },
  ) {
    if (mergeMode) {
      toggleMergeOrder(clip.id);
      return;
    }

    // Ctrl+Shift+click: add range to existing selection (falls back to plain select if no anchor)
    if (modifiers.ctrl && modifiers.shift) {
      if (lastSelectedIdRef.current) selectRange(lastSelectedIdRef.current, clip.id, true);
      else selectClip(clip.id);
      return;
    }

    // Ctrl+click: toggle selection
    if (modifiers.ctrl) {
      toggleClipSelection(clip.id);
      return;
    }

    // Shift+click: range selection (replaces). Anchor missing -> seed it with this tile.
    if (modifiers.shift) {
      if (lastSelectedIdRef.current) selectRange(lastSelectedIdRef.current, clip.id, false);
      else selectClip(clip.id);
      return;
    }

    // Plain click
    if (clip.isUnified) {
      if (unifiedPreviews[clip.id]) {
        setMergedPreviewClip(unifiedPreviews[clip.id]);
        setViewerClipId("merged-preview");

        const existingState = previewStates[clip.id];
        if (!existingState || (existingState.status !== "ready" && existingState.status !== "rendering")) {
          const cachedMp4Path = unifiedPreviews[clip.id].path!;
          const cachedMp4Duration = unifiedPreviews[clip.id].sourceEnd;
          void (async () => {
            setPreviewStates((current) => ({
              ...current,
              [clip.id]: { status: "rendering" },
            }));
            try {
              const webpRaw = await invoke<string>("clip_preview_generate", {
                sceneId: clip.id,
                sourcePath: cachedMp4Path,
                start: 0,
                end: cachedMp4Duration,
                fps: clip.fps || 24,
              });
              const webpPayload = parseBridgePayload<{ path: string; duration: number }>(webpRaw);
              setPreviewStates((current) => ({
                ...current,
                [clip.id]: {
                  status: "ready",
                  path: webpPayload.path,
                  src: convertFileSrc(webpPayload.path),
                  duration: webpPayload.duration,
                },
              }));
            } catch (webpErr) {
              console.error("Failed to generate WebP preview for unified clip:", webpErr);
              setPreviewStates((current) => ({
                ...current,
                [clip.id]: { status: "error" },
              }));
            }
          })();
        }
        return;
      }

      if (isPreviewMerging) return;
      setError(null);
      setIsPreviewMerging(true);

      try {
        const raw = await invoke<string>("clip_preview_merge", {
          clips: clip.segments,
        });
        const payload = parseBridgePayload<{ path: string; duration: number }>(raw);
        
        const mockClip: ClipPreviewItem = {
          id: "merged-preview",
          index: 9999,
          label: clip.label,
          range: clip.range,
          sourceName: "Merged Preview",
          sourceSrc: "",
          sourceStart: 0,
          sourceEnd: payload.duration,
          previewStart: 0,
          previewEnd: payload.duration,
          path: payload.path,
          fps: clip.fps || 24,
        };

        setUnifiedPreviews((current) => ({ ...current, [clip.id]: mockClip }));
        setMergedPreviewClip(mockClip);
        setViewerClipId("merged-preview");

        // Immediately trigger WebP preview generation in the background!
        setPreviewStates((current) => ({
          ...current,
          [clip.id]: { status: "rendering" },
        }));
        void (async () => {
          try {
            const webpRaw = await invoke<string>("clip_preview_generate", {
              sceneId: clip.id,
              sourcePath: payload.path,
              start: 0,
              end: payload.duration,
              fps: clip.fps || 24,
            });
            const webpPayload = parseBridgePayload<{ path: string; duration: number }>(webpRaw);
            setPreviewStates((current) => ({
              ...current,
              [clip.id]: {
                status: "ready",
                path: webpPayload.path,
                src: convertFileSrc(webpPayload.path),
                duration: webpPayload.duration,
              },
            }));
          } catch (webpErr) {
            console.error("Failed to generate WebP preview for unified clip:", webpErr);
            setPreviewStates((current) => ({
              ...current,
              [clip.id]: { status: "error" },
            }));
          }
        })();

      } catch (e) {
        const errorText = readBridgeError(e);
        setError(errorText);
      } finally {
        setIsPreviewMerging(false);
      }
      return;
    }

    // Plain click for standard clip: open scene viewer with audio. Selection lives on the corner
    // button (clip-corner-select) and the modifier paths above.
    setViewerClipId(clip.id);
  }

  function unifySelectedInGrid() {
    if (mergeOrder.length < 2) return;

    const currentLayout = activeGridItems ?? clips.map((c) => [c.id]);
    const selectedUnderlyingIds: string[] = [];
    const groupsToRemove = new Set<number>();

    mergeOrder.forEach((selectedId) => {
      const dispClip = displayedClips.find((c) => c.id === selectedId);
      if (!dispClip) return;

      let foundGroupIndex = -1;
      if (dispClip.isUnified) {
        foundGroupIndex = currentLayout.findIndex((group) => {
          if (group.length <= 1) return false;
          const constituent = group.map(id => clips.find(c => c.id === id)!).filter(Boolean);
          const generatedId = `unified-${constituent.map((c) => c.id).join("_")}`;
          return generatedId === selectedId;
        });
      } else {
        foundGroupIndex = currentLayout.findIndex(
          (group) => group.length === 1 && group[0] === selectedId
        );
      }

      if (foundGroupIndex !== -1) {
        groupsToRemove.add(foundGroupIndex);
        selectedUnderlyingIds.push(...currentLayout[foundGroupIndex]);
      }
    });

    if (selectedUnderlyingIds.length < 2) return;

    const nextLayout: string[][] = [];
    let inserted = false;

    currentLayout.forEach((group, index) => {
      if (groupsToRemove.has(index)) {
        if (!inserted) {
          nextLayout.push(selectedUnderlyingIds);
          inserted = true;
        }
      } else {
        nextLayout.push(group);
      }
    });

    setActiveGridItems(nextLayout);
    setMergeOrder([]);
    setMergeMode(false);

    // Automatically trigger preview merge & WebP generation in the background!
    const combinedId = `unified-${selectedUnderlyingIds.join("_")}`;
    const constituentClips = selectedUnderlyingIds.map(id => clips.find(c => c.id === id)!).filter(Boolean);
    const segments = constituentClips.flatMap((c) =>
      c.isUnified && c.segments
        ? c.segments
        : [{
            source: c.path!,
            start: c.sourceStart,
            end: c.sourceEnd,
            index: c.index,
            fps: c.fps,
          }]
    );

    void (async () => {
      setPreviewStates((current) => ({
        ...current,
        [combinedId]: { status: "rendering" },
      }));

      try {
        const raw = await invoke<string>("clip_preview_merge", {
          clips: segments,
        });
        const payload = parseBridgePayload<{ path: string; duration: number }>(raw);
        
        const mockClip: ClipPreviewItem = {
          id: "merged-preview",
          index: 9999,
          label: `Merged Clip (${constituentClips.map((c) => c.index + 1).join("+")})`,
          range: `${constituentClips.length} clips merged · ${payload.duration.toFixed(1)}s`,
          sourceName: "Merged Preview",
          sourceSrc: "",
          sourceStart: 0,
          sourceEnd: payload.duration,
          previewStart: 0,
          previewEnd: payload.duration,
          path: payload.path,
          fps: constituentClips[0]?.fps || 24,
        };

        setUnifiedPreviews((current) => ({ ...current, [combinedId]: mockClip }));

        const webpRaw = await invoke<string>("clip_preview_generate", {
          sceneId: combinedId,
          sourcePath: payload.path,
          start: 0,
          end: payload.duration,
          fps: constituentClips[0]?.fps || 24,
        });
        const webpPayload = parseBridgePayload<{ path: string; duration: number }>(webpRaw);
        setPreviewStates((current) => ({
          ...current,
          [combinedId]: {
            status: "ready",
            path: webpPayload.path,
            src: convertFileSrc(webpPayload.path),
            duration: webpPayload.duration,
          },
        }));
      } catch (err) {
        console.error("Failed to generate background preview for merged clip:", err);
        setPreviewStates((current) => ({
          ...current,
          [combinedId]: { status: "error" },
        }));
      }
    })();
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

  async function startPreviewMerge() {
    if (mergeOrderedClips.length < 2 || isExtracting || isPreviewMerging) return;

    setError(null);
    setIsPreviewMerging(true);

    const exportClips = mergeOrderedClips.flatMap((clip) => {
      if (clip.isUnified && clip.segments) {
        return clip.segments;
      }
      return [
        {
          source: clip.path!,
          start: clip.sourceStart,
          end: clip.sourceEnd,
          index: clip.index,
          fps: clip.fps,
        },
      ];
    });

    try {
      const raw = await invoke<string>("clip_preview_merge", {
        clips: exportClips,
      });
      const payload = parseBridgePayload<{ path: string; duration: number }>(raw);
      
      const mockClip: ClipPreviewItem = {
        id: "merged-preview",
        index: 9999,
        label: `Merged Preview (${mergeFilenameStem})`,
        range: `${mergeOrderedClips.length} clips combined`,
        sourceName: "Merged Preview",
        sourceSrc: "",
        sourceStart: 0,
        sourceEnd: payload.duration,
        previewStart: 0,
        previewEnd: payload.duration,
        path: payload.path,
        fps: 24,
      };

      setMergedPreviewClip(mockClip);
      setViewerClipId("merged-preview");
    } catch (e) {
      const errorText = readBridgeError(e);
      setError(errorText);
    } finally {
      setIsPreviewMerging(false);
    }
  }

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

    const exportClips = mergeOrderedClips.flatMap((clip) => {
      if (clip.isUnified && clip.segments) {
        return clip.segments;
      }
      return [
        {
          source: clip.path!,
          start: clip.sourceStart,
          end: clip.sourceEnd,
          index: clip.index,
          fps: clip.fps,
        },
      ];
    });

    setError(null);
    setIsExtracting(true);
    const mergeRow: ClipExportRow = {
      id: `merge-${mergeFilenameStem}`,
      label: `${mergeFilenameStem}.${mergeExt}`,
      range: `${mergeOrderedClips.length} clips`,
      status: "active",
    };
    setExportMinimized(false);
    setExportSession({
      mode: "merge",
      rows: [mergeRow],
      activeIndex: 0,
      activePercent: 0,
      activeFps: null,
      activeSpeed: null,
      activeMessage: `Merging ${exportClips.length} clips into ${mergeFilenameStem}.${mergeExt}...`,
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
    const selectedClips = displayedClips.filter((clip) => selectedClipIds.has(clip.id));
    if (selectedClips.length === 0) return;

    const rows: ClipExportRow[] = selectedClips.map((clip) => ({
      id: clip.id,
      label: clip.label,
      range: clip.range,
      status: "pending",
    }));

    setError(null);
    setIsExtracting(true);
    setExportMinimized(false);
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
          if (clip.isUnified && clip.segments) {
            await invoke<string>("clip_export_merged", {
              clips: clip.segments,
              outputDir: outDir,
              preset: exportFormat,
              qualityValue: clipQualitySpec(exportFormat) ? exportQuality[exportFormat] : null,
            });
          } else {
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
          }
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
      ? `${result.sceneCount} scenes ready - ${readyPreviewCount}/${displayedClips.length} previews cached`
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
            <span className="clip-compat-badge" title="Scene detection runs on a converted copy in the app's cache, but previews and exports still read your original file. The original is untouched.">
              {convertedBadgeNames.length === 1
                ? `Detecting from a converted copy of ${convertedBadgeNames[0]} (exports use the original)`
                : `Detecting from converted copies for ${convertedBadgeNames.length} files (exports use the originals)`}
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
                className={`clip-tool-button spring-motion ${hasClips && selectedCount === displayedClips.length ? "is-active" : ""}`}
                disabled={!hasClips || isExtracting}
                onClick={toggleAllClipSelection}
              >
                <CheckCircle2 size={18} strokeWidth={2} />
                <span>{hasClips && selectedCount === displayedClips.length ? "Clear selection" : "Select all clips"}</span>
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
            <>
              <button
                type="button"
                className="clip-confirm-button spring-motion"
                disabled={mergeOrder.length < 2 || isExtracting || isPreviewMerging}
                onClick={startPreviewMerge}
                title={mergeOrder.length < 2 ? "Select at least 2 clips to preview" : "Preview merged clips"}
              >
                {isPreviewMerging ? (
                  <Loader2 className="is-spinning" size={17} strokeWidth={2.1} />
                ) : (
                  <Play size={17} strokeWidth={2.1} />
                )}
                <span>
                  {mergeOrder.length < 2
                    ? "Select 2+ clips"
                    : isPreviewMerging ? "Merging..." : "Preview merge"}
                </span>
              </button>

              <button
                type="button"
                className="clip-confirm-button spring-motion"
                disabled={mergeOrder.length < 2 || isExtracting}
                onClick={unifySelectedInGrid}
                title={mergeOrder.length < 2 ? "Select at least 2 clips to merge in real time" : "Merge selected clips in real time into a single grid card"}
              >
                <Film size={17} strokeWidth={2.1} />
                <span>
                  {mergeOrder.length < 2
                    ? "Select 2+ clips"
                    : "Merge in real time"}
                </span>
              </button>

              <button
                type="button"
                className="clip-confirm-button spring-motion accent-glow"
                disabled={mergeOrder.length < 2 || isExtracting}
                onClick={startMergeExport}
                title={mergeOrder.length < 2 ? "Select at least 2 clips to merge" : `Merge into ${mergeFilenameStem}.${mergeExt}`}
              >
                <CheckCircle2 size={17} strokeWidth={2.1} />
                <span>
                  {mergeOrder.length < 2
                    ? "Select 2+ clips"
                    : `Merge into ${mergeFilenameStem}.${mergeExt}`}
                </span>
              </button>
            </>
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

        <button
          type="button"
          className="clip-primary-action spring-motion accent-glow"
          disabled={!canExtract}
          onClick={() => void startExtraction(undefined, { force: hasClips })}
        >
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
            title="If this is taking too long, the source may use a format the extractor can't read. Convert it to a compatible format."
          >
            Stuck? Convert to compatible format
          </button>
        )}
      </div>

      <div className="clip-extractor-stage">
        {hasClips ? (
          <Virtuoso
            ref={virtuosoRef}
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
                    onClick={(modifiers) => handleClipClick(clip, modifiers)}
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

        {hasClips && selectedClipIds.size > 0 && !mergeMode && (
          <div className="clip-jump-pill" role="group" aria-label="Jump through selected clips">
            <button
              type="button"
              className="clip-jump-pill-btn spring-motion"
              onClick={() => jumpToSelection("prev")}
              title="Jump to previous selected clip"
              aria-label="Jump to previous selected clip"
            >
              <ChevronUp size={16} strokeWidth={2.4} />
            </button>
            <span className="clip-jump-pill-count" aria-hidden="true">{selectedClipIds.size}</span>
            <button
              type="button"
              className="clip-jump-pill-btn spring-motion"
              onClick={() => jumpToSelection("next")}
              title="Jump to next selected clip"
              aria-label="Jump to next selected clip"
            >
              <ChevronDown size={16} strokeWidth={2.4} />
            </button>
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
          minimized={exportMinimized}
          onCancel={() => {
            clipCancellingRef.current = true;
            void invoke("cancel_clip");
          }}
          onClose={() => setExportSession(null)}
          onMinimize={() => setExportMinimized(true)}
          onRestore={() => setExportMinimized(false)}
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
                    : `→ ${mergeFilenameStem}.${mergeExt}`}
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

// nelux+NVDEC reliably hardware-decodes only these codecs. Anything else can
// hang in native C++ without raising, so the backend routes those files to a
// software decode -> TransNetV2 (still "gpu" mode) path instead of touching
// nelux/NVDEC. This set is now used only to log a "software decode will be
// used" heads-up before extraction — it no longer blocks the GPU path or pops
// the convert modal. Keep in sync with GPU_DECODABLE_CODECS / cuvid_decoder()
// in backend/clip_cli.py.
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
  // Shown as a warning under the dropdown when the option is selected
  // (typically the "why is this disabled" message).
  reason?: string;
  // Always-on dropdown description line for the option.
  description?: string;
};

// Mirrors preset_extension() in src-tauri/src/clips.rs. Used for UI labels so
// the displayed filename matches the file the backend writes.
function clipPresetExtension(format: ClipExportFormat): string {
  switch (format) {
    case "prores-lt":
    case "prores-hq":
    case "gpu-intra":
      return "mov";
    case "h264-cpu":
    case "hevc-cpu":
    case "h264-nvenc":
    case "av1-nvenc":
      return "mp4";
    case "lossless-cut":
      return "mkv";
    default:
      return "mov";
  }
}

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
    case "lossless-cut":
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
      value: "lossless-cut",
      label: "Lossless cut (no re-encode)",
      disabled: false,
      description: "Bit-exact stream copy of the original, fastest. Snaps to the nearest keyframe (not frame-accurate). Saved as MKV.",
    },
    {
      value: "prores-lt",
      label: "ProRes LT MOV",
      disabled: false,
      description: "Editing-friendly 10-bit intermediate, larger files. Re-encoded from the original.",
    },
    {
      value: "prores-hq",
      label: "ProRes HQ MOV",
      disabled: false,
      description: "Highest-quality 10-bit intermediate for NLEs, largest files. Re-encoded from the original.",
    },
    {
      value: "h264-cpu",
      label: "H.264 CPU MP4",
      disabled: false,
      description: "Widely compatible delivery codec (libx264). Lower CRF = higher quality.",
    },
    {
      value: "hevc-cpu",
      label: "HEVC CPU MP4",
      disabled: false,
      description: "Smaller files than H.264 at equal quality (libx265). Lower CRF = higher quality.",
    },
    {
      value: "gpu-intra",
      label: "GPU Intra MOV",
      disabled: !gpuMode || !gpuIntraReady,
      reason: !gpuMode ? cpuModeReason : gpuIntraReady ? undefined : statusMessage,
      description: "All-intra HEVC 10-bit via NVENC, edit-friendly and fast on RTX.",
    },
    {
      value: "h264-nvenc",
      label: "H.264 NVENC MP4",
      disabled: !gpuMode || !h264NvencReady,
      reason: !gpuMode ? cpuModeReason : h264NvencReady ? undefined : "Bundled FFmpeg does not expose h264_nvenc on this machine.",
      description: "Fast GPU H.264 delivery encode. Lower CQ = higher quality.",
    },
    {
      value: "av1-nvenc",
      label: "AV1 NVENC MP4",
      disabled: !gpuMode || !av1NvencReady,
      reason: !gpuMode ? cpuModeReason : av1NvencReady ? undefined : "Bundled FFmpeg does not expose av1_nvenc on this machine.",
      description: "Fast GPU AV1 delivery encode, smallest files. Lower CQ = higher quality.",
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
