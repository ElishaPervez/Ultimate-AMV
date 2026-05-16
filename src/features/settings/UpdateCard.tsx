import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { AlertTriangle, CheckCircle2, Download, Loader2, RefreshCw } from "lucide-react";
import { formatBytes } from "../../lib/format";
import { logFrontend, safeLogValue } from "../../lib/log";

type UpdaterPlugin = typeof import("@tauri-apps/plugin-updater");
type UpdateHandle = Awaited<ReturnType<UpdaterPlugin["check"]>>;

type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up-to-date" }
  | { kind: "available"; version: string; notes: string }
  | { kind: "downloading"; version: string; received: number; total: number }
  | { kind: "ready"; version: string }
  | { kind: "error"; message: string };

function readableUpdaterError(error: unknown): string {
  if (error instanceof Error) {
    const text = (error.message || error.name || "Unknown error").trim();
    return text.length > 280 ? `${text.slice(0, 277)}...` : text;
  }
  if (typeof error === "string") {
    const trimmed = error.trim();
    return trimmed.length > 280 ? `${trimmed.slice(0, 277)}...` : trimmed;
  }
  try {
    const text = JSON.stringify(error);
    return text.length > 280 ? `${text.slice(0, 277)}...` : text;
  } catch {
    return "Unknown updater error";
  }
}

function progressPercent(received: number, total: number): number {
  if (total <= 0) return 0;
  const pct = Math.floor((received / total) * 100);
  if (pct < 0) return 0;
  if (pct > 100) return 100;
  return pct;
}

