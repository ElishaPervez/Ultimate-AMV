import React from "react";
import { CheckCircle2, Circle } from "lucide-react";
import type { ClipPreviewItem, ClipVideoRange } from "../../types/clip";

// Currently dead code : see FINDINGS.md. Moved here unchanged during the
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

const THUMBNAIL_CACHE = new Map<string, string>();

function useWebpThumbnail(src: string | undefined) {
  const [thumbnail, setThumbnail] = React.useState<string | null>(() => {
    return src ? (THUMBNAIL_CACHE.get(src) ?? null) : null;
  });

  React.useEffect(() => {
    if (!src) {
      setThumbnail(null);
      return;
    }

    if (THUMBNAIL_CACHE.has(src)) {
      setThumbnail(THUMBNAIL_CACHE.get(src)!);
      return;
    }

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth || 426;
        canvas.height = img.naturalHeight || 240;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.75);
          THUMBNAIL_CACHE.set(src, dataUrl);
          setThumbnail(dataUrl);
        }
      } catch (e) {
        console.error("Failed to generate WebP thumbnail:", e);
      }
    };
    img.src = src;

    return () => {
      img.onload = null;
    };
  }, [src]);

  return thumbnail;
}

export function ClipPreviewTile({
  clip,
  selected,
  mergeMode,
  mergePosition,
  paused,
  playable,
  activationEpoch,
  clipHoverPreview,
  onClick,
  onToggleSelect,
}: {
  clip: ClipPreviewItem;
  selected: boolean;
  mergeMode: boolean;
  mergePosition: number | null;
  paused: boolean;
  playable: boolean;
  activationEpoch: number;
  clipHoverPreview: boolean;
  onClick: () => void;
  onToggleSelect: () => void;
}) {
  const [isHovered, setIsHovered] = React.useState(false);
  const previewRange = previewClipPlaybackRange(clip);
  const shouldPlay = Boolean(previewRange) && playable && !paused && (!clipHoverPreview || isHovered);
  const thumbnail = useWebpThumbnail(previewRange?.src);
  const placeholderLoading = playable && clip.previewState?.status !== "error";
  const loopDuration = previewRange
    ? Math.max(0.45, previewRange.end - previewRange.start)
    : 0;
  const [isReady, setIsReady] = React.useState(false);

  React.useEffect(() => {
    setIsReady(false);
  }, [previewRange?.src, activationEpoch]);

  return (
    <div className={`clip-preview-tile-wrapper ${selected ? "is-selected" : ""}`}>
      <button
        type="button"
        className={`clip-preview-tile ${selected ? "is-selected" : ""} ${mergeMode ? "is-selectable" : ""}`}
        onClick={onClick}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {shouldPlay && previewRange ? (
          <>
            <img
              key={`${previewRange.id}-${activationEpoch}`}
              // Cache-bust on activation: Chromium otherwise serves the WebP from its decoded image cache and the animation stays mid-cycle, desynced from the bar.
              src={`${previewRange.src}?v=${activationEpoch}`}
              alt=""
              className={isReady ? "is-ready" : "is-loading"}
              onLoad={() => setIsReady(true)}
              onError={() => setIsReady(false)}
            />
            {!isReady && <span className="clip-video-placeholder is-loading" aria-hidden="true" />}
          </>
        ) : (
          thumbnail ? (
            <img
              src={thumbnail}
              alt=""
              className="is-ready static-thumbnail"
            />
          ) : (
            <span className={`clip-video-placeholder ${placeholderLoading ? "is-loading" : ""}`} />
          )
        )}
        {shouldPlay && previewRange && isReady && (
          <span
            className="clip-loop-progress"
            style={{ "--clip-loop-duration": `${loopDuration}s` } as React.CSSProperties}
            aria-hidden="true"
          >
            <span key={`${previewRange.id}-${activationEpoch}`} />
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
