import { Loader2 } from "lucide-react";
import type { AudioSetupProgress } from "../../types/audio";

function friendlySetupMessage(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return "Working...";
  if (trimmed.length > 120) return trimmed.slice(0, 117) + "...";
  return trimmed;
}

export function SetupRunningCard({
  mode,
  progress,
}: {
  mode: "cpu" | "gpu";
  progress: AudioSetupProgress | null;
}) {
  const total = progress?.total ?? 0;
  const step = progress?.step ?? 0;
  const indeterminate = total === 0 || step === 0;
  const percent = total > 0 ? Math.min(100, Math.round((step / total) * 100)) : 0;
  const heading = `Installing ${mode === "gpu" ? "GPU" : "CPU"} engine`;
  const subheading =
    total > 0 ? `Step ${Math.min(step, total)} of ${total}` : "Preparing install...";
  const detail = progress?.message ? friendlySetupMessage(progress.message) : "Starting...";

  return (
    <section className="audio-card install-card is-running" aria-live="polite">
      <header className="audio-card-header">
        <span className="audio-card-icon install-icon">
          <Loader2 size={22} strokeWidth={2.2} className="audio-spin" />
        </span>
        <div>
          <h2>{heading}</h2>
          <p className="audio-card-sub">{subheading}</p>
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
          style={{ width: indeterminate ? "100%" : `${Math.max(4, percent)}%` }}
        />
      </div>

      <p className="audio-card-status install-detail" title={progress?.message ?? ""}>
        {detail}
      </p>
    </section>
  );
}
