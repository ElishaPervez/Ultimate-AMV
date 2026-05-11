import { Cpu, Sparkles, Zap } from "lucide-react";
import type { AudioStatus } from "../../types/audio";

export function DepInstallCard({
  status,
  hasGpu,
  gpuSetupBlocked,
  onChoose,
}: {
  status: AudioStatus;
  hasGpu: boolean;
  gpuSetupBlocked: boolean;
  onChoose: (mode: "cpu" | "gpu") => void;
}) {
  return (
    <section className="audio-card install-card">
      <header className="audio-card-header">
        <span className="audio-card-icon install-icon">
          <Sparkles size={22} strokeWidth={2.2} />
        </span>
        <div>
          <h2>One-time engine setup</h2>
          <p className="audio-card-sub">
            Vocal Extraction needs PyTorch, audio-separator, and the model runtime. Pick a mode and we'll install
            everything for you.
          </p>
        </div>
      </header>

      <ul className="install-detect">
        {gpuSetupBlocked && (
          <li className="install-warning">
            <span className="install-detect-label">Compatible GPU not found</span>
            <span className="install-detect-value">GPU Vocal Extraction needs an NVIDIA CUDA GPU.</span>
          </li>
        )}
        <li>
          <span className="install-detect-label">Detected hardware</span>
          <span className="install-detect-value">{status.hardware.device}</span>
        </li>
        <li>
          <span className="install-detect-label">Active model</span>
          <span className="install-detect-value">{status.model_name}</span>
        </li>
      </ul>

      <div className="install-actions">
        <button
          type="button"
          className={`install-btn ${hasGpu ? "is-primary" : "is-secondary"}`}
          onClick={() => onChoose("gpu")}
          disabled={gpuSetupBlocked}
          title={hasGpu ? "Install GPU mode (CUDA 12.8)" : "Compatible GPU not found"}
        >
          <Zap size={16} strokeWidth={2.3} />
          <span>Install GPU mode</span>
          <small>{hasGpu ? "CUDA 12.8 — faster" : "Compatible GPU not found"}</small>
        </button>

        <button
          type="button"
          className={`install-btn ${hasGpu ? "is-secondary" : "is-primary"}`}
          onClick={() => onChoose("cpu")}
        >
          <Cpu size={16} strokeWidth={2.3} />
          <span>Install CPU only</span>
          <small>{hasGpu ? "Skip GPU — works anywhere" : "Recommended"}</small>
        </button>
      </div>
    </section>
  );
}
