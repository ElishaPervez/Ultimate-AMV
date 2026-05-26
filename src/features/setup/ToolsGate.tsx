import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AlertTriangle, CheckCircle2, Download, Loader2, RefreshCw, X } from "lucide-react";
import { logFrontend } from "../../lib/log";
import { readBridgeError } from "../../utils/bridge";

type BinaryStatus = {
  name: string;
  present: boolean;
  valid: boolean;
  missingFiles: string[];
};

type ToolsStatus = {
  ok: boolean;
  toolsDir: string;
  binaries: BinaryStatus[];
};

type ProgressEvent =
  | { type: "install-start"; binaries: string[] }
  | { type: "binary-start"; binary: string }
  | { type: "binary-skip"; binary: string }
  | { type: "binary-done"; binary: string }
  | { type: "download-start"; binary: string; totalBytes: number | null }
  | {
      type: "download-progress";
      binary: string;
      downloadedBytes: number;
      totalBytes: number | null;
    }
  | { type: "download-complete"; binary: string; downloadedBytes: number }
  | { type: "verify-start"; binary: string }
  | { type: "install-step"; binary: string }
  | { type: "install-complete" };

type BinaryProgress = {
  state: "pending" | "downloading" | "verifying" | "installing" | "done" | "skipped";
  downloadedBytes: number;
  totalBytes: number | null;
};

const STAGE_LABEL: Record<BinaryProgress["state"], string> = {
  pending: "Waiting",
  downloading: "Downloading",
  verifying: "Checking",
  installing: "Installing",
  done: "Ready",
  skipped: "Already ready",
};

function formatBytes(value: number | null): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return ":";
  const units = ["B", "KB", "MB", "GB"];
  let v = value;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

