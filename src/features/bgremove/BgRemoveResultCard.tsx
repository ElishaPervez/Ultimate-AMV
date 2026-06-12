import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, CheckCircle2, FolderOpen, RefreshCw, X } from "lucide-react";

// Compact result banner rendered inside the run-card's action area, above the
// action buttons, so the rest of the panel stays visible after a job ends.
export function BgRemoveResultCard({
  kind,
  message,
  onDismiss,
  onRetry,
  outputDir,
}: {
  kind: "success" | "error";
  message: string;
  onDismiss: () => void;
  onRetry?: () => void;
  outputDir?: string;
}) {
  const isSuccess = kind === "success";
  const tint = isSuccess ? "34, 197, 94" : "239, 68, 68";
  const actionStyle: React.CSSProperties = {
    padding: "6px 10px",
    display: "flex",
    alignItems: "center",
    gap: "6px",
    fontSize: "12px",
  };

  return (
    <div
      className="glass"
      style={{
        padding: "14px 16px",
        borderRadius: "12px",
        border: `1px solid rgba(${tint}, 0.2)`,
        background: `rgba(${tint}, 0.05)`,
        color: isSuccess ? "#4ade80" : "#f87171",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        fontSize: "13px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        {isSuccess ? (
          <CheckCircle2 size={15} style={{ flexShrink: 0 }} />
        ) : (
          <AlertTriangle size={15} style={{ flexShrink: 0 }} />
        )}
        <h4 style={{ margin: 0, fontWeight: 600, flex: 1 }}>
          {isSuccess ? "Background isolation complete" : "Background isolation failed"}
        </h4>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "inherit",
            padding: "2px",
            display: "flex",
          }}
        >
          <X size={14} />
        </button>
      </div>
      <p style={{ margin: 0 }} className="dim-text">
        {message}
      </p>
      {((isSuccess && outputDir) || (!isSuccess && onRetry)) && (
        <div style={{ display: "flex", gap: "8px" }}>
          {isSuccess && outputDir && (
            <button
              type="button"
              className="install-btn is-secondary"
              style={actionStyle}
              onClick={() => invoke("open_path", { path: outputDir })}
            >
              <FolderOpen size={14} strokeWidth={2.3} />
              <span>Open folder</span>
            </button>
          )}
          {!isSuccess && onRetry && (
            <button
              type="button"
              className="install-btn is-secondary"
              style={actionStyle}
              onClick={onRetry}
            >
              <RefreshCw size={14} strokeWidth={2.3} />
              <span>Try again</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
