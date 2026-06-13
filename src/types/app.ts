export type SectionId =
  | "home"
  | "clip-hunting"
  | "downloader"
  | "tsukyio"
  | "audio-extraction"
  | "video-conversion"
  | "audio-conversion"
  | "bg-removal"
  | "logs"
  | "settings";

export type AppThemeId = "cyan" | "mint" | "violet" | "rose" | "amber" | "custom";

export type AppConfig = {
  type: "config";
  force_cpu: boolean;
  setup_type: string;
  clip_extraction_mode: "cpu" | "gpu";
  setup_complete: boolean;
  download_path: string;
  provider_url: string;
  theme: AppThemeId;
  theme_color_a: string;
  theme_color_b: string;
  background_image: string;
  background_scale: number;
  background_offset_x: number;
  background_offset_y: number;
  background_dim: number;
  background_blur: number;
  background_video: string;
  background_video_source: string;
  background_video_fps: number;
  /** "1"/"true" = flip workspace text dark for bright wallpapers. Stored as a
   * string by set_config; parsed tolerantly in readBackgroundState. */
  background_bright_text: string | boolean;
  audio_output_format: "wav" | "mp3";
  clip_hover_preview: boolean;
  /** Default-off flag gating the featherweight offset-playback scene previews.
   * When false the previews behave byte-for-byte as today (animated-WebP grid
   * + scene_clip_render modal). Plain key/value via get_config/set_config. */
  featherweight_previews: boolean;
  tsukyio_api_key: string;
};

export type BackgroundState = {
  imagePath: string;
  scale: number;
  offsetX: number;
  offsetY: number;
  dim: number;
  blur: number;
  videoPath: string;
  videoSource: string;
  videoFps: number;
  /** Dark workspace text for bright wallpapers (user-opted, suggested by the
   * customizer's brightness sniff — never forced). */
  brightText: boolean;
};
