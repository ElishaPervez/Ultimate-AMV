import React from "react";
import { AlertTriangle, CheckCircle2, Cpu, Loader2, Trash2, Zap } from "lucide-react";
import type { AppConfig } from "../../types/app";
import type { AudioSetupProgress, AudioStatus } from "../../types/audio";

interface EngineSettingsProps {
  status: AudioStatus | null;
  backendConfig: AppConfig | null;
  settingsChecking: boolean;
  setupRunning: "cpu" | "gpu" | null;
  setupProgress: AudioSetupProgress | null;
  setupLines: string[];
  setupNotice: string | null;
  error: string | null;
  setupLogRef: React.RefObject<HTMLPreElement | null>;
  switchMode: (mode: "cpu" | "gpu") => void;
  clearingCache: boolean;
  cacheNotice: string | null;
  cacheError: string | null;
  clearCache: () => void;
}

export function EngineSettings({
  status,
  backendConfig,
  settingsChecking,
  setupRunning,
  setupProgress,
  setupLines,
  setupNotice,
  error,
  setupLogRef,
  switchMode,
  clearingCache,
  cacheNotice,
  cacheError,
  clearCache,
}: EngineSettingsProps) {
  const rawMode = backendConfig?.setup_type ?? "cpu";
  const hasGpu = status?.hardware.gpu_type === "nvidia";
  const gpuSetupBlocked = status ? !hasGpu : false;
  const depsReady = status?.dependencies.ready ?? false;
  const torchVersion = status?.dependencies.torch_version ?? "";
  const installedMode: "gpu" | "cpu" | null = torchVersion.includes("+cu")
    ? "gpu"
    : torchVersion.includes("+cpu")
      ? "cpu"
      : null;
  const currentMode = installedMode ?? rawMode;
  const gpuAllSet = installedMode === "gpu" && depsReady && hasGpu;
  const cpuAllSet = installedMode === "cpu" && depsReady;

  return (
    <div className="settings-category-wrapper">
      <div className="settings-group glass">
        <div className="settings-group-header">AI Engine</div>
        <div className="settings-engine-warning accent-glow">
          <AlertTriangle size={15} />
          <span>
            This engine is shared between <strong>Vocal Separation</strong> and <strong>Scene Splitting</strong>.
            Because they both use the same AI background environment, they must run on the same hardware.
          </span>
        </div>

        <div className="setting-row deps-row">
          <div className="setting-info">
            <span className="setting-label">Active mode</span>
            <span className="setting-desc">
              {installedMode === "gpu"
                ? "GPU (Faster)"
                : installedMode === "cpu"
                  ? "CPU-only"
                  : status
                    ? "Detecting engine..."
                    : "Checking..."}
              {status ? ` · ${status.hardware.device} · ${status.hardware.provider}` : ""}
            </span>
          </div>

          <div className="deps-badge">
            {depsReady && installedMode ? (
              <span className="deps-badge-ready">{installedMode.toUpperCase()} READY</span>
            ) : (
              <span className="deps-badge-missing">Not installed</span>
            )}
          </div>
        </div>

        <div className="setting-row deps-row">
          <div className="setting-info">
            <span className="setting-label">Helper software status</span>
            <span className="setting-desc">
              {status
                ? [
                  status.dependencies.torch ? "AI core ✓" : "AI core missing",
                  status.dependencies.onnxruntime ? "Inference engine ✓" : "Inference engine missing",
                  status.dependencies.audio_separator ? "Vocal splitter ✓" : "Vocal splitter missing",
                  status.dependencies.typing_extensions ? "Utilities ✓" : "Utilities missing",
                  status.dependencies.pydub ? "Audio toolkit ✓" : "Audio toolkit missing",
                ].join("  ·  ")
                : "Loading..."}
            </span>
          </div>
        </div>

        <div className="deps-switch-actions">
          {gpuSetupBlocked && (
            <div className="settings-gpu-warning glass">
              <AlertTriangle size={15} />
              <span>Compatible graphics card not found. GPU mode requires an NVIDIA graphics card.</span>
            </div>
          )}
          <button
            type="button"
            className={`install-btn spring-motion ${currentMode === "gpu" ? "is-primary accent-glow" : "is-secondary"}`}
            onClick={() => switchMode("gpu")}
            disabled={settingsChecking || gpuAllSet || setupRunning !== null || gpuSetupBlocked}
            title={
              settingsChecking ? "Checking graphics card..." :
                gpuAllSet ? "GPU mode is ready" :
                  gpuSetupBlocked ? "Compatible graphics card not found" :
                    "Switch to GPU mode (Faster)"
            }
          >
            <Zap size={16} strokeWidth={2.3} />
            <span>{settingsChecking ? "Checking GPU" : gpuAllSet ? "GPU ready" : "Switch to GPU"}</span>
            <small>{settingsChecking ? "Please wait" : gpuAllSet ? "Already set up" : hasGpu ? "NVIDIA GPU : faster" : "Compatible graphics card not found"}</small>
          </button>

          <button
            type="button"
            className={`install-btn spring-motion ${currentMode === "cpu" ? "is-primary accent-glow" : "is-secondary"}`}
            onClick={() => switchMode("cpu")}
            disabled={settingsChecking || cpuAllSet || setupRunning !== null}
            title={settingsChecking ? "Checking current setup..." : cpuAllSet ? "CPU mode is ready" : "Switch to CPU mode"}
          >
            <Cpu size={16} strokeWidth={2.3} />
            <span>{settingsChecking ? "Checking CPU" : cpuAllSet ? "CPU ready" : "Switch to CPU"}</span>
            <small>{settingsChecking ? "Please wait" : cpuAllSet ? "Already set up" : hasGpu ? "Works on any computer" : "Recommended"}</small>
          </button>
        </div>

        {setupRunning && (
          <div className="settings-setup-status">
            <Loader2 size={16} className="audio-spin" />
            <span>
              Installing {setupRunning === "gpu" ? "GPU" : "CPU"} engine{setupProgress ? ` : step ${setupProgress.step}/${setupProgress.total}` : ""}
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

      <div className="settings-group glass">
        <div className="settings-group-header">Storage</div>
        <div className="setting-row">
          <div className="setting-info">
            <span className="setting-label">Saved video previews</span>
            <span className="setting-desc">
              Saved video loops used when showing previews. Safe to clear &mdash; they will be created again when needed.
            </span>
          </div>
          <button
            type="button"
            className="settings-action-pill is-danger spring-motion"
            onClick={() => clearCache()}
            disabled={clearingCache}
            title="Delete saved video previews"
          >
            <span className="settings-action-pill-icon" aria-hidden="true">
              {clearingCache ? <Loader2 size={16} className="audio-spin" /> : <Trash2 size={16} strokeWidth={2.3} />}
            </span>
            <span className="settings-action-pill-label">
              {clearingCache ? "Clearing..." : "Clear cache"}
            </span>
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
  );
}
