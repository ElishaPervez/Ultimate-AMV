import { CheckCircle2, History, Loader2, X, Zap } from "lucide-react";
import { BatchStatusList } from "../audio/BatchStatusList";
import { fileName } from "../../lib/paths";
import type { BatchItemStatus } from "../../types/audio";
import type { ConversionDone, ConversionProgress } from "../../types/conversion";

export function ConversionRunCard({
  title,
  subtitle,
  canRun,
  running,
  progress,
  result,
  error,
  batchItems,
  onRun,
  onCancel,
}: {
  title: string;
  subtitle: string;
  canRun: boolean;
  running: boolean;
  progress: ConversionProgress | null;
  result: ConversionDone | null;
  error: string | null;
  batchItems?: BatchItemStatus[];
  onRun: () => void;
  onCancel?: () => void;
}) {
  const percent = progress?.percent ?? null;
  const indeterminate = running && (percent === null || percent < 0);
  const width = percent === null ? 0 : Math.max(0, Math.min(100, percent));

  return (
    <div className={`conversion-card run-card ${error ? "is-error" : ""}`}>
      <div className="conversion-run-head">
        <div>
          <small>Action</small>
          <strong>{title}</strong>
          <p>{subtitle}</p>
        </div>
        {running && onCancel ? (
          <button type="button" className="conversion-run-btn is-cancel" onClick={onCancel}>
            <X size={17} strokeWidth={2.3} />
            <span>Cancel</span>
          </button>
        ) : (
          <button type="button" className="conversion-run-btn" onClick={onRun} disabled={!canRun}>
            {running ? <Loader2 size={17} className="audio-spin" /> : <Zap size={17} strokeWidth={2.3} />}
            <span>{running ? "Working" : "Start"}</span>
          </button>
        )}
      </div>

      {(running || progress || result || error) && (
        <div className="conversion-status">
          <div
            className={`conversion-progress ${indeterminate ? "is-indeterminate" : ""}`}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent === null ? undefined : Math.round(width)}
          >
            <span style={{ width: indeterminate ? "100%" : `${width}%` }} />
          </div>
          <p>{error || progress?.message || (result ? `Saved: ${result.output}` : "Ready")}</p>
          {progress && (progress.fps || progress.speed) && (
            <div className="conversion-metrics">
              {progress.fps && <span>fps {progress.fps}</span>}
              {progress.speed && <span>speed {progress.speed}</span>}
            </div>
          )}
          {result && (
            <div className="conversion-output">
              <CheckCircle2 size={16} />
              <span>{fileName(result.output)}</span>
            </div>
          )}
          {result?.archivedOriginal && (
            <div className="conversion-output is-muted">
              <History size={16} />
              <span>Original archived in {fileName(result.archivedOriginal)}</span>
            </div>
          )}
          {batchItems && batchItems.length > 1 && <BatchStatusList items={batchItems} />}
        </div>
      )}
    </div>
  );
}
