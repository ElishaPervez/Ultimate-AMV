import React from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Image as ImageIcon, MessageCircle, Plus, X, Sparkles } from "lucide-react";
import { applyAppTheme } from "../../lib/theme";
import { logFrontend, safeLogValue } from "../../lib/log";
import type { AppConfig } from "../../types/app";
import { CustomColorPicker } from "./CustomColorPicker";

const DISCORD_INVITE_URL = "https://discord.gg/XuJrkeXKh6";

function DiscordGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M20.317 4.369A19.79 19.79 0 0 0 16.558 3.2a.075.075 0 0 0-.079.038c-.34.607-.719 1.4-.984 2.026a18.27 18.27 0 0 0-5.486 0 12.64 12.64 0 0 0-1-2.026.078.078 0 0 0-.079-.038A19.74 19.74 0 0 0 5.171 4.37a.07.07 0 0 0-.032.027C1.533 9.79.554 15.062 1.036 20.268a.083.083 0 0 0 .031.057 19.91 19.91 0 0 0 5.99 3.03.078.078 0 0 0 .085-.027 14.21 14.21 0 0 0 1.226-1.994.076.076 0 0 0-.041-.105 13.13 13.13 0 0 1-1.873-.892.077.077 0 0 1-.008-.128c.126-.094.252-.193.372-.292a.075.075 0 0 1 .078-.01c3.927 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .079.009c.12.099.246.198.373.293a.077.077 0 0 1-.006.127 12.32 12.32 0 0 1-1.874.892.076.076 0 0 0-.04.106 16 16 0 0 0 1.225 1.993.077.077 0 0 0 .084.028 19.85 19.85 0 0 0 6-3.03.077.077 0 0 0 .032-.056c.576-6.018-.966-11.246-4.087-15.872a.06.06 0 0 0-.031-.028zM8.02 17.097c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.418 2.157-2.418 1.21 0 2.176 1.094 2.157 2.418 0 1.334-.956 2.42-2.157 2.42zm7.974 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.418 2.157-2.418 1.21 0 2.175 1.094 2.157 2.418 0 1.334-.946 2.42-2.157 2.42z" />
    </svg>
  );
}

interface AppearanceSettingsProps {
  backendConfig: AppConfig | null;
  persistConfigField: (key: string, value: string) => Promise<void>;
  themeColors: { primary: string; secondary: string };
  discordEnabled: boolean;
  toggleDiscordPresence: () => void;
}

type GradientPreset = {
  primary: string;
  secondary: string;
  name?: string;
  angle?: number;
  isCustom?: boolean;
};

const defaultPresets: GradientPreset[] = [
  { primary: "#48d7ff", secondary: "#63e6a2", name: "Cyan Spark", angle: 120 }, // Cyan
  { primary: "#63e6a2", secondary: "#48d7ff", name: "Mint Breeze", angle: 120 }, // Mint
  { primary: "#a98cff", secondary: "#48d7ff", name: "Violet Dream", angle: 120 }, // Violet
  { primary: "#ff6d91", secondary: "#a98cff", name: "Rose Whisper", angle: 120 }, // Rose
  { primary: "#f4c267", secondary: "#ff6d91", name: "Amber Glow", angle: 120 }, // Amber
];

