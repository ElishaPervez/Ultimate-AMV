import { DEFAULT_BG_STATE } from "./constants";
import type { AppConfig, BackgroundState } from "../types/app";

export function clampBgValue(value: unknown, min: number, max: number, fallback: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

export function readBackgroundState(config: Partial<AppConfig> | null | undefined): BackgroundState {
  return {
    imagePath: typeof config?.background_image === "string" ? config.background_image : "",
    scale: clampBgValue(config?.background_scale, 1, 5, DEFAULT_BG_STATE.scale),
    offsetX: clampBgValue(config?.background_offset_x, 0, 100, DEFAULT_BG_STATE.offsetX),
    offsetY: clampBgValue(config?.background_offset_y, 0, 100, DEFAULT_BG_STATE.offsetY),
    dim: clampBgValue(config?.background_dim, 0, 100, DEFAULT_BG_STATE.dim),
    blur: clampBgValue(config?.background_blur, 0, 40, DEFAULT_BG_STATE.blur),
    videoPath: typeof config?.background_video === "string" ? config.background_video : "",
    videoSource: typeof config?.background_video_source === "string" ? config.background_video_source : "",
    videoFps: clampBgValue(config?.background_video_fps, 15, 60, DEFAULT_BG_STATE.videoFps),
    brightText:
      config?.background_bright_text === true ||
      config?.background_bright_text === "1" ||
      config?.background_bright_text === "true",
  };
}
