import { ListPlus } from "lucide-react";
import type { DownloadQueueItem } from "../../types/download";

export function DownloadQueuePanel({
  queue,
  onCancel,
}: {
  queue: DownloadQueueItem[];
  onCancel: (job: DownloadQueueItem) => void;
}) {
  const activeOrQueued = queue.filter((job) => job.status === "queued" || job.status === "downloading");
  const recentFinished = queue.filter((job) => job.status === "done" || job.status === "error" || job.status === "cancelled").slice(-4).reverse();
  const rows = [...activeOrQueued, ...recentFinished];

  return (
    <aside className="download-queue-panel" aria-label="Download queue">
      <div className="download-panel-head">
        <ListPlus size={17} strokeWidth={2.1} />
        <span>Queue</span>
      </div>
      {rows.length === 0 ? (
        <div className="download-queue-empty">No queued downloads.</div>
      ) : (
        rows.map((job) => (
          <div key={job.id} className={`download-queue-row is-${job.status}`}>
            <div className="download-queue-copy">
              <strong>{job.title}</strong>
              <small>{[job.subtitle, job.qualityLabel].filter(Boolean).join(" - ") || job.url}</small>
              {job.progress && (
                <span>{job.progress.percent != null ? `${job.progress.percent.toFixed(1)}% - ` : ""}{job.progress.message}</span>
              )}
              {job.warning && <span className="stream-warning">⚠ {job.warning}</span>}
              {job.error && <span className="stream-error">{job.error}</span>}
            </div>
            {(job.status === "queued" || job.status === "downloading") && (
              <button type="button" className="stream-cancel-button" onClick={() => onCancel(job)}>
                {job.status === "downloading" ? "Cancel" : "Remove"}
              </button>
            )}
            {job.progress && job.status === "downloading" && (
              <div className={`stream-progress-track ${job.progress.percent == null ? "is-indeterminate" : ""}`}>
                <div
                  className="stream-progress-fill"
                  style={job.progress.percent == null ? undefined : { width: `${Math.max(0, Math.min(100, job.progress.percent))}%` }}
                />
              </div>
            )}
          </div>
        ))
      )}
    </aside>
  );
}