// Helper to convert HSL to Hex
function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  const r = Math.round(255 * f(0));
  const g = Math.round(255 * f(8));
  const b = Math.round(255 * f(4));
  return "#" + [r, g, b].map(x => x.toString(16).padStart(2, "0")).join("");
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

  const [gradientPresets, setGradientPresets] = React.useState<GradientPreset[]>([]);
  const [appliedAngle, setAppliedAngle] = React.useState(120);

  // Gradient Builder States
  const [isBuilderOpen, setIsBuilderOpen] = React.useState(false);
  const [builderColorA, setBuilderColorA] = React.useState("#48d7ff");
  const [builderColorB, setBuilderColorB] = React.useState("#63e6a2");
  const [builderName, setBuilderName] = React.useState("");
  const [builderAngle, setBuilderAngle] = React.useState(120);

  const generateRandomCoolGradient = () => {
    const h1 = Math.floor(Math.random() * 360);
    const h2 = (h1 + 40 + Math.floor(Math.random() * 80)) % 360;
    const s1 = 75 + Math.floor(Math.random() * 20);
    const s2 = 75 + Math.floor(Math.random() * 20);
    const l1 = 50 + Math.floor(Math.random() * 15);
    const l2 = 50 + Math.floor(Math.random() * 15);

    const colorA = hslToHex(h1, s1, l1);
    const colorB = hslToHex(h2, s2, l2);

    const coolNames = [
      "Cyber Spark", "Neon Horizon", "Mint Vapor", "Retro Flare",
      "Galactic Sunset", "Ultraviolet", "Sakura Petal", "Hyper Ocean",
      "Acid Dream", "Stellar Glow", "Abyssal Pulse", "Crimson Flow",
      "Aqua Prism", "Solar Wind", "Plasma Cloud", "Tokyo Drift"
    ];
    const name = coolNames[Math.floor(Math.random() * coolNames.length)];

    setBuilderColorA(colorA);
    setBuilderColorB(colorB);
    setBuilderName(name);
    setBuilderAngle(120 + Math.floor(Math.random() * 4) * 15);
  };

  React.useEffect(() => {
    const saved = localStorage.getItem("custom-gradient-presets");
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as GradientPreset[];
        setGradientPresets([...defaultPresets, ...parsed.map(p => ({ ...p, isCustom: true }))]);
      } catch (e) {
        setGradientPresets(defaultPresets);
      }
    } else {
      setGradientPresets(defaultPresets);
    }
  }, []);

  const saveGradientPreset = (primary: string, secondary: string, name?: string, angle?: number) => {
    const saved = localStorage.getItem("custom-gradient-presets");
    let currentCustom: GradientPreset[] = [];
    if (saved) {
      try {
        currentCustom = JSON.parse(saved);
      } catch (e) {}
    }
    if (currentCustom.some(p => p.primary.toLowerCase() === primary.toLowerCase() && p.secondary.toLowerCase() === secondary.toLowerCase() && (p.angle || 120) === (angle || 120))) {
      return;
    }
    const updated = [...currentCustom, { primary, secondary, name, angle }];
    localStorage.setItem("custom-gradient-presets", JSON.stringify(updated));
    setGradientPresets([...defaultPresets, ...updated.map(p => ({ ...p, isCustom: true }))]);
  };

  const deleteGradientPreset = (index: number) => {
    const customIndex = index - defaultPresets.length;
    if (customIndex < 0) return;

    const saved = localStorage.getItem("custom-gradient-presets");
    let currentCustom: GradientPreset[] = [];
    if (saved) {
      try {
        currentCustom = JSON.parse(saved);
      } catch (e) {}
    }
    currentCustom.splice(customIndex, 1);
    localStorage.setItem("custom-gradient-presets", JSON.stringify(currentCustom));
    setGradientPresets([...defaultPresets, ...currentCustom.map(p => ({ ...p, isCustom: true }))]);
  };

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
      <div className="settings-group glass" style={{ position: "relative", zIndex: 10 }}>
        <div className="settings-group-header">Appearance</div>

        <div className="setting-row theme-setting-row" style={{ position: "relative", zIndex: 11 }}>
          <div className="setting-info">
            <span className="setting-label">Theme colors</span>
            <span className="setting-desc">
              Choose one or two colors for buttons, active tabs, highlights, loading progress, and clickable items.
            </span>
          </div>
          <div className="theme-customizer" aria-label="Theme colors">
            <CustomColorPicker
              label="Color 1"
              color={draftColors.primary}
              onChange={(nextColor) => {
                const next = { ...draftRef.current, primary: nextColor };
                draftRef.current = next;
                setDraftColors(next);
                applyAppTheme(next);
                scheduleFlush("theme_color_a");
              }}
              onBlur={flushPending}
            />
            <CustomColorPicker
              label="Color 2"
              color={draftColors.secondary}
              onChange={(nextColor) => {
                const next = { ...draftRef.current, secondary: nextColor };
                draftRef.current = next;
                setDraftColors(next);
                applyAppTheme(next);
                scheduleFlush("theme_color_b");
              }}
              onBlur={flushPending}
            />
            <div style={{ display: "flex", flexDirection: "column", gap: "6px", width: "100%", height: "100%" }}>
              <span style={{ fontSize: "11px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.5px", color: "rgba(255,255,255,0.45)" }}>Preview</span>
              <div
                className="theme-gradient-preview"
                style={{
                  background: `linear-gradient(${appliedAngle}deg, ${draftColors.primary}, ${draftColors.secondary})`,
                  height: "46px",
                  margin: 0,
                }}
                aria-hidden="true"
              />
            </div>
          </div>
        </div>

        <div className="setting-row" style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: "14px", padding: "14px 12px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div className="setting-info">
              <span className="setting-label">Custom Gradient Presets</span>
              <span className="setting-desc">Save your dual-color highlights persistently or click to set both instantly.</span>
            </div>
            <button
              type="button"
              className="install-btn is-primary"
              style={{
                padding: "6px 12px",
                display: "flex",
                alignItems: "center",
                gap: "6px",
                fontSize: "12px",
                border: "1px solid rgb(var(--theme-accent-rgb) / 0.4)",
                background: "rgb(var(--theme-accent-rgb) / 0.08)",
                color: "#fff",
                borderRadius: "6px",
                cursor: "pointer",
                outline: "none"
              }}
              onClick={() => {
                saveGradientPreset(draftColors.primary, draftColors.secondary, "Custom Preset", appliedAngle);
              }}
            >
              <Plus size={14} />
              <span>Save Current</span>
            </button>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "center" }}>
            {gradientPresets.map((preset, idx) => (
              <div
                key={idx}
                className="spring-motion"
                title={preset.name || `Gradient ${idx + 1}`}
                style={{
                  position: "relative",
                  width: "74px",
                  height: "36px",
                  borderRadius: "8px",
                  background: `linear-gradient(${preset.angle || 120}deg, ${preset.primary}, ${preset.secondary})`,
                  cursor: "pointer",
                  border: "1px solid rgba(255, 255, 255, 0.15)",
                  boxShadow: "0 4px 10px rgba(0,0,0,0.3)",
                  transition: "transform 0.15s, border-color 0.15s",
                }}
                onClick={() => {
                  const next = { primary: preset.primary, secondary: preset.secondary };
                  draftRef.current = next;
                  setDraftColors(next);
                  setAppliedAngle(preset.angle || 120);
                  applyAppTheme(next);
                  scheduleFlush("theme_color_a");
                  scheduleFlush("theme_color_b");
                  flushPending();
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = "scale(1.04)";
                  e.currentTarget.style.borderColor = "rgba(255,255,255,0.4)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = "scale(1)";
                  e.currentTarget.style.borderColor = "rgba(255,255,255,0.15)";
                }}
              >
                {preset.isCustom && (
                  <button
                    type="button"
                    style={{
                      position: "absolute",
                      top: "-6px",
                      right: "-6px",
                      width: "16px",
                      height: "16px",
                      borderRadius: "50%",
                      background: "rgba(0,0,0,0.75)",
                      color: "#ff6d91",
                      border: "1px solid rgba(255,255,255,0.2)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      cursor: "pointer",
                      fontSize: "9px",
                      padding: 0,
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteGradientPreset(idx);
                    }}
                  >
                    <X size={10} strokeWidth={2.5} />
                  </button>
                )}
              </div>
            ))}

            {/* Create Custom Gradient Dashed Swatch */}
            <button
              type="button"
              className="spring-motion"
              title="Create a custom gradient preset visually"
              onClick={() => {
                setIsBuilderOpen(prev => !prev);
                setBuilderColorA(draftColors.primary);
                setBuilderColorB(draftColors.secondary);
                setBuilderName("");
                setBuilderAngle(appliedAngle);
              }}
              style={{
                position: "relative",
                width: "74px",
                height: "36px",
                borderRadius: "8px",
                border: "2px dashed rgba(255, 255, 255, 0.2)",
                background: "rgba(255, 255, 255, 0.02)",
                color: "rgba(255, 255, 255, 0.5)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                transition: "all 0.15s",
                outline: "none",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = "rgba(255, 255, 255, 0.4)";
                e.currentTarget.style.background = "rgba(255, 255, 255, 0.05)";
                e.currentTarget.style.color = "#fff";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = "rgba(255, 255, 255, 0.2)";
                e.currentTarget.style.background = "rgba(255, 255, 255, 0.02)";
                e.currentTarget.style.color = "rgba(255, 255, 255, 0.5)";
              }}
            >
              <Plus size={16} />
            </button>
          </div>

          {/* Visual Custom Gradient Builder Panel */}
          {isBuilderOpen && (
            <div
              style={{
                marginTop: "10px",
                padding: "16px",
                borderRadius: "12px",
                border: "1px solid rgba(255, 255, 255, 0.08)",
                background: "rgba(255, 255, 255, 0.025)",
                backdropFilter: "blur(12px)",
                display: "flex",
                flexDirection: "column",
                gap: "14px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: "13px", fontWeight: 700, color: "#fff", textTransform: "uppercase", letterSpacing: "0.5px" }}>Create Custom Gradient</span>
                <button
                  type="button"
                  onClick={() => setIsBuilderOpen(false)}
                  style={{ background: "none", border: "none", color: "rgba(255,255,255,0.45)", cursor: "pointer", padding: 0 }}
                >
                  <X size={16} />
                </button>
              </div>

              {/* Dynamic Live Banner Preview */}
              <div
                style={{
                  height: "56px",
                  borderRadius: "8px",
                  background: `linear-gradient(${builderAngle}deg, ${builderColorA}, ${builderColorB})`,
                  border: "1px solid rgba(255, 255, 255, 0.15)",
                  boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.2), 0 4px 12px rgba(0,0,0,0.3)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#fff",
                  fontWeight: 700,
                  fontSize: "12px",
                  textShadow: "0 2px 4px rgba(0,0,0,0.5)",
                  letterSpacing: "0.5px",
                  position: "relative",
                  overflow: "hidden",
                }}
              >
                {builderName || "Unnamed Custom Gradient"}
              </div>

              {/* Name Input & Custom Angle */}
              <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: "14px" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  <span style={{ fontSize: "10px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.5px", color: "rgba(255,255,255,0.4)" }}>Gradient Name</span>
                  <input
                    type="text"
                    placeholder="e.g. Neon Sunset"
                    value={builderName}
                    onChange={(e) => setBuilderName(e.target.value)}
                    style={{
                      background: "rgba(0,0,0,0.2)",
                      border: "1px solid rgba(255,255,255,0.08)",
                      borderRadius: "6px",
                      color: "#fff",
                      padding: "6px 10px",
                      fontSize: "12px",
                      outline: "none",
                      width: "100%",
                    }}
                  />
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  <span style={{ fontSize: "10px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.5px", color: "rgba(255,255,255,0.4)" }}>Angle: {builderAngle}°</span>
                  <div style={{ display: "flex", alignItems: "center", height: "100%" }}>
                    <input
                      type="range"
                      min="0"
                      max="360"
                      value={builderAngle}
                      onChange={(e) => setBuilderAngle(Number(e.target.value))}
                      style={{
                        width: "100%",
                        accentColor: builderColorA,
                        height: "4px",
                        borderRadius: "2px",
                        cursor: "pointer",
                      }}
                    />
                  </div>
                </div>
              </div>

              {/* Quick Angle presets */}
              <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
                <span style={{ fontSize: "9px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.5px", color: "rgba(255,255,255,0.35)" }}>Quick Angle Directions</span>
                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                  {[0, 45, 90, 120, 135, 180, 270].map((angle) => (
                    <button
                      key={angle}
                      type="button"
                      onClick={() => setBuilderAngle(angle)}
                      style={{
                        padding: "3px 6px",
                        background: builderAngle === angle ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.02)",
                        border: `1px solid ${builderAngle === angle ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.06)"}`,
                        borderRadius: "4px",
                        color: "#fff",
                        fontSize: "9px",
                        cursor: "pointer",
                        transition: "all 0.15s",
                      }}
                    >
                      {angle}°
                    </button>
                  ))}
                </div>
              </div>

              {/* Color Selectors */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
                <CustomColorPicker
                  label="Start Color"
                  color={builderColorA}
                  onChange={setBuilderColorA}
                />
                <CustomColorPicker
                  label="End Color"
                  color={builderColorB}
                  onChange={setBuilderColorB}
                />
              </div>

              {/* Actions Footer */}
              <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", borderTop: "1px solid rgba(255, 255, 255, 0.05)", paddingTop: "10px", marginTop: "2px" }}>
                <button
                  type="button"
                  onClick={generateRandomCoolGradient}
                  style={{
                    padding: "5px 10px",
                    background: "rgba(255,255,255,0.03)",
                    border: "1px solid rgba(255,255,255,0.06)",
                    borderRadius: "6px",
                    color: "rgba(255,255,255,0.8)",
                    fontSize: "11px",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: "4px",
                    outline: "none",
                  }}
                >
                  <Sparkles size={11} />
                  <span>Randomize</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    const nameToUse = builderName.trim() || `Gradient ${gradientPresets.length + 1}`;
                    saveGradientPreset(builderColorA, builderColorB, nameToUse, builderAngle);
                    setIsBuilderOpen(false);

                    const next = { primary: builderColorA, secondary: builderColorB };
                    draftRef.current = next;
                    setDraftColors(next);
                    setAppliedAngle(builderAngle);
                    applyAppTheme(next);
                    scheduleFlush("theme_color_a");
                    scheduleFlush("theme_color_b");
                    flushPending();
                  }}
                  style={{
                    padding: "5px 12px",
                    background: `linear-gradient(120deg, ${builderColorA}, ${builderColorB})`,
                    border: "none",
                    borderRadius: "6px",
                    color: "#fff",
                    fontWeight: 600,
                    fontSize: "11px",
                    cursor: "pointer",
                    outline: "none",
                    boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
                  }}
                >
                  Save Preset
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="setting-row">
          <div className="setting-info">
            <span className="setting-label">Background image</span>
            <span className="setting-desc">
              {backendConfig?.background_image
                ? "You have a background image. Open the settings to move, darken, blur, or remove it."
                : "Add a custom image to the background of your workspace. Opens an editor to crop, move, zoom, darken, or blur your image."}
            </span>
          </div>
          <button
            type="button"
            className="settings-action-pill spring-motion"
            onClick={() => window.dispatchEvent(new CustomEvent("bg-customize-open"))}
            title={backendConfig?.background_image ? "Open background settings" : "Choose a background image"}
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
              {backendConfig?.background_image ? "Edit background" : "Choose background"}
            </span>
          </button>
        </div>
      </div>

      <div className="settings-group glass">
        <div className="settings-group-header">Community</div>
        <div className="setting-row">
          <div className="setting-info">
            <span className="setting-label">Join our Discord</span>
            <span className="setting-desc">
              Chat with other users, share your videos, request new features, and get help when something goes wrong.
            </span>
          </div>
          <button
            type="button"
            className="settings-action-pill is-discord spring-motion"
            onClick={() => {
              void openUrl(DISCORD_INVITE_URL).catch((error) => {
                logFrontend("warn", "frontend.discord.invite.open.error", "Could not open Discord invite", {
                  error: safeLogValue(error),
                });
              });
            }}
            title="Open the Ultimate AMV Discord invite in your browser"
          >
            <span className="settings-action-pill-icon" aria-hidden="true">
              <DiscordGlyph size={16} />
            </span>
            <span className="settings-action-pill-label">Discord</span>
          </button>
        </div>
      </div>

        <div className="settings-group glass">
        <div className="settings-group-header">Discord Status</div>
        <div className="setting-row">
          <div className="setting-info">
            <span className="setting-label">Show status on Discord</span>
            <span className="setting-desc">
              Shows &ldquo;Playing Ultimate AMV&rdquo; and what you are doing on your Discord profile. Requires the Discord desktop app to be open.
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
              aria-label="Show status on Discord"
              data-on={discordEnabled ? "true" : "false"}
              onClick={toggleDiscordPresence}
              title={discordEnabled ? "Click to hide status on Discord" : "Click to show status on Discord"}
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
