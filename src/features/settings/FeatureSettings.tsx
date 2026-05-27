import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { Film, Music, FileAudio } from "lucide-react";
import type { AppConfig } from "../../types/app";
import { Dropdown } from "../../components/Dropdown";

interface FeatureSettingsProps {
  backendConfig: AppConfig | null;
  persistConfigField: (key: string, value: string) => Promise<void>;
  clipHoverPreview: boolean;
  setClipHoverPreview: React.Dispatch<React.SetStateAction<boolean>>;
  localDownloadPath: string;
  setLocalDownloadPath: React.Dispatch<React.SetStateAction<string>>;
  currentMode: "cpu" | "gpu";
}

export function FeatureSettings({
  backendConfig,
  persistConfigField,
  clipHoverPreview,
  setClipHoverPreview,
  localDownloadPath,
  setLocalDownloadPath,
  currentMode,
}: FeatureSettingsProps) {
  return (
    <div className="settings-category-wrapper">
      <div className="settings-group glass">
        <div className="settings-group-header">Downloads</div>
        <div className="setting-row">
          <div className="setting-info" style={{ flex: 1, minWidth: 0 }}>
            <span className="setting-label">Download folder</span>
            <span className="setting-desc">
              Where anime episodes are saved. Defaults to Videos\Ultimate AMV.
            </span>
          </div>
        </div>
        <div className="settings-download-path-row">
          <input
            type="text"
            className="settings-path-input"
            value={localDownloadPath}
            placeholder="Default: Videos\Ultimate AMV"
            readOnly
            aria-label="Download folder path"
          />
          <button
            type="button"
            className="settings-path-browse-btn spring-motion"
            onClick={async () => {
              const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
              const selected = await openDialog({ directory: true, multiple: false });
              if (selected && typeof selected === "string") {
                setLocalDownloadPath(selected);
                void persistConfigField("download_path", selected);
              }
            }}
          >
            Browse
          </button>
        </div>
      </div>

      <div className="settings-group glass">
        <div className="settings-group-header">Scene Splitting</div>

        <div className="setting-row">
          <div className="setting-info">
            <span className="setting-label">Detector type</span>
            <span className="setting-desc">
              {currentMode === "gpu"
                ? "Fast RTX detector (controlled by AI Engine settings)"
                : "Universal CPU detector (controlled by AI Engine settings)"}
            </span>
          </div>
          <div className="deps-badge">
            <span
              className="deps-badge-ready"
              style={{ color: "var(--fg-muted)", border: "1px solid var(--border)", background: "transparent" }}
            >
              {currentMode.toUpperCase()}
            </span>
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-info">
            <span className="setting-label">Hover-to-Play previews</span>
            <span className="setting-desc">
              Only play animated clip loops when hovering over a tile. Dramatically reduces CPU and GPU usage on larger grids.
            </span>
          </div>
          <div className="settings-toggle-wrap">
            <span className="settings-toggle-icon" aria-hidden="true">
              <Film size={16} strokeWidth={2.3} />
            </span>
            <span className={`settings-toggle-label ${clipHoverPreview ? "is-on" : "is-off"}`}>
              {clipHoverPreview ? "Enabled" : "Disabled"}
            </span>
            <button
              type="button"
              className="settings-toggle-switch spring-motion"
              role="switch"
              aria-checked={clipHoverPreview}
              aria-label="Hover-to-Play previews"
              data-on={clipHoverPreview ? "true" : "false"}
              onClick={() => {
                const next = !clipHoverPreview;
                setClipHoverPreview(next);
                void invoke("set_config", { key: "clip_hover_preview", value: next ? "true" : "false" });
                window.dispatchEvent(
                  new CustomEvent("clip-hover-preview-changed", { detail: { enabled: next } }),
                );
              }}
              title={clipHoverPreview ? "Disable hover preview" : "Enable hover preview"}
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

      <div className="settings-group glass">
        <div className="settings-group-header">Vocal Separation</div>
        <div className="setting-row">
          <div className="setting-info">
            <span className="setting-label">Audio file format</span>
            <span className="setting-desc">
              Format used for separating vocals and music. WAV is high quality; MP3 uses less space.
            </span>
          </div>
          <Dropdown<"wav" | "mp3">
            options={[
              {
                value: "wav",
                label: "WAV (high quality)",
                description: "Best sound quality, larger files.",
                icon: FileAudio,
              },
              {
                value: "mp3",
                label: "MP3 (smaller size)",
                description: "Smaller files, plays on almost any device.",
                icon: Music,
              },
            ]}
            value={backendConfig?.audio_output_format ?? "wav"}
            onChange={(val) => {
              void persistConfigField("audio_output_format", val);
            }}
            align="right"
          />
        </div>
      </div>
    </div>
  );
}
