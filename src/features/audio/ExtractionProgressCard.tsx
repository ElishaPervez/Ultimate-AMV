import { FileAudio, Loader2, X } from "lucide-react";
import type { AudioProgress } from "../../types/audio";

function stageHeading(stage: string, percent: number): string {
  switch (stage) {
    case "loading":
      return "Loading AI model";
    case "model-download":
      return percent >= 0 ? `Downloading AI model — ${percent}%` : "Downloading AI model";
    case "processing":
      return percent >= 0 ? `Extracting vocals — ${percent}%` : "Extracting vocals";
    case "finalizing":
      return "Saving stems";
    case "complete":
      return "Complete";
    default:
      return "Working";
  }
}

export function ExtractionProgressCard({
  fileName: name,
  progress,
  onCancel,
}: {
  fileName: string;
  progress: AudioProgress | null;
  onCancel?: () => void;
}) {
  const stage = progress?.stage ?? "loading";
  const percent = progress?.percent ?? -1;
  const indeterminate = percent < 0;
  const stageLabel = stageHeading(stage, percent);
  const subline = progress?.message ?? "Loading AI model...";

  return (
    <section className="audio-card extraction-card" aria-live="polite">
      <header className="audio-card-header">
        <span className="audio-card-icon">
          <Loader2 size={22} strokeWidth={2.2} className="audio-spin" />
        </span>
        <div>
          <h2>{stageLabel}</h2>
          <p className="audio-file-line">
            <FileAudio size={14} strokeWidth={2} /> {name}
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
