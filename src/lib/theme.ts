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

/**
 * Did the user deliberately pick an accent through the UI?
 *
 * The accent axis is orthogonal to the engine (CSS) theme. When it's NOT
 * explicitly chosen, the active engine theme's own accent (defined in its
 * `theme.css`) should show — so the inline `:root` override must be skipped,
 * since inline styles beat any cascade layer.
 *
 * Detection rule: picking a preset swatch OR a custom color in
 * AppearanceSettings always persists `theme_color_a`/`theme_color_b`, and the
 * backend (`set_config`) flips `theme` to `"custom"` whenever those are
 * written. So `theme === "custom"` is the reliable "user chose an accent"
 * signal. A fresh install (`theme: "cyan"`) or any legacy config that merely
 * carries a named preset is treated as "not explicitly chosen", so the engine
 * theme's accent wins.
 */
export function hasExplicitAccent(
  config: Partial<Pick<AppConfig, "theme">> | null | undefined,
): boolean {
  return config?.theme === "custom";
}

export function applyAppTheme(colors: { primary: string; secondary: string }) {
  const root = document.documentElement;
  root.dataset.theme = "custom";
  root.style.setProperty("--theme-accent-rgb", hexToRgbParts(colors.primary));
  root.style.setProperty("--theme-accent-2-rgb", hexToRgbParts(colors.secondary));
  root.style.setProperty("--theme-accent-contrast", getReadableContrast(colors.primary));
}

/**
 * Drop the inline `:root` accent override so the active engine theme's own
 * accent (from its `theme.css`, in the `theme` cascade layer) takes back over.
 * Used to return to the "theme default" accent — e.g. when switching engine
 * themes from the sidebar picker.
 */
export function clearAppTheme() {
  const root = document.documentElement;
  delete root.dataset.theme;
  root.style.removeProperty("--theme-accent-rgb");
  root.style.removeProperty("--theme-accent-2-rgb");
  root.style.removeProperty("--theme-accent-contrast");
}
