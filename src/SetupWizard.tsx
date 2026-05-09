import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AlertTriangle, CheckCircle2, Cpu, Loader2, Zap } from "lucide-react";

type SetupStep = "hardware" | "recommend" | "install" | "complete";

type HardwareInfo = {
  hasNvidiaGpu: boolean;
  gpuName?: string | null;
  message: string;
};

type SetupProgress = {
  type: "setup-progress";
  step: number;
  total: number;
  state: "running" | "done" | "error";
  message: string;
};

interface Props {
  onComplete: () => void;
}

export function SetupWizard({ onComplete }: Props) {
  const [step, setStep] = React.useState<SetupStep>("hardware");
  const [hardware, setHardware] = React.useState<HardwareInfo | null>(null);
  const [selectedMode, setSelectedMode] = React.useState<"gpu" | "cpu">("cpu");
  const [installing, setInstalling] = React.useState(false);
  const [progress, setProgress] = React.useState<SetupProgress | null>(null);
  const [logLines, setLogLines] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const logRef = React.useRef<HTMLPreElement | null>(null);

  React.useEffect(() => {
    void detectHardware();
  }, []);

  React.useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logLines]);

  async function detectHardware() {
    try {
      const raw = await invoke<string>("video_gpu_status");
      const data = JSON.parse(raw) as HardwareInfo;
      setHardware(data);
      setSelectedMode(data.hasNvidiaGpu ? "gpu" : "cpu");
    } catch {
      setHardware({ hasNvidiaGpu: false, gpuName: null, message: "Hardware detection failed" });
      setSelectedMode("cpu");
    }
  }

  async function startInstall() {
    setInstalling(true);
    setLogLines([]);
    setProgress(null);
    setError(null);

    const unlisten = await listen<SetupProgress>("audio-setup-progress", (ev) => {
      setProgress(ev.payload);
      setLogLines((prev) => {
        const line = formatLine(ev.payload);
        if (!line || prev[prev.length - 1] === line) return prev;
        return [...prev, line].slice(-80);
      });
    });

    try {
      await invoke("audio_setup", { mode: selectedMode });
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setInstalling(false);
      unlisten();
      return;
    }

    unlisten();
    setInstalling(false);
    setStep("complete");
  }

  async function finish() {
    await invoke("set_config", { key: "clip_extraction_mode", value: selectedMode }).catch(() => {});
    await invoke("set_config", { key: "setup_complete", value: "true" }).catch(() => {});
    onComplete();
  }

  function formatLine(p: SetupProgress): string {
    const parts: string[] = [];
    if (p.total > 0 && p.step > 0) parts.push(`[${Math.min(p.step, p.total)}/${p.total}]`);
    if (p.state !== "running") parts.push(p.state.toUpperCase());
    parts.push(p.message.trim() || "Working...");
    return parts.join(" ");
  }

  const steps: SetupStep[] = ["hardware", "recommend", "install", "complete"];
  const stepIndex = steps.indexOf(step);
  const stepLabels = ["Hardware", "Engine", "Install", "Done"];

  return (
    <div className="setup-wizard">
      <div className="setup-step-bar">
        {steps.map((s, i) => (
          <div
            key={s}
            className={`setup-step-dot ${i < stepIndex ? "is-done" : i === stepIndex ? "is-active" : ""}`}
          >
            <span className="setup-step-num">
              {i < stepIndex ? <CheckCircle2 size={14} /> : i + 1}
            </span>
            <span className="setup-step-label">{stepLabels[i]}</span>
          </div>
        ))}
      </div>

      <div className="setup-content">
        {step === "hardware" && (
          <div className="setup-card">
            <h2>Detecting Hardware</h2>
            {!hardware ? (
              <div className="setup-loading">
                <Loader2 size={28} className="audio-spin" />
                <span>Scanning system...</span>
              </div>
            ) : (
              <>
                <div className={`setup-hw-result ${hardware.hasNvidiaGpu ? "is-gpu" : "is-cpu"}`}>
                  {hardware.hasNvidiaGpu ? <Zap size={24} /> : <Cpu size={24} />}
                  <div>
                    <div className="setup-hw-name">
                      {hardware.gpuName ?? (hardware.hasNvidiaGpu ? "NVIDIA GPU" : "No NVIDIA GPU detected")}
                    </div>
                    <div className="setup-hw-msg">{hardware.message}</div>
                  </div>
                </div>
                <div className="setup-nav">
                  <button type="button" className="setup-next-btn" onClick={() => setStep("recommend")}>
                    Continue
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {step === "recommend" && hardware && (
          <div className="setup-card">
            <h2>Choose Engine</h2>
            <p className="setup-desc">
              Select how Ultimate AMV runs AI vocal extraction and clip detection.
            </p>
            <div className="setup-mode-options">
              <label
                className={`setup-mode-option ${selectedMode === "gpu" ? "is-selected" : ""} ${!hardware.hasNvidiaGpu ? "is-disabled" : ""}`}
              >
                <input
                  type="radio"
                  name="mode"
                  value="gpu"
                  checked={selectedMode === "gpu"}
                  disabled={!hardware.hasNvidiaGpu}
                  onChange={() => setSelectedMode("gpu")}
                />
                <Zap size={20} />
                <div>
                  <span className="setup-mode-name">GPU mode (CUDA 12.8)</span>
                  <span className="setup-mode-desc">
                    {hardware.hasNvidiaGpu
                      ? `Uses ${hardware.gpuName ?? "your NVIDIA GPU"} — faster, downloads ~3 GB`
                      : "Requires an NVIDIA GPU — not detected on this machine"}
                  </span>
                </div>
              </label>
              <label className={`setup-mode-option ${selectedMode === "cpu" ? "is-selected" : ""}`}>
                <input
                  type="radio"
                  name="mode"
                  value="cpu"
                  checked={selectedMode === "cpu"}
                  onChange={() => setSelectedMode("cpu")}
                />
                <Cpu size={20} />
                <div>
                  <span className="setup-mode-name">CPU mode</span>
                  <span className="setup-mode-desc">
                    Works on any machine — slower, downloads ~200 MB
                  </span>
                </div>
              </label>
            </div>
            <div className="setup-nav">
              <button type="button" className="setup-back-btn" onClick={() => setStep("hardware")}>
                Back
              </button>
              <button type="button" className="setup-next-btn" onClick={() => setStep("install")}>
                Continue
              </button>
            </div>
          </div>
        )}

        {step === "install" && (
          <div className="setup-card">
            <h2>Installing Dependencies</h2>
            {!installing && !error && logLines.length === 0 && (
              <>
                <p className="setup-desc">
                  {selectedMode === "gpu"
                    ? "Will download PyTorch with CUDA 12.8 and AI models (~3 GB)."
                    : "Will download PyTorch CPU and AI models (~200 MB)."}
                </p>
                <div className="setup-nav">
                  <button
                    type="button"
                    className="setup-back-btn"
                    onClick={() => setStep("recommend")}
                  >
                    Back
                  </button>
                  <button type="button" className="setup-next-btn" onClick={startInstall}>
                    Install
                  </button>
                </div>
              </>
            )}
            {installing && (
              <div className="setup-installing">
                <div className="setup-progress-status">
                  <Loader2 size={16} className="audio-spin" />
                  <span>
                    {progress
                      ? `Step ${Math.min(progress.step, progress.total)} / ${progress.total} — ${progress.message}`
                      : "Starting..."}
                  </span>
                </div>
                {logLines.length > 0 && (
                  <pre ref={logRef} className="setup-log">
                    {logLines.join("\n")}
                  </pre>
                )}
              </div>
            )}
            {error && (
              <div className="setup-error-block">
                <div className="setup-error-msg">
                  <AlertTriangle size={16} />
                  <span>{error}</span>
                </div>
                <div className="setup-nav">
                  <button
                    type="button"
                    className="setup-back-btn"
                    onClick={() => setStep("recommend")}
                  >
                    Back
                  </button>
                  <button type="button" className="setup-next-btn" onClick={startInstall}>
                    Retry
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {step === "complete" && (
          <div className="setup-card setup-card-complete">
            <CheckCircle2 size={52} className="setup-complete-icon" />
            <h2>Ready</h2>
            <p className="setup-desc">
              {selectedMode === "gpu" ? "GPU" : "CPU"} engine installed. Ultimate AMV is ready to
              use.
            </p>
            <button type="button" className="setup-next-btn" onClick={finish}>
              Start Using Ultimate AMV
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
