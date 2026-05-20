import type { AppThemeId, BackgroundState } from "../types/app";
import type { DownloadFormat } from "../types/download";

export const APP_THEMES: Array<{ id: Exclude<AppThemeId, "custom">; colors: [string, string] }> = [
  { id: "cyan", colors: ["#48d7ff", "#63e6a2"] },
  { id: "mint", colors: ["#63e6a2", "#48d7ff"] },
  { id: "violet", colors: ["#a98cff", "#48d7ff"] },
  { id: "rose", colors: ["#ff6d91", "#a98cff"] },
  { id: "amber", colors: ["#f4c267", "#ff6d91"] },
];

export const CLIP_AUDIO_SETTINGS_KEY = "ultimate-amv.clip-audio-settings";
export const CLIP_COLUMN_OPTIONS = [1, 2, 3, 4] as const;
export const MAX_GRID_AUTOPLAYERS = 100;
export const CLIP_PREVIEW_BATCH_SIZE = 8;
export const CLIP_PREVIEW_CPU_BATCH_CONCURRENCY = 2;
export const CLIP_PREVIEW_GPU_BATCH_CONCURRENCY = 3;

export const BEST_FORMAT_ID = "__best__";

export const BEST_FORMAT_ENTRY: DownloadFormat = {
  id: BEST_FORMAT_ID,
  label: "Best (auto-merge video + audio)",
  ext: "mp4",
  resolution: null,
  width: null,
  height: null,
  bitrate: null,
  filesize: null,
  vcodec: null,
  acodec: null,
  audioOnly: false,
};

export const DEFAULT_BG_STATE: BackgroundState = {
  imagePath: "",
  scale: 1,
  offsetX: 50,
  offsetY: 50,
  dim: 55,
  blur: 0,
  videoPath: "",
  videoSource: "",
  videoFps: 30,
};

export const WALLPAPER_FPS_OPTIONS = [15, 24, 30, 60] as const;
export const WALLPAPER_VIDEO_EXTENSIONS = ["mp4", "mkv", "webm", "mov", "m4v"];
