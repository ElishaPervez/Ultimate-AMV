import React from "react";
import { Columns, Film, Pause, Play, Sliders, StepBack, StepForward } from "lucide-react";

const CHECKER_BACKGROUND: React.CSSProperties = {
  backgroundImage: `
    linear-gradient(45deg, rgba(255,255,255,0.03) 25%, transparent 25%),
    linear-gradient(-45deg, rgba(255,255,255,0.03) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, rgba(255,255,255,0.03) 75%),
    linear-gradient(-45deg, transparent 75%, rgba(255,255,255,0.03) 75%)
  `,
  backgroundSize: "20px 20px",
  backgroundPosition: "0 0, 0 10px, 10px -10px, -10px 0px",
  backgroundColor: "#131518",
};

const VIDEO_FILL: React.CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  width: "100%",
  height: "100%",
  objectFit: "contain",
  pointerEvents: "none",
};

const CORNER_LABEL: React.CSSProperties = {
  position: "absolute",
  top: "12px",
  background: "rgba(0,0,0,0.6)",
  padding: "4px 8px",
  borderRadius: "4px",
  fontSize: "11px",
  color: "#fff",
  zIndex: 5,
  pointerEvents: "none",
  border: "1px solid rgba(255,255,255,0.1)",
};

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00.00";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(2).padStart(5, "0")}`;
}

