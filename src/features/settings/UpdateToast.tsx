import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { Download, Loader2, X } from "lucide-react";
import { logFrontend, safeLogValue } from "../../lib/log";

type UpdaterPlugin = typeof import("@tauri-apps/plugin-updater");
type UpdateHandle = Awaited<ReturnType<UpdaterPlugin["check"]>>;

type ToastState =
  | { kind: "hidden" }
  | { kind: "available"; version: string }
  | { kind: "downloading"; version: string; received: number; total: number }
  | { kind: "installing"; version: string };

function progressPercent(received: number, total: number): number {
  if (total <= 0) return 0;
  const pct = Math.floor((received / total) * 100);
  if (pct < 0) return 0;
  if (pct > 100) return 100;
  return pct;
}

function readUpdaterError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown updater error";
  }
}

export function UpdateToast() {
  const [state, setState] = React.useState<ToastState>({ kind: "hidden" });
  const updateRef = React.useRef<UpdateHandle | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const updater = await import("@tauri-apps/plugin-updater");
        const result = await updater.check();
        if (cancelled) return;
        if (!result || !result.available) {
          logFrontend("info", "updater.auto_check.up_to_date", "Startup check: app is on latest version");
          return;
        }
        updateRef.current = result;
        const version = result.version || "";
        logFrontend("info", "updater.auto_check.available", "Startup check: update available", { version });
        setState({ kind: "available", version });
      } catch (error) {
        logFrontend("warn", "updater.auto_check.error", "Startup update check failed", {
          error: safeLogValue(error),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function downloadAndInstall() {
    const handle = updateRef.current;
    if (!handle) return;
    const version = handle.version || "";
    setState({ kind: "downloading", version, received: 0, total: 0 });
    logFrontend("info", "updater.toast.download.start", "Toast: downloading update", { version });
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
      logFrontend("info", "updater.toast.download.complete", "Toast: download complete", { version });
      setState({ kind: "installing", version });

      logFrontend("info", "updater.toast.install.start", "Toast: applying update; app will exit");
      await invoke<void>("prepare_for_update").catch((error) => {
        logFrontend("warn", "updater.prepare.failed", "prepare_for_update failed", {
          error: safeLogValue(error),
        });
      });
      void handle.install();
    } catch (error) {
      logFrontend("error", "updater.toast.error", "Toast install flow failed", {
        error: safeLogValue(error),
      });
      setState({ kind: "hidden" });
      window.alert(`Update failed: ${readUpdaterError(error)}`);
    }
  }

  if (state.kind === "hidden") return null;

  const isWorking = state.kind === "downloading" || state.kind === "installing";

  return (
    <div className="update-toast" role="status" aria-live="polite">
      {!isWorking && (
        <button
          type="button"
          className="update-toast-dismiss"
          aria-label="Dismiss"
          onClick={() => setState({ kind: "hidden" })}
        >
          <X size={13} />
        </button>
      )}
      <div className="update-toast-body">
        <div className="update-toast-title">Update available</div>
        <div className="update-toast-version">Ultimate AMV v{state.version}</div>
      </div>
      {state.kind === "available" && (
        <button
          type="button"
          className="update-toast-action"
          onClick={() => void downloadAndInstall()}
        >
          <Download size={14} />
          <span>Download and install</span>
        </button>
      )}
      {state.kind === "downloading" && (
        <div className="update-toast-progress">
          <Loader2 size={14} className="audio-spin" />
          <span>Downloading {progressPercent(state.received, state.total)}%</span>
        </div>
      )}
      {state.kind === "installing" && (
        <div className="update-toast-progress">
          <Loader2 size={14} className="audio-spin" />
          <span>Installing, app will restart...</span>
        </div>
      )}
    </div>
  );
}
