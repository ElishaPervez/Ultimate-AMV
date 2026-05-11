import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, Copy, ScrollText, Trash2 } from "lucide-react";
import { logFrontend, safeLogValue } from "../../lib/log";
import { parseBridgePayload, readBridgeError } from "../../utils/bridge";

export function LogsPanel() {
  const [lines, setLines] = React.useState<string[]>([]);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [copyState, setCopyState] = React.useState<"idle" | "copied" | "error">("idle");
  const [clearing, setClearing] = React.useState(false);

  React.useEffect(() => {
    void refreshLogs();
    const interval = window.setInterval(() => {
      void refreshLogs();
    }, 2500);
    return () => window.clearInterval(interval);
  }, []);

  async function refreshLogs() {
    try {
      const raw = await invoke<string>("app_logs");
      const payload = parseBridgePayload<{ type: "logs"; lines: string[] }>(raw);
      setLines(payload.lines ?? []);
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(readBridgeError(error));
    }
  }

  async function copyLogs() {
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopyState("copied");
      logFrontend("info", "frontend.logs.copy", "Copied logs to clipboard", {
        lineCount: lines.length,
      });
      window.setTimeout(() => setCopyState("idle"), 1600);
    } catch (error) {
      setCopyState("error");
      setErrorMessage(readBridgeError(error));
      logFrontend("error", "frontend.logs.copy.error", "Could not copy logs to clipboard", {
        error: safeLogValue(error),
      });
      window.setTimeout(() => setCopyState("idle"), 2200);
    }
  }

  async function clearLogs() {
    try {
      setClearing(true);
      await invoke("clear_app_logs");
      setLines([]);
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(readBridgeError(error));
    } finally {
      setClearing(false);
    }
  }

  return (
    <div className="logs-panel">
      <div className="logs-toolbar">
        <span>{lines.length} log lines</span>
        <div className="logs-actions">
          <button className="logs-clear-button" type="button" onClick={clearLogs} disabled={lines.length === 0 || clearing}>
            <Trash2 size={15} />
            {clearing ? "Clearing" : "Clear logs"}
          </button>
          <button type="button" onClick={copyLogs} disabled={lines.length === 0}>
            <Copy size={15} />
            {copyState === "copied" ? "Copied" : copyState === "error" ? "Copy failed" : "Copy logs"}
          </button>
          <button type="button" onClick={refreshLogs}>
            Refresh
          </button>
        </div>
      </div>

      {errorMessage && (
        <div className="audio-message is-error">
          <AlertTriangle size={17} /> {errorMessage}
        </div>
      )}

      {lines.length === 0 ? (
        <div className="audio-empty">
          <ScrollText size={32} strokeWidth={1.8} />
          <h2>No logs yet</h2>
        </div>
      ) : (
        <pre className="terminal-log" aria-label="Application logs">
          {lines.join("\n")}
        </pre>
      )}
    </div>
  );
}