// Synchronized before/after player for a finished video isolation: the
// original source and the showcase WebM (VP9 + alpha re-encode of the export)
// play in parallel, with wipe and side-by-side layouts, seeking, and
// frame-stepping. The isolated video is the sync master — its codec is under
// our control, while the original may not even decode in WebView2.
export function VideoComparisonCard({
  original,
  isolated,
  fps,
}: {
  original: string;
  isolated: string;
  fps: number | null;
}) {
  const [layoutMode, setLayoutMode] = React.useState<"slider" | "side-by-side">("slider");
  const [isPlaying, setIsPlaying] = React.useState(false);
  const [currentTime, setCurrentTime] = React.useState(0);
  const [duration, setDuration] = React.useState(0);
  const [sliderPosition, setSliderPosition] = React.useState(50);
  const [originalUnplayable, setOriginalUnplayable] = React.useState(false);
  const originalRef = React.useRef<HTMLVideoElement | null>(null);
  const isolatedRef = React.useRef<HTMLVideoElement | null>(null);
  // Carries the playhead across the layout switch (the videos remount).
  const pendingSeekRef = React.useRef<number | null>(null);

  const effectiveFps = fps && fps > 0 ? fps : 24;

  const syncOriginal = (force = false) => {
    const master = isolatedRef.current;
    const follower = originalRef.current;
    if (!master || !follower || originalUnplayable) return;
    if (force || Math.abs(follower.currentTime - master.currentTime) > 0.08) {
      follower.currentTime = master.currentTime;
    }
  };

  const pauseBoth = () => {
    isolatedRef.current?.pause();
    originalRef.current?.pause();
    setIsPlaying(false);
  };

  const togglePlay = () => {
    const master = isolatedRef.current;
    if (!master) return;
    if (isPlaying) {
      pauseBoth();
      return;
    }
    syncOriginal(true);
    void master.play()?.catch(() => {});
    if (!originalUnplayable) {
      void originalRef.current?.play()?.catch(() => {});
    }
    setIsPlaying(true);
  };

  const seekTo = (time: number) => {
    const master = isolatedRef.current;
    if (!master) return;
    const clamped = Math.max(0, Math.min(duration || 0, time));
    master.currentTime = clamped;
    syncOriginal(true);
    setCurrentTime(clamped);
  };

  const stepFrame = (direction: -1 | 1) => {
    pauseBoth();
    const base = isolatedRef.current?.currentTime ?? currentTime;
    seekTo(base + direction / effectiveFps);
  };

  const switchLayout = (mode: "slider" | "side-by-side") => {
    if (mode === layoutMode) return;
    pendingSeekRef.current = isolatedRef.current?.currentTime ?? currentTime;
    pauseBoth();
    setLayoutMode(mode);
  };

  const handleLoadedMetadata = () => {
    const master = isolatedRef.current;
    if (!master) return;
    setDuration(master.duration || 0);
    if (pendingSeekRef.current !== null) {
      const restore = pendingSeekRef.current;
      pendingSeekRef.current = null;
      seekTo(restore);
    }
  };

  const isolatedVideoProps = {
    src: isolated,
    muted: true,
    playsInline: true,
    preload: "auto" as const,
    onTimeUpdate: () => {
      const master = isolatedRef.current;
      if (!master) return;
      syncOriginal();
      setCurrentTime(master.currentTime);
    },
    onLoadedMetadata: handleLoadedMetadata,
    onEnded: pauseBoth,
  };

  const originalVideoProps = {
    src: original,
    muted: true,
    playsInline: true,
    preload: "auto" as const,
    onError: () => setOriginalUnplayable(true),
  };

  const modeButtonStyle = (active: boolean): React.CSSProperties => ({
    background: active ? "rgba(255,255,255,0.08)" : "transparent",
    border: "none",
    borderRadius: "4px",
    padding: "6px 10px",
    color: active ? "#fff" : "rgba(255,255,255,0.4)",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: "4px",
    fontSize: "11px",
  });

  const transportButtonStyle: React.CSSProperties = {
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: "6px",
    padding: "6px 8px",
    color: "#fff",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
  };

  return (
    <div
      className="glass"
      style={{
        padding: "20px",
        borderRadius: "12px",
        border: "1px solid rgba(255,255,255,0.06)",
        background: "linear-gradient(135deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.01) 100%)",
        display: "flex",
        flexDirection: "column",
        gap: "16px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h4 style={{ margin: "0 0 4px 0", fontSize: "14px", display: "flex", alignItems: "center", gap: "8px" }}>
            <Film size={16} style={{ color: "var(--accent-a)" }} />
            Result Comparison
          </h4>
          <p className="dim-text" style={{ fontSize: "12px", margin: 0 }}>
            Original vs isolated output — play in parallel or step to any frame.
          </p>
        </div>

        <div
          style={{
            display: "flex",
            background: "rgba(0,0,0,0.2)",
            padding: "2px",
            borderRadius: "6px",
            border: "1px solid rgba(255,255,255,0.05)",
          }}
        >
          <button
            type="button"
            onClick={() => switchLayout("slider")}
            style={modeButtonStyle(layoutMode === "slider")}
            title="Interactive Wipe Slider"
          >
            <Sliders size={12} />
            <span>Slider</span>
          </button>
          <button
            type="button"
            onClick={() => switchLayout("side-by-side")}
            style={modeButtonStyle(layoutMode === "side-by-side")}
            title="Side-by-Side Comparison"
          >
            <Columns size={12} />
            <span>Side-by-Side</span>
          </button>
        </div>
      </div>

      {originalUnplayable && (
        <p className="dim-text" style={{ fontSize: "12px", margin: 0 }}>
          The original video can&apos;t be decoded for playback here — showing the isolated output only.
        </p>
      )}

      {layoutMode === "slider" ? (
        <div
          onMouseMove={(event) => {
            if (originalUnplayable) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const percent = ((event.clientX - rect.left) / rect.width) * 100;
            setSliderPosition(Math.max(0, Math.min(100, percent)));
          }}
          style={{
            position: "relative",
            width: "100%",
            height: "360px",
            borderRadius: "8px",
            overflow: "hidden",
            cursor: originalUnplayable ? "default" : "ew-resize",
            userSelect: "none",
            background: "#0c0d0e",
            border: "1px solid rgba(255, 255, 255, 0.08)",
          }}
        >
          {!originalUnplayable && (
            <video ref={originalRef} {...originalVideoProps} style={VIDEO_FILL} />
          )}
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: "100%",
              clipPath: originalUnplayable ? undefined : `polygon(${sliderPosition}% 0, 100% 0, 100% 100%, ${sliderPosition}% 100%)`,
              pointerEvents: "none",
              ...CHECKER_BACKGROUND,
            }}
          />
          <video
            ref={isolatedRef}
            {...isolatedVideoProps}
            style={{
              ...VIDEO_FILL,
              clipPath: originalUnplayable ? undefined : `polygon(${sliderPosition}% 0, 100% 0, 100% 100%, ${sliderPosition}% 100%)`,
            }}
          />
          {!originalUnplayable && (
            <>
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  left: `${sliderPosition}%`,
                  width: "2px",
                  backgroundColor: "var(--accent-a, #3b82f6)",
                  boxShadow: "0 0 10px rgba(59, 130, 246, 0.8)",
                  zIndex: 10,
                  pointerEvents: "none",
                }}
              />
              <div style={{ ...CORNER_LABEL, left: "12px" }}>Original</div>
              <div style={{ ...CORNER_LABEL, right: "12px" }}>Isolated</div>
            </>
          )}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
          <div
            style={{
              background: "#0c0d0e",
              borderRadius: "8px",
              overflow: "hidden",
              height: "260px",
              position: "relative",
              border: "1px solid rgba(255,255,255,0.06)",
            }}
          >
            {!originalUnplayable && (
              <video ref={originalRef} {...originalVideoProps} style={VIDEO_FILL} />
            )}
            <div style={{ ...CORNER_LABEL, top: undefined, bottom: "8px", left: "8px", fontSize: "10px", padding: "2px 6px" }}>
              Original
            </div>
          </div>
          <div
            style={{
              borderRadius: "8px",
              overflow: "hidden",
              height: "260px",
              position: "relative",
              border: "1px solid rgba(255,255,255,0.06)",
              ...CHECKER_BACKGROUND,
            }}
          >
            <video ref={isolatedRef} {...isolatedVideoProps} style={VIDEO_FILL} />
            <div style={{ ...CORNER_LABEL, top: undefined, bottom: "8px", left: "8px", fontSize: "10px", padding: "2px 6px" }}>
              Isolated
            </div>
          </div>
        </div>
      )}

      {/* Transport: play both in sync, scrub, or step exact frames */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <button type="button" aria-label={isPlaying ? "Pause" : "Play"} style={transportButtonStyle} onClick={togglePlay}>
          {isPlaying ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <button type="button" aria-label="Previous frame" style={transportButtonStyle} onClick={() => stepFrame(-1)}>
          <StepBack size={14} />
        </button>
        <button type="button" aria-label="Next frame" style={transportButtonStyle} onClick={() => stepFrame(1)}>
          <StepForward size={14} />
        </button>
        <input
          type="range"
          aria-label="Seek"
          min={0}
          max={duration || 0}
          step={0.01}
          value={Math.min(currentTime, duration || 0)}
          disabled={!duration}
          onChange={(event) => seekTo(Number(event.target.value))}
          style={{ flex: 1, accentColor: "rgb(var(--theme-accent-rgb))" }}
        />
        <span
          className="dim-text"
          style={{ fontSize: "11px", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}
        >
          {formatTime(currentTime)} / {formatTime(duration)} · frame {Math.round(currentTime * effectiveFps)}
        </span>
      </div>
    </div>
  );
}
