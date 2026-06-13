/* DEV TOOLS: featherweight-preview tuning panel â€” bake values then delete */
//
// DEV-ONLY live tuning surface for the featherweight offset-playback previews.
// EVERYTHING here is gated on import.meta.env.DEV at the single mount site in
// src/shell/App.tsx, so nothing in this file ships in a production build.
//
// Purpose: tune the universal loop margin (and grid <video> cap) on REAL
// footage in-app, watch the live boundary-overshoot readout, then bake the good
// values back into src/lib/constants.ts and hide this panel. Every edit site is
// tagged /* DEV TOOLS */ so the whole feature is trivially greppable/removable.
//
// It does NOT own playback â€” it only mutates the shared previewTunables store
// (which components read) and polls the offset-metrics registry for the readout.

import React from "react";
import { MAX_GRID_VIDEO_PLAYERS_CEILING } from "../lib/constants";
import {
  getOffsetMetricsSummary,
  setPreviewTunables,
  usePreviewTunables,
} from "./previewTunables";

export function PreviewDevTools({ onClose }: { onClose: () => void }) {
  const tunables = usePreviewTunables();
  const [summary, setSummary] = React.useState(() => getOffsetMetricsSummary());

  // Poll the (non-reactive) live-metrics registry. 10 Hz is plenty for a
  // human-readable readout and keeps the hot path free of React churn.
  React.useEffect(() => {
    const id = window.setInterval(() => {
      setSummary(getOffsetMetricsSummary());
    }, 100);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div style={S.overlay}>
      <div style={S.panel}>
        <div style={S.header}>
          <span style={S.title}>🪶 Featherweight Preview DevTools</span>
          <button type="button" style={S.closeBtn} onClick={onClose}>
            Close ✕
          </button>
        </div>

        <div style={S.body}>
          <p style={S.note}>
            Live-edits the shared tunables store on real footage. Bake the final
            values into <code>src/lib/constants.ts</code>, then remove this panel.
          </p>

          <label style={S.checkRow}>
            <input
              type="checkbox"
              checked={tunables.featherweightEnabled}
              onChange={(e) => setPreviewTunables({ featherweightEnabled: e.target.checked })}
            />
            <span>
              Featherweight previews enabled
              <em style={S.hint}> (DEV override of the config gate)</em>
            </span>
          </label>

          <div style={S.fieldRow}>
            <label style={S.field}>
              End margin (frames)
              <input
                type="number"
                min={0}
                step={1}
                value={tunables.endMarginFrames}
                onChange={(e) =>
                  setPreviewTunables({ endMarginFrames: clampInt(e.target.value, 0) })
                }
                style={S.input}
              />
              <em style={S.hint}>turn around N frames before the cut</em>
            </label>

            <label style={S.field}>
              Start margin (frames)
              <input
                type="number"
                min={0}
                step={1}
                value={tunables.startMarginFrames}
                onChange={(e) =>
                  setPreviewTunables({ startMarginFrames: clampInt(e.target.value, 0) })
                }
                style={S.input}
              />
              <em style={S.hint}>start N frames after the cut</em>
            </label>
          </div>

          <div style={S.fieldRow}>
            <label style={S.field}>
              Max grid &lt;video&gt; players
              <input
                type="number"
                min={1}
                max={MAX_GRID_VIDEO_PLAYERS_CEILING}
                step={1}
                value={tunables.maxGridVideoPlayers}
                onChange={(e) =>
                  setPreviewTunables({
                    maxGridVideoPlayers: clampInt(e.target.value, 1, MAX_GRID_VIDEO_PLAYERS_CEILING),
                  })
                }
                style={S.input}
              />
              <em style={S.hint}>
                hard cap {MAX_GRID_VIDEO_PLAYERS_CEILING}; floored at the visible-tile count
              </em>
            </label>

            <label style={S.field}>
              Play area margin (px)
              <input
                type="number"
                min={0}
                step={50}
                value={tunables.playAreaMarginPx}
                onChange={(e) =>
                  setPreviewTunables({ playAreaMarginPx: clampInt(e.target.value, 0) })
                }
                style={S.input}
              />
              <em style={S.hint}>how far outside the viewport (px) a clip starts playing</em>
            </label>
          </div>

          <label style={S.checkRow}>
            <input
              type="checkbox"
              checked={tunables.forceTimeupdateFallback}
              onChange={(e) =>
                setPreviewTunables({ forceTimeupdateFallback: e.target.checked })
              }
            />
            <span>
              Force timeupdate fallback
              <em style={S.hint}> (tune the coarse-loop margin, worst case)</em>
            </span>
          </label>

          <div style={S.readout}>
            <Row k="active offset videos" v={String(summary.activeCount)} />
            <Row
              k="max overshoot (active tiles)"
              v={`${summary.maxOvershootMs.toFixed(1)} ms`}
              danger={summary.maxOvershootMs > 80}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function clampInt(raw: string, min: number, max?: number): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return min;
  const lower = Math.max(min, n);
  return max != null ? Math.min(max, lower) : lower;
}

function Row({ k, v, danger }: { k: string; v: string; danger?: boolean }) {
  return (
    <div style={S.row}>
      <span style={S.rowK}>{k}</span>
      <span style={{ ...S.rowV, ...(danger ? { color: "#ff6b6b" } : null) }}>{v}</span>
    </div>
  );
}

// Inline styles keep the panel self-contained (mirrors OffsetSpike), so the
// whole DEV TOOLS feature deletes in one pass with no styles.css residue.
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
    width: "min(560px, 94vw)",
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
  body: { display: "flex", flexDirection: "column", gap: 16, padding: 16 },
  note: { margin: 0, fontSize: 12, color: "#8a90a2", lineHeight: 1.5 },
  checkRow: { display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13 },
  fieldRow: { display: "flex", gap: 16, flexWrap: "wrap" },
  field: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "#aab0c0" },
  hint: { fontSize: 10.5, color: "#6b7180", fontStyle: "normal" },
  input: {
    width: 110,
    background: "#0c0e14",
    color: "#e6e8ee",
    border: "1px solid #2a2f3d",
    borderRadius: 6,
    padding: "6px 8px",
  },
  readout: {
    marginTop: 4,
    padding: "8px 12px",
    background: "#0c0e14",
    border: "1px solid #20242f",
    borderRadius: 8,
  },
  row: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    padding: "6px 0",
    fontSize: 13,
  },
  rowK: { color: "#aab0c0" },
  rowV: { fontVariantNumeric: "tabular-nums", fontWeight: 600, textAlign: "right" },
};
