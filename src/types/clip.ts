export type ClipPreviewState = {
  status: "rendering" | "ready" | "error";
  path?: string;
  src?: string;
  duration?: number;
  error?: string;
};

/** Per-source playback decision returned by the Rust `clip_playback_plan`
 * command. `direct` = the original file is WebView2-friendly AND in asset
 * scope, so offset playback can run straight off `sourceSrc`. `proxy` = play a
 * shared low-res short-GOP transcode instead. Mirrors the Rust struct
 * (serde camelCase) field-for-field. */
export type PlaybackPlan = {
  mode: "direct" | "proxy";
  videoCodec: string;
  audioCodec: string | null;
  width: number;
  height: number;
  pixFmt: string;
  container: string;
  inScope: boolean;
  reasons: string[];
};

export type ClipPreviewItem = {
  id: string;
  index: number;
  label: string;
  range: string;
  sourceName: string;
  sourceSrc: string;
  sourceStart: number;
  sourceEnd: number;
  previewStart: number;
  previewEnd: number;
  previewState?: ClipPreviewState;
  fps: number;
  path?: string;
  /** Resolved offset-playback source (original `sourceSrc` for a `direct`
   * plan, or the shared proxy's `convertFileSrc` for a `proxy` plan). Only set
   * once the source's `PlaybackPlan` is known; absent => fall back to the
   * WebP poster / `scene_clip_render` path. */
  playbackSrc?: string;
  playbackMode?: "direct" | "proxy";
  isUnified?: boolean;
  /** Set on a unified clip whose constituent segments are ALL from the same
   * source AND adjacent in both source time and stored-array order at equal fps
   * (the contiguous-merge case). Optional so single clips and existing callers
   * are unaffected. */
  isContiguous?: boolean;
  /** Number of constituent segments in a unified clip. Optional; absent on
   * single clips. */
  segmentCount?: number;
  segments?: Array<{
    source: string;
    start: number;
    end: number;
    index: number;
    fps: number;
    /** OPTIONAL inward-padded playback window for this segment, in seconds on
     * its playback source. When present, the offset player should loop exactly
     * [previewStart, previewEnd] for this segment instead of recomputing the
     * margin from start/end. Export still reads the raw start/end. */
    previewStart?: number;
    previewEnd?: number;
    /** OPTIONAL resolved offset-playback source for this segment (mirrors
     * ClipPreviewItem.playbackSrc — original src for a `direct` plan, the
     * shared proxy's convertFileSrc for a `proxy` plan). */
    playbackSrc?: string;
    playbackMode?: "direct" | "proxy";
  }>;
};

export type ClipPreviewBatchResult = {
  type: "done";
  items: Array<{
    sceneId: string;
    path?: string | null;
    duration: number;
    cached: boolean;
    error?: string | null;
  }>;
};

export type ClipVideoRange = {
  id: string;
  src: string;
  start: number;
  end: number;
};

export type ClipScene = {
  source: string;
  start: number;
  end: number;
  index: number;
  label: string;
};

export type ClipProgress = {
  type: "progress";
  stage: string;
  percent: number;
  message: string;
  elapsedSeconds?: number;
};

export type ClipBatchProgressContext = {
  activeIndex: number;
  total: number;
  inputPath: string;
};

export type ClipExtractionResult = {
  type: "done";
  mode?: "cpu" | "gpu";
  input: string;
  scenes: ClipScene[];
  cuts: number[];
  sceneCount: number;
  fps: number;
  duration: number;
  totalSeconds: number;
};

export type ClipAudioSettings = {
  muted: boolean;
  volume: number;
};

export type ClipExportFormat =
  | "gpu-intra"
  | "prores-lt"
  | "prores-hq"
  | "h264-nvenc"
  | "av1-nvenc"
  | "h264-cpu"
  | "hevc-cpu"
  | "lossless-cut";
