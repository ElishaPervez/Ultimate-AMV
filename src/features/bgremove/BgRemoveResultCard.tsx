import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, ArrowRight, CheckCircle2, FolderOpen, RefreshCw, Video } from "lucide-react";

export function BgRemoveResultCard({
  kind,
  fileName: name,
  message,
  onAgain,
  onRetry,
  outputDir,
}: {
  kind: "success" | "error";
  fileName: string;
  message: string;
  onAgain: () => void;
  onRetry?: () => void;
  outputDir?: string;
}) {
  const isSuccess = kind === "success";
  
  return (
    <section className={`audio-card result-card is-${kind}`}>
      <header className="audio-card-header">
        <span className={`audio-card-icon ${isSuccess ? "result-success" : "result-error"}`}>
          {isSuccess ? <CheckCircle2 size={22} /> : <AlertTriangle size={22} />}
        </span>
        <div>
          <h2>{isSuccess ? "Background isolation complete" : "Background isolation failed"}</h2>
          <p className="audio-file-line">
            <Video size={14} strokeWidth={2} /> {name}
          </p>
        </div>
      </header>
      <p className="audio-card-status">{message}</p>
      <div className="result-actions">
        {isSuccess && outputDir && (
          <button
            type="button"
            className="install-btn is-secondary"
            onClick={() => invoke("open_path", { path: outputDir })}
          >
            <FolderOpen size={15} strokeWidth={2.3} />
            <span>Open folder</span>
          </button>
        )}
        {!isSuccess && onRetry && (
          <button type="button" className="install-btn is-secondary" onClick={onRetry}>
            <RefreshCw size={15} strokeWidth={2.3} />
            <span>Try again</span>
          </button>
        )}
        <button type="button" className="install-btn is-primary" onClick={onAgain}>
          <ArrowRight size={15} strokeWidth={2.3} />
          <span>Isolate another video</span>
        </button>
      </div>
    </section>
  );
}