export function ToolsGate({ onReady }: { onReady: () => void }) {
  const [status, setStatus] = React.useState<ToolsStatus | null>(null);
  const [phase, setPhase] = React.useState<"checking" | "missing" | "installing" | "error">(
    "checking",
  );
  const [error, setError] = React.useState<string | null>(null);
  const [progressByBinary, setProgressByBinary] = React.useState<
    Record<string, BinaryProgress>
  >({});
  const installRunningRef = React.useRef(false);

  const refreshStatus = React.useCallback(async (): Promise<ToolsStatus | null> => {
    setError(null);
    try {
      const next = await invoke<ToolsStatus>("tools_status");
      setStatus(next);
      logFrontend("info", "tools.gate.status", "Tools status checked", {
        ok: next.ok,
        missing: next.binaries.filter((b) => !b.present).map((b) => b.name),
      });
      return next;
    } catch (caught) {
      const message = readBridgeError(caught);
      setError(message);
      setPhase("error");
      logFrontend("error", "tools.gate.status_error", "Tools status check failed", {
        error: message,
      });
      return null;
    }
  }, []);

  React.useEffect(() => {
    void (async () => {
      const initial = await refreshStatus();
      if (!initial) return;
      if (initial.ok) {
        onReady();
        return;
      }
      setPhase("missing");
    })();
  }, [refreshStatus, onReady]);

  const startInstall = React.useCallback(async () => {
    if (installRunningRef.current || !status) return;
    installRunningRef.current = true;
    setPhase("installing");
    setError(null);

    const baseline: Record<string, BinaryProgress> = {};
    for (const binary of status.binaries) {
      baseline[binary.name] = {
        state: binary.present ? "skipped" : "pending",
        downloadedBytes: 0,
        totalBytes: null,
      };
    }
    setProgressByBinary(baseline);

    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listen<ProgressEvent>("tools-progress", (event) => {
        const payload = event.payload;
        setProgressByBinary((current) => {
          const next = { ...current };
          switch (payload.type) {
            case "binary-start": {
              next[payload.binary] = {
                state: "downloading",
                downloadedBytes: 0,
                totalBytes: null,
              };
              break;
            }
            case "binary-skip": {
              next[payload.binary] = {
                state: "skipped",
                downloadedBytes: 0,
                totalBytes: null,
              };
              break;
            }
            case "download-start": {
              const prior = next[payload.binary];
              next[payload.binary] = {
                state: "downloading",
                downloadedBytes: 0,
                totalBytes: payload.totalBytes,
              };
              if (!prior) break;
              break;
            }
            case "download-progress": {
              next[payload.binary] = {
                state: "downloading",
                downloadedBytes: payload.downloadedBytes,
                totalBytes: payload.totalBytes,
              };
              break;
            }
            case "download-complete": {
              const prior = next[payload.binary];
              next[payload.binary] = {
                state: "verifying",
                downloadedBytes: payload.downloadedBytes,
                totalBytes: prior?.totalBytes ?? payload.downloadedBytes,
              };
              break;
            }
            case "verify-start": {
              const prior = next[payload.binary];
              next[payload.binary] = {
                state: "verifying",
                downloadedBytes: prior?.downloadedBytes ?? 0,
                totalBytes: prior?.totalBytes ?? null,
              };
              break;
            }
            case "install-step": {
              const prior = next[payload.binary];
              next[payload.binary] = {
                state: "installing",
                downloadedBytes: prior?.downloadedBytes ?? 0,
                totalBytes: prior?.totalBytes ?? null,
              };
              break;
            }
            case "binary-done": {
              const prior = next[payload.binary];
              next[payload.binary] = {
                state: "done",
                downloadedBytes: prior?.downloadedBytes ?? 0,
                totalBytes: prior?.totalBytes ?? null,
              };
              break;
            }
            case "install-start":
            case "install-complete":
            default:
              break;
          }
          return next;
        });
      });

      logFrontend("info", "tools.gate.install_start", "Tools install started", {});
      await invoke<void>("tools_install");
      logFrontend("info", "tools.gate.install_complete", "Tools install completed", {});

      const refreshed = await refreshStatus();
      if (refreshed?.ok) {
        onReady();
      } else {
        setPhase("missing");
        setError(
          refreshed
            ? "Install reported success but expected files are still missing."
            : "Install completed but status check failed.",
        );
      }
    } catch (caught) {
      const message = readBridgeError(caught);
      setError(message);
      setPhase("error");
      logFrontend("error", "tools.gate.install_error", "Tools install failed", {
        error: message,
      });
    } finally {
      unlisten?.();
      installRunningRef.current = false;
    }
  }, [status, refreshStatus, onReady]);

  const cancelInstall = React.useCallback(() => {
    void invoke<void>("tools_cancel").catch(() => undefined);
    logFrontend("warn", "tools.gate.cancel", "User cancelled tools install", {});
  }, []);

  if (phase === "error" && !status) {
    return (
      <div className="startup-gate">
        <div className="startup-gate-card startup-gate-card-wide">
          <AlertTriangle size={30} className="startup-gate-icon is-error" />
          <h2>Download failed</h2>
          <p>
            Could not check video and audio tools. Check your network connection and try again.
          </p>
          {error && (
            <div className="startup-gate-error">
              <AlertTriangle size={16} />
              <span>{error}</span>
            </div>
          )}
          <div className="startup-gate-actions">
            <button
              type="button"
              className="install-btn"
              onClick={() => {
                setPhase("checking");
                void refreshStatus().then((next) => {
                  if (next?.ok) onReady();
                  else if (next) setPhase("missing");
                });
              }}
            >
              <RefreshCw size={16} />
              <span>Retry</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (phase === "checking" || !status) {
    return (
      <div className="startup-gate">
        <div className="startup-gate-card">
          <Loader2 size={22} className="audio-spin" />
          <span>Checking video and audio tools...</span>
        </div>
      </div>
    );
  }

  const totals = Object.values(progressByBinary).reduce(
    (acc, item) => {
      if (item.totalBytes && Number.isFinite(item.totalBytes)) {
        acc.totalBytes += item.totalBytes;
      }
      acc.downloadedBytes += item.downloadedBytes;
      return acc;
    },
    { totalBytes: 0, downloadedBytes: 0 },
  );

  const isInstalling = phase === "installing";

  return (
    <div className="startup-gate">
      <div className="startup-gate-card startup-gate-card-wide">
        {isInstalling ? (
          <Loader2 size={28} className="audio-spin startup-gate-icon" />
        ) : phase === "error" ? (
          <AlertTriangle size={30} className="startup-gate-icon is-error" />
        ) : (
          <Download size={28} className="startup-gate-icon" />
        )}
        <h2>
          {isInstalling
            ? "Setting up video and audio tools"
            : phase === "error"
              ? "Download failed"
              : "First-launch download"}
        </h2>
        <p>
          {isInstalling
            ? "Downloading video and audio tools. This is a one-time setup — future updates will be much smaller."
            : phase === "error"
              ? "The download was interrupted. Check your network and try again. Partial files were cleaned up."
              : "Ultimate AMV needs to download video and audio tools (about 200 MB) to your computer. This is a one-time setup."}
        </p>

        <div className="tools-gate-list">
          {status.binaries.map((binary) => {
            const progress = progressByBinary[binary.name];
            const state = progress?.state ?? (binary.present ? "done" : "pending");
            const pct =
              progress && progress.totalBytes
                ? Math.min(100, (progress.downloadedBytes / progress.totalBytes) * 100)
                : binary.present
                  ? 100
                  : 0;
            const stateClass =
              state === "done" || state === "skipped"
                ? "is-done"
                : state === "pending"
                  ? "is-pending"
                  : "is-active";
            return (
              <div className={`tools-gate-row ${stateClass}`} key={binary.name}>
                <div className="tools-gate-row-head">
                  <span className="tools-gate-name">{binary.name}</span>
                  <span className="tools-gate-state">
                    {state === "done" || state === "skipped" ? (
                      <CheckCircle2 size={14} />
                    ) : state === "pending" ? null : (
                      <Loader2 size={14} className="audio-spin" />
                    )}
                    <span>{STAGE_LABEL[state]}</span>
                  </span>
                </div>
                <div className="tools-gate-bar">
                  <div className="tools-gate-bar-fill" style={{ width: `${pct}%` }} />
                </div>
                <div className="tools-gate-meta">
                  <span>
                    {state === "downloading" && progress
                      ? `${formatBytes(progress.downloadedBytes)} / ${formatBytes(progress.totalBytes)}`
                      : state === "done"
                        ? "Ready and installed"
                        : state === "skipped"
                          ? "Already installed"
                          : state === "verifying"
                            ? "Checking file safety..."
                            : state === "installing"
                              ? "Setting up files..."
                              : "Waiting"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {isInstalling && totals.totalBytes > 0 && (
          <div className="startup-gate-progress">
            <Loader2 size={15} className="audio-spin" />
            <span>
              Total: {formatBytes(totals.downloadedBytes)} / {formatBytes(totals.totalBytes)}
            </span>
          </div>
        )}

        {error && (
          <div className="startup-gate-error">
            <AlertTriangle size={16} />
            <span>{error}</span>
          </div>
        )}

        <div className="startup-gate-actions">
          {isInstalling ? (
            <button type="button" className="install-btn is-secondary" onClick={cancelInstall}>
              <X size={16} />
              <span>Cancel</span>
            </button>
          ) : (
            <>
              <button type="button" className="install-btn" onClick={() => void startInstall()}>
                <Download size={16} />
                <span>{phase === "error" ? "Retry download" : "Download and install"}</span>
              </button>
              <button
                type="button"
                className="install-btn is-secondary"
                onClick={() => void refreshStatus()}
              >
                <RefreshCw size={16} />
                <span>Recheck</span>
              </button>
            </>
          )}
        </div>

        <div className="tools-gate-footnote">
          <span>Cache: {status.toolsDir}</span>
        </div>
      </div>
    </div>
  );
}
