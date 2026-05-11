import { convertFileSrc } from "@tauri-apps/api/core";
import type { BackgroundState } from "../../types/app";

export function BackgroundLayer({ state }: { state: BackgroundState }) {
  const hasImage = Boolean(state.imagePath);
  const url = hasImage ? convertFileSrc(state.imagePath) : "";
  return (
    <div
      className={`app-bg ${hasImage ? "has-image" : ""}`}
      aria-hidden="true"
    >
      {hasImage && (
        <div
          className="app-bg-image"
          style={{
            backgroundImage: `url("${url}")`,
            backgroundPosition: `${state.offsetX}% ${state.offsetY}%`,
            transform: `scale(${state.scale})`,
            filter: state.blur > 0 ? `blur(${state.blur}px)` : undefined,
          }}
        />
      )}
      {hasImage && (
        <div
          className="app-bg-overlay"
          style={{ background: `rgba(5, 5, 7, ${state.dim / 100})` }}
        />
      )}
    </div>
  );
}
