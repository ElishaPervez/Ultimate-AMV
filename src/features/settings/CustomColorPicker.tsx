import React from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { HexColorPicker } from "react-colorful";
import { Pipette } from "lucide-react";

// Chromium's EyeDropper API (Chrome/Edge/WebView2 95+) — not in TS's lib.dom yet
declare global {
  interface Window {
    EyeDropper?: new () => { open: (options?: { signal?: AbortSignal }) => Promise<{ sRGBHex: string }> };
  }
}

interface CustomColorPickerProps {
  label: string;
  color: string;
  onChange: (color: string) => void;
  onBlur?: () => void;
}

const PRESET_SWATCHES = [
  { label: "Cyan", color: "#48d7ff" },
  { label: "Mint", color: "#63e6a2" },
  { label: "Violet", color: "#a98cff" },
  { label: "Rose", color: "#ff6d91" },
  { label: "Amber", color: "#f4c267" },
  { label: "Blue", color: "#2e86de" },
  { label: "Lime", color: "#10ac84" },
  { label: "Orange", color: "#ff9f43" },
];

// Helper to convert hex to RGB
function hexToRgb(hex: string) {
  const cleanHex = hex.replace(/^#/, "");
  if (cleanHex.length !== 6) return { r: 0, g: 0, b: 0 };
  const match = cleanHex.match(/.{2}/g);
  if (!match) return { r: 0, g: 0, b: 0 };
  const [r, g, b] = match.map((x) => parseInt(x, 16));
  return { r, g, b };
}

// Helper to convert RGB to Hex
function rgbToHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// Helper to convert hex to HSL
function hexToHsl(hex: string) {
  const { r, g, b } = hexToRgb(hex);
  const rNorm = r / 255;
  const gNorm = g / 255;
  const bNorm = b / 255;
  const max = Math.max(rNorm, gNorm, bNorm);
  const min = Math.min(rNorm, gNorm, bNorm);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rNorm:
        h = (gNorm - bNorm) / d + (gNorm < bNorm ? 6 : 0);
        break;
      case gNorm:
        h = (bNorm - rNorm) / d + 2;
        break;
      case bNorm:
        h = (rNorm - gNorm) / d + 4;
        break;
    }
    h /= 6;
  }
  return {
    h: Math.round(h * 360),
    s: Math.round(s * 100),
    l: Math.round(l * 100),
  };
}

// Helper to parse RGB/RGBA string
function parseRgb(rgbStr: string): string | null {
  const match = rgbStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*[\d.]+)?\)/i);
  if (!match) return null;
  const [r, g, b] = match.slice(1, 4).map(Number);
  if (r >= 0 && r <= 255 && g >= 0 && g <= 255 && b >= 0 && b <= 255) {
    return rgbToHex(r, g, b);
  }
  return null;
}

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
  return rgbToHex(r, g, b);
}

// Helper to parse HSL/HSLA string
function parseHsl(hslStr: string): string | null {
  const match = hslStr.match(/hsla?\((\d+)°?,\s*(\d+)%?,\s*(\d+)%?(?:,\s*[\d.]+)?\)/i);
  if (!match) return null;
  const [h, s, l] = match.slice(1, 4).map(Number);
  if (h >= 0 && h <= 360 && s >= 0 && s <= 100 && l >= 0 && l <= 100) {
    return hslToHex(h, s, l);
  }
  return null;
}

// EyeDropper results are "#rrggbb" on Windows, but some platforms emit
// "rgba(...)" instead (WICG/eyedropper-api#28) — accept both.
function normalizeSampledColor(value: string): string | null {
  const lower = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(lower)) return lower;
  return parseRgb(lower);
}

