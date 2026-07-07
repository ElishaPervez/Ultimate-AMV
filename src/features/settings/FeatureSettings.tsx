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
  // Local draft of the Tsukyio key so we don't fire a config write on every
  // keystroke; persist on Save (matching how the download path persists on a
  // discrete action rather than per-character).
  const [tsukyioKey, setTsukyioKey] = React.useState(backendConfig?.tsukyio_api_key ?? "");
  const [tsukyioSaved, setTsukyioSaved] = React.useState(false);

  React.useEffect(() => {
    setTsukyioKey(backendConfig?.tsukyio_api_key ?? "");
  }, [backendConfig?.tsukyio_api_key]);

  // Featherweight (offset-playback) previews are the default; the toggle below
  // lets the user switch BACK to the classic animated-grid previews. Seeded from
  // the persisted config (default-on when the key is absent), mirroring how the
  // Tsukyio key drafts off backendConfig above.
  const [featherweightPreviews, setFeatherweightPreviews] = React.useState(
    backendConfig?.featherweight_previews ?? true,
  );

  React.useEffect(() => {
    setFeatherweightPreviews(backendConfig?.featherweight_previews ?? true);
  }, [backendConfig?.featherweight_previews]);

  async function saveTsukyioKey() {
    await persistConfigField("tsukyio_api_key", tsukyioKey.trim());
    setTsukyioSaved(true);
    window.dispatchEvent(new CustomEvent("tsukyio-config-changed"));
    window.setTimeout(() => setTsukyioSaved(false), 2500);
  }

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
        <div className="settings-group-header">Tsukyio Vault</div>
        <div className="setting-row">
          <div className="setting-info" style={{ flex: 1, minWidth: 0 }}>
            <span className="setting-label">API key</span>
            <span className="setting-desc">
              Connect the Tsukyio anime asset vault to browse and download clips in-app.
              Get a free key at{" "}
              <a href="https://tsukyio.com" target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
                tsukyio.com
              </a>
              . Powered by Tsukyio.
            </span>
          </div>
        </div>
        <div className="settings-download-path-row">
          <input
            type="password"
            className="settings-path-input"
            value={tsukyioKey}
            placeholder="tsk_..."
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setTsukyioKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveTsukyioKey();
            }}
            aria-label="Tsukyio API key"
          />
          <button
            type="button"
            className="settings-path-browse-btn spring-motion"
            disabled={tsukyioKey.trim() === (backendConfig?.tsukyio_api_key ?? "").trim()}
            onClick={() => void saveTsukyioKey()}
          >
            {tsukyioSaved ? "Saved" : "Save key"}
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

        <div className="setting-row">
          <div className="setting-info">
            <span className="setting-label">Lightweight scene previews</span>
            <span className="setting-desc">
              Play scene previews straight from the source with no extra encoding. Turn off to use the
              classic animated-grid previews.
            </span>
          </div>
          <div className="settings-toggle-wrap">
            <span className="settings-toggle-icon" aria-hidden="true">
              <Film size={16} strokeWidth={2.3} />
            </span>
            <span className={`settings-toggle-label ${featherweightPreviews ? "is-on" : "is-off"}`}>
              {featherweightPreviews ? "Enabled" : "Disabled"}
            </span>
            <button
              type="button"
              className="settings-toggle-switch spring-motion"
              role="switch"
              aria-checked={featherweightPreviews}
              aria-label="Lightweight scene previews"
              data-on={featherweightPreviews ? "true" : "false"}
              onClick={() => {
                const next = !featherweightPreviews;
                setFeatherweightPreviews(next);
                void invoke("set_config", { key: "featherweight_previews", value: next ? "true" : "false" });
                window.dispatchEvent(
                  new CustomEvent("featherweight-previews-changed", { detail: { enabled: next } }),
                );
              }}
              title={featherweightPreviews ? "Use classic previews" : "Use lightweight previews"}
            >
              <span className="settings-toggle-track" aria-hidden="true">
                <span className="settings-toggle-track-on">ON</span>
                <span className="settings-toggle-track-off">OFF</span>
                <span className="settings-toggle-knob" />
              </span>
            </button>
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-info">
            <span className="setting-label">Preview quality</span>
            <span className="setting-desc">
              Resolution of the lightweight scene-preview proxy. Sharper looks better but builds slower and
              uses more disk; lower is smoother on weak machines.
            </span>
          </div>
          <Dropdown<number>
            options={[
              { value: 0, label: "Source (max)", description: "Match the source height (capped at 1080p)." },
              { value: 1080, label: "1080p", description: "Sharpest; slowest build, most disk." },
              { value: 720, label: "720p", description: "Sharp; balanced build cost." },
              { value: 480, label: "480p", description: "Lighter; faster build." },
              { value: 360, label: "360p", description: "Light; smooth on weak machines." },
              { value: 240, label: "240p (default)", description: "Default; fast build, low disk." },
              { value: 144, label: "144p", description: "Smoothest playback; least sharp." },
            ]}
            value={backendConfig?.scene_preview_height ?? 240}
            onChange={(val) => {
              void persistConfigField("scene_preview_height", String(val));
              window.dispatchEvent(
                new CustomEvent("scene-preview-height-changed", { detail: { height: val } }),
              );
            }}
            align="right"
          />
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
