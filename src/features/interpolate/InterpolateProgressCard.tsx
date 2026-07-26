import React from "react";
import { Loader2, X } from "lucide-react";
import type { InterpolateProgress } from "../../types/interpolate";

function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "Measuring queue speed";
  if (seconds < 60) return `About ${Math.max(1, Math.round(seconds))}s left`;
  const minutes = Math.ceil(seconds / 60);
  return `About ${minutes} min left`;
}

export function InterpolateProgressCard({
  progress,
  overallPercent,
  completed,
  total,
  cadenceSteps,
  cadenceLabel,
  etaSeconds,
  cancelling,
  onCancel,
}: {
  progress: InterpolateProgress | null;
  overallPercent: number;
  completed: number;
  total: number;
  cadenceSteps: number;
  cadenceLabel: string;
  etaSeconds: number | null;
  cancelling: boolean;
  onCancel: () => void;
}) {
  const percent = progress?.percent ?? -1;
  const indeterminate = percent < 0;
  return (
    <div className="interpolate-progress-card" aria-live="polite">
      <div className="interpolate-progress-heading">
        <Loader2 size={15} className="audio-spin" />
        <div>
          <strong>{progress?.clipName || "Preparing interpolation"}</strong>
          <span>{progress?.message || "Starting the frame engine"}</span>
        </div>
      </div>

      <div className="cadence-rail" aria-label={cadenceLabel}>
        <span className="is-source" />
        {Array.from({ length: cadenceSteps - 1 }, (_, index) => (
          <span className="is-synthesized" key={index} />
        ))}
        <span className="is-source" />
      </div>

      <div className="interpolate-progress-row">
        <span>Current clip</span>
        <strong>{indeterminate ? "—" : `${Math.round(percent)}%`}</strong>
      </div>
      <div className={`audio-progress-track ${indeterminate ? "is-indeterminate" : ""}`}>
        <div
          className="audio-progress-fill"
          style={indeterminate ? undefined : { width: `${Math.max(0, Math.min(100, percent))}%` }}
        />
      </div>

      <div className="interpolate-progress-row">
        <span>Queue · {completed} of {total}</span>
        <strong>{formatEta(etaSeconds)}</strong>
      </div>
      <div className="audio-progress-track">
        <div className="audio-progress-fill" style={{ width: `${Math.max(0, Math.min(100, overallPercent))}%` }} />
      </div>

      <button
        type="button"
        className="conversion-run-btn is-cancel"
        disabled={cancelling}
        onClick={onCancel}
      >
        <X size={15} />
        {cancelling ? "Stopping…" : "Cancel"}
      </button>
    </div>
  );
}
