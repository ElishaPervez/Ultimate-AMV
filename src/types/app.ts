import React from "react";

export type SectionId =
  | "clip-hunting"
  | "downloader"
  | "audio-extraction"
  | "video-conversion"
  | "audio-conversion"
  | "logs"
  | "settings";

export type NavItem = {
  id: SectionId;
  label: string;
  short: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
};

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
};

export type BackgroundState = {
  imagePath: string;
  scale: number;
  offsetX: number;
  offsetY: number;
  dim: number;
  blur: number;
};
