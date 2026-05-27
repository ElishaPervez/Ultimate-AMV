import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AlertTriangle, ArrowRight, Cpu, Loader2, RefreshCw, Zap } from "lucide-react";
import { SetupWizard } from "../SetupWizard";
import { parseBridgePayload, readBridgeError } from "../utils/bridge";
import type { AppConfig } from "../types/app";
import type { AudioSetupPlan, AudioSetupProgress } from "../types/audio";
import { ToolsGate } from "../features/setup/ToolsGate";
import { App } from "./App";

export function Root() {
  // The tools gate runs before any other startup work : ffmpeg/ffprobe/yt-dlp
  // are no longer bundled (Phase 2), and downstream code (audio bridge config
  // load, clip server warmup) assumes the bundled-tool paths are populated.
  const [toolsReady, setToolsReady] = React.useState<boolean>(false);
  const [setupComplete, setSetupComplete] = React.useState<boolean | null>(null);
  const [startupState, setStartupState] = React.useState<"idle" | "checking" | "ready" | "needs-repair" | "repairing" | "error">("idle");
  const [startupMode, setStartupMode] = React.useState<"cpu" | "gpu" | null>(null);
  const [startupPlan, setStartupPlan] = React.useState<AudioSetupPlan | null>(null);
  const [startupError, setStartupError] = React.useState<string | null>(null);
  const [startupProgress, setStartupProgress] = React.useState<AudioSetupProgress | null>(null);
  const [startupLines, setStartupLines] = React.useState<string[]>([]);
  const startupRepairRunningRef = React.useRef(false);

  React.useEffect(() => {
    if (!toolsReady) return;
    invoke<string>("get_config")
      .then((raw) => {
        try {
          const config = parseBridgePayload<AppConfig>(raw);
          setSetupComplete(config.setup_complete === true);
        } catch {
          setSetupComplete(false);
        }
      })
      .catch(() => setSetupComplete(false));
  }, [toolsReady]);

  React.useEffect(() => {
    if (setupComplete === true) {
      void checkStartupDependencies();
    }
  }, [setupComplete]);

  React.useEffect(() => {
    const handler = () => {
      if (setupComplete === true) {
        void checkStartupDependencies();
      }
    };
    window.addEventListener("clipmode-changed", handler);
    return () => window.removeEventListener("clipmode-changed", handler);
  }, [setupComplete]);

  function parseSetupMode(value: unknown): "cpu" | "gpu" | null {
    return value === "cpu" || value === "gpu" ? value : null;
  }

  async function checkStartupDependencies() {
    setStartupState("checking");
    setStartupError(null);
    setStartupProgress(null);
    try {
      const rawConfig = await invoke<string>("get_config");
      const config = parseBridgePayload<AppConfig>(rawConfig);
      if (config.setup_complete !== true) {
        setSetupComplete(false);
        setStartupState("idle");
        return;
      }

      const mode = parseSetupMode(config.setup_type);
      if (!mode) {
        throw new Error(`Invalid setup mode in config: ${config.setup_type || "missing"}`);
      }
      setStartupMode(mode);

      const rawPlan = await invoke<string>("audio_setup_plan", { mode });
      const plan = parseBridgePayload<AudioSetupPlan>(rawPlan);
      setStartupPlan(plan);
      setStartupState(plan.installs.length === 0 ? "ready" : "needs-repair");
    } catch (error) {
      setStartupError(readBridgeError(error));
      setStartupState("error");
    }
  }

  async function repairStartupDependencies() {
    if (!startupMode || startupRepairRunningRef.current) return;

    startupRepairRunningRef.current = true;
    setStartupState("repairing");
    setStartupError(null);
    setStartupProgress(null);
    setStartupLines([]);

    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listen<AudioSetupProgress>("audio-setup-progress", (event) => {
        setStartupProgress(event.payload);
        setStartupLines((current) => {
          const line = formatStartupSetupLine(event.payload);
          if (!line || current[current.length - 1] === line) return current;
          return [...current, line].slice(-80);
        });
      });

      await invoke<string>("audio_setup", { mode: startupMode });
      await checkStartupDependencies();
    } catch (error) {
      setStartupError(readBridgeError(error));
      setStartupState("error");
    } finally {
      unlisten?.();
      startupRepairRunningRef.current = false;
    }
  }

  function formatStartupSetupLine(progress: AudioSetupProgress): string {
    const parts: string[] = [];
    if (progress.total > 0 && progress.step > 0) {
      parts.push(`[${Math.min(progress.step, progress.total)}/${progress.total}]`);
    }
    if (progress.state !== "running") {
      parts.push(progress.state.toUpperCase());
    }
    parts.push(progress.message.trim() || "Working...");
    return parts.join(" ");
  }

  function startupStatusClass(component: string, status: string): string {
    const normalizedComponent = component.toLowerCase();
    const normalized = status.toLowerCase();
    if (
      normalized === "not installed" &&
      (normalizedComponent === "cpu runtime" || normalizedComponent === "gpu runtime")
    ) {
      return "is-installed";
    }
    if (normalized.includes("needs install") || normalized.includes("missing") || normalized.includes("not installed")) {
      return "is-missing";
    }
    if (normalized.includes("will remove")) {
      return "is-missing";
    }
    if (normalized.includes("installed") || normalized.includes("ready") || normalized === "gpu" || normalized === "cpu") {
      return "is-installed";
    }
    return "";
  }

  if (!toolsReady) {
    return <ToolsGate onReady={() => setToolsReady(true)} />;
  }

  if (setupComplete === null) {
    return (
      <div className="startup-gate">
        <div className="startup-gate-card">
          <Loader2 size={22} className="audio-spin" />
          <span>Loading settings...</span>
        </div>
      </div>
    );
  }

  if (!setupComplete) {
    return <SetupWizard onComplete={() => setSetupComplete(true)} />;
  }

  if (startupState === "idle" || startupState === "checking") {
    return (
      <div className="startup-gate">
        <div className="startup-gate-card">
          <Loader2 size={22} className="audio-spin" />
          <span>Checking {startupMode ? startupMode.toUpperCase() : "AI"} Engine...</span>
        </div>
      </div>
    );
  }

  if (startupState === "needs-repair" || startupState === "repairing" || startupState === "error") {
    const mode = startupMode ?? "cpu";
    const isRepairing = startupState === "repairing";
    const issueRows = startupPlan?.issues ?? [];
    const detailRows = startupPlan?.rows ?? [];

    return (
      <div className="startup-gate">
        <div className="startup-gate-card startup-gate-card-wide">
          {isRepairing ? (
            <Loader2 size={28} className="audio-spin startup-gate-icon" />
          ) : startupState === "error" ? (
            <AlertTriangle size={30} className="startup-gate-icon is-error" />
          ) : (
            <AlertTriangle size={30} className="startup-gate-icon" />
          )}
          <h2>
            {isRepairing
              ? `Repairing ${mode.toUpperCase()} AI Engine`
              : startupState === "error"
                ? "Engine Check Failed"
                : `${mode.toUpperCase()} AI Engine Needs Setup`}
          </h2>
          <p>
            {isRepairing
              ? "Installing missing helper files."
              : "We found some files that need repair before Ultimate AMV is ready to use."}
          </p>

          {issueRows.length > 0 && (
            <div className="startup-gate-list">
              {issueRows.map((issue) => (
                <span key={issue}>{issue}</span>
              ))}
            </div>
          )}

          {detailRows.length > 0 && (
            <div className="startup-gate-table">
              {detailRows.map((row) => (
                <React.Fragment key={row.component}>
                  <span>{row.component}</span>
                  <strong className={startupStatusClass(row.component, row.status)}>{row.status}</strong>
                </React.Fragment>
              ))}
            </div>
          )}

          {startupError && (
            <div className="startup-gate-error">
              <AlertTriangle size={16} />
              <span>{startupError}</span>
            </div>
          )}

          {startupProgress && (
            <div className="startup-gate-progress">
              <Loader2 size={15} className="audio-spin" />
              <span>
                {startupProgress.total > 0
                  ? `Step ${Math.min(startupProgress.step, startupProgress.total)} / ${startupProgress.total}: ${startupProgress.message}`
                  : startupProgress.message}
              </span>
            </div>
          )}

          {startupLines.length > 0 && (
            <pre className="startup-gate-log">{startupLines.join("\n")}</pre>
          )}

          <div className="startup-gate-actions">
            <button type="button" className="install-btn" onClick={repairStartupDependencies} disabled={isRepairing || !startupMode}>
              {isRepairing ? <Loader2 size={16} className="audio-spin" /> : mode === "gpu" ? <Zap size={16} /> : <Cpu size={16} />}
              <span>{isRepairing ? "Repairing" : `Repair ${mode.toUpperCase()} AI Engine`}</span>
            </button>
            <button type="button" className="install-btn is-secondary" onClick={() => void checkStartupDependencies()} disabled={isRepairing}>
              <RefreshCw size={16} />
              <span>Check again</span>
            </button>
            <button type="button" className="install-btn is-secondary" onClick={() => setStartupState("ready")} disabled={isRepairing}>
              <ArrowRight size={16} />
              <span>Skip for now</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  return <App />;
}
