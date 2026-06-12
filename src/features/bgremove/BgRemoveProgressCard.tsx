import React from "react";
import { Loader2, X } from "lucide-react";
import type { BgRemoveProgress } from "../../types/bgremove";

function getStageHeading(stage: string, percent: number, isImage?: boolean): string {
  switch (stage) {
    case "dependencies":
      return "Checking dependencies...";
    case "model-init":
      return "Initializing AI model...";
    case "processing":
      return percent >= 0 ? `Isolating character : ${Math.round(percent)}%` : "Isolating background...";
    case "cancelling":
      return "Stopping...";
    default:
      return isImage ? "Processing image..." : "Processing video...";
  }
}

// Compact progress block rendered inside the run-card's action area, in place
// of the action buttons, so the rest of the panel stays visible while a job runs.
export function BgRemoveProgressCard({
  progress,
  onCancel,
  isImage,
}: {
  progress: BgRemoveProgress | null;
  onCancel?: () => void;
  isImage?: boolean;
}) {
  const stage = progress?.stage ?? "dependencies";
  const percent = progress?.percent ?? -1;
  const indeterminate = percent < 0;
  const stageLabel = getStageHeading(stage, percent, isImage);
  const subline = progress?.message ?? "Preparing process...";

  return (
    <div aria-live="polite" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", fontWeight: 600 }}>
        <Loader2 size={14} strokeWidth={2.2} className="audio-spin" />
        <span>{stageLabel}</span>
      </div>
      <div
        className={`audio-progress-track ${indeterminate ? "is-indeterminate" : ""}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : percent}
      >
        <div
          className="audio-progress-fill"
          style={indeterminate ? undefined : { width: `${Math.max(0, Math.min(100, percent))}%` }}
        />
      </div>
      <p className="dim-text" style={{ fontSize: "12px", margin: 0 }}>
        {subline}
      </p>
      {onCancel && (
        <button
          type="button"
          className="install-btn is-secondary"
          style={{
            width: "100%",
            minHeight: "34px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "6px",
          }}
          disabled={stage === "cancelling"}
          onClick={onCancel}
        >
          <X size={15} strokeWidth={2.3} />
          <span>Cancel</span>
        </button>
      )}
    </div>
  );
}
