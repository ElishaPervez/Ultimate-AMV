import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, CheckCircle2, Cpu, FolderOpen, Loader2, Zap } from "lucide-react";

type SetupStep = "hardware" | "recommend" | "folder" | "install" | "complete";

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
  const [downloadPath, setDownloadPath] = React.useState("");
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

  async function chooseDownloadFolder() {
    const selected = await openDialog({ directory: true, multiple: false });
    if (selected && typeof selected === "string") {
      setDownloadPath(selected);
      await invoke("set_config", { key: "download_path", value: selected }).catch(() => {});
    }
  }

  function formatLine(p: SetupProgress): string {
    const parts: string[] = [];
    if (p.total > 0 && p.step > 0) parts.push(`[${Math.min(p.step, p.total)}/${p.total}]`);
    if (p.state !== "running") parts.push(p.state.toUpperCase());
    parts.push(p.message.trim() || "Working...");
    return parts.join(" ");
  }

  const steps: SetupStep[] = ["hardware", "recommend", "folder", "install", "complete"];
  const stepIndex = steps.indexOf(step);
  const stepLabels = ["Hardware", "Engine", "Folder", "Install", "Done"];

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
            <h2>Checking your computer</h2>
            {!hardware ? (
              <div className="setup-loading">
                <Loader2 size={28} className="audio-spin" />
                <span>Scanning computer...</span>
              </div>
            ) : (
              <>
                <div className={`setup-hw-result ${hardware.hasNvidiaGpu ? "is-gpu" : "is-cpu"}`}>
                  {hardware.hasNvidiaGpu ? <Zap size={24} /> : <Cpu size={24} />}
                  <div>
                    <div className="setup-hw-name">
                      {hardware.gpuName ?? (hardware.hasNvidiaGpu ? "NVIDIA graphics card" : "No NVIDIA graphics card detected")}
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
            <h2>Choose AI Engine</h2>
            <p className="setup-desc">
              Select how Ultimate AMV separates vocals and splits video scenes.
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
                  <span className="setup-mode-name">GPU mode (Faster)</span>
                  <span className="setup-mode-desc">
                    {hardware.hasNvidiaGpu
                      ? `Uses ${hardware.gpuName ?? "your NVIDIA graphics card"} : faster, downloads about 3 GB`
                      : "Requires an NVIDIA graphics card : not found on this computer"}
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
                    Works on any computer : slower, downloads about 200 MB
                  </span>
                </div>
              </label>
            </div>
            <div className="setup-nav">
              <button type="button" className="setup-back-btn" onClick={() => setStep("hardware")}>
                Back
              </button>
              <button type="button" className="setup-next-btn" onClick={() => setStep("folder")}>
                Continue
              </button>
            </div>
          </div>
        )}

        {step === "folder" && (
          <div className="setup-card">
            <h2>Choose Save Folder</h2>
            <p className="setup-desc">
              Where Ultimate AMV will save downloaded anime episodes and YouTube clips. You can change this anytime in Settings.
            </p>
            <div className="setup-folder-row">
              <FolderOpen size={18} />
              <input
                type="text"
                className="setup-folder-input"
                value={downloadPath}
                placeholder="Default: Videos\Ultimate AMV"
                readOnly
                aria-label="Download folder path"
              />
              <button type="button" className="setup-folder-browse" onClick={chooseDownloadFolder}>
                Browse
              </button>
            </div>
            <div className="setup-nav">
              <button type="button" className="setup-back-btn" onClick={() => setStep("recommend")}>
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
            <h2>Installing helper files</h2>
            {!installing && !error && logLines.length === 0 && (
              <>
                <p className="setup-desc">
                  {selectedMode === "gpu"
                    ? "Will download graphics card support files and AI models (about 3 GB)."
                    : "Will download universal files and AI models (about 200 MB)."}
                </p>
                <div className="setup-nav">
                  <button
                    type="button"
                    className="setup-back-btn"
                    onClick={() => setStep("folder")}
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
                      ? `Step ${Math.min(progress.step, progress.total)} / ${progress.total} : ${progress.message}`
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
                    onClick={() => setStep("folder")}
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
