import React from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AlertTriangle, CheckCircle2, Cpu, Image as ImageIcon, Loader2, Trash2, Zap } from "lucide-react";
import { formatBytes } from "../../lib/format";
import { logFrontend, safeLogValue } from "../../lib/log";
import { applyAppTheme, readThemeColors } from "../../lib/theme";
import { parseBridgePayload, readBridgeError } from "../../utils/bridge";
import type { AppConfig } from "../../types/app";
import type { AudioSetupProgress, AudioStatus } from "../../types/audio";

function formatSetupLogLine(progress: AudioSetupProgress): string {
  const parts = [];
  if (progress.total > 0 && progress.step > 0) {
    parts.push(`[${Math.min(progress.step, progress.total)}/${progress.total}]`);
  }
  if (progress.state !== "running") parts.push(progress.state.toUpperCase());
  parts.push(progress.message.trim() || "Working...");
  return parts.join(" ");
}

export function SettingsPanel() {
  const [backendConfig, setBackendConfig] = React.useState<AppConfig | null>(null);
  const [localClipMode, setLocalClipMode] = React.useState<"cpu" | "gpu">("gpu");
  const [localDownloadPath, setLocalDownloadPath] = React.useState("");
  const [localThemeColors, setLocalThemeColors] = React.useState(() => readThemeColors(null));
  const [status, setStatus] = React.useState<AudioStatus | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [setupRunning, setSetupRunning] = React.useState<"cpu" | "gpu" | null>(null);
  const [setupProgress, setSetupProgress] = React.useState<AudioSetupProgress | null>(null);
  const [setupLines, setSetupLines] = React.useState<string[]>([]);
  const [setupNotice, setSetupNotice] = React.useState<string | null>(null);
  const setupLogRef = React.useRef<HTMLPreElement | null>(null);
  const [clearingCache, setClearingCache] = React.useState(false);
  const [cacheNotice, setCacheNotice] = React.useState<string | null>(null);
  const [cacheError, setCacheError] = React.useState<string | null>(null);

  React.useEffect(() => {
    void refreshConfig();
    void refreshStatus();
    const onBgSaved = () => void refreshConfig();
    window.addEventListener("bg-saved", onBgSaved);
    return () => window.removeEventListener("bg-saved", onBgSaved);
  }, []);

  React.useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<AudioSetupProgress>("audio-setup-progress", (event) => {
      setSetupProgress(event.payload);
      setSetupLines((current) => {
        const nextLine = formatSetupLogLine(event.payload);
        if (!nextLine || current[current.length - 1] === nextLine) return current;
        return [...current, nextLine].slice(-80);
      });
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  React.useEffect(() => {
    const log = setupLogRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [setupLines]);

  async function refreshConfig() {
    try {
      const raw = await invoke<string>("get_config");
      const payload = parseBridgePayload<AppConfig>(raw);
      setBackendConfig(payload);
      setLocalClipMode(payload.clip_extraction_mode ?? "gpu");
      setLocalDownloadPath(payload.download_path ?? "");
      const nextThemeColors = readThemeColors(payload);
      setLocalThemeColors(nextThemeColors);
      applyAppTheme(nextThemeColors);
      setError(null);
    } catch (e) {
      setError(readBridgeError(e));
    }
  }

  async function refreshStatus() {
    try {
      const raw = await invoke<string>("audio_status");
      const payload = parseBridgePayload<AudioStatus>(raw);
      setStatus(payload);
    } catch (e) {
      console.error("Could not load status:", e);
      logFrontend("error", "frontend.settings.status.error", "Could not load dependency status", {
        error: safeLogValue(e),
      });
    }
  }

  async function persistConfigField(key: string, value: string) {
    try {
      const raw = await invoke<string>("set_config", { key, value });
      const latest = parseBridgePayload<AppConfig>(raw);
      setBackendConfig(latest);
      setError(null);
    } catch (e) {
      setError(readBridgeError(e));
    }
  }

  async function switchMode(mode: "cpu" | "gpu") {
    setSetupRunning(mode);
    setSetupLines([]);
    setSetupProgress({
      type: "setup-progress",
      step: 0,
      total: 0,
      state: "running",
      message: `Preparing ${mode.toUpperCase()} install...`,
    });
    setSetupNotice(null);
    setError(null);
    try {
      await invoke<string>("audio_setup", { mode });
      await invoke<string>("set_config", { key: "clip_extraction_mode", value: mode });
      setSetupNotice(`${mode === "gpu" ? "GPU" : "CPU"} engine ready.`);
      window.dispatchEvent(new CustomEvent("clipmode-changed", { detail: { mode } }));
      await refreshConfig();
      await refreshStatus();
      window.setTimeout(() => setSetupLines([]), 10000);
    } catch (e) {
      setError(readBridgeError(e));
    } finally {
      setSetupRunning(null);
      setSetupProgress(null);
    }
  }

  async function clearCache() {
    setClearingCache(true);
    setCacheNotice(null);
    setCacheError(null);
    try {
      const report = await invoke<{ files_removed: number; bytes_freed: number }>("clear_app_cache");
      const files = report.files_removed ?? 0;
      const bytes = report.bytes_freed ?? 0;
      setCacheNotice(
        files === 0
          ? "Cache already empty."
          : `Cleared ${files} preview file${files === 1 ? "" : "s"} (${formatBytes(bytes)}).`,
      );
      window.setTimeout(() => setCacheNotice(null), 6000);
    } catch (e) {
      setCacheError(readBridgeError(e));
    } finally {
      setClearingCache(false);
    }
  }

  const rawMode = backendConfig?.setup_type ?? "cpu";
  const currentMode = rawMode;
  const hasGpu = status?.hardware.gpu_type === "nvidia";
  const settingsChecking = !status || !backendConfig;
  const gpuSetupBlocked = status ? !hasGpu : false;
  const depsReady = status?.dependencies.ready ?? false;
  const torchVersion = status?.dependencies.torch_version ?? "";
  const installedMode: "gpu" | "cpu" | null = torchVersion.includes("+cu")
    ? "gpu"
    : torchVersion.includes("+cpu")
      ? "cpu"
      : null;
  const modeMismatch = installedMode !== null && installedMode !== currentMode;
  const gpuAllSet = currentMode === "gpu" && installedMode === "gpu" && depsReady && hasGpu;
  const cpuAllSet = currentMode === "cpu" && installedMode === "cpu" && depsReady;

  return (
    <div className="settings-panel">
      <div className="settings-toolbar">
        <span>System preferences</span>
      </div>

      <div className="settings-groups">


        <div className="settings-group">
          <div className="settings-group-header">AI Hardware Engine</div>
          <div className="settings-engine-warning">
            <AlertTriangle size={15} />
            <span>
              This engine is shared between <strong>Vocal Extraction</strong> and <strong>Clip Extraction</strong>.
              Because they share a single PyTorch environment, you must use the same hardware mode for both.
            </span>
          </div>

          <div className="setting-row deps-row">
            <div className="setting-info">
              <span className="setting-label">Active mode</span>
              <span className="setting-desc">
                {installedMode === "gpu"
                  ? "GPU (CUDA)"
                  : installedMode === "cpu"
                    ? "CPU-only"
                    : status
                      ? "Detecting engine..."
                      : "Checking..."}
                {status ? ` · ${status.hardware.device} · ${status.hardware.provider}` : ""}
                {modeMismatch && installedMode
                  ? ` · configured for ${currentMode.toUpperCase()}`
                  : ""}
              </span>
            </div>

            <div className="deps-badge">
              {modeMismatch && installedMode ? (
                <span className="deps-badge-missing">
                  {installedMode.toUpperCase()} installed · {currentMode.toUpperCase()} configured
                </span>
              ) : depsReady && installedMode ? (
                <span className="deps-badge-ready">{installedMode.toUpperCase()} READY</span>
              ) : (
                <span className="deps-badge-missing">Not installed</span>
              )}
            </div>
          </div>

          <div className="setting-row deps-row">
            <div className="setting-info">
              <span className="setting-label">Dependency status</span>
              <span className="setting-desc">
                {status
                  ? [
                    status.dependencies.torch ? `PyTorch ${status.dependencies.torch_version ?? ""}` : "PyTorch missing",
                    status.dependencies.onnxruntime ? "ONNX OK" : "ONNX missing",
                    status.dependencies.audio_separator ? "audio-separator OK" : "audio-separator missing",
                    status.dependencies.typing_extensions ? "typing_extensions OK" : "typing_extensions missing",
                    status.dependencies.pydub ? "pydub OK" : "pydub missing",
                  ].join("  ·  ")
                  : "Loading..."}
              </span>
            </div>
          </div>

          <div className="deps-switch-actions">
            {gpuSetupBlocked && (
              <div className="settings-gpu-warning">
                <AlertTriangle size={15} />
                <span>Compatible GPU not found. GPU Vocal Extraction needs an NVIDIA CUDA GPU.</span>
              </div>
            )}
            <button
              type="button"
              className={`install-btn ${currentMode === "gpu" ? "is-primary" : "is-secondary"}`}
              onClick={() => switchMode("gpu")}
              disabled={settingsChecking || gpuAllSet || setupRunning !== null || gpuSetupBlocked}
              title={
                settingsChecking ? "Checking GPU compatibility..." :
                  gpuAllSet ? "GPU mode is ready" :
                    gpuSetupBlocked ? "Compatible GPU not found" :
                      "Switch to GPU mode (CUDA 12.8)"
              }
            >
              <Zap size={16} strokeWidth={2.3} />
              <span>{settingsChecking ? "Checking GPU" : gpuAllSet ? "GPU ready" : "Switch to GPU"}</span>
              <small>{settingsChecking ? "Please wait" : gpuAllSet ? "Already set up" : hasGpu ? "CUDA 12.8 — faster" : "Compatible GPU not found"}</small>
            </button>

            <button
              type="button"
              className={`install-btn ${currentMode === "cpu" ? "is-primary" : "is-secondary"}`}
              onClick={() => switchMode("cpu")}
              disabled={settingsChecking || cpuAllSet || setupRunning !== null}
              title={settingsChecking ? "Checking current setup..." : cpuAllSet ? "CPU mode is ready" : "Switch to CPU mode"}
            >
              <Cpu size={16} strokeWidth={2.3} />
              <span>{settingsChecking ? "Checking CPU" : cpuAllSet ? "CPU ready" : "Switch to CPU"}</span>
              <small>{settingsChecking ? "Please wait" : cpuAllSet ? "Already set up" : hasGpu ? "Fallback — works anywhere" : "Recommended"}</small>
            </button>
          </div>

          {setupRunning && (
            <div className="settings-setup-status">
              <Loader2 size={16} className="audio-spin" />
              <span>
                Installing {setupRunning === "gpu" ? "GPU" : "CPU"} engine{setupProgress ? ` — step ${setupProgress.step}/${setupProgress.total}` : ""}
              </span>
            </div>
          )}

          {setupLines.length > 0 && (
            <pre ref={setupLogRef} className="settings-live-log" aria-label="Dependency setup log">
              {setupLines.join("\n")}
            </pre>
          )}

          {setupNotice && (
            <div className="settings-notice is-success">
              <CheckCircle2 size={16} /> {setupNotice}
            </div>
          )}

          {error && (
            <div className="settings-notice is-error">
              <AlertTriangle size={16} /> {error}
            </div>
          )}
        </div>

        <div className="settings-group">
          <div className="settings-group-header">Clip Extraction</div>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">Detection engine</span>
              <span className="setting-desc">
                {currentMode === "gpu"
                  ? "RTX TransNetV2 with NVDEC analysis decode (Locked to AI Hardware Engine)"
                  : "PySceneDetect CPU detection for broad hardware support (Locked to AI Hardware Engine)"}
              </span>
            </div>
            <div className="deps-badge">
              <span className="deps-badge-ready" style={{ color: "var(--fg-muted)", border: "1px solid var(--border)", background: "transparent" }}>
                {currentMode.toUpperCase()}
              </span>
            </div>
          </div>

        </div>

        <div className="settings-group">
          <div className="settings-group-header">Downloads</div>
          <div className="setting-row">
            <div className="setting-info" style={{ flex: 1, minWidth: 0 }}>
              <span className="setting-label">Download folder</span>
              <span className="setting-desc">
                Where anime episodes are saved. Defaults to Videos\Ultimate AMV\anime downloads.
              </span>
            </div>
          </div>
          <div className="settings-download-path-row">
            <input
              type="text"
              className="settings-path-input"
              value={localDownloadPath}
              placeholder="Default: Videos\Ultimate AMV\anime downloads"
              readOnly
              aria-label="Download folder path"
            />
            <button
              type="button"
              className="settings-path-browse-btn"
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

        <div className="settings-group">
          <div className="settings-group-header">Appearance</div>
          <div className="setting-row theme-setting-row">
            <div className="setting-info">
              <span className="setting-label">Gradient theme</span>
              <span className="setting-desc">Choose one or two custom colors for buttons, active tabs, highlights, progress, and action states.</span>
            </div>
            <div className="theme-customizer" aria-label="Gradient theme colors">
              <label className="theme-color-field">
                <span>Color 1</span>
                <input
                  type="color"
                  value={localThemeColors.primary}
                  onChange={(event) => {
                    const next = { ...localThemeColors, primary: event.currentTarget.value };
                    setLocalThemeColors(next);
                    applyAppTheme(next);
                    window.dispatchEvent(new CustomEvent("theme-changed", { detail: next }));
                    void persistConfigField("theme_color_a", next.primary);
                  }}
                  aria-label="Gradient theme color 1"
                />
              </label>
              <label className="theme-color-field">
                <span>Color 2</span>
                <input
                  type="color"
                  value={localThemeColors.secondary}
                  onChange={(event) => {
                    const next = { ...localThemeColors, secondary: event.currentTarget.value };
                    setLocalThemeColors(next);
                    applyAppTheme(next);
                    window.dispatchEvent(new CustomEvent("theme-changed", { detail: next }));
                    void persistConfigField("theme_color_b", next.secondary);
                  }}
                  aria-label="Gradient theme color 2"
                />
              </label>
              <div
                className="theme-gradient-preview"
                style={{
                  background: `linear-gradient(120deg, ${localThemeColors.primary}, ${localThemeColors.secondary})`,
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
            <div className="bg-setting-actions">
              {backendConfig?.background_image && (
                <div
                  className="bg-setting-thumb"
                  aria-hidden="true"
                  style={{ backgroundImage: `url("${convertFileSrc(backendConfig.background_image)}")` }}
                />
              )}
              <button
                type="button"
                className="install-btn is-secondary"
                onClick={() => window.dispatchEvent(new CustomEvent("bg-customize-open"))}
              >
                <ImageIcon size={16} strokeWidth={2.2} />
                <span>{backendConfig?.background_image ? "Customize background" : "Choose background"}</span>
              </button>
            </div>
          </div>
        </div>

        <div className="settings-group">
          <div className="settings-group-header">Storage</div>
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">Preview cache</span>
              <span className="setting-desc">
                Generated thumbnail clips used by the clip grid. Safe to clear &mdash; previews regenerate on demand.
              </span>
            </div>
            <button
              type="button"
              className="install-btn is-secondary"
              onClick={() => void clearCache()}
              disabled={clearingCache}
              title="Delete cached clip preview files"
            >
              {clearingCache ? <Loader2 size={16} className="audio-spin" /> : <Trash2 size={16} strokeWidth={2.3} />}
              <span>{clearingCache ? "Clearing..." : "Clear cache"}</span>
              <small>{clearingCache ? "Please wait" : "Frees disk space"}</small>
            </button>
          </div>
          {cacheNotice && (
            <div className="settings-notice is-success">
              <CheckCircle2 size={16} /> {cacheNotice}
            </div>
          )}
          {cacheError && (
            <div className="settings-notice is-error">
              <AlertTriangle size={16} /> {cacheError}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
