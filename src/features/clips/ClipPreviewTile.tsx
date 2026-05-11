import React from "react";
import { CheckCircle2, Circle } from "lucide-react";
import type { ClipPreviewItem, ClipVideoRange } from "../../types/clip";

// Currently dead code — see FINDINGS.md. Moved here unchanged during the
// main.tsx split to keep that work move-only.
function sourceClipPlaybackRange(clip: ClipPreviewItem): ClipVideoRange {
  const safeFps = Number.isFinite(clip.fps) && clip.fps > 0 ? clip.fps : 24;
  const offset = clip.index === 0 || clip.sourceStart <= 0 ? 0 : 1.5 / safeFps;
  return {
    id: `${clip.id}-source`,
    src: clip.sourceSrc,
    start: clip.sourceStart + offset,
    end: clip.sourceEnd,
  };
}
void sourceClipPlaybackRange;

function previewClipPlaybackRange(clip: ClipPreviewItem): ClipVideoRange | null {
  const state = clip.previewState;
  if (state?.status !== "ready" || !state.src || !state.duration) return null;
  return {
    id: `${clip.id}-preview`,
    src: state.src,
    start: 0,
    end: state.duration,
  };
}

export function ClipPreviewTile({
  clip,
  selected,
  mergeMode,
  mergePosition,
  paused,
  playable,
  onClick,
  onToggleSelect,
}: {
  clip: ClipPreviewItem;
  selected: boolean;
  mergeMode: boolean;
  mergePosition: number | null;
  paused: boolean;
  playable: boolean;
  onClick: () => void;
  onToggleSelect: () => void;
}) {
  const previewRange = previewClipPlaybackRange(clip);
  const shouldPlay = Boolean(previewRange) && playable && !paused;
  const placeholderLoading = playable && clip.previewState?.status !== "error";
  const loopDuration = previewRange
    ? Math.max(0.45, previewRange.end - previewRange.start)
    : 0;
  const [isReady, setIsReady] = React.useState(false);

  React.useEffect(() => {
    setIsReady(false);
  }, [previewRange?.src]);

  return (
    <div className={`clip-preview-tile-wrapper ${selected ? "is-selected" : ""}`}>
      <button
        type="button"
        className={`clip-preview-tile ${selected ? "is-selected" : ""} ${mergeMode ? "is-selectable" : ""}`}
        onClick={onClick}
      >
        {shouldPlay && previewRange ? (
          <>
            <img
              src={previewRange.src}
              alt=""
              className={isReady ? "is-ready" : "is-loading"}
              onLoad={() => setIsReady(true)}
              onError={() => setIsReady(false)}
            />
            {!isReady && <span className="clip-video-placeholder is-loading" aria-hidden="true" />}
          </>
        ) : (
          <span className={`clip-video-placeholder ${placeholderLoading ? "is-loading" : ""}`} />
        )}
        {shouldPlay && previewRange && isReady && (
          <span
            className="clip-loop-progress"
            style={{ "--clip-loop-duration": `${loopDuration}s` } as React.CSSProperties}
            aria-hidden="true"
          >
            <span key={previewRange.id} />
          </span>
        )}
        <span className="clip-tile-scrim" />
        <span className="clip-source-badge">{clip.sourceName}</span>
        <span className="clip-tile-meta">
          <strong>{clip.label}</strong>
          <small>{clip.range}</small>
        </span>
        {mergeMode && mergePosition != null && (
          <span key={mergePosition} className="clip-merge-badge" aria-hidden="true">
            {mergePosition}
          </span>
        )}
      </button>
      <button
        type="button"
        className={`clip-corner-select ${selected ? "is-selected" : ""} ${mergeMode && mergePosition != null ? "is-merge" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggleSelect();
        }}
        aria-label={
          mergeMode
            ? mergePosition != null
              ? `Remove from merge (position ${mergePosition})`
              : "Add to merge"
            : selected
              ? "Deselect clip"
              : "Select clip"
        }
      >
        {mergeMode ? (
          mergePosition != null ? (
            <span className="clip-corner-num">{mergePosition}</span>
          ) : (
            <Circle size={20} strokeWidth={2.5} />
          )
        ) : selected ? (
          <CheckCircle2 size={20} strokeWidth={2.5} />
        ) : (
          <Circle size={20} strokeWidth={2.5} />
        )}
      </button>
    </div>
  );
}
