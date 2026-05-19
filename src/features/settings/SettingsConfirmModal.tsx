import React from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, X } from "lucide-react";

interface SettingsConfirmModalProps {
  open: boolean;
  title: string;
  description: React.ReactNode;
  confirmText: string;
  cancelText?: string;
  isDanger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function SettingsConfirmModal({
  open,
  title,
  description,
  confirmText,
  cancelText = "Cancel",
  isDanger = false,
  onConfirm,
  onCancel,
}: SettingsConfirmModalProps) {
  React.useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onCancel]);

  if (!open) return null;

  return createPortal(
    <div className="episode-label-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div className={`episode-label-modal settings-confirm-modal glass ${isDanger ? "is-danger" : ""}`}>
        <div className="episode-label-header">
          <div>
            <span className="episode-label-kicker">
              <AlertTriangle size={13} strokeWidth={2.2} /> Confirm action
            </span>
            <h2 style={{ marginTop: "6px" }}>{title}</h2>
            <div className="settings-confirm-desc">{description}</div>
          </div>
          <button
            type="button"
            className="episode-label-close spring-motion"
            onClick={onCancel}
            aria-label="Close modal"
          >
            <X size={16} />
          </button>
        </div>

        <div className="episode-label-actions" style={{ marginTop: "12px" }}>
          <div className="episode-label-actions-right">
            <button type="button" className="episode-label-cancel spring-motion" onClick={onCancel}>
              {cancelText}
            </button>
            <button
              type="button"
              className={`episode-label-confirm spring-motion ${isDanger ? "is-danger" : "accent-glow"}`}
              onClick={onConfirm}
            >
              <CheckCircle2 size={15} strokeWidth={2.2} /> {confirmText}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
