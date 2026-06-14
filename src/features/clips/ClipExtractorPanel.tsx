import React from "react";
import { createPortal } from "react-dom";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { ArrowRight, CheckCircle2, ChevronDown, ChevronUp, Clapperboard, Film, Info, Loader2, Scissors, Upload, X, Zap } from "lucide-react";
import { Dropdown } from "../../components/Dropdown";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import {
  CLIP_AUDIO_SETTINGS_KEY,
  CLIP_COLUMN_OPTIONS,
  CLIP_PREVIEW_BATCH_SIZE,
  CLIP_PREVIEW_CPU_BATCH_CONCURRENCY,
  CLIP_PREVIEW_GPU_BATCH_CONCURRENCY,
  FAST_SCROLL_VELOCITY_PX_PER_FRAME,
  GRID_VIDEO_OVERSCAN_ROWS,
  MAX_GRID_AUTOPLAYERS,
  MAX_GRID_VIDEO_PLAYERS_CEILING,
  PREVIEW_PLAY_AREA_MARGIN_PX,
} from "../../lib/constants";

// How long after the scroll velocity drops below the fast-fling threshold the
// `fastScrolling` flag stays set before clearing (ms). One short settle so the
// geometry mount set recomputes promptly when the user releases a fling.
const FAST_SCROLL_SETTLE_MS = 140;
/* DEV TOOLS: featherweight tunables — the grid reads margins / max-video cap /
 * the DEV featherweight override from this store. In prod the store equals the
 * baked constants, so reading it is a constant read. */
import { usePreviewTunables } from "../../dev/previewTunables";
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
  PlaybackPlan,
} from "../../types/clip";
import type { ConversionProgress, VideoControlSpec, VideoGpuStatus } from "../../types/conversion";
import { ClipCompatConvertModal } from "./ClipCompatConvertModal";
import { ClipExportProgressModal } from "./ClipExportProgressModal";
import type { ClipExportRow, ClipExportSession } from "./ClipExportProgressModal";
import { ClipPreviewScroller } from "./ClipPreviewScroller";
import { ClipPreviewTile, offsetMarginWindow } from "./ClipPreviewTile";
import { SceneViewerModal } from "./SceneViewerModal";

// Currently dead code : see FINDINGS.md. Moved here unchanged during the
// main.tsx split to keep that work move-only.
void readClipAudioSettings;
void writeClipAudioSettings;
void formatPreciseClipTime;

/** The export-bound / flag-off segment shape consumed by the Rust merge/export
 * commands (clip_preview_merge, clip_export_merged). */
type ClipSegment = NonNullable<ClipPreviewItem["segments"]>[number];

/**
 * Flatten a list of clips into the ordered constituent-segment array the
 * backend merge/export commands consume.
 *
 * INVARIANTS (do not break — these keep the output byte-identical to the four
 * inline flatMaps this replaced, on which export correctness depends):
 *  - ORDER IS PRESERVED VERBATIM. Segments come out in the exact order the
 *    input clips appear, and within a unified clip in its STORED segments-array
 *    order. NEVER sort by index, source, time, or anything else.
 *  - A unified clip's already-built `segments` are flattened RECURSIVELY and
 *    passed through BY REFERENCE (never rebuilt), so their object shape stays
 *    exactly `{ source, start, end, index, fps }`. (Stored segments are always
 *    leaf objects, so the recursion bottoms out immediately — but recursing
 *    keeps the helper correct if nested unified clips are ever passed in.)
 *  - A single (non-unified) clip emits exactly ONE leaf segment with property
 *    order `{ source, start, end, index, fps }`, identical to the prior inline
 *    object literals. `clip.path` is asserted non-null exactly as before.
 */
function buildSegments(clips: ClipPreviewItem[]): ClipSegment[] {
  return clips.flatMap((clip) =>
    clip.isUnified && clip.segments
      ? buildSegmentsFromStored(clip.segments)
      : [
          {
            source: clip.path!,
            start: clip.sourceStart,
            end: clip.sourceEnd,
            index: clip.index,
            fps: clip.fps,
          },
        ],
  );
}

/** Recurse through a stored segments array, preserving array order and passing
 * each leaf segment through unchanged. Stored segments are already flat leaf
 * objects, so this is a verbatim pass-through today; it stays recursive so a
 * future nested-unified shape would still flatten in stored order. */
function buildSegmentsFromStored(segments: ClipSegment[]): ClipSegment[] {
  return segments.flatMap((segment) => {
    const nested = (segment as { segments?: ClipSegment[] }).segments;
    return Array.isArray(nested) ? buildSegmentsFromStored(nested) : [segment];
  });
}

/**
 * CONTIGUOUS-MERGE DETECTION (Step D) — the LOCKED definition, evaluated over a
 * unified clip's segments in their STORED ARRAY ORDER (never mergeOrder, which is
 * reset to [] right after a merge). A merge is contiguous when EVERY pair of
 * adjacent stored segments:
 *   - shares the exact same `source`, AND
 *   - has equal `fps` (so the frame-duration tolerance is well defined), AND
 *   - is adjacent in source time: |seg[i].end - seg[i+1].start| < 1/fps.
 *
 * A contiguous merge can therefore be replayed as ONE continuous decode window
 * on the single shared source (one decoder, zero seeks). NON-contiguous merges
 * return null and keep their current poster / first-scene behavior (the
 * segmented playlist arrives in a later stage). A 0/1-segment list is never
 * treated as a contiguous merge.
 */
function isContiguousMerge(segments: ClipSegment[]): boolean {
  if (!segments || segments.length < 2) return false;
  const first = segments[0];
  const fps = first.fps;
  if (!Number.isFinite(fps) || fps <= 0) return false;
  const frameTolerance = 1 / fps;
  for (let i = 0; i < segments.length - 1; i++) {
    const a = segments[i];
    const b = segments[i + 1];
    if (a.source !== b.source || b.source !== first.source) return false;
    if (a.fps !== fps || b.fps !== fps) return false;
    if (Math.abs(a.end - b.start) >= frameTolerance) return false;
  }
  return true;
}

/**
 * The single continuous offset-playback window for a CONTIGUOUS merge, in
 * file-relative seconds on the shared source. The opening edge reuses the SHARED
 * margin helper on the FIRST segment (so the scene-0 head exemption keeps a
 * merge that begins at the file head from losing its opening frames), and the
 * closing edge reuses it on the LAST segment. Inner seams are skipped entirely —
 * the segments are adjacent in source time, so [firstStart, lastEnd] is exactly
 * the joined range. Caller must have verified isContiguousMerge first.
 */
function contiguousMergeWindow(
  segments: ClipSegment[],
  startMarginFrames: number,
  endMarginFrames: number,
): { previewStart: number; previewEnd: number } {
  const first = segments[0];
  const last = segments[segments.length - 1];
  const head = offsetMarginWindow(first.start, first.end, first.fps, startMarginFrames, endMarginFrames);
  const tail = offsetMarginWindow(last.start, last.end, last.fps, startMarginFrames, endMarginFrames);
  return { previewStart: head.startSec, previewEnd: tail.endSec };
}

/**
 * CENTRAL, GEOMETRY-DRIVEN, HARD-CAPPED mount-set computation (pure).
 *
 * The SOLE authority for which grid tiles may mount a live offset <video>. It
 * REPLACES the retired per-tile IntersectionObserver mount decision so the
 * live-<video> union can never exceed the EFFECTIVE cap (clamped to
 * MAX_GRID_VIDEO_PLAYERS_CEILING by the caller). Computed from scroll GEOMETRY
 * only — never from Virtuoso's inflated overscan range and never from
 * offsetMetrics.activeCount (a feedback loop).
 *
 *  1. Eligible band = the visible rows EXTENDED by `marginRows` on each side (the
 *     250px pre-play pre-warm preserved as rows).
 *  2. The EFFECTIVE cap is floored at the count of tiles ACTUALLY visible
 *     (visibleTileCount = visible-row count × cols, clamped to the real clip
 *     count) so a tall/dense viewport (e.g. 16–24 visible tiles at 4 cols)
 *     never leaves a still-visible tile dark when the knob cap (prod 12) is
 *     below the visible band. The incoming `cap` (the knob value, already
 *     ceiling-clamped by the caller) can only RAISE the cap above that floor to
 *     add pre-warm headroom; MAX_GRID_VIDEO_PLAYERS_CEILING still bounds the top.
 *  3. Grant in TWO phases: (a) every VISIBLE tile unconditionally — the floor
 *     guarantees they fit — then (b) fill the remaining budget with PRE-WARM
 *     tiles, walking OUTWARD from the viewport-center row (nearest first) until
 *     the effective cap is reached. Granting visible tiles in their own phase
 *     (not via the center walk) is what prevents a nearer-to-center pre-warm tile
 *     from stealing the last budget slot from a farther-but-still-VISIBLE tile on
 *     an asymmetric band (the cap-below-visible dead-zone).
 *
 * Extracted as a pure function (no React) so the hard cap can be unit-tested
 * deterministically across a scripted fast-fling (jsdom has no real Virtuoso
 * geometry). The `geometryMountVideoIds` memo calls this verbatim.
 */
