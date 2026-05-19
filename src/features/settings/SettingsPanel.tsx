import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Palette, Sliders, Zap } from "lucide-react";
import { isDiscordEnabled, setDiscordEnabled } from "../../lib/discord";
import { formatBytes } from "../../lib/format";
import { logFrontend, safeLogValue } from "../../lib/log";
import { parseBridgePayload, readBridgeError } from "../../utils/bridge";
import type { AppConfig } from "../../types/app";
import type { AudioSetupProgress, AudioStatus } from "../../types/audio";
import { UpdateCard } from "./UpdateCard";
import { EngineSettings } from "./EngineSettings";
import { FeatureSettings } from "./FeatureSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { SettingsConfirmModal } from "./SettingsConfirmModal";

function formatSetupLogLine(progress: AudioSetupProgress): string {
  const parts = [];
  if (progress.total > 0 && progress.step > 0) {
    parts.push(`[${Math.min(progress.step, progress.total)}/${progress.total}]`);
  }
  if (progress.state !== "running") parts.push(progress.state.toUpperCase());
  parts.push(progress.message.trim() || "Working...");
  return parts.join(" ");
}

interface SettingsPanelProps {
  themeColors: { primary: string; secondary: string };
}

type ConfirmState = {
  open: boolean;
  title: string;
  description: React.ReactNode;
  confirmText: string;
  isDanger: boolean;
  onConfirm: () => void;
};

const CONFIRM_CLOSED: ConfirmState = {
  open: false,
  title: "",
  description: "",
  confirmText: "",
  isDanger: false,
  onConfirm: () => {},
};