export function CustomColorPicker({ label, color, onChange, onBlur }: CustomColorPickerProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [isSampling, setIsSampling] = React.useState(false);
  const samplingRef = React.useRef(false);
  const [overlayActive, setOverlayActive] = React.useState(false);
  const [chip, setChip] = React.useState<{ x: number; y: number } | null>(null);
  const [liveHex, setLiveHex] = React.useState<string | null>(null);
  const colorBeforeSampleRef = React.useRef(color);
  const sampleTickRef = React.useRef(0);

  // The confirming click can reach the document after sampling settles;
  // release the outside-click guard a beat later so that click can't
  // close the popover before the user sees the sampled color.
  const releaseSamplingGuard = () => {
    window.setTimeout(() => {
      samplingRef.current = false;
    }, 100);
  };

  const stopOverlay = () => {
    setOverlayActive(false);
    setIsSampling(false);
    setChip(null);
    setLiveHex(null);
    releaseSamplingGuard();
  };

  const beginScreenPick = async () => {
    if (samplingRef.current) return;
    samplingRef.current = true;
    setIsSampling(true);
    if (typeof window.EyeDropper === "function") {
      const startedAt = performance.now();
      try {
        const result = await new window.EyeDropper().open();
        const sampled = normalizeSampledColor(result.sRGBHex);
        if (sampled) onChange(sampled);
        setIsSampling(false);
        releaseSamplingGuard();
        return;
      } catch {
        // A genuine Esc-cancel takes human-scale time. WebView2 ships the
        // EyeDropper API surface but no picking UI — open() rejects within
        // a few ms — so an instant rejection means "not implemented here":
        // fall back to sampling the app window natively.
        if (performance.now() - startedAt > 250) {
          setIsSampling(false);
          releaseSamplingGuard();
          return;
        }
      }
    }
    colorBeforeSampleRef.current = color;
    setOverlayActive(true);
  };

  const overlayMove = (event: React.PointerEvent) => {
    setChip({ x: event.clientX, y: event.clientY });
    const now = performance.now();
    if (now - sampleTickRef.current < 33) return;
    sampleTickRef.current = now;
    invoke<string>("sample_screen_color")
      .then((hex) => {
        if (!samplingRef.current) return;
        const sampled = normalizeSampledColor(hex);
        if (sampled) {
          setLiveHex(sampled);
          onChange(sampled);
        }
      })
      .catch(() => {});
  };

  const overlayConfirm = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    invoke<string>("sample_screen_color")
      .then((hex) => {
        const sampled = normalizeSampledColor(hex);
        if (sampled) onChange(sampled);
      })
      .catch(() => {
        // keep the last live sample already applied via onChange
      })
      .finally(stopOverlay);
  };

  const overlayCancel = () => {
    onChange(colorBeforeSampleRef.current);
    stopOverlay();
  };

  const rgb = hexToRgb(color);
  const hsl = hexToHsl(color);

  // Maintain local text inputs so keyboard entry doesn't cause caret jumping
  const [localHex, setLocalHex] = React.useState(color);
  const [localRgb, setLocalRgb] = React.useState(`rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`);
  const [localRgba, setLocalRgba] = React.useState(`rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 1)`);
  const [localHsl, setLocalHsl] = React.useState(`hsl(${hsl.h}°, ${hsl.s}%, ${hsl.l}%)`);

  // Sync inputs when the actual color changes (e.g. from the picker wheel)
  React.useEffect(() => {
    setLocalHex(color);
    setLocalRgb(`rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`);
    setLocalRgba(`rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 1)`);
    setLocalHsl(`hsl(${hsl.h}°, ${hsl.s}%, ${hsl.l}%)`);
  }, [color]);

  // Close popover on click outside
  React.useEffect(() => {
    if (!isOpen) return;
    const listener = (event: MouseEvent | TouchEvent) => {
      if (samplingRef.current) return;
      if (containerRef.current?.contains(event.target as Node)) {
        return;
      }
      setIsOpen(false);
      if (onBlur) onBlur();
    };
    document.addEventListener("mousedown", listener);
    document.addEventListener("touchstart", listener);
    return () => {
      document.removeEventListener("mousedown", listener);
      document.removeEventListener("touchstart", listener);
    };
  }, [isOpen, onBlur]);

  // Esc cancels overlay sampling and restores the pre-sampling color
  React.useEffect(() => {
    if (!overlayActive) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      overlayCancel();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [overlayActive]);

  return (
    <div ref={containerRef} className="custom-color-picker-container" style={{ position: "relative", display: "flex", flexDirection: "column", gap: "6px", width: "100%" }}>
      <span style={{ fontSize: "11px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.5px", color: "rgba(255,255,255,0.45)" }}>{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "6px 8px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "8px", height: "46px" }}>
        {/* Interactive Swatch */}
        <button
          type="button"
          onClick={() => setIsOpen((prev) => !prev)}
          aria-label={`Pick ${label} color`}
          style={{
            width: "36px",
            height: "36px",
            borderRadius: "50%",
            backgroundColor: color,
            border: "2px solid rgba(255, 255, 255, 0.2)",
            boxShadow: "0 4px 12px rgba(0,0,0,0.3), inset 0 1px 1px rgba(255,255,255,0.2)",
            cursor: "pointer",
            outline: "none",
            transition: "transform 0.15s cubic-bezier(0.4, 0, 0.2, 1), border-color 0.15s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = "scale(1.08)";
            e.currentTarget.style.borderColor = "rgba(255, 255, 255, 0.5)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = "scale(1)";
            e.currentTarget.style.borderColor = "rgba(255, 255, 255, 0.2)";
          }}
        />
        {/* Main Hex input field */}
        <input
          type="text"
          value={localHex}
          onChange={(e) => {
            const val = e.target.value;
            setLocalHex(val);
            // Instant update if hex matches standard format
            if (/^#[0-9A-Fa-f]{6}$/.test(val)) {
              onChange(val);
            }
          }}
          onBlur={onBlur}
          aria-label={label === "Color 1" ? "Theme color 1" : label === "Color 2" ? "Theme color 2" : label}
          style={{
            flex: 1,
            minWidth: 0,
            width: "100%",
            background: "rgba(0,0,0,0.2)",
            border: "none",
            borderRadius: "4px",
            color: "#fff",
            padding: "4px 6px",
            fontSize: "12px",
            fontFamily: "monospace",
            textAlign: "center",
            outline: "none",
          }}
        />
      </div>

      {/* Popover */}
      {isOpen && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            left: "0",
            zIndex: 1000,
            background: "rgba(22, 22, 22, 0.95)",
            backdropFilter: "blur(24px)",
            WebkitBackdropFilter: "blur(24px)",
            border: "1px solid rgba(255, 255, 255, 0.08)",
            boxShadow: "0 24px 48px rgba(0, 0, 0, 0.7), 0 2px 10px rgba(0, 0, 0, 0.4)",
            borderRadius: "14px",
            padding: "16px",
            display: "flex",
            flexDirection: "column",
            gap: "14px",
            width: "250px",
          }}
        >
          {/* Main Color Picker Wheel */}
          <HexColorPicker color={color} onChange={onChange} style={{ width: "218px", height: "160px" }} />

          {/* Screen eyedropper — EyeDropper API when functional, native overlay fallback */}
          <button
            type="button"
            onClick={beginScreenPick}
            disabled={isSampling}
            aria-label={`Pick ${label} from screen`}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "6px",
              padding: "7px 10px",
              background: isSampling ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: "6px",
              color: "rgba(255,255,255,0.85)",
              fontSize: "11px",
              fontWeight: 600,
              letterSpacing: "0.3px",
              cursor: isSampling ? "default" : "pointer",
              outline: "none",
              transition: "background 0.15s, border-color 0.15s",
            }}
            onMouseEnter={(e) => {
              if (isSampling) return;
              e.currentTarget.style.background = "rgba(255,255,255,0.08)";
              e.currentTarget.style.borderColor = "rgba(255,255,255,0.2)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = isSampling ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.04)";
              e.currentTarget.style.borderColor = "rgba(255,255,255,0.1)";
            }}
          >
            <Pipette size={12} />
            <span>{isSampling ? "Click any color on screen…" : "Pick from screen"}</span>
          </button>

          {/* Quick presets */}
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <span style={{ fontSize: "10px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.5px", color: "rgba(255,255,255,0.4)" }}>
              Presets
            </span>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "6px" }}>
              {PRESET_SWATCHES.map((swatch) => (
                <button
                  key={swatch.label}
                  type="button"
                  onClick={() => onChange(swatch.color)}
                  title={swatch.label}
                  style={{
                    height: "22px",
                    borderRadius: "4px",
                    backgroundColor: swatch.color,
                    border: color.toLowerCase() === swatch.color.toLowerCase() ? "2px solid #fff" : "1px solid rgba(255, 255, 255, 0.1)",
                    cursor: "pointer",
                    outline: "none",
                  }}
                />
              ))}
            </div>
          </div>

          {/* Format values info - EDITABLE */}
          <div style={{ display: "flex", flexDirection: "column", gap: "8px", borderTop: "1px solid rgba(255, 255, 255, 0.06)", paddingTop: "10px" }}>
            <span style={{ fontSize: "10px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.5px", color: "rgba(255,255,255,0.4)" }}>
              Values (Editable)
            </span>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              {/* HEX */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.4)", width: "42px" }}>HEX</span>
                <input
                  type="text"
                  value={localHex}
                  onChange={(e) => {
                    const val = e.target.value;
                    setLocalHex(val);
                    if (/^#[0-9A-Fa-f]{6}$/.test(val)) {
                      onChange(val);
                    }
                  }}
                  style={{
                    width: "150px",
                    background: "rgba(0,0,0,0.25)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: "4px",
                    color: color,
                    fontWeight: 600,
                    padding: "3px 6px",
                    fontSize: "11px",
                    fontFamily: "monospace",
                    outline: "none",
                  }}
                />
              </div>
              {/* RGB */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.4)", width: "42px" }}>RGB</span>
                <input
                  type="text"
                  value={localRgb}
                  onChange={(e) => {
                    const val = e.target.value;
                    setLocalRgb(val);
                    const parsed = parseRgb(val);
                    if (parsed) {
                      onChange(parsed);
                    }
                  }}
                  style={{
                    width: "150px",
                    background: "rgba(0,0,0,0.25)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: "4px",
                    color: "rgba(255,255,255,0.85)",
                    padding: "3px 6px",
                    fontSize: "11px",
                    fontFamily: "monospace",
                    outline: "none",
                  }}
                />
              </div>
              {/* RGBA */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.4)", width: "42px" }}>RGBA</span>
                <input
                  type="text"
                  value={localRgba}
                  onChange={(e) => {
                    const val = e.target.value;
                    setLocalRgba(val);
                    const parsed = parseRgb(val); // works for rgba too
                    if (parsed) {
                      onChange(parsed);
                    }
                  }}
                  style={{
                    width: "150px",
                    background: "rgba(0,0,0,0.25)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: "4px",
                    color: "rgba(255,255,255,0.85)",
                    padding: "3px 6px",
                    fontSize: "11px",
                    fontFamily: "monospace",
                    outline: "none",
                  }}
                />
              </div>
              {/* HSL */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.4)", width: "42px" }}>HSL</span>
                <input
                  type="text"
                  value={localHsl}
                  onChange={(e) => {
                    const val = e.target.value;
                    setLocalHsl(val);
                    const parsed = parseHsl(val);
                    if (parsed) {
                      onChange(parsed);
                    }
                  }}
                  style={{
                    width: "150px",
                    background: "rgba(0,0,0,0.25)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: "4px",
                    color: "rgba(255,255,255,0.85)",
                    padding: "3px 6px",
                    fontSize: "11px",
                    fontFamily: "monospace",
                    outline: "none",
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Native sampling overlay — covers the window; pointer position picks the
          composited screen pixel underneath (wallpaper, video, thumbnails, all of it) */}
      {overlayActive &&
        createPortal(
          <div
            aria-label={`Sampling ${label}: click a color to apply it`}
            onPointerMove={overlayMove}
            onClick={overlayConfirm}
            onContextMenu={(e) => {
              e.preventDefault();
              overlayCancel();
            }}
            style={{ position: "fixed", inset: 0, zIndex: 99999, cursor: "crosshair" }}
          >
            {chip && (
              <div
                style={{
                  position: "fixed",
                  left: chip.x + 16,
                  top: chip.y + 16,
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "6px 10px",
                  background: "rgba(12, 12, 14, 0.92)",
                  border: "1px solid rgba(255,255,255,0.14)",
                  borderRadius: "8px",
                  boxShadow: "0 8px 20px rgba(0,0,0,0.45)",
                  pointerEvents: "none",
                }}
              >
                <span
                  style={{
                    width: "18px",
                    height: "18px",
                    borderRadius: "4px",
                    background: liveHex ?? "transparent",
                    border: "1px solid rgba(255,255,255,0.25)",
                  }}
                />
                <span style={{ fontSize: "11px", fontFamily: "monospace", color: "#fff" }}>{liveHex ?? "…"}</span>
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
