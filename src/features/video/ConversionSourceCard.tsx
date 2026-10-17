import React from "react";
import { FolderKanban } from "lucide-react";
import { fileName } from "../../lib/paths";

export function ConversionSourceCard({
  icon,
  label,
  selectedFiles,
  pickLabel,
  onPick,
  disabled,
  actionTitle,
  actionSubtitle,
}: {
  icon: React.ReactNode;
  label: string;
  selectedFiles: string[];
  pickLabel: string;
  onPick: () => void;
  disabled: boolean;
  actionTitle?: string;
  actionSubtitle?: string;
}) {
  const selectedLabel = selectedFiles.length > 1
    ? `${selectedFiles.length} files selected`
    : selectedFiles[0] ? fileName(selectedFiles[0]) : "No file selected";
  const selectedPathLabel = selectedFiles.length > 1 ? selectedFiles.map(fileName).join(" / ") : selectedFiles[0];

  return (
    <div className="conversion-card source-card">
      <span className="conversion-icon">{icon}</span>
      <div className="source-card-info">
        <small>{label}</small>
        <strong>{selectedLabel}</strong>
        {selectedPathLabel && <p className="source-card-path" title={selectedPathLabel}>{selectedPathLabel}</p>}
        {actionTitle && (
          <div className="source-card-action">
            <small>Action</small>
            <strong>{actionTitle}</strong>
            {actionSubtitle && <p className="source-card-action-desc">{actionSubtitle}</p>}
          </div>
        )}
      </div>
      <button type="button" className="conversion-pick-btn" onClick={onPick} disabled={disabled}>
        <FolderKanban size={16} strokeWidth={2.2} />
        <span>{pickLabel}</span>
      </button>
    </div>
  );
}
