export type ClipPreviewState = {
  status: "rendering" | "ready" | "error";
  path?: string;
  src?: string;
  duration?: number;
  error?: string;
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

export type ClipExportFormat = "gpu-intra" | "prores-lt" | "prores-hq" | "h264-nvenc" | "av1-nvenc" | "h264-cpu" | "hevc-cpu";
