import React from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Loader2, Wand2, X } from "lucide-react";
import { fileName } from "../../lib/paths";

export function ClipCompatConvertModal({
  open,
  failedPath,
  rawError,
  isConverting,
  convertMessage,
  onConvert,
  onCancel,
}: {
  open: boolean;
  failedPath: string | null;
  rawError: string | null;
  isConverting: boolean;
  convertMessage: string | null;
  onConvert: () => void;
  onCancel: () => void;
}) {
  const [showDetails, setShowDetails] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setShowDetails(false);
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isConverting) {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, isConverting, onCancel]);

  if (!open) return null;

  const displayName = failedPath ? fileName(failedPath) : "This episode";

  return createPortal(
    <div className="episode-label-backdrop" role="dialog" aria-label="Unsupported format">
      <div className="episode-label-modal">
        <div className="episode-label-header">
          <div>
            <span className="episode-label-kicker">
              <AlertTriangle size={13} strokeWidth={2.2} /> Format not supported
            </span>
            <h2>This file can't be read directly</h2>
            <p>
              <strong>{displayName}</strong> uses a format the clip extractor can't open.
              We can convert it to a compatible format : your original file stays untouched,
              and the converted copy is kept in the app's cache so future runs are instant.
            </p>
          </div>
          {!isConverting && (
            <button
              type="button"
              className="episode-label-close"
              onClick={onCancel}
              aria-label="Cancel"
            >
              <X size={16} />
            </button>
          )}
        </div>

        {isConverting ? (
          <div className="clip-compat-status">
            <Loader2 className="is-spinning" size={18} strokeWidth={2.1} />
            <span>{convertMessage ?? "Converting to compatible format..."}</span>
          </div>
        ) : (
          rawError && (
            <div className="clip-compat-details">
              <button
                type="button"
                className="episode-label-link"
                onClick={() => setShowDetails((value) => !value)}
              >
                {showDetails ? "Hide technical details" : "Show technical details"}
              </button>
              {showDetails && (
                <pre className="clip-compat-error-trace">{rawError}</pre>
              )}
            </div>
          )
        )}

        <div className="episode-label-actions">
          <div className="episode-label-actions-right">
            <button
              type="button"
              className="episode-label-cancel"
              onClick={onCancel}
              disabled={isConverting}
            >
              Cancel
            </button>
            <button
              type="button"
              className="episode-label-confirm"
              onClick={onConvert}
              disabled={isConverting || !failedPath}
            >
              {isConverting
                ? <><Loader2 className="is-spinning" size={15} strokeWidth={2.2} /> Converting...</>
                : <><Wand2 size={15} strokeWidth={2.2} /> Convert to compatible format</>}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
