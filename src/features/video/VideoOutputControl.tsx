import React from "react";
import type { VideoControlSpec } from "../../types/conversion";

export function VideoOutputControl({
  spec,
  value,
  disabled,
  onChange,
}: {
  spec: VideoControlSpec;
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const percent = ((value - spec.min) / (spec.max - spec.min)) * 100;
  const [draftValue, setDraftValue] = React.useState(String(value));

  React.useEffect(() => {
    setDraftValue(String(value));
  }, [value, spec.label]);

  function commitDraft() {
    const next = Number(draftValue);
    onChange(Number.isFinite(next) ? next : spec.defaultValue);
  }

  return (
    <div className="video-output-control">
      <div className="video-output-control-head">
        <div>
          <small>{spec.label}</small>
          <span>{spec.help}</span>
        </div>
        <label className="video-output-value">
          <span>{spec.valueLabel}</span>
          <input
            type="number"
            min={spec.min}
            max={spec.max}
            step={spec.step}
            value={draftValue}
            disabled={disabled}
            onChange={(event) => {
              const next = event.currentTarget.value;
              if (/^\d*$/.test(next)) {
                setDraftValue(next);
              }
            }}
            onBlur={commitDraft}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
            aria-label={spec.label}
          />
          <b>{spec.suffix}</b>
        </label>
      </div>
      <input
        className="video-output-slider"
        type="range"
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        style={{ "--fill": `${percent}%` } as React.CSSProperties}
        aria-label={spec.label}
      />
    </div>
  );
}
