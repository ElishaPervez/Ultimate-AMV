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
        <div className="clip-rate-mode" role="group" aria-label="H.264 rate control">
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
            className={mode === "bitrate" ? "is-active" : ""}
            disabled={disabled}
            aria-pressed={mode === "bitrate"}
            onClick={() => onModeChange("bitrate")}
          >
            Target bitrate
          </button>
        </div>
      </div>

      {mode === "bitrate" && (
        <div className="clip-bitrate-row">
          <div>
            <strong>Average bitrate</strong>
            <small>Higher values preserve more detail and create larger files.</small>
          </div>
          <label className="clip-bitrate-value">
            <input
              type="number"
              min="0.1"
              step="0.1"
              value={draftBitrate}
              disabled={disabled}
              aria-label="Target bitrate"
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