export function computeGeometryMountVideoIds(params: {
  clipRows: { id: string }[][];
  cap: number;
  rowHeightPx: number;
  viewportHeightPx: number;
  scrollTopPx: number;
  rowsInView: number;
  marginPx: number;
}): Set<string> {
  const { clipRows, cap, rowHeightPx, viewportHeightPx, scrollTopPx, rowsInView, marginPx } = params;
  const ids = new Set<string>();
  if (clipRows.length <= 0 || cap <= 0) return ids;
  const lastRow = clipRows.length - 1;

  let firstVisibleRow: number;
  let lastVisibleRow: number;
  if (rowHeightPx > 0 && viewportHeightPx > 0) {
    firstVisibleRow = Math.floor(scrollTopPx / rowHeightPx);
    lastVisibleRow = Math.ceil((scrollTopPx + viewportHeightPx) / rowHeightPx) - 1;
  } else {
    // Geometry not measured yet (initial / pre-mount): fall back to the top
    // rows that fill the viewport (rowsInView), or the first row at minimum.
    firstVisibleRow = 0;
    lastVisibleRow = (rowsInView > 0 ? rowsInView : 1) - 1;
  }

  // VIEWPORT-AWARE CAP FLOOR. Count the tiles ACTUALLY intersecting the viewport
  // (the visible-row span × that span's columns, clamped to the real clip count).
  // The effective cap is floored at this count so EVERY visible tile always
  // mounts — a tall/dense viewport (~16–24 tiles at 4 cols) is never left with
  // dark-but-visible tiles when the knob cap (prod 12) sits below the visible
  // band. The incoming `cap` can only RAISE the cap above this floor (pre-warm
  // headroom); the caller has already clamped it to MAX_GRID_VIDEO_PLAYERS_CEILING.
  const clampedFirstVisible = Math.max(0, Math.min(firstVisibleRow, lastRow));
  const clampedLastVisible = Math.max(clampedFirstVisible, Math.min(lastVisibleRow, lastRow));
  let visibleTileCount = 0;
  for (let r = clampedFirstVisible; r <= clampedLastVisible; r += 1) {
    visibleTileCount += clipRows[r]?.length ?? 0;
  }
  // The hard ceiling bounds the top even above the visible-tile floor: in the
  // pathological case where the viewport shows MORE tiles than the ceiling
  // (only reachable at a tiny row height / huge viewport), we accept a dead-zone
  // rather than blow past the decoder safety limit. `cap` is already
  // ceiling-clamped by the caller; re-clamp here so the floor can't escape it.
  const effectiveCap = Math.min(
    MAX_GRID_VIDEO_PLAYERS_CEILING,
    Math.max(cap, visibleTileCount),
  );

  // PHASE 1 — grant EVERY VISIBLE tile first. Because effectiveCap is floored at
  // visibleTileCount, this fits within the cap (except the pathological case
  // where the viewport itself shows more tiles than the ceiling — then we honor
  // the ceiling, granting the visible tiles nearest the top first and accepting a
  // dead-zone rather than exceeding the decoder safety limit). Granting visible
  // tiles unconditionally — NOT via the center-distance walk — is what guarantees
  // no still-visible tile is dropped in favor of a nearer-to-center PRE-WARM tile
  // on an asymmetric band (the DEFECT-A dead-zone).
  for (let r = clampedFirstVisible; r <= clampedLastVisible; r += 1) {
    for (const clip of clipRows[r] ?? []) {
      ids.add(clip.id);
      if (ids.size >= effectiveCap) return ids;
    }
  }

  // PHASE 2 — fill the remaining budget (effectiveCap - visible) with PRE-WARM
  // tiles. Extend the band by the pre-play margin (250px -> rows) on each side so
  // a tile is already decoding by the time it scrolls into view, then walk
  // OUTWARD from the viewport-center row (nearest first) so the discretionary
  // headroom favors the rows closest to the middle of what the user sees. Visible
  // rows are skipped here (already granted in phase 1).
  const marginRows = rowHeightPx > 0 ? Math.ceil(marginPx / rowHeightPx) : 1;
  const bandFirst = Math.max(0, Math.min(firstVisibleRow - marginRows, lastRow));
  const bandLast = Math.max(bandFirst, Math.min(lastVisibleRow + marginRows, lastRow));
  const centerRow = Math.max(
    bandFirst,
    Math.min(Math.floor((firstVisibleRow + lastVisibleRow) / 2), bandLast),
  );
  for (let offset = 0; bandFirst + offset <= bandLast || centerRow - offset >= bandFirst; offset += 1) {
    const rowsToVisit = offset === 0 ? [centerRow] : [centerRow - offset, centerRow + offset];
    let visitedAny = false;
    for (const r of rowsToVisit) {
      if (r < bandFirst || r > bandLast) continue;
      visitedAny = true;
      // Visible rows are already granted; only pre-warm rows add tiles here.
      if (r >= clampedFirstVisible && r <= clampedLastVisible) continue;
      for (const clip of clipRows[r] ?? []) {
        ids.add(clip.id);
        if (ids.size >= effectiveCap) return ids;
      }
    }
    // Stop once the outward walk has exhausted the band on both sides.
    if (!visitedAny && centerRow - offset < bandFirst && centerRow + offset > bandLast) break;
  }
  return ids;
}

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
  /* DEV TOOLS: measured scroll-viewport geometry for viewport-fill decoder
   * windowing. Only populated in featherweight mode (the ResizeObserver below
   * is gated on featherweightActive && hasClips); flag-off these stay 0 and the
   * video budget falls back to the tunable seed, so behavior is unchanged. */
  const [viewportHeightPx, setViewportHeightPx] = React.useState(0);
  const [viewportWidthPx, setViewportWidthPx] = React.useState(0);
  /* DEV TOOLS (featherweight only): the scroller's current scrollTop, throttled
   * to one update per rAF. Drives the central geometry-driven mount set (the SOLE
   * authoritative, capped set of tiles allowed to mount a live offset <video>).
   * Flag-off this stays 0 and is never read. */
  const [scrollTopPx, setScrollTopPx] = React.useState(0);
  /* DEV TOOLS (featherweight only): transient FAST-FLING flag. Set from real
   * scroll VELOCITY (|scrollTop delta| per rAF frame, NOT Virtuoso's isScrolling,
   * which is true for slow scroll too). While true the panel grants NO new
   * offset-<video> mounts (it holds the last committed set) so a fling allocates
   * no new decoders; cleared ~140ms after velocity drops, at which point the
   * geometry-based set recomputes immediately (no dead-zone). */
  const [fastScrolling, setFastScrolling] = React.useState(false);
  // Held as state (not a ref) so the ResizeObserver effect re-runs the moment
  // Virtuoso hands us the scroll element via scrollerRef — a ref wouldn't
  // re-trigger the effect and the first measurement could be missed.
  const [scrollerEl, setScrollerEl] = React.useState<HTMLElement | null>(null);
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
  /* DEV TOOLS: featherweight offset-playback wiring. ALL gated behind the
   * persisted `featherweight_previews` config flag — when off, none of the maps
   * below ever populate and the grid renders byte-for-byte as before.
   *  - playbackPlans:    sourcePath -> PlaybackPlan (probe once per distinct source).
   *  - sourceProxyPaths: sourcePath -> resolved proxy file path (proxy plans only).
   * Mirrors the detectorProxies Record state pattern. */
  const [featherweightPreviews, setFeatherweightPreviews] = React.useState(false);
  /* Max preview-proxy height (Settings "Preview quality"). 0 = Source/unlimited.
   * Threaded into clip_playback_plan + build_source_proxy as the `height` invoke
   * arg. kickProxyBuild is a []-deps useCallback that reads only refs, so mirror
   * the height into scenePreviewHeightRef to dodge the stale-closure trap. */
  const [scenePreviewHeight, setScenePreviewHeight] = React.useState(240);
  const scenePreviewHeightRef = React.useRef(240);
  React.useEffect(() => {
    scenePreviewHeightRef.current = scenePreviewHeight;
  }, [scenePreviewHeight]);
  const [playbackPlans, setPlaybackPlans] = React.useState<Record<string, PlaybackPlan>>({});
  const [sourceProxyPaths, setSourceProxyPaths] = React.useState<Record<string, string>>({});
  // In-flight guards so we kick exactly one plan / one proxy build per source.
  const planInFlightRef = React.useRef<Set<string>>(new Set());
  const proxyInFlightRef = React.useRef<Set<string>>(new Set());
  /* DEV TOOLS: sources whose proxy build FAILED. A failed build can't be
   * "pending" (it will never produce a path), so the graceful-poster decision
   * must treat these as settled-with-no-source -> static merged poster, not an
   * indefinite spinner. Cleared whenever the per-source maps reset. */
  const failedProxiesRef = React.useRef<Set<string>>(new Set());
  /* Sources whose proxy must be REBUILT (not cache-hit) on the next build —
   * populated by "extract again" (force) so a stale/buggy proxy can't survive a
   * full re-extraction. Consumed (one-shot) when that source's proxy build fires. */
  const forceProxyRebuildRef = React.useRef<Set<string>>(new Set());
  /* Per-source generation guard. A late resolve from an OLD plan/proxy run (e.g.
   * a non-forced build still in flight when "extract again" kicks a forced one)
   * must not clobber the CURRENT run's state or delete its in-flight markers.
   * Each kick captures the source's epoch; bump-before-clear on every
   * invalidating event makes the stale closure's captured epoch go stale so its
   * .then/.catch/.finally early-return. */
  const sourceEpochRef = React.useRef<Map<string, number>>(new Map());
  const bumpSourceEpoch = React.useCallback((source: string) => {
    sourceEpochRef.current.set(source, (sourceEpochRef.current.get(source) ?? 0) + 1);
  }, []);
  const currentSourceEpoch = (source: string) => sourceEpochRef.current.get(source) ?? 0;
  // DEV tunables: margins + max-video cap. In prod this equals the baked
  // constants (the DEV panel is the only mutator). The DEV featherweight toggle
  // also force-enables the feature even when the config flag is off.
  const tunables = usePreviewTunables();
  const featherweightActive = featherweightPreviews || tunables.featherweightEnabled;
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
  /* Real-time merge animation. When the user merges the selected clips into one
   * card, we snapshot the on-screen rect (+ thumbnail) of each selected tile and
   * fly fixed-position ghost clones into their shared centre while the new
   * unified card springs in (justMergedId). Both are torn down on one timer.
   * Ghosts are rendered in a body portal so they're immune to any transformed
   * ancestor; the whole thing no-ops gracefully if rects can't be measured. */
  type MergeGhost = { id: string; left: number; top: number; width: number; height: number; thumb: string | null };
  const [mergeGhosts, setMergeGhosts] = React.useState<{ ghosts: MergeGhost[]; tx: number; ty: number } | null>(null);
  const [justMergedId, setJustMergedId] = React.useState<string | null>(null);
  const mergeAnimTimerRef = React.useRef<number | null>(null);
  React.useEffect(
    () => () => {
      if (mergeAnimTimerRef.current != null) window.clearTimeout(mergeAnimTimerRef.current);
    },
    [],
  );
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

  // Live-sync the featherweight gate when the Settings toggle flips it, so an
  // open grid switches between offset-playback and the classic WebP path
  // without a remount (mirrors the clip-hover-preview-changed listener).
  React.useEffect(() => {
    const handler = (e: Event) => {
      setFeatherweightPreviews((e as CustomEvent<{ enabled: boolean }>).detail.enabled);
    };
    window.addEventListener("featherweight-previews-changed", handler);
    return () => window.removeEventListener("featherweight-previews-changed", handler);
  }, []);

  // Live-sync the preview-quality cap when the Settings dropdown changes it, so an
  // open grid re-probes the playback plan and rebuilds the proxy at the new height
  // without a remount (mirrors the featherweight-previews-changed listener).
  React.useEffect(() => {
    const handler = (e: Event) => {
      setScenePreviewHeight((e as CustomEvent<{ height: number }>).detail.height);
    };
    window.addEventListener("scene-preview-height-changed", handler);
    return () => window.removeEventListener("scene-preview-height-changed", handler);
  }, []);

  async function refreshClipMode() {
    try {
      const raw = await invoke<string>("get_config");
      const payload = parseBridgePayload<AppConfig>(raw);
      setClipMode(payload.clip_extraction_mode ?? "gpu");
      setHoverPlayOnly(payload.clip_hover_preview ?? false);
      /* Featherweight previews are the default; only an explicit `false` saved
       * by the Settings toggle routes back to the classic WebP/scene_clip path. */
      setFeatherweightPreviews(payload.featherweight_previews ?? true);
      setScenePreviewHeight(payload.scene_preview_height ?? 240);
      setClipModeLoaded(true);
    } catch (configError) {
      console.error("Could not load clip extraction mode:", configError);
      // Keep featherweight previews on by default if the config read fails,
      // matching SceneViewerModal — a transient failure shouldn't silently
      // drop the grid back to the classic path.
      setFeatherweightPreviews(true);
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
    /* NOTE: per-source plan/proxy state is intentionally NOT reset here. This
     * effect fires on every result?.input change — including when detection's
     * results land mid-extraction — and the proxy build is now kicked early
     * (concurrent with detection in startExtraction). Resetting here would wipe
     * the in-flight proxy (or its proxyInFlightRef marker) the moment results
     * arrive, leaving tiles stuck. The plan/proxy reset now happens ONCE at
     * extraction start (startExtraction) and on new source selection (acceptVideos). */
  }, [result?.input]);

  /* DEV TOOLS: listen for proxy-build progress so a finished proxy flips its
   * tiles from WebP poster to live offset <video>. The terminal "complete" tick
   * is matched by the source becoming present in sourceProxyPaths (set when the
   * build_source_proxy promise resolves below); this listener only needs to keep
   * the build observable. Always mounted but inert until a build emits. */
  const [proxyProgress, setProxyProgress] = React.useState<Record<string, number>>({});
  React.useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void listen<{ sourcePath: string; percent: number; stage: string }>(
      "proxy-progress",
      (event) => {
        if (cancelled) return;
        const { sourcePath, percent } = event.payload;
        setProxyProgress((current) => ({ ...current, [sourcePath]: percent }));
      },
    ).then((cleanup) => {
      if (cancelled) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

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
    /* DEV TOOLS: a brand-new source selection invalidates any prior per-source
     * plan/proxy/progress/failure state so the graceful-poster decision (and the
     * concurrent proxy build) starts clean. The result effect no longer resets
     * these, so a new source must clear them here. */
    setPlaybackPlans({});
    setSourceProxyPaths({});
    setProxyProgress({});
    for (const s of new Set([...proxyInFlightRef.current, ...planInFlightRef.current])) bumpSourceEpoch(s);
    planInFlightRef.current.clear();
    proxyInFlightRef.current.clear();
    failedProxiesRef.current.clear();
    forceProxyRebuildRef.current.clear();

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
      /* DEV TOOLS: resolve the offset-playback source from the per-source plan.
       * Only set once the plan is known (and, for proxy plans, once the proxy
       * file has been built); absent => tile keeps the WebP poster. Gated on
       * featherweightActive so flag-off leaves playbackSrc undefined entirely. */
      let playbackSrc: string | undefined;
      let playbackMode: "direct" | "proxy" | undefined;
      if (featherweightActive) {
        const plan = playbackPlans[scene.source];
        const proxyPath = sourceProxyPaths[scene.source];
        if (proxyPath) {
          // Play the 240p short-GOP proxy whenever it's built — even for "direct"
          // sources — so ~20 concurrent decoders don't starve rVFC (seam bleed).
          playbackSrc = convertFileSrc(proxyPath);
          playbackMode = "proxy";
        } else if (plan?.mode === "direct") {
          // Until the proxy finishes building, a friendly source still plays direct so
          // the grid isn't blank; it swaps to the proxy when ready.
          playbackSrc = convertFileSrc(scene.source);
          playbackMode = "direct";
        }
        // else: unfriendly source, proxy not built yet -> poster until ready.
      }
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
        playbackSrc,
        playbackMode,
      };
    });
  }, [result, previewStates, featherweightActive, playbackPlans, sourceProxyPaths]);

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

        // Stored segments (array order is verbatim; never sorted) — the single
        // source of truth for the contiguous-merge fast path below.
        const segments = buildSegments(constituentClips);

        const unified: ClipPreviewItem = {
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
          segments,
        };

        /* STEP D — CONTIGUOUS MERGE FAST PATH. All gated on featherweightActive;
         * flag-off the object above is returned byte-for-byte unchanged.
         *
         * When the merge is contiguous (all segments same source, adjacent in
         * source + stored-array order at equal fps), route it through the
         * previewStart/End-aware OffsetVideoLayer as ONE continuous window on the
         * single shared source: resolve that source's proxy/direct playbackSrc
         * exactly as single clips do, then set previewStart = first segment's
         * margined start (head exemption applies) and previewEnd = last segment's
         * margined end. The synthetic summary sourceStart/sourceEnd stay as-is.
         *
         * NON-contiguous merges get NO playbackSrc this stage — they keep their
         * current poster / first-scene behavior; the segmented playlist arrives
         * in a later stage. */
        if (featherweightActive) {
          const contiguous = isContiguousMerge(segments);
          unified.isContiguous = contiguous;
          unified.segmentCount = segments.length;

          if (contiguous) {
            const sharedSource = segments[0].source;
            const plan = playbackPlans[sharedSource];
            const proxyPath = sourceProxyPaths[sharedSource];
            if (proxyPath) {
              unified.playbackSrc = convertFileSrc(proxyPath);
              unified.playbackMode = "proxy";
            } else if (plan?.mode === "direct") {
              unified.playbackSrc = convertFileSrc(sharedSource);
              unified.playbackMode = "direct";
            }
            // else: unfriendly source, proxy not built yet -> poster until ready
            // (matches the single-clip resolution exactly).

            const mergeWindow = contiguousMergeWindow(
              segments,
              tunables.startMarginFrames,
              tunables.endMarginFrames,
            );
            unified.previewStart = mergeWindow.previewStart;
            unified.previewEnd = mergeWindow.previewEnd;
          } else {
            /* STEP A — NON-CONTIGUOUS MERGE PLAYBACK. The segments jump around
             * the SAME source (single-source rule), so there's no single joined
             * window; instead the segmented playlist seeks between per-segment
             * windows on ONE shared proxy/direct source.
             *
             * (1) Resolve the shared source's top-level playbackSrc/playbackMode
             *     with the EXACT proxy-then-direct resolution single clips and the
             *     contiguous path use (all segments share one source, so resolve
             *     from segments[0].source). This top-level src is what the
             *     playlist player decodes; per-segment playbackSrc is left unset
             *     since every segment plays off this same source.
             * (2) Populate EACH segment's [previewStart, previewEnd] from the
             *     shared margin helper on the segment's OWN file-relative
             *     start/end (so the per-segment head exemption carries). Build
             *     fresh segment objects so the export-bound stored shape (raw
             *     start/end, stored array order) is never mutated. */
            const sharedSource = segments[0].source;
            const plan = playbackPlans[sharedSource];
            const proxyPath = sourceProxyPaths[sharedSource];
            if (proxyPath) {
              unified.playbackSrc = convertFileSrc(proxyPath);
              unified.playbackMode = "proxy";
            } else if (plan?.mode === "direct") {
              unified.playbackSrc = convertFileSrc(sharedSource);
              unified.playbackMode = "direct";
            }
            // else: unfriendly source, proxy not built yet -> poster until ready
            // (matches the single-clip / contiguous resolution exactly).

            unified.segments = segments.map((seg) => {
              const win = offsetMarginWindow(
                seg.start,
                seg.end,
                seg.fps,
                tunables.startMarginFrames,
                tunables.endMarginFrames,
              );
              return { ...seg, previewStart: win.startSec, previewEnd: win.endSec };
            });
          }
        }

        return unified;
      }
    }).filter(Boolean);
  }, [
    clips,
    activeGridItems,
    previewStates,
    featherweightActive,
    playbackPlans,
    sourceProxyPaths,
    tunables.startMarginFrames,
    tunables.endMarginFrames,
  ]);

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
  // Bake progress must count SETTLED previews, not just ready ones. A preview
  // that permanently errors is terminal and the bake scheduler never retries it,
  // so excluding it would peg the bar below 100% forever after a single failure.
  // Treat both "ready" and "error" as done for progress purposes.
  const settledPreviewCount = React.useMemo(
    () =>
      displayedClips.reduce((count, clip) => {
        const status = clip.previewState?.status;
        return count + (status === "ready" || status === "error" ? 1 : 0);
      }, 0),
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

  /* DEV TOOLS: measure the scroll viewport so the offset-<video> budget can be
   * sized to FILL the visible area (+ a small overscan) instead of a fixed cap.
   * Virtuoso's scrollerRef hands us the real scroll element (the
   * ClipPreviewScroller div). Only observe in featherweight mode with clips —
   * flag-off this never attaches and the geometry stays 0. */
  React.useEffect(() => {
    if (!featherweightActive || !hasClips || !scrollerEl || typeof ResizeObserver === "undefined") {
      // Reset so a flag flip / cleared grid / lost element can't leave a stale
      // measurement feeding the budget memo (memo then falls back to tunable).
      setViewportHeightPx(0);
      setViewportWidthPx(0);
      return;
    }
    const el = scrollerEl;
    const measure = () => {
      setViewportHeightPx(el.clientHeight);
      setViewportWidthPx(el.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
    // scrollerEl changes when Virtuoso (re)mounts the scroll element — e.g. when
    // hasClips toggles — so re-running on it picks up the fresh target.
  }, [featherweightActive, hasClips, scrollerEl]);

  /* DEV TOOLS (featherweight only): track the scroller's scrollTop AND its
   * per-frame velocity so the central mount set can be computed from real scroll
   * GEOMETRY and FAST-FLING suppression can key on actual velocity (not
   * Virtuoso's isScrolling, which is true for slow scroll too).
   * THROTTLED to one state update per requestAnimationFrame — a raw scroll
   * handler would re-render the panel on every wheel tick. Flag-off (or before
   * Virtuoso hands us the element) this never attaches; scrollTop stays 0 and
   * fastScrolling stays false. */
  React.useEffect(() => {
    if (!featherweightActive || !hasClips || !scrollerEl) {
      setScrollTopPx(0);
      setFastScrolling(false);
      return undefined;
    }
    const el = scrollerEl;
    let rafId = 0;
    let lastTopPx = el.scrollTop;
    let settleTimer = 0;
    const clearSettle = () => {
      if (settleTimer) {
        window.clearTimeout(settleTimer);
        settleTimer = 0;
      }
    };
    const onScroll = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        const top = el.scrollTop;
        // Velocity = px moved since the previous rAF sample. A real fling moves
        // many px/frame; a careful drag stays well under the threshold.
        const velocity = Math.abs(top - lastTopPx);
        lastTopPx = top;
        setScrollTopPx(top);
        if (velocity > FAST_SCROLL_VELOCITY_PX_PER_FRAME) {
          setFastScrolling(true);
          // Re-arm the settle timer on every fast frame so the flag clears only
          // ~140ms AFTER the fling actually slows below the threshold.
          clearSettle();
          settleTimer = window.setTimeout(() => {
            settleTimer = 0;
            setFastScrolling(false);
          }, FAST_SCROLL_SETTLE_MS);
        }
      });
    };
    // Seed the resting scrollTop immediately (the element may already be
    // scrolled when this effect re-attaches after a remount).
    lastTopPx = el.scrollTop;
    setScrollTopPx(el.scrollTop);
    setFastScrolling(false);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (rafId) cancelAnimationFrame(rafId);
      clearSettle();
    };
  }, [featherweightActive, hasClips, scrollerEl]);

  /* DEV TOOLS: derive per-row pixel geometry from the real CSS layout so we can
   * count how many rows fill the viewport. Mirrors src/styles/clips.css:
   *   .clip-preview-grid-scroller { padding-right: 6px }
   *   .clip-preview-grid-row { gap: 12px; padding-bottom: 12px }
   *   .clip-preview-tile { aspect-ratio: 16 / 9 }
   */
  // HOISTED out of rowsInView so the viewport-tight visible-row floor can reuse
  // the same per-row pixel height. 0 when geometry isn't measured yet.
  const rowHeightPx = React.useMemo(() => {
    if (viewportHeightPx <= 0 || viewportWidthPx <= 0) return 0;
    const ROW_GAP = 12; // column gap == row padding-bottom
    const SCROLLBAR_PAD = 6; // scroller padding-right
    const usableWidth = viewportWidthPx - SCROLLBAR_PAD;
    if (usableWidth <= 0) return 0;
    const tileWidth = (usableWidth - (gridCols - 1) * ROW_GAP) / gridCols;
    if (tileWidth <= 0) return 0;
    const tileHeight = (tileWidth * 9) / 16;
    const rowHeight = tileHeight + ROW_GAP; // tile + padding-bottom between rows
    return rowHeight > 0 ? rowHeight : 0;
  }, [viewportHeightPx, viewportWidthPx, gridCols]);

  const rowsInView = React.useMemo(() => {
    if (rowHeightPx <= 0 || viewportHeightPx <= 0) return 0;
    return Math.ceil(viewportHeightPx / rowHeightPx);
  }, [rowHeightPx, viewportHeightPx]);

  /* DEV TOOLS (featherweight only) — CENTRAL, GEOMETRY-DRIVEN, HARD-CAPPED mount
   * set. This is the SOLE authority for which tiles may mount a live offset
   * <video>; it REPLACES the retired per-tile IntersectionObserver mount decision
   * (useInPlayArea) so the live-<video> union can never exceed a known cap.
   *
   * Computed from scroll GEOMETRY (scrollTop + measured rowHeight + viewport
   * height), NEVER from Virtuoso's inflated overscan range and NEVER from
   * offsetMetrics.activeCount (which is incremented AFTER a <video> mounts — a
   * feedback loop). Recomputed CONTINUOUSLY (cheap) so slow scroll pre-warms.
   *
   *  1. Eligible band = the visible rows EXTENDED by `marginRows` on each side
   *     (the 250px pre-play pre-warm preserved as rows).
   *  2. The effective cap is FLOORED at the visible-tile count so every visible
   *     tile always mounts (no cap-below-visible dead-zone), and ceiling-bounded
   *     at the top:
   *       effectiveCap = min(
   *         MAX_GRID_VIDEO_PLAYERS_CEILING,
   *         max(visibleTileCount, max(1, tunables.maxGridVideoPlayers)))
   *     `tunables.maxGridVideoPlayers` (the repurposed live knob, dialed in the
   *     DEV panel against the activeCount readout) can only RAISE the cap above
   *     the visible floor to add pre-warm headroom; the hard ceiling always
   *     bounds the top. The floor + ceiling clamp lives inside
   *     computeGeometryMountVideoIds; this memo passes the ceiling-clamped knob.
   *  3. From the eligible tiles, ORDER by distance from the viewport-CENTER row
   *     and take the nearest up-to-effectiveCap (so when the cap is below the
   *     band, the visible tiles — nearest the center — are granted first).
   *
   * Fast-fling SUPPRESSION is applied OUTSIDE this memo (see mayMountVideoIds):
   * while `fastScrolling` is true the panel holds the last committed set so a
   * fling allocates no NEW decoders; this memo keeps computing eligibility so the
   * instant the fling clears the visible tiles are granted at once (no dead-zone). */
  const geometryMountVideoIds = React.useMemo(() => {
    if (!featherweightActive) return new Set<string>();
    // Repurpose the (formerly inert) "Max grid players" knob as the LIVE cap,
    // ceiling-clamped here so it can never push past the absolute hard ceiling
    // (which, at 35, keeps even the 2x StrictMode transient — plus the play-area
    // gate's hover +1 — under the decoder safety limit: (35 + 1) × 2 = 72 < 75).
    // computeGeometryMountVideoIds then FLOORS this at the visible-tile count so
    // every visible tile mounts (no dead-zone) and re-applies the ceiling at the
    // top.
    const cap = Math.min(
      MAX_GRID_VIDEO_PLAYERS_CEILING,
      Math.max(1, Math.floor(tunables.maxGridVideoPlayers) || 1),
    );
    return computeGeometryMountVideoIds({
      clipRows,
      cap,
      rowHeightPx,
      viewportHeightPx,
      scrollTopPx,
      rowsInView,
      marginPx: PREVIEW_PLAY_AREA_MARGIN_PX,
    });
  }, [featherweightActive, clipRows, rowHeightPx, viewportHeightPx, scrollTopPx, rowsInView, tunables.maxGridVideoPlayers]);

  /* DEV TOOLS (featherweight only) — FAST-FLING HOLD. While `fastScrolling` is
   * true we do NOT grant new mounts: we return the LAST committed geometry set
   * (held in a ref) so a fling allocates zero new decoders. The instant
   * fastScrolling clears (settle timeout), the live geometry set is committed and
   * returned immediately — the now-visible tiles mount at once, no dead-zone.
   * Flag-off this is the empty set (geometryMountVideoIds is empty). */
  const lastCommittedMountIdsRef = React.useRef<Set<string>>(new Set());
  const mayMountVideoIds = React.useMemo(() => {
    if (fastScrolling) {
      // Hold: serve the last set committed before the fling started.
      return lastCommittedMountIdsRef.current;
    }
    lastCommittedMountIdsRef.current = geometryMountVideoIds;
    return geometryMountVideoIds;
  }, [fastScrolling, geometryMountVideoIds]);

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
    //
    // OVERSCAN_ROWS == GRID_VIDEO_OVERSCAN_ROWS (both 1) so flag-off behavior is
    // numerically identical to the old `±1`. In featherweight mode we also floor
    // the bottom of the window at the measured fill (startRow + rowsInView - 1)
    // so the active set can never under-report visible rows relative to the
    // viewport-fill video budget — otherwise the budget couldn't be filled.
    const OVERSCAN_ROWS = GRID_VIDEO_OVERSCAN_ROWS;
    const lastRow = clipRows.length - 1;
    const baseStart = visibleRowRange?.startIndex ?? 0;
    const baseEnd = visibleRowRange?.endIndex ?? baseStart;
    const startRow = Math.max(0, baseStart - OVERSCAN_ROWS);
    const fillEnd = featherweightActive && rowsInView > 0 ? baseStart + rowsInView - 1 : baseEnd;
    const endRow = Math.min(lastRow, Math.max(baseEnd, fillEnd) + OVERSCAN_ROWS);

    for (let rowIndex = startRow; rowIndex <= endRow; rowIndex += 1) {
      for (const clip of clipRows[rowIndex] ?? []) {
        active.add(clip.id);
        if (active.size >= MAX_GRID_AUTOPLAYERS) break;
      }
      if (active.size >= MAX_GRID_AUTOPLAYERS) break;
    }
    return active;
  }, [clipRows, gridCols, gridPreview, visibleRowRange, featherweightActive, rowsInView]);

  React.useEffect(() => {
    setVisibleRowRange(null);
  }, [result, gridCols]);

  /* Stable Virtuoso props. Inline object/function props (style/components/
   * computeItemKey/scrollerRef) get a fresh identity EVERY render. Virtuoso lists
   * scrollerRef in a passive scroll-attach effect's deps, so a new identity re-runs
   * that effect -> its cleanup calls scrollerRef(null) -> setScrollerEl(null) ->
   * re-render -> new identity -> infinite loop ("Maximum update depth exceeded";
   * the components object compounds it by remounting the scroller). Memoizing pins
   * the identities and breaks the cycle. Real Virtuoso only runs in the live app,
   * not jsdom, so this never surfaces in tests — verify the fix live. */
  const virtuosoStyle = React.useMemo(
    () => ({ "--clip-cols": gridCols }) as React.CSSProperties,
    [gridCols],
  );
  const virtuosoComponents = React.useMemo(() => ({ Scroller: ClipPreviewScroller }), []);
  const computeRowKey = React.useCallback(
    (index: number, row: ClipPreviewItem[]) => `row-${gridCols}-${index}-${row[0]?.id ?? ""}`,
    [gridCols],
  );
  const handleScrollerRef = React.useCallback((el: HTMLElement | Window | null) => {
    setScrollerEl((el as HTMLElement | null) ?? null);
  }, []);

  /* DEV TOOLS: lazily probe a PlaybackPlan for each distinct source that has an
   * active visible tile (first preview interaction). One invoke per source. */
  React.useEffect(() => {
    if (!featherweightActive || !hasClips) return;
    const sources = new Set<string>();
    for (const clip of displayedClips) {
      if (!activeGridClipIds.has(clip.id) || !clip.path) continue;
      if (playbackPlans[clip.path] || planInFlightRef.current.has(clip.path)) continue;
      sources.add(clip.path);
    }
    for (const source of sources) {
      planInFlightRef.current.add(source);
      const epoch = currentSourceEpoch(source);
      void invoke<PlaybackPlan>("clip_playback_plan", { sourcePath: source, height: scenePreviewHeightRef.current })
        .then((plan) => {
          if (currentSourceEpoch(source) !== epoch) return;
          setPlaybackPlans((current) => ({ ...current, [source]: plan }));
        })
        .catch((planError) => {
          if (currentSourceEpoch(source) !== epoch) return;
          logFrontend("warn", "frontend.clip.playback_plan.warning", "Could not compute playback plan", {
            source,
            error: safeLogValue(planError),
          });
        })
        .finally(() => {
          if (currentSourceEpoch(source) !== epoch) return;
          planInFlightRef.current.delete(source);
        });
    }
  }, [featherweightActive, hasClips, displayedClips, activeGridClipIds, playbackPlans, scenePreviewHeight]);

  /* When the preview-quality cap changes, discard the cached per-source plans and
   * proxy paths so both re-run at the new height: the plan re-probes (a source can
   * flip direct<->proxy when the cap crosses its height) and the proxy rebuilds at
   * the new resolution (the Rust cache key folds in the height, so distinct heights
   * are separate proxies — the old one stays on disk and is reused if reverted). */
  const prevScenePreviewHeightRef = React.useRef(scenePreviewHeight);
  React.useEffect(() => {
    if (prevScenePreviewHeightRef.current === scenePreviewHeight) return;
    prevScenePreviewHeightRef.current = scenePreviewHeight;
    for (const s of new Set([...proxyInFlightRef.current, ...planInFlightRef.current])) bumpSourceEpoch(s);
    planInFlightRef.current.clear();
    proxyInFlightRef.current.clear();
    failedProxiesRef.current.clear();
    setPlaybackPlans({});
    setSourceProxyPaths({});
  }, [scenePreviewHeight]);

  /* Kick exactly ONE build_source_proxy for a source, deduping on the in-flight
   * ref. Used both by the lazy on-scroll effect below AND by startExtraction to
   * overlap the build with scene detection. Dedup is proxyInFlightRef-only (a ref,
   * always current); it deliberately does NOT read sourceProxyPaths (that would
   * need it as a dep / could be stale) — callers that can skip an already-built
   * source do their own sourceProxyPaths check before calling. */
  const kickProxyBuild = React.useCallback((source: string) => {
    if (proxyInFlightRef.current.has(source)) return;
    proxyInFlightRef.current.add(source);
    const epoch = currentSourceEpoch(source);
    // "extract again" marks the source for a forced rebuild so the Rust side
    // skips its cache; consumed below so only the first build after a re-extract
    // is forced (later tile interactions reuse the freshly-built proxy).
    const forceRebuild = forceProxyRebuildRef.current.has(source);
    void invoke<string>("build_source_proxy", { sourcePath: source, force: forceRebuild, height: scenePreviewHeightRef.current })
      .then((proxyPath) => {
        if (currentSourceEpoch(source) !== epoch) return;
        if (proxyPath) setSourceProxyPaths((current) => ({ ...current, [source]: proxyPath }));
      })
      .catch((proxyError) => {
        if (currentSourceEpoch(source) !== epoch) return;
        // A FAILED build is terminal: mark it so the graceful-poster decision
        // no longer counts this source as "pending" (otherwise a pinned
        // proxyProgress entry would spin forever), and drop its stale progress
        // tick so nothing else reads it as an in-flight build.
        failedProxiesRef.current.add(source);
        setProxyProgress((cur) => {
          const { [source]: _dropped, ...rest } = cur;
          return rest;
        });
        logFrontend("warn", "frontend.clip.source_proxy.warning", "Could not build source proxy", {
          source,
          error: safeLogValue(proxyError),
        });
      })
      .finally(() => {
        if (currentSourceEpoch(source) !== epoch) return;
        proxyInFlightRef.current.delete(source);
        // One-shot: the forced rebuild has happened (or failed); drop the mark
        // so subsequent builds for this source cache normally.
        forceProxyRebuildRef.current.delete(source);
      });
  }, []);

  /* DEV TOOLS: for proxy-mode sources with an active visible tile, kick exactly
   * ONE build_source_proxy per source on first interaction. The proxy-progress
   * listener tracks the build; on resolve we record the proxy path which flips
   * those tiles from WebP poster to live offset <video>. Never pre-warmed. */
  React.useEffect(() => {
    if (!featherweightActive || !hasClips) return;
    const sources = new Set<string>();
    for (const clip of displayedClips) {
      if (!activeGridClipIds.has(clip.id) || !clip.path) continue;
      // Featherweight previews always use the lightweight proxy (even for "direct"
      // sources) — concurrent full-res decoders starve rVFC and the loop overshoots
      // its margin. Build once the plan has resolved (so we skip unprobeable files).
      if (!playbackPlans[clip.path]) continue;
      if (sourceProxyPaths[clip.path] || proxyInFlightRef.current.has(clip.path)) continue;
      sources.add(clip.path);
    }
    for (const source of sources) kickProxyBuild(source);
  }, [featherweightActive, hasClips, displayedClips, activeGridClipIds, playbackPlans, sourceProxyPaths, kickProxyBuild]);

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
    /* DEV TOOLS: when featherweight is active the live offset <video> tiles
     * replace the baked animated-WebP grid entirely, so skip the heavy
     * preview-bake batch (the "X/N previews cached" grind) altogether. Flag-off
     * keeps the batch scheduler running verbatim. */
    if (featherweightActive) return;

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
  }, [activeGridClipIds, clipMode, clips, gridPreview, hasClips, previewStates, featherweightActive]);

  async function startExtraction(overrideVideos?: string[], options?: { force?: boolean; proxies?: Record<string, string> }) {
    const videos = overrideVideos ?? selectedVideos;
    if (videos.length === 0 || isExtracting) return;
    const force = options?.force ?? false;
    const proxies = options?.proxies ?? detectorProxies;

    // "Extract again" (force) must be a COMPLETE redo: scene detection already
    // bypasses its cache via the force flag below, but the source proxy has its
    // own on-disk cache. Mark each re-extracted source so its next proxy build
    // rebuilds instead of cache-hitting a stale/buggy file. Consumed one-shot in
    // the lazy proxy-build effect. Without this, no proxy fix is ever testable.
    if (force) {
      for (const video of videos) forceProxyRebuildRef.current.add(video);
    }

    // Reset per-source plan/proxy state ONCE here at extraction start (it used to
    // live in the result?.input effect). Doing it here — before the concurrent
    // proxy build is kicked below — means detection's results landing mid-extraction
    // won't wipe the in-flight proxy or its proxyInFlightRef marker. failedProxiesRef
    // is cleared too so a prior terminal failure doesn't poison the new build.
    setPlaybackPlans({});
    setSourceProxyPaths({});
    setProxyProgress({});
    for (const s of new Set([...proxyInFlightRef.current, ...planInFlightRef.current])) bumpSourceEpoch(s);
    planInFlightRef.current.clear();
    proxyInFlightRef.current.clear();
    failedProxiesRef.current.clear();

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

      // Overlap: start the source-proxy build(s) concurrently with detection. The proxy
      // (NVDEC+NVENC) and TransNet detection (tensor cores) mostly use different GPU
      // silicon; they only share the decoder. Fire-and-forget — do NOT await — so the
      // ~23s proxy overlaps the ~21s detection instead of running after it. force is
      // honored via forceProxyRebuildRef (set above on "extract again").
      if (featherweightActive) {
        for (const video of videos) kickProxyBuild(video);
      }

      const results: ClipExtractionResult[] = [];
      for (let index = 0; index < videos.length; index += 1) {
        if (clipCancellingRef.current) break;
        const rawPath = videos[index];
        // Feed the detector the proxy if one exists for this raw (manual
        // last-resort convert), but everything user-facing stays on the raw.
        const detectInput = proxies[rawPath] ?? rawPath;
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
      const nextProxies = { ...detectorProxies, [failedPath]: convertedPath };
      setConvertedSources((current) => ({ ...current, [failedPath]: originalName }));
      setDetectorProxies(nextProxies);
      setCompatModal(null);
      setConvertMessage(null);
      setIsConverting(false);
      // selectedVideos already holds the raw at failedIndex; just re-run.
      void startExtraction(selectedVideos, { force: true, proxies: nextProxies });
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
    // Instant (not smooth) jump: smooth-scrolling the whole list makes the grid's
    // IntersectionObserver mount + play every row's preview <video> along the path
    // (severe lag). Jumping straight to the target renders only the destination's
    // tiles, so nothing loads "along the way".
    virtuosoRef.current?.scrollToIndex({ index: rowIndex, align: "center", behavior: "auto" });
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

  /* Snapshot live on-screen rects (+ thumbnail src) for the given display clip
   * ids, scoped to the grid scroller. Tiles scrolled out of Virtuoso's overscan
   * band aren't mounted and are silently skipped — the caller no-ops the merge
   * animation when fewer than 2 are found, so it degrades cleanly. */
  function captureMergeGhostRects(ids: string[]): MergeGhost[] {
    const root = scrollerEl;
    if (!root || typeof document === "undefined") return [];
    const out: MergeGhost[] = [];
    ids.forEach((id) => {
      const node = root.querySelector<HTMLElement>(`[data-clip-id="${CSS.escape(id)}"]`);
      if (!node) return;
      const r = node.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      const img = node.querySelector<HTMLImageElement>("img.clip-static-thumbnail");
      out.push({ id, left: r.left, top: r.top, width: r.width, height: r.height, thumb: img?.src ?? null });
    });
    return out;
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

    // Snapshot where the selected tiles sit RIGHT NOW (before the layout
    // collapses and their DOM recycles) so we can fly ghost copies into the new
    // card. Query by the rendered display ids (mergeOrder), not the underlying
    // ids — an already-unified selected card renders under its `unified-...` id.
    const combinedId = `unified-${selectedUnderlyingIds.join("_")}`;
    const ghostRects = captureMergeGhostRects(mergeOrder);

    setActiveGridItems(nextLayout);
    setMergeOrder([]);
    setMergeMode(false);

    // Spring the freshly-formed card in, and — if we measured ≥2 source tiles —
    // converge their ghosts into the tiles' shared centre. Both clear on one timer.
    setJustMergedId(combinedId);
    if (ghostRects.length >= 2) {
      const tx = ghostRects.reduce((s, g) => s + g.left + g.width / 2, 0) / ghostRects.length;
      const ty = ghostRects.reduce((s, g) => s + g.top + g.height / 2, 0) / ghostRects.length;
      setMergeGhosts({ ghosts: ghostRects, tx, ty });
    }
    if (mergeAnimTimerRef.current != null) window.clearTimeout(mergeAnimTimerRef.current);
    mergeAnimTimerRef.current = window.setTimeout(() => {
      setMergeGhosts(null);
      setJustMergedId(null);
      mergeAnimTimerRef.current = null;
    }, 360);

    // Automatically trigger preview merge & WebP generation in the background!
    const constituentClips = selectedUnderlyingIds.map(id => clips.find(c => c.id === id)!).filter(Boolean);
    const segments = buildSegments(constituentClips);

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

  // SINGLE-SOURCE MERGES ONLY. The canonical source identity of a clip is its
  // source file path. For a unified clip every segment already shares one source
  // (this very rule guarantees it), so its first segment's source is that key;
  // single clips key on `clip.path`. Returns null only if neither is known.
  function clipSourceKey(clip: ClipPreviewItem): string | null {
    if (clip.isUnified && clip.segments && clip.segments.length > 0) {
      return clip.segments[0].source ?? clip.path ?? null;
    }
    return clip.path ?? null;
  }

  function toggleMergeOrder(clipId: string) {
    setMergeOrder((prev) => {
      // Removing is always allowed (and clears the source lock when emptied).
      if (prev.includes(clipId)) return prev.filter((id) => id !== clipId);

      const candidate = displayedClips.find((c) => c.id === clipId);
      if (!candidate) return prev;

      // The FIRST pick sets the allowed source. Subsequent picks from a
      // different source are rejected (no-op) — cross-episode / cross-source
      // merges are forbidden. The merge corner-select renders disabled for
      // those tiles, but guard here too so every add path is covered.
      const allowedSource = prev
        .map((id) => displayedClips.find((c) => c.id === id))
        .map((c) => (c ? clipSourceKey(c) : null))
        .find((key) => key != null);
      if (allowedSource != null && clipSourceKey(candidate) !== allowedSource) {
        return prev;
      }

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

  // The source the in-progress merge is locked to: set by the first pick,
  // null while the merge selection is empty. Single-source merges only — clips
  // from any other source can't join, so the grid disables their corner-select.
  const mergeLockedSource = React.useMemo<string | null>(() => {
    for (const id of mergeOrder) {
      const clip = displayedClips.find((c) => c.id === id);
      const key = clip ? clipSourceKey(clip) : null;
      if (key != null) return key;
    }
    return null;
  }, [mergeOrder, displayedClips]);

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

  /* DEV TOOLS: surface an in-flight proxy build in the featherweight status line.
   * A source is building when proxy-progress has emitted a percent for it but its
   * resolved path isn't in sourceProxyPaths yet; once built it reverts to the
   * normal ready text. Pick the lowest percent so the line reflects the slowest
   * build still finishing. */
  const proxyBuildPct = React.useMemo(() => {
    if (!featherweightActive) return null;
    let lowest: number | null = null;
    for (const [source, percent] of Object.entries(proxyProgress)) {
      if (sourceProxyPaths[source]) continue;
      if (lowest === null || percent < lowest) lowest = percent;
    }
    return lowest;
  }, [featherweightActive, proxyProgress, sourceProxyPaths]);

  /* The prep bar carries the proxy-build / WebP-cache progress now, so this
   * caption is just the scene-ready summary — no duplicated build % or cached
   * count. Featherweight bakes nothing, so it reads "live previews". */
  const runMessage = error
    ?? (result
      ? (featherweightActive
          ? `${displayedClips.length} scenes ready - live previews`
          : `${result.sceneCount} scenes ready`)
      : progress?.message ?? "");

  /* Per-task progress bars. The detection feed and the secondary preview-prep
   * task run CONCURRENTLY, so each bar is driven SOLELY by its own signal and
   * never fights the other. There is no synthetic roll-up: two purpose-built
   * bars already convey state, and a fixed-weight blend of two parallel tasks
   * with no fixed cost ratio reads as broken (Overall at 60% while detection is
   * 100% above it) and pulls a completed bar backward when a post-detection lazy
   * proxy build kicks. Each task simply shows its own honest fraction.
   *
   * - detection: progress.percent (already cross-episode overall via
   *   mapClipBatchProgress). Indeterminate while extracting before any percent.
   * - prep (exactly one runs per mode — proxy ON / WebP OFF):
   *     featherweight ON  -> source-proxy build (proxyBuildPct). Bar appears
   *       only while a build is in flight or has resolved; absent otherwise so
   *       a non-running stage hides rather than showing 0%. proxyBuildPct===null
   *       with resolved paths => done (100%); building with no percent yet =>
   *       indeterminate. Failed sources are already excluded from proxyBuildPct.
   *     featherweight OFF -> WebP preview bake (settledPreviewCount / clips).
   *       Cache hits flip clips to ready immediately so the bar renders complete;
   *       errors count as settled so a single failure can't peg the bar < 100%.
   */
  const proxyResolvedCount = Object.keys(sourceProxyPaths).length;
  const prepBar = React.useMemo<{
    label: string;
    percent: number;
    indeterminate: boolean;
  } | null>(() => {
    if (featherweightActive) {
      // No proxy in flight and none resolved => no build ran this mode: hide.
      if (proxyBuildPct === null && proxyResolvedCount === 0) return null;
      if (proxyBuildPct === null) {
        return { label: "Preview proxy", percent: 100, indeterminate: false };
      }
      return {
        label: "Building preview proxy",
        percent: Math.max(0, Math.min(100, proxyBuildPct)),
        // No percent yet (cache-miss build just kicked) => indeterminate sweep.
        indeterminate: proxyBuildPct <= 0,
      };
    }
    // WebP bake only runs with a visible grid and at least one clip; otherwise
    // there is no prep task to report, so hide the bar rather than show 0%.
    if (!gridPreview || displayedClips.length === 0) return null;
    return {
      label: `Caching previews (${readyPreviewCount}/${displayedClips.length})`,
      // Drive the fill off SETTLED (ready + error) previews so a permanently
      // failed bake can't keep the bar below 100% once all work has finished.
      percent: Math.round((settledPreviewCount / displayedClips.length) * 100),
      indeterminate: false,
    };
  }, [
    featherweightActive,
    proxyBuildPct,
    proxyResolvedCount,
    gridPreview,
    displayedClips.length,
    readyPreviewCount,
    settledPreviewCount,
  ]);

  const detectionIndeterminate = isExtracting && (!progress || progress.percent <= 0);

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
            <button
              type="button"
              className="clip-confirm-button spring-motion accent-glow"
              disabled={mergeOrder.length < 2 || isExtracting}
              onClick={unifySelectedInGrid}
              title={
                mergeOrder.length < 2
                  ? "Select at least 2 clips to merge"
                  : "Merge the selected clips into one — preview it by clicking the card, export it with Export"
              }
            >
              <Film size={17} strokeWidth={2.1} />
              <span>{mergeOrder.length < 2 ? "Select 2+ clips" : `Merge ${mergeOrder.length} clips`}</span>
            </button>
          )}
        </div>

        {!exportSession && (progress || error || result) && (
          <div className={`clip-run-card glass ${error ? "is-error" : ""}`}>
            {/* Scene detection — always present; the core task. */}
            {(progress || error) && (
              <div className="clip-bar-row">
                <div className="clip-run-line">
                  <strong>{error ? "Extraction failed" : formatClipProgressStage(progress?.stage)}</strong>
                  {progress && !error && <span>{Math.round(progress.percent)}%</span>}
                </div>
                {progress && !error && (
                  <div className={`clip-progress-track ${detectionIndeterminate ? "is-indeterminate" : ""}`}>
                    <span className="spring-motion" style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }} />
                  </div>
                )}
              </div>
            )}
            {/* Preview prep — exactly one of proxy build / WebP bake, only when it actually runs. */}
            {!error && prepBar && (
              <div className="clip-bar-row">
                <div className="clip-run-line">
                  <strong>{prepBar.label}</strong>
                  {!prepBar.indeterminate && <span>{prepBar.percent}%</span>}
                </div>
                <div className={`clip-progress-track ${prepBar.indeterminate ? "is-indeterminate" : ""}`}>
                  <span className="spring-motion" style={{ width: `${prepBar.percent}%` }} />
                </div>
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
            style={virtuosoStyle}
            components={virtuosoComponents}
            computeItemKey={computeRowKey}
            /* DEV TOOLS: capture the real scroll element so the viewport-fill
             * video-budget ResizeObserver can measure it. Stable handler (above)
             * so Virtuoso's scroll-attach effect doesn't loop. */
            scrollerRef={handleScrollerRef}
            rangeChanged={setVisibleRowRange}
            itemContent={(_index, row) => (
              <div
                className="clip-preview-grid-row"
                style={{ '--clip-cols': gridCols } as React.CSSProperties}
              >
                {row.map((clip) => {
                  // SINGLE-SOURCE MERGES ONLY: while a merge is locked to a
                  // source, tiles from any other source can't be added. Already
                  // selected tiles are never disabled (they can still be removed).
                  const mergeDisabled =
                    mergeMode &&
                    mergeLockedSource != null &&
                    !mergePositions.has(clip.id) &&
                    clipSourceKey(clip) !== mergeLockedSource;
                  /* STEP D — GRACEFUL POSTER signal. For a featherweight tile with
                   * no resolved playbackSrc, distinguish a build that is GENUINELY
                   * expected (spinner) from a source that simply has no playable
                   * form yet (static poster — no indefinite spinner).
                   *
                   * A source is PENDING iff EITHER:
                   *  - its PlaybackPlan probe hasn't returned yet (still in flight /
                   *    not recorded), OR
                   *  - the plan resolved as PROXY mode and the proxy is genuinely
                   *    expected: no proxy path yet AND the build has not FAILED.
                   *    (The build being actively running / queued — proxyInFlightRef
                   *    or a live proxyProgress tick — also keeps it pending, but a
                   *    FAILED build, which drops its progress entry and is recorded
                   *    in failedProxiesRef, no longer counts.)
                   *
                   * A DIRECT-mode plan resolves playbackSrc immediately, so it is
                   * never pending here. Net effect: the spinner shows continuously
                   * from plan-resolve through proxy completion for proxy sources,
                   * while a FAILED build settles to the neutral merged poster instead
                   * of spinning forever. Flag-off this is unused (the tile ignores it). */
                  const sourceKey = clipSourceKey(clip);
                  const planForKey = sourceKey != null ? playbackPlans[sourceKey] : undefined;
                  // FIX A — a probe (plan + proxy) is only ever scheduled for a tile
                  // that is in activeGridClipIds (both probe effects gate on it). The
                  // spinner, however, is gated on the IntersectionObserver play area, so
                  // a tile could be spinner-eligible while NO probe is scheduled for it
                  // -> permanent spinner. Require `scheduled` on BOTH pending sub-conditions
                  // so a tile that is NOT slated for a probe reports pending=false (and
                  // falls to the neutral merged poster) instead of spinning forever; an
                  // ACTIVE tile whose proxy is genuinely building still reports pending.
                  const scheduled = activeGridClipIds.has(clip.id);
                  const proxyExpected =
                    scheduled &&
                    sourceKey != null &&
                    planForKey?.mode === "proxy" &&
                    !sourceProxyPaths[sourceKey] &&
                    !failedProxiesRef.current.has(sourceKey);
                  const planPending =
                    scheduled &&
                    sourceKey != null &&
                    (!planForKey || planInFlightRef.current.has(sourceKey));
                  const playbackPending =
                    featherweightActive &&
                    !clip.playbackSrc &&
                    sourceKey != null &&
                    (planPending || proxyExpected);
                  return (
                  <ClipPreviewTile
                    key={clip.id}
                    clip={clip}
                    mergeMode={mergeMode}
                    mergeDisabled={mergeDisabled}
                    mergePosition={mergePositions.get(clip.id) ?? null}
                    paused={!gridPreview || Boolean(viewerClip)}
                    playable={activeGridClipIds.has(clip.id)}
                    selected={mergeMode ? mergePositions.has(clip.id) : selectedClipIds.has(clip.id)}
                    activationEpoch={activationEpoch}
                    clipHoverPreview={hoverPlayOnly}
                    /* DEV TOOLS: featherweight gate */
                    featherweightEnabled={featherweightActive}
                    playbackPending={playbackPending}
                    /* DEV TOOLS: CENTRAL, GEOMETRY-DRIVEN, HARD-CAPPED mount gate.
                     * The panel's own scroll geometry is the SOLE authority for
                     * which tiles may mount a live offset <video> (the per-tile
                     * IntersectionObserver was retired from the mount path). The
                     * set size never exceeds the decoder ceiling, and a fast fling
                     * grants no new mounts. Flag-off mayMountVideoIds is empty. */
                    mayMountVideo={mayMountVideoIds.has(clip.id)}
                    justMerged={justMergedId === clip.id}
                    onClick={(modifiers) => handleClipClick(clip, modifiers)}
                    onToggleSelect={() =>
                      mergeMode ? toggleMergeOrder(clip.id) : toggleClipSelection(clip.id)
                    }
                  />
                  );
                })}
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

        {/* Real-time merge: ghost clones of the just-merged tiles, flying into
            their shared centre while the new unified card springs in. Portalled
            to <body> so fixed-position viewport coords are never thrown off by a
            transformed ancestor; pointer-transparent and torn down on a timer. */}
        {mergeGhosts &&
          createPortal(
            <div className="clip-merge-ghosts" aria-hidden="true">
              {mergeGhosts.ghosts.map((g) => (
                <span
                  key={g.id}
                  className="clip-merge-ghost"
                  style={
                    {
                      left: g.left,
                      top: g.top,
                      width: g.width,
                      height: g.height,
                      backgroundImage: g.thumb ? `url("${g.thumb}")` : undefined,
                      "--gx": `${mergeGhosts.tx - (g.left + g.width / 2)}px`,
                      "--gy": `${mergeGhosts.ty - (g.top + g.height / 2)}px`,
                    } as React.CSSProperties
                  }
                />
              ))}
            </div>,
            document.body,
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
