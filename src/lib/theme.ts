import { APP_THEMES } from "./constants";
import type { AppConfig } from "../types/app";

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

export function getThemePreset(theme: unknown) {
  return APP_THEMES.find((preset) => preset.id === theme) ?? APP_THEMES[0];
}

export function hexToRgbParts(hex: string) {
  const normalized = isHexColor(hex) ? hex.slice(1) : "48d7ff";
  const value = Number.parseInt(normalized, 16);
  return `${(value >> 16) & 255} ${(value >> 8) & 255} ${value & 255}`;
}

export function getReadableContrast(hex: string) {
  const normalized = isHexColor(hex) ? hex.slice(1) : "48d7ff";
  const red = Number.parseInt(normalized.slice(0, 2), 16) / 255;
  const green = Number.parseInt(normalized.slice(2, 4), 16) / 255;
  const blue = Number.parseInt(normalized.slice(4, 6), 16) / 255;
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  return luminance > 0.62 ? "#061116" : "#f7fbff";
}

export function readThemeColors(config: Partial<Pick<AppConfig, "theme" | "theme_color_a" | "theme_color_b">> | null | undefined) {
  const preset = getThemePreset(config?.theme);
  const primary = isHexColor(config?.theme_color_a) ? config.theme_color_a : preset.colors[0];
  const secondary = isHexColor(config?.theme_color_b) ? config.theme_color_b : preset.colors[1];
  return { primary, secondary };
}

export function applyAppTheme(colors: { primary: string; secondary: string }) {
  const root = document.documentElement;
  root.dataset.theme = "custom";
  root.style.setProperty("--theme-accent-rgb", hexToRgbParts(colors.primary));
  root.style.setProperty("--theme-accent-2-rgb", hexToRgbParts(colors.secondary));
  root.style.setProperty("--theme-accent-contrast", getReadableContrast(colors.primary));
}
