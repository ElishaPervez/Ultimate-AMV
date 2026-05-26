import React from "react";
import { Loader2, Video, X } from "lucide-react";
import type { BgRemoveProgress } from "../../types/bgremove";

function getStageHeading(stage: string, percent: number): string {
  switch (stage) {
    case "dependencies":
      return "Checking dependencies...";
    case "model-init":
      return "Initializing AI model...";
    case "processing":
      return percent >= 0 ? `Isolating character : ${Math.round(percent)}%` : "Isolating background...";
    default:
      return "Processing video...";
  }
}

export function BgRemoveProgressCard({
  fileName: name,
  progress,
  onCancel,
}: {
  fileName: string;
  progress: BgRemoveProgress | null;
  onCancel?: () => void;
}) {
  const stage = progress?.stage ?? "dependencies";
  const percent = progress?.percent ?? -1;
  const indeterminate = percent < 0;
  const stageLabel = getStageHeading(stage, percent);
  const subline = progress?.message ?? "Preparing process...";

  return (
    <section className="audio-card extraction-card" aria-live="polite">
      <header className="audio-card-header">
        <span className="audio-card-icon">
          <Loader2 size={22} strokeWidth={2.2} className="audio-spin" />
        </span>
        <div>
          <h2>{stageLabel}</h2>
          <p className="audio-file-line">
            <Video size={14} strokeWidth={2} /> {name}
          </p>
        </div>
      </header>

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

      <p className="audio-card-status">{subline}</p>
      {onCancel && (
        <div className="result-actions">
          <button type="button" className="install-btn is-secondary" onClick={onCancel}>
            <X size={15} strokeWidth={2.3} />
            <span>Cancel</span>
          </button>
        </div>
      )}
    </section>
  );
}
