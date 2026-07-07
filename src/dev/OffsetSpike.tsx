/* TEMP: offset-playback spike — remove after evaluation */
//
// Dev-only diagnostic to prove-or-kill "offset playback": instead of cutting a
// clip, play a sub-range [start,end] of one video file on loop and measure how
// tightly it loops in THIS WebView2 runtime. The failure mode we hunt for is the
// loop bleeding past `end` into the next scene.
//
// Nothing in here ships: the only mount site is gated on `import.meta.env.DEV`.
// All typings, styles and logic are self-contained so the whole file + its two
// edit sites in App.tsx can be deleted in one pass.

import React from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

// rVFC is already in this project's DOM lib (HTMLVideoElement.requestVideoFrameCallback),
// so we use the native types directly and gate calls on the runtime feature check below.
type VfcCallback = VideoFrameRequestCallback;

const TEST_ASSET = "C:\\Users\\Elisha\\.amv-spike\\test.mp4";
const RVFC_SUPPORTED = "requestVideoFrameCallback" in HTMLVideoElement.prototype;

function fmtRebased(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00.000";
  const sign = seconds < 0 ? "-" : "";
  const abs = Math.abs(seconds);
  const m = Math.floor(abs / 60);
  const s = Math.floor(abs % 60);
  const ms = Math.round((abs - Math.floor(abs)) * 1000);
  return `${sign}${m}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

type SpikeStats = {
  loops: number;
  rebased: number;
  maxOvershootMs: number;
  lastLatencyMs: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
  greenSeen: boolean;
  fps: number;
};

const ZERO_STATS: SpikeStats = {
  loops: 0,
  rebased: 0,
  maxOvershootMs: 0,
  lastLatencyMs: 0,
  avgLatencyMs: 0,
  maxLatencyMs: 0,
  greenSeen: false,
  fps: 0,
};

export function OffsetSpike({ onClose }: { onClose: () => void }) {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);

  const [start, setStart] = React.useState(1.0);
  const [end, setEnd] = React.useState(3.0);
  const [forceTimeupdate, setForceTimeupdate] = React.useState(false);
  const [src, setSrc] = React.useState<string>(() => convertFileSrc(TEST_ASSET));
  const [pickedPath, setPickedPath] = React.useState<string>(TEST_ASSET);
  const [videoError, setVideoError] = React.useState<string | null>(null);
  const [stats, setStats] = React.useState<SpikeStats>(ZERO_STATS);

  // The actual loop mode is rVFC unless unsupported or the user forces fallback.
  const usingRvfc = RVFC_SUPPORTED && !forceTimeupdate;

  // Mutable accumulators live in a ref so the per-frame callback never re-binds
  // and never triggers React re-renders on the hot path; we snapshot into state
  // on a slow interval instead.
  const accRef = React.useRef({
    loops: 0,
    rebased: 0,
    maxOvershootMs: 0,
    latencies: [] as number[],
    lastLatencyMs: 0,
    maxLatencyMs: 0,
    greenSeen: false,
    fps: 0,
    seekIssuedAt: 0,
    awaitingSeek: false,
    sampledThisLoop: false,
  });

  // Reset accumulators whenever the measured scenario changes.
  React.useEffect(() => {
    accRef.current = {
      loops: 0,
      rebased: 0,
      maxOvershootMs: 0,
      latencies: [],
      lastLatencyMs: 0,
      maxLatencyMs: 0,
      greenSeen: false,
      fps: 0,
      seekIssuedAt: 0,
      awaitingSeek: false,
      sampledThisLoop: false,
    };
    setStats(ZERO_STATS);
  }, [src, start, end, forceTimeupdate]);

  // Slow UI snapshot of the hot-path accumulators (10 Hz is plenty for readout).
  React.useEffect(() => {
    const id = window.setInterval(() => {
      const a = accRef.current;
      const v = videoRef.current;
      const rebased = v ? v.currentTime - start : 0;
      const avg =
        a.latencies.length > 0
          ? a.latencies.reduce((sum, x) => sum + x, 0) / a.latencies.length
          : 0;
      setStats({
        loops: a.loops,
        rebased,
        maxOvershootMs: a.maxOvershootMs,
        lastLatencyMs: a.lastLatencyMs,
        avgLatencyMs: avg,
        maxLatencyMs: a.maxLatencyMs,
        greenSeen: a.greenSeen,
        fps: a.fps,
      });
    }, 100);
    return () => window.clearInterval(id);
  }, [start]);

  // Core loop engine: re-arms on every scenario change. Handles BOTH the rVFC
  // path and the timeupdate fallback, plus seek-latency timing and the green
  // bleed canvas sample. Teardown cancels every handle/listener/timeout.
  React.useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;

    let cancelled = false;
    let rvfcHandle = 0;
    let safetyTimer = 0;
    const a = accRef.current;

    // Best-effort fps estimate for the "~Y frames" overshoot conversion. The
    // staged asset is CFR; real files vary. We refine from rVFC presentedFrames
    // when available, else fall back to a 30fps assumption.
    let firstFrameTime = 0;
    let firstFrameCount = 0;

    const sampleGreen = () => {
      // Draw the current frame into a tiny offscreen canvas and check the centre
      // pixel. While looping [1.0,3.0] the staged asset must stay RED; any GREEN
      // means playback bled past 3.0s into the GREEN half — the objective signal.
      const canvas = canvasRef.current;
      if (!canvas) return;
      try {
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const cx = (canvas.width / 2) | 0;
        const cy = (canvas.height / 2) | 0;
        const px = ctx.getImageData(cx, cy, 1, 1).data;
        const [r, g, b] = [px[0], px[1], px[2]];
        if (g > 110 && r < 110 && b < 110) {
          a.greenSeen = true;
        }
      } catch {
        // drawImage can throw if the frame isn't decodable yet — ignore.
      }
    };

    const doLoopback = (observedTime: number) => {
      // Record overshoot at the instant before snapping back.
      const overshootMs = Math.max(0, (observedTime - end) * 1000);
      if (overshootMs > a.maxOvershootMs) a.maxOvershootMs = overshootMs;
      // Sample once near the end of this loop to catch any bleed.
      if (!a.sampledThisLoop) {
        sampleGreen();
        a.sampledThisLoop = true;
      }
      a.loops += 1;
      // Issue the snap-back seek and start the latency clock.
      a.seekIssuedAt = performance.now();
      a.awaitingSeek = true;
      video.currentTime = start;
      a.sampledThisLoop = false;
    };

    const onSeeked = () => {
      if (!a.awaitingSeek) return;
      a.awaitingSeek = false;
      const latency = performance.now() - a.seekIssuedAt;
      a.lastLatencyMs = latency;
      if (latency > a.maxLatencyMs) a.maxLatencyMs = latency;
      a.latencies.push(latency);
      if (a.latencies.length > 200) a.latencies.shift();
    };

    // --- rVFC path -----------------------------------------------------------
    const onFrame: VfcCallback = (_now, metadata) => {
      if (cancelled) return;
      // fps from presentedFrames delta over wall time.
      if (firstFrameTime === 0) {
        firstFrameTime = metadata.expectedDisplayTime;
        firstFrameCount = metadata.presentedFrames;
      } else {
        const dt = (metadata.expectedDisplayTime - firstFrameTime) / 1000;
        const df = metadata.presentedFrames - firstFrameCount;
        if (dt > 0.5 && df > 0) a.fps = df / dt;
      }
      const t = metadata.mediaTime ?? video.currentTime;
      if (t >= end) {
        doLoopback(t);
      }
      if (!cancelled && RVFC_SUPPORTED) {
        rvfcHandle = video.requestVideoFrameCallback(onFrame);
      }
    };

    // --- timeupdate fallback path -------------------------------------------
    const onTimeUpdate = () => {
      if (cancelled) return;
      if (a.fps === 0) a.fps = 30; // no rVFC fps source in fallback mode
      if (video.currentTime >= end) {
        doLoopback(video.currentTime);
      } else {
        // setTimeout safety net: fire a snap-back at the remaining time so we
        // also measure the fallback's overshoot when timeupdate is too coarse.
        const remainingMs = (end - video.currentTime) * 1000;
        if (remainingMs > 0 && remainingMs < 1000) {
          window.clearTimeout(safetyTimer);
          safetyTimer = window.setTimeout(() => {
            if (!cancelled && video.currentTime >= end - 0.001) {
              doLoopback(video.currentTime);
            }
          }, remainingMs);
        }
      }
    };

    const onLoadedMeta = () => {
      setVideoError(null);
      video.currentTime = start;
      void video.play().catch(() => {
        /* autoplay can reject; muted should allow it. */
      });
    };

    const onError = () => {
      const code = video.error?.code;
      const msg = video.error?.message;
      setVideoError(`Video error${code ? ` (code ${code})` : ""}${msg ? `: ${msg}` : ""}`);
    };

    video.addEventListener("loadedmetadata", onLoadedMeta);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    if (usingRvfc) {
      rvfcHandle = video.requestVideoFrameCallback(onFrame);
    } else {
      video.addEventListener("timeupdate", onTimeUpdate);
    }

    // If metadata is already loaded (src unchanged but a param changed), kick now.
    if (video.readyState >= 1) {
      onLoadedMeta();
    }

    return () => {
      cancelled = true;
      window.clearTimeout(safetyTimer);
      if (RVFC_SUPPORTED && rvfcHandle) {
        video.cancelVideoFrameCallback(rvfcHandle);
      }
      video.removeEventListener("loadedmetadata", onLoadedMeta);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.pause();
    };
  }, [src, start, end, usingRvfc]);

  const pickFile = async () => {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Video", extensions: ["mp4", "mkv", "mov", "webm", "m4v", "avi"] }],
      });
      if (typeof selected === "string") {
        setPickedPath(selected);
        setVideoError(null);
        setSrc(convertFileSrc(selected));
      }
    } catch (err) {
      setVideoError(err instanceof Error ? err.message : String(err));
    }
  };

  // Verdict: TIGHT when overshoot is under ~one frame and no green ever sampled.
  const frameMs = stats.fps > 0 ? 1000 / stats.fps : 1000 / 30;
  const overshootFrames = stats.maxOvershootMs / frameMs;
  const tight = !stats.greenSeen && stats.maxOvershootMs <= frameMs * 1.0;
  const verdict =
    stats.loops === 0
      ? "WAITING (no loops yet)…"
      : tight
        ? `TIGHT (overshoot ${stats.maxOvershootMs.toFixed(1)}ms ≈ ${overshootFrames.toFixed(2)} frame, no green)`
        : `BLEEDS (overshoot ${stats.maxOvershootMs.toFixed(1)}ms ≈ ${overshootFrames.toFixed(2)} frames${stats.greenSeen ? ", GREEN seen" : ""})`;

  return (
    <div style={S.overlay}>
      <div style={S.panel}>
        <div style={S.header}>
          <span style={S.title}>🔬 Offset Playback Spike (dev-only)</span>
          <button type="button" style={S.closeBtn} onClick={onClose}>
            Close ✕
          </button>
        </div>

        <div style={S.body}>
          <div style={S.left}>
            <video
              ref={videoRef}
              src={src}
              muted
              playsInline
              style={S.video}
            />
            <canvas ref={canvasRef} width={16} height={16} style={{ display: "none" }} />

            <div style={S.controls}>
              <label style={S.field}>
                start
                <input
                  type="number"
                  step={0.1}
                  value={start}
                  onChange={(e) => setStart(Number(e.target.value))}
                  style={S.input}
                />
              </label>
              <label style={S.field}>
                end
                <input
                  type="number"
                  step={0.1}
                  value={end}
                  onChange={(e) => setEnd(Number(e.target.value))}
                  style={S.input}
                />
              </label>
              <label style={S.checkField}>
                <input
                  type="checkbox"
                  checked={forceTimeupdate}
                  onChange={(e) => setForceTimeupdate(e.target.checked)}
                />
                Force timeupdate fallback
              </label>
            </div>

            <div style={S.controls}>
              <button type="button" style={S.btn} onClick={() => void pickFile()}>
                Pick a real file…
              </button>
            </div>
            <div style={S.path}>file: {pickedPath}</div>
            {videoError && <div style={S.error}>{videoError}</div>}
          </div>

          <div style={S.right}>
            <Row k="rVFC supported" v={RVFC_SUPPORTED ? "yes" : "no"} />
            <Row k="active loop mode" v={usingRvfc ? "rVFC" : "timeupdate"} />
            <Row k="loops completed" v={String(stats.loops)} />
            <Row k="rebased time" v={fmtRebased(stats.rebased)} />
            <Row
              k="max overshoot past end"
              v={`${stats.maxOvershootMs.toFixed(1)} ms  (~${overshootFrames.toFixed(2)} frames @ ${stats.fps ? stats.fps.toFixed(1) : "?"} fps)`}
            />
            <Row
              k="snap-back latency last/avg/max"
              v={`${stats.lastLatencyMs.toFixed(1)} / ${stats.avgLatencyMs.toFixed(1)} / ${stats.maxLatencyMs.toFixed(1)} ms`}
            />
            <Row
              k="GREEN bleed detected"
              v={stats.greenSeen ? "yes" : "no"}
              danger={stats.greenSeen}
            />

            <div style={{ ...S.verdict, ...(tight ? S.verdictGood : S.verdictBad) }}>
              {verdict}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ k, v, danger }: { k: string; v: string; danger?: boolean }) {
  return (
    <div style={S.row}>
      <span style={S.rowK}>{k}</span>
      <span style={{ ...S.rowV, ...(danger ? { color: "#ff6b6b" } : null) }}>{v}</span>
    </div>
  );
}

// Inline styles keep the spike self-contained (no edits to styles.css needed).
const S: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    zIndex: 99999,
    background: "rgba(8,10,16,0.92)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "system-ui, sans-serif",
  },
  panel: {
    width: "min(1100px, 94vw)",
    maxHeight: "92vh",
    overflow: "auto",
    background: "#13161f",
    border: "1px solid #2a2f3d",
    borderRadius: 12,
    boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
    color: "#e6e8ee",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "12px 16px",
    borderBottom: "1px solid #2a2f3d",
  },
  title: { fontWeight: 600, fontSize: 15 },
  closeBtn: {
    background: "#2a2f3d",
    color: "#e6e8ee",
    border: "none",
    borderRadius: 6,
    padding: "6px 12px",
    cursor: "pointer",
  },
  body: { display: "flex", gap: 16, padding: 16, flexWrap: "wrap" },
  left: { flex: "1 1 420px", minWidth: 360 },
  right: { flex: "1 1 360px", minWidth: 320 },
  video: {
    width: "100%",
    aspectRatio: "16 / 9",
    background: "#000",
    borderRadius: 8,
    objectFit: "contain",
  },
  controls: { display: "flex", gap: 12, alignItems: "center", marginTop: 12, flexWrap: "wrap" },
  field: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "#aab0c0" },
  checkField: { display: "flex", gap: 6, alignItems: "center", fontSize: 13 },
  input: {
    width: 90,
    background: "#0c0e14",
    color: "#e6e8ee",
    border: "1px solid #2a2f3d",
    borderRadius: 6,
    padding: "6px 8px",
  },
  btn: {
    background: "#3b82f6",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "8px 14px",
    cursor: "pointer",
    fontSize: 13,
  },
  path: { marginTop: 10, fontSize: 11, color: "#8a90a2", wordBreak: "break-all" },
  error: {
    marginTop: 8,
    fontSize: 12,
    color: "#ff6b6b",
    background: "rgba(255,107,107,0.1)",
    padding: "6px 10px",
    borderRadius: 6,
  },
  row: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    padding: "8px 0",
    borderBottom: "1px solid #20242f",
    fontSize: 13,
  },
  rowK: { color: "#aab0c0" },
  rowV: { fontVariantNumeric: "tabular-nums", fontWeight: 600, textAlign: "right" },
  verdict: {
    marginTop: 16,
    padding: "12px 14px",
    borderRadius: 8,
    fontWeight: 700,
    fontSize: 14,
    textAlign: "center",
  },
  verdictGood: { background: "rgba(34,197,94,0.15)", color: "#4ade80", border: "1px solid #22c55e" },
  verdictBad: { background: "rgba(239,68,68,0.15)", color: "#f87171", border: "1px solid #ef4444" },
};
