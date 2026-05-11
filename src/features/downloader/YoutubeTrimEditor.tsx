import React from "react";
import { FileVideo, Scissors, X } from "lucide-react";
import { formatHms, parseHms } from "../../lib/time";

export function YoutubeTrimEditor({
  previewUrl,
  durationSeconds,
  enabled,
  onEnabledChange,
  startSeconds,
  endSeconds,
  onChange,
  forceKeyframes,
  onForceKeyframesChange,
}: {
  previewUrl: string | null;
  durationSeconds: number;
  enabled: boolean;
  onEnabledChange: (next: boolean) => void;
  startSeconds: number;
  endSeconds: number;
  onChange: (start: number, end: number) => void;
  forceKeyframes: boolean;
  onForceKeyframesChange: (next: boolean) => void;
}) {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const [playerCurrentTime, setPlayerCurrentTime] = React.useState(0);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [startInput, setStartInput] = React.useState(formatHms(startSeconds, true));
  const [endInput, setEndInput] = React.useState(formatHms(endSeconds, true));

  React.useEffect(() => {
    setStartInput(formatHms(startSeconds, true));
  }, [startSeconds]);
  React.useEffect(() => {
    setEndInput(formatHms(endSeconds, true));
  }, [endSeconds]);

  React.useEffect(() => {
    setPreviewError(null);
  }, [previewUrl]);

  function readCurrentTime(): number {
    const t = videoRef.current?.currentTime;
    return typeof t === "number" && Number.isFinite(t) ? t : 0;
  }

  function seekPlayer(seconds: number) {
    if (videoRef.current) {
      videoRef.current.currentTime = Math.max(0, Math.min(durationSeconds, seconds));
    }
    setPlayerCurrentTime(seconds);
  }

  const clamp = (n: number) => Math.max(0, Math.min(durationSeconds, n));

  function applyStart(next: number) {
    const safe = clamp(next);
    const safeEnd = Math.max(safe + 0.1, endSeconds);
    onChange(safe, Math.min(durationSeconds, safeEnd));
  }
  function applyEnd(next: number) {
    const safe = clamp(next);
    const safeStart = Math.min(safe - 0.1, startSeconds);
    onChange(Math.max(0, safeStart), safe);
  }

  function commitStartInput() {
    const parsed = parseHms(startInput);
    if (parsed === null) {
      setStartInput(formatHms(startSeconds, true));
      return;
    }
    applyStart(parsed);
  }
  function commitEndInput() {
    const parsed = parseHms(endInput);
    if (parsed === null) {
      setEndInput(formatHms(endSeconds, true));
      return;
    }
    applyEnd(parsed);
  }

  const startPercent = durationSeconds > 0 ? (startSeconds / durationSeconds) * 100 : 0;
  const endPercent = durationSeconds > 0 ? (endSeconds / durationSeconds) * 100 : 100;
  const playheadPercent = durationSeconds > 0
    ? Math.max(0, Math.min(100, (playerCurrentTime / durationSeconds) * 100))
    : 0;

  return (
    <section className="youtube-trim">
      <header className="youtube-trim-head">
        <label className="youtube-trim-toggle">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => onEnabledChange(event.target.checked)}
          />
          <Scissors size={14} strokeWidth={2.2} />
          <span>Trim a section</span>
        </label>
        {enabled ? (
          <small>Selection: {formatHms(Math.max(0, endSeconds - startSeconds), false)} of {formatHms(durationSeconds, false)}</small>
        ) : (
          <small>Optional. Toggle on to download just a segment.</small>
        )}
        {enabled ? (
          <button
            type="button"
            className="youtube-trim-close"
            onClick={() => onEnabledChange(false)}
            aria-label="Close trim editor"
            title="Close trim editor"
          >
            <X size={14} strokeWidth={2.4} />
          </button>
        ) : null}
      </header>

      {enabled ? (
        <div className="youtube-trim-body">
          <div className="youtube-trim-frame">
            {previewUrl && !previewError ? (
              <video
                ref={videoRef}
                src={previewUrl}
                controls
                preload="metadata"
                playsInline
                onTimeUpdate={() => setPlayerCurrentTime(readCurrentTime())}
                onSeeked={() => setPlayerCurrentTime(readCurrentTime())}
                onError={() => setPreviewError("Could not load preview stream — type timestamps manually below.")}
              />
            ) : (
              <div className="youtube-trim-frame-fallback">
                <FileVideo size={20} strokeWidth={2} />
                <span>{previewError ?? "No progressive preview available for this video."}</span>
                <small>Type the start and end times manually below.</small>
              </div>
            )}
          </div>

          <div className="youtube-trim-marker-bar">
            <button
              type="button"
              className="youtube-trim-marker-btn is-start"
              onClick={() => applyStart(readCurrentTime())}
              title="Use the player's current time as the clip start"
            >
              <span className="youtube-trim-marker-glyph">[</span>
              <span>Set start ({formatHms(playerCurrentTime, false)})</span>
            </button>
            <button
              type="button"
              className="youtube-trim-marker-btn is-end"
              onClick={() => applyEnd(readCurrentTime())}
              title="Use the player's current time as the clip end"
            >
              <span>Set end ({formatHms(playerCurrentTime, false)})</span>
              <span className="youtube-trim-marker-glyph">]</span>
            </button>
          </div>

          <div
            className="youtube-trim-track"
            style={{
              ["--start" as string]: `${startPercent}%`,
              ["--end" as string]: `${endPercent}%`,
              ["--playhead" as string]: `${playheadPercent}%`,
            }}
          >
            <input
              className="youtube-trim-range is-start"
              type="range"
              min={0}
              max={Math.max(0.001, durationSeconds)}
              step={0.05}
              value={startSeconds}
              onChange={(event) => applyStart(Number(event.target.value))}
              aria-label="Clip start"
            />
            <input
              className="youtube-trim-range is-end"
              type="range"
              min={0}
              max={Math.max(0.001, durationSeconds)}
              step={0.05}
              value={endSeconds}
              onChange={(event) => applyEnd(Number(event.target.value))}
              aria-label="Clip end"
            />
            <span className="youtube-trim-playhead" />
          </div>

          <div className="youtube-trim-fields">
            <label>
              <span>Start</span>
              <input
                value={startInput}
                onChange={(event) => setStartInput(event.target.value)}
                onBlur={commitStartInput}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitStartInput();
                  }
                }}
                spellCheck={false}
                placeholder="00:00:00.000"
              />
              <button
                type="button"
                onClick={() => seekPlayer(startSeconds)}
                title="Seek the preview player to this start time"
              >
                Preview
              </button>
            </label>
            <label>
              <span>End</span>
              <input
                value={endInput}
                onChange={(event) => setEndInput(event.target.value)}
                onBlur={commitEndInput}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitEndInput();
                  }
                }}
                spellCheck={false}
                placeholder="00:00:00.000"
              />
              <button
                type="button"
                onClick={() => seekPlayer(Math.max(0, endSeconds - 1))}
                title="Seek to one second before the end"
              >
                Preview
              </button>
            </label>
          </div>

          <div className="youtube-trim-options">
            <label>
              <input
                type="checkbox"
                checked={forceKeyframes}
                onChange={(event) => onForceKeyframesChange(event.target.checked)}
              />
              <span>Frame-accurate cuts</span>
              <small>Re-encodes a small region around the boundaries so the cut lands exactly where you set it.</small>
            </label>
          </div>
        </div>
      ) : null}
    </section>
  );
}