export function SettingsPanel({ themeColors }: SettingsPanelProps) {
  const [activeTab, setActiveTab] = React.useState<"engine" | "features" | "appearance">("engine");
  const [backendConfig, setBackendConfig] = React.useState<AppConfig | null>(null);
  const [localDownloadPath, setLocalDownloadPath] = React.useState("");
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
  const [discordEnabled, setDiscordEnabledLocal] = React.useState(isDiscordEnabled);
  const [clipHoverPreview, setClipHoverPreview] = React.useState(true);
  const [confirmModal, setConfirmModal] = React.useState<ConfirmState>(CONFIRM_CLOSED);

  function closeConfirm() {
    setConfirmModal((prev) => ({ ...prev, open: false }));
  }

  function toggleDiscordPresence() {
    const next = !discordEnabled;
    setDiscordEnabledLocal(next);
    setDiscordEnabled(next);
  }

  React.useEffect(() => {
    void refreshConfig();
    void refreshStatus();
    const onBgSaved = () => void refreshConfig();
    window.addEventListener("bg-saved", onBgSaved);
    return () => window.removeEventListener("bg-saved", onBgSaved);
  }, []);

  React.useEffect(() => {
    const handler = (e: Event) => {
      setClipHoverPreview((e as CustomEvent<{ enabled: boolean }>).detail.enabled);
    };
    window.addEventListener("clip-hover-preview-changed", handler);
    return () => window.removeEventListener("clip-hover-preview-changed", handler);
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
      setLocalDownloadPath(payload.download_path ?? "");
      setClipHoverPreview(payload.clip_hover_preview ?? true);
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

  function confirmSwitchMode(mode: "cpu" | "gpu") {
    setConfirmModal({
      open: true,
      title: `Switch to ${mode.toUpperCase()} engine?`,
      description: (
        <p>
          You are about to switch the AI hardware engine to <strong>{mode.toUpperCase()}</strong>.{" "}
          {mode === "gpu"
            ? "This will download and configure CUDA libraries (PyTorch GPU build) which needs a stable internet connection and around 2-3 GB of disk space. Any active audio separations will be paused."
            : "This will install the CPU-only PyTorch wheel for universal hardware compatibility. Processing will be slower but will run on any computer."}
        </p>
      ),
      confirmText: `Switch to ${mode.toUpperCase()}`,
      isDanger: false,
      onConfirm: () => {
        closeConfirm();
        void switchMode(mode);
      },
    });
  }

  function confirmClearCache() {
    setConfirmModal({
      open: true,
      title: "Clear preview cache?",
      description: (
        <p>
          Delete all cached clip preview files? Previews will regenerate the next time you open the clip extractor.
        </p>
      ),
      confirmText: "Clear cache",
      isDanger: true,
      onConfirm: () => {
        closeConfirm();
        void clearCache();
      },
    });
  }

  const rawMode: "cpu" | "gpu" = backendConfig?.setup_type === "gpu" ? "gpu" : "cpu";
  const torchVersion = status?.dependencies.torch_version ?? "";
  const installedMode: "gpu" | "cpu" | null = torchVersion.includes("+cu")
    ? "gpu"
    : torchVersion.includes("+cpu")
      ? "cpu"
      : null;
  // The installed torch wheel is the source of truth: a successful install
  // path always sets setup_type to match, so any drift between the stored
  // pref and the wheel tag is a stale config (the backend self-heals this
  // on the next show_config).
  const currentMode: "cpu" | "gpu" = installedMode ?? rawMode;
  const settingsChecking = !status || !backendConfig;

  return (
    <div className="settings-panel">
      <div className="settings-toolbar">
        <span>System preferences</span>
      </div>

      <div className="settings-tab-bar glass">
        <button
          type="button"
          className={`settings-tab-btn spring-motion ${activeTab === "engine" ? "is-active accent-glow" : ""}`}
          onClick={() => setActiveTab("engine")}
        >
          <Zap size={15} />
          <span>System & Engine</span>
        </button>
        <button
          type="button"
          className={`settings-tab-btn spring-motion ${activeTab === "features" ? "is-active accent-glow" : ""}`}
          onClick={() => setActiveTab("features")}
        >
          <Sliders size={15} />
          <span>Feature Preferences</span>
        </button>
        <button
          type="button"
          className={`settings-tab-btn spring-motion ${activeTab === "appearance" ? "is-active accent-glow" : ""}`}
          onClick={() => setActiveTab("appearance")}
        >
          <Palette size={15} />
          <span>Theme & Social</span>
        </button>
      </div>

      <div className="settings-groups">
        {activeTab === "engine" && (
          <>
            <UpdateCard />
            <EngineSettings
              status={status}
              backendConfig={backendConfig}
              settingsChecking={settingsChecking}
              setupRunning={setupRunning}
              setupProgress={setupProgress}
              setupLines={setupLines}
              setupNotice={setupNotice}
              error={error}
              setupLogRef={setupLogRef}
              switchMode={confirmSwitchMode}
              clearingCache={clearingCache}
              cacheNotice={cacheNotice}
              cacheError={cacheError}
              clearCache={confirmClearCache}
            />
          </>
        )}

        {activeTab === "features" && (
          <FeatureSettings
            backendConfig={backendConfig}
            persistConfigField={persistConfigField}
            clipHoverPreview={clipHoverPreview}
            setClipHoverPreview={setClipHoverPreview}
            localDownloadPath={localDownloadPath}
            setLocalDownloadPath={setLocalDownloadPath}
            currentMode={currentMode}
          />
        )}

        {activeTab === "appearance" && (
          <AppearanceSettings
            backendConfig={backendConfig}
            persistConfigField={persistConfigField}
            themeColors={themeColors}
            discordEnabled={discordEnabled}
            toggleDiscordPresence={toggleDiscordPresence}
          />
        )}
      </div>

      <SettingsConfirmModal
        open={confirmModal.open}
        title={confirmModal.title}
        description={confirmModal.description}
        confirmText={confirmModal.confirmText}
        isDanger={confirmModal.isDanger}
        onConfirm={confirmModal.onConfirm}
        onCancel={closeConfirm}
      />
    </div>
  );
}