export function UpdateCard() {
  const [currentVersion, setCurrentVersion] = React.useState<string>("");
  const [state, setState] = React.useState<UpdateState>({ kind: "idle" });
  const updateRef = React.useRef<UpdateHandle | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void getVersion()
      .then((value) => {
        if (!cancelled) setCurrentVersion(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  async function checkForUpdates() {
    setState({ kind: "checking" });
    logFrontend("info", "updater.check.start", "Checking for updates");
    try {
      const updater = await import("@tauri-apps/plugin-updater");
      const result = await updater.check();
      if (!result || !result.available) {
        updateRef.current = null;
        setState({ kind: "up-to-date" });
        logFrontend("info", "updater.check.up_to_date", "App is on latest version");
        return;
      }
      updateRef.current = result;
      const version = result.version || "";
      const notes = (result.body || "").trim();
      setState({ kind: "available", version, notes });
      logFrontend("info", "updater.check.available", "Update available", { version });
    } catch (error) {
      const message = readableUpdaterError(error);
      setState({ kind: "error", message });
      logFrontend("error", "updater.check.error", "Update check failed", {
        error: safeLogValue(error),
      });
    }
  }

  async function downloadAndInstall() {
    const handle = updateRef.current;
    if (!handle) return;
    const version = handle.version || "";
    setState({ kind: "downloading", version, received: 0, total: 0 });
    logFrontend("info", "updater.download.start", "Downloading update", { version });
    try {
      let received = 0;
      let total = 0;
      await handle.download((progress) => {
        if (progress.event === "Started") {
          total = progress.data.contentLength ?? 0;
          received = 0;
        } else if (progress.event === "Progress") {
          received += progress.data.chunkLength ?? 0;
        } else if (progress.event === "Finished") {
          received = total > 0 ? total : received;
        }
        setState({ kind: "downloading", version, received, total });
      });
      logFrontend("info", "updater.download.complete", "Update download complete", { version });
      setState({ kind: "ready", version });

      logFrontend("info", "updater.install.start", "Applying update; app will exit");
      // Drop KILL_ON_JOB_CLOSE on the Windows Job Object and kill Python
      // sidecars BEFORE the installer spawns. Without this, install()'s
      // child installer inherits our job and dies the instant we exit —
      // the user stays on the old version with no error.
      await invoke<void>("prepare_for_update").catch((error) => {
        logFrontend("warn", "updater.prepare.failed", "prepare_for_update failed; install may not survive", {
          error: safeLogValue(error),
        });
      });
      // install() blocks and never returns on Windows — the installer terminates
      // the running process and relaunches the new build via the /R flag.
      void handle.install();
    } catch (error) {
      const message = readableUpdaterError(error);
      setState({ kind: "error", message });
      logFrontend("error", "updater.download.error", "Update download or install failed", {
        error: safeLogValue(error),
      });
    }
  }

  const versionLabel = currentVersion ? `v${currentVersion}` : "unknown";

  return (
    <div className="settings-group">
      <div className="settings-group-header">App Updates</div>

      <div className="setting-row deps-row">
        <div className="setting-info">
          <span className="setting-label">Current version</span>
          <span className="setting-desc">
            Ultimate AMV {versionLabel}
            {state.kind === "available" || state.kind === "downloading" || state.kind === "ready"
              ? ` · update to v${state.version} pending`
              : ""}
          </span>
        </div>
        <div className="deps-badge">
          {state.kind === "up-to-date" ? (
            <span className="deps-badge-ready">UP TO DATE</span>
          ) : state.kind === "available" || state.kind === "downloading" ? (
            <span className="deps-badge-missing">UPDATE AVAILABLE</span>
          ) : state.kind === "ready" ? (
            <span className="deps-badge-ready">READY</span>
          ) : (
            <span
              className="deps-badge-ready"
              style={{ color: "var(--fg-muted)", border: "1px solid var(--border)", background: "transparent" }}
            >
              {versionLabel.toUpperCase()}
            </span>
          )}
        </div>
      </div>

      {state.kind === "available" && state.notes && (
        <pre className="settings-live-log" aria-label="Release notes">
          {state.notes}
        </pre>
      )}

      {state.kind === "downloading" && (
        <div className="settings-setup-status">
          <Loader2 size={16} className="audio-spin" />
          <span>
            Downloading v{state.version} — {progressPercent(state.received, state.total)}%
            {state.total > 0
              ? ` (${formatBytes(state.received)} / ${formatBytes(state.total)})`
              : state.received > 0
                ? ` (${formatBytes(state.received)})`
                : ""}
          </span>
        </div>
      )}

      <div className="deps-switch-actions">
        {(state.kind === "idle" || state.kind === "error") && (
          <button
            type="button"
            className="install-btn is-primary"
            onClick={() => void checkForUpdates()}
            title="Check the GitHub release feed for a newer version"
          >
            <RefreshCw size={16} strokeWidth={2.3} />
            <span>Check for updates</span>
            <small>Current: {versionLabel}</small>
          </button>
        )}

        {state.kind === "checking" && (
          <button type="button" className="install-btn is-primary" disabled>
            <Loader2 size={16} className="audio-spin" />
            <span>Checking...</span>
            <small>Contacting update server</small>
          </button>
        )}

        {state.kind === "up-to-date" && (
          <button
            type="button"
            className="install-btn is-secondary"
            onClick={() => void checkForUpdates()}
            title="Check again for a newer version"
          >
            <RefreshCw size={16} strokeWidth={2.3} />
            <span>Check again</span>
            <small>Current: {versionLabel}</small>
          </button>
        )}

        {state.kind === "available" && (
          <button
            type="button"
            className="install-btn is-primary"
            onClick={() => void downloadAndInstall()}
            title={`Download and install Ultimate AMV v${state.version}, then restart`}
          >
            <Download size={16} strokeWidth={2.3} />
            <span>Download and install update</span>
            <small>Updates {versionLabel} → v{state.version}</small>
          </button>
        )}

        {state.kind === "downloading" && (
          <button type="button" className="install-btn is-primary" disabled>
            <Loader2 size={16} className="audio-spin" />
            <span>Downloading {progressPercent(state.received, state.total)}%</span>
            <small>App will restart automatically</small>
          </button>
        )}

        {state.kind === "ready" && (
          <button type="button" className="install-btn is-primary" disabled>
            <Loader2 size={16} className="audio-spin" />
            <span>Installing v{state.version}...</span>
            <small>App will restart in a moment</small>
          </button>
        )}
      </div>

      {state.kind === "up-to-date" && (
        <div className="settings-notice is-success">
          <CheckCircle2 size={16} /> You're on the latest version ({versionLabel}).
        </div>
      )}

      {state.kind === "error" && (
        <div className="settings-notice is-error">
          <AlertTriangle size={16} /> {state.message}
        </div>
      )}
    </div>
  );
}
