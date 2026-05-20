import React from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { BackgroundState } from "../../types/app";

export function BackgroundLayer({ state }: { state: BackgroundState }) {
  const hasVideo = Boolean(state.videoPath);
  const hasImage = !hasVideo && Boolean(state.imagePath);
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const videoUrl = hasVideo ? convertFileSrc(state.videoPath) : "";
  const imageUrl = hasImage ? convertFileSrc(state.imagePath) : "";

  // Pause the wallpaper any time the user is not actively looking at the
  // window. Two listeners cover different cases:
  //   - document.visibilitychange: fires on minimize and virtual-desktop
  //     switch in modern WebView2 - the cases where the OS already drops
  //     decode priority.
  //   - Tauri window blur (alt+tab, click another app): the window is still
  //     "visible" to the OS so visibilitychange does NOT fire. Without this
  //     listener the wallpaper keeps decoding while the user is using a
  //     different app.
  React.useEffect(() => {
    if (!hasVideo) return;
    const el = videoRef.current;
    if (!el) return;

    let isFocused = true;
    let isVisible = !document.hidden;

    const reconcile = () => {
      if (isFocused && isVisible) {
        void el.play().catch(() => {});
      } else {
        el.pause();
      }
    };

    const onVisibility = () => {
      isVisible = !document.hidden;
      reconcile();
    };
    document.addEventListener("visibilitychange", onVisibility);

    let unlistenFocus: (() => void) | null = null;
    let cancelled = false;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      if (cancelled) return;
      const win = getCurrentWindow();
      void win.onFocusChanged(({ payload: focused }) => {
        isFocused = focused;
        reconcile();
      }).then((fn) => {
        if (cancelled) fn();
        else unlistenFocus = fn;
      });
    });

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (unlistenFocus) unlistenFocus();
    };
  }, [hasVideo, state.videoPath]);

  return (
    <div
      className={`app-bg ${hasImage ? "has-image" : ""} ${hasVideo ? "has-video" : ""}`}
      aria-hidden="true"
    >
      {hasVideo && (
        <video
          ref={videoRef}
          className="app-bg-video"
          src={videoUrl}
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          disablePictureInPicture
          disableRemotePlayback
          style={{
            filter: state.blur > 0 ? `blur(${state.blur}px)` : undefined,
          }}
        />
      )}
      {hasImage && (
        <div
          className="app-bg-image"
          style={{
            backgroundImage: `url("${imageUrl}")`,
            backgroundPosition: `${state.offsetX}% ${state.offsetY}%`,
            transform: `scale(${state.scale})`,
            filter: state.blur > 0 ? `blur(${state.blur}px)` : undefined,
          }}
        />
      )}
      {(hasImage || hasVideo) && (
        <div
          className="app-bg-overlay"
          style={{ background: `rgba(5, 5, 7, ${state.dim / 100})` }}
        />
      )}
    </div>
  );
}
