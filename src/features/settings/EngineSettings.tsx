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
        <div className="settings-group-header">AI Hardware Engine</div>
        <div className="settings-engine-warning accent-glow">
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
            <div className="settings-gpu-warning glass">
              <AlertTriangle size={15} />
              <span>Compatible GPU not found. GPU Vocal Extraction needs an NVIDIA CUDA GPU.</span>
            </div>
          )}
          <button
            type="button"
            className={`install-btn spring-motion ${currentMode === "gpu" ? "is-primary accent-glow" : "is-secondary"}`}
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
            <small>{settingsChecking ? "Please wait" : gpuAllSet ? "Already set up" : hasGpu ? "CUDA 12.8 : faster" : "Compatible GPU not found"}</small>
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
            <small>{settingsChecking ? "Please wait" : cpuAllSet ? "Already set up" : hasGpu ? "Fallback : works anywhere" : "Recommended"}</small>
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
            <span className="setting-label">Preview cache</span>
            <span className="setting-desc">
              Generated thumbnail clips used by the clip grid. Safe to clear &mdash; previews regenerate on demand.
            </span>
          </div>
          <button
            type="button"
            className="settings-action-pill is-danger spring-motion"
            onClick={() => clearCache()}
            disabled={clearingCache}
            title="Delete cached clip preview files"
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
