import React from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Image as ImageIcon, MessageCircle } from "lucide-react";
import { applyAppTheme } from "../../lib/theme";
import type { AppConfig } from "../../types/app";

interface AppearanceSettingsProps {
  backendConfig: AppConfig | null;
  persistConfigField: (key: string, value: string) => Promise<void>;
  themeColors: { primary: string; secondary: string };
  discordEnabled: boolean;
  toggleDiscordPresence: () => void;
}

export function AppearanceSettings({
  backendConfig,
  persistConfigField,
  themeColors,
  discordEnabled,
  toggleDiscordPresence,
}: AppearanceSettingsProps) {
  const [draftColors, setDraftColors] = React.useState(themeColors);
  const draftRef = React.useRef(draftColors);
  const pendingKeysRef = React.useRef<Set<"theme_color_a" | "theme_color_b">>(new Set());
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    setDraftColors(themeColors);
    draftRef.current = themeColors;
  }, [themeColors]);

  React.useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const flushPending = React.useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const keys = pendingKeysRef.current;
    if (keys.size === 0) return;
    const colors = draftRef.current;
    window.dispatchEvent(new CustomEvent("theme-changed", { detail: colors }));
    if (keys.has("theme_color_a")) {
      void persistConfigField("theme_color_a", colors.primary);
    }
    if (keys.has("theme_color_b")) {
      void persistConfigField("theme_color_b", colors.secondary);
    }
    keys.clear();
  }, [persistConfigField]);

  const scheduleFlush = React.useCallback(
    (key: "theme_color_a" | "theme_color_b") => {
      pendingKeysRef.current.add(key);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flushPending, 200);
    },
    [flushPending],
  );

  return (
    <div className="settings-category-wrapper">
      <div className="settings-group glass">
        <div className="settings-group-header">Appearance</div>

        <div className="setting-row theme-setting-row">
          <div className="setting-info">
            <span className="setting-label">Gradient theme</span>
            <span className="setting-desc">
              Choose one or two custom colors for buttons, active tabs, highlights, progress, and action states.
            </span>
          </div>
          <div className="theme-customizer" aria-label="Gradient theme colors">
            <label className="theme-color-field">
              <span>Color 1</span>
              <input
                type="color"
                value={draftColors.primary}
                onChange={(event) => {
                  const next = { ...draftRef.current, primary: event.currentTarget.value };
                  draftRef.current = next;
                  setDraftColors(next);
                  applyAppTheme(next);
                  scheduleFlush("theme_color_a");
                }}
                onBlur={flushPending}
                aria-label="Gradient theme color 1"
              />
            </label>
            <label className="theme-color-field">
              <span>Color 2</span>
              <input
                type="color"
                value={draftColors.secondary}
                onChange={(event) => {
                  const next = { ...draftRef.current, secondary: event.currentTarget.value };
                  draftRef.current = next;
                  setDraftColors(next);
                  applyAppTheme(next);
                  scheduleFlush("theme_color_b");
                }}
                onBlur={flushPending}
                aria-label="Gradient theme color 2"
              />
            </label>
            <div
              className="theme-gradient-preview"
              style={{
                background: `linear-gradient(120deg, ${draftColors.primary}, ${draftColors.secondary})`,
              }}
              aria-hidden="true"
            />
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-info">
            <span className="setting-label">Background image</span>
            <span className="setting-desc">
              {backendConfig?.background_image
                ? "An image is currently set. Open the customizer to reposition, dim, blur, or remove it."
                : "Replace the empty black areas of the workspace with a custom image. Opens a cropper for positioning, zoom, dim, and blur."}
            </span>
          </div>
          <button
            type="button"
            className="settings-action-pill spring-motion"
            onClick={() => window.dispatchEvent(new CustomEvent("bg-customize-open"))}
            title={backendConfig?.background_image ? "Open the background customizer" : "Choose a background image"}
          >
            {backendConfig?.background_image ? (
              <span
                className="settings-action-pill-thumb"
                aria-hidden="true"
                style={{ backgroundImage: `url("${convertFileSrc(backendConfig.background_image)}")` }}
              />
            ) : (
              <span className="settings-action-pill-icon" aria-hidden="true">
                <ImageIcon size={16} strokeWidth={2.2} />
              </span>
            )}
            <span className="settings-action-pill-label">
              {backendConfig?.background_image ? "Customize background" : "Choose background"}
            </span>
          </button>
        </div>
      </div>

      <div className="settings-group glass">
        <div className="settings-group-header">Discord Rich Presence</div>
        <div className="setting-row">
          <div className="setting-info">
            <span className="setting-label">Show activity on Discord</span>
            <span className="setting-desc">
              Displays &ldquo;Playing Ultimate AMV&rdquo; with the current panel or running job on your Discord profile. Requires the Discord desktop app to be running.
            </span>
          </div>
          <div className="settings-toggle-wrap">
            <span className="settings-toggle-icon" aria-hidden="true">
              <MessageCircle size={16} strokeWidth={2.3} />
            </span>
            <span className={`settings-toggle-label ${discordEnabled ? "is-on" : "is-off"}`}>
              {discordEnabled ? "Enabled" : "Disabled"}
            </span>
            <button
              type="button"
              className="settings-toggle-switch spring-motion"
              role="switch"
              aria-checked={discordEnabled}
              aria-label="Show activity on Discord"
              data-on={discordEnabled ? "true" : "false"}
              onClick={toggleDiscordPresence}
              title={discordEnabled ? "Click to hide presence on Discord" : "Click to show presence on Discord"}
            >
              <span className="settings-toggle-track" aria-hidden="true">
                <span className="settings-toggle-track-on">ON</span>
                <span className="settings-toggle-track-off">OFF</span>
                <span className="settings-toggle-knob" />
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
