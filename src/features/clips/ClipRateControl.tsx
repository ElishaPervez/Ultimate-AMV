import React from "react";
import type { ClipExportRateMode } from "../../types/clip";

export function ClipRateControl({
  mode,
  bitrateMbps,
  disabled,
  onModeChange,
  onBitrateChange,
}: {
  mode: ClipExportRateMode;
  bitrateMbps: number;
  disabled: boolean;
  onModeChange: (mode: ClipExportRateMode) => void;
  onBitrateChange: (bitrateMbps: number) => void;
}) {
  const [draftBitrate, setDraftBitrate] = React.useState(String(bitrateMbps));

  React.useEffect(() => {
    setDraftBitrate(String(bitrateMbps));
  }, [bitrateMbps]);

  function commitBitrate() {
    const next = Number(draftBitrate);
    if (Number.isFinite(next) && next > 0) {
      onBitrateChange(next);
      setDraftBitrate(String(next));
      return;
    }
    setDraftBitrate(String(bitrateMbps));
  }

  return (
    <div className="clip-rate-control">
      <div className="clip-rate-control-head">
        <span>Rate control</span>
        <div className="clip-rate-mode" role="group" aria-label="Export rate control">
          <button
            type="button"
            className={mode === "quality" ? "is-active" : ""}
            disabled={disabled}
            aria-pressed={mode === "quality"}
            onClick={() => onModeChange("quality")}
          >
            Quality
          </button>
          <button
            type="button"
            className={mode === "vbr" ? "is-active" : ""}
            disabled={disabled}
            aria-pressed={mode === "vbr"}
            onClick={() => onModeChange("vbr")}
          >
            VBR
          </button>
          <button
            type="button"
            className={mode === "cbr" ? "is-active" : ""}
            disabled={disabled}
            aria-pressed={mode === "cbr"}
            onClick={() => onModeChange("cbr")}
          >
            CBR
          </button>
        </div>
        <small className="clip-rate-mode-help">
          {mode === "quality"
            ? "Picks the bitrate per scene to hit a consistent look. File size varies."
            : mode === "vbr"
              ? "Aims for this average bitrate; busy scenes may go over."
              : "Holds this bitrate throughout. Predictable file size, safe for streaming."}
        </small>
      </div>

      {mode !== "quality" && (
        <div className={`clip-bitrate-row is-${mode}`}>
          <div>
            <strong>{mode === "cbr" ? "Constant bitrate" : "Average target"}</strong>
          </div>
          <label className="clip-bitrate-value">
            <input
              type="number"
              min="0.1"
              step="0.1"
              value={draftBitrate}
              disabled={disabled}
              aria-label={mode === "cbr" ? "Constant bitrate" : "Average bitrate"}
              onChange={(event) => {
                const next = event.currentTarget.value;
                if (/^\d*(?:\.\d*)?$/.test(next)) setDraftBitrate(next);
              }}
              onBlur={commitBitrate}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
            <span>Mbps</span>
          </label>
        </div>
      )}
    </div>
  );
}
