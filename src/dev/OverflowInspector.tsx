import React from "react";
import { createPortal } from "react-dom";
import {
  DESIGN_HEIGHT,
  DESIGN_WIDTH,
  MAX_ZOOM,
  MIN_ZOOM,
  UI_ZOOM_CHANGED_EVENT,
  getUiZoom,
} from "../lib/uiScale";

/**
 * DEV ONLY — the verification tool for window-driven UI scaling.
 *
 * Scaling is supposed to mean "the window never causes a scrollbar". This
 * finds every element that is actually scrolling right now, outlines it, and
 * reports how far past its box the content runs, so a resize sweep produces a
 * measured pass/fail instead of a visual guess.
 *
 * Two kinds of overflow are separated because only one of them is a bug:
 *  - CONTENT: a genuinely long list (the log terminal, the settings list).
 *    Expected; it would scroll at any window size.
 *  - LAYOUT: something that fits at the design size and stops fitting when
 *    the window shrinks. That is the bug class this whole change exists to
 *    remove, so anything reported here needs a look.
 *
 * Gated behind import.meta.env.DEV at the call site — never ships.
 */

type Hit = {
  id: number;
  label: string;
  rect: DOMRect;
  overflowY: number;
  overflowX: number;
  /** Overflow that survives at the design size — i.e. not caused by shrinking. */
  inherent: boolean;
};

/** Anything smaller than this is a rounding artefact, not a real overflow. */
const NOISE_PX = 2;

function describe(el: Element): string {
  const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean) : [];
  const name = cls.length ? `.${cls.slice(0, 2).join(".")}` : el.tagName.toLowerCase();
  return name.length > 46 ? `${name.slice(0, 44)}…` : name;
}

function scan(): Hit[] {
  const hits: Hit[] = [];
  let id = 0;
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
    const overflowY = el.scrollHeight - el.clientHeight;
    const overflowX = el.scrollWidth - el.clientWidth;
    if (overflowY <= NOISE_PX && overflowX <= NOISE_PX) continue;

    const style = getComputedStyle(el);
    const scrolls = /(auto|scroll)/.test(`${style.overflowY} ${style.overflowX}`);
    if (!scrolls) continue;

    const rect = el.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) continue;

    // At the design size the viewport is exactly DESIGN_WIDTH x DESIGN_HEIGHT.
    // Anything taller than the viewport itself would overflow there too, so
    // it is a long list rather than a casualty of the window shrinking.
    const inherent = el.scrollHeight > DESIGN_HEIGHT || el.scrollWidth > DESIGN_WIDTH;

    hits.push({
      id: id++,
      label: describe(el),
      rect,
      overflowY: Math.max(0, overflowY),
      overflowX: Math.max(0, overflowX),
      inherent,
    });
  }
  return hits.sort((a, b) => b.overflowY + b.overflowX - (a.overflowY + a.overflowX));
}

export function OverflowInspector({ onClose }: { onClose: () => void }) {
  const [hits, setHits] = React.useState<Hit[]>([]);
  const [zoom, setZoom] = React.useState(getUiZoom());
  const [viewport, setViewport] = React.useState({ w: window.innerWidth, h: window.innerHeight });
  const [outlines, setOutlines] = React.useState(true);

  React.useEffect(() => {
    let frame = 0;
    const refresh = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setHits(scan());
        setZoom(getUiZoom());
        setViewport({ w: window.innerWidth, h: window.innerHeight });
      });
    };
    refresh();
    const timer = window.setInterval(refresh, 600);
    window.addEventListener("resize", refresh);
    window.addEventListener(UI_ZOOM_CHANGED_EVENT, refresh);
    return () => {
      cancelAnimationFrame(frame);
      window.clearInterval(timer);
      window.removeEventListener("resize", refresh);
      window.removeEventListener(UI_ZOOM_CHANGED_EVENT, refresh);
    };
  }, []);

  const bugs = hits.filter((h) => !h.inherent);
  const expected = hits.filter((h) => h.inherent);
  const logical = { w: Math.round(viewport.w * zoom), h: Math.round(viewport.h * zoom) };

  return createPortal(
    <>
      {outlines &&
        hits.map((hit) => (
          <div
            key={hit.id}
            style={{
              position: "fixed",
              left: hit.rect.left,
              top: hit.rect.top,
              width: hit.rect.width,
              height: hit.rect.height,
              border: `2px solid ${hit.inherent ? "#f5c451" : "#fb7185"}`,
              background: hit.inherent ? "rgba(245,196,81,0.06)" : "rgba(251,113,133,0.10)",
              pointerEvents: "none",
              zIndex: 99990,
              borderRadius: 4,
            }}
          />
        ))}

      <div style={S.panel}>
        <div style={S.head}>
          <b style={{ fontSize: 13 }}>Overflow inspector</b>
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" style={S.btn} onClick={() => setOutlines((v) => !v)}>
              {outlines ? "Hide boxes" : "Show boxes"}
            </button>
            <button type="button" style={S.btn} onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        <div style={S.rows}>
          <Row k="Window (logical)" v={`${logical.w} × ${logical.h}`} />
          <Row
            k="Zoom"
            v={`${Math.round(zoom * 100)}%${zoom <= MIN_ZOOM ? "  (floor)" : zoom >= MAX_ZOOM ? "  (ceiling)" : ""}`}
            tone={zoom <= MIN_ZOOM ? "warn" : undefined}
          />
          <Row
            k="Layout space"
            v={`${viewport.w} × ${viewport.h} css`}
            tone={viewport.w < DESIGN_WIDTH || viewport.h < DESIGN_HEIGHT ? "bad" : "good"}
          />
          <Row
            k="Caused by window size"
            v={bugs.length === 0 ? "none — pass" : `${bugs.length}`}
            tone={bugs.length === 0 ? "good" : "bad"}
          />
          <Row k="Long lists (expected)" v={String(expected.length)} />
        </div>

        {hits.length > 0 && (
          <div style={S.list}>
            {hits.map((hit) => (
              <div key={hit.id} style={S.item}>
                <span style={{ color: hit.inherent ? "#f5c451" : "#fb7185", fontWeight: 700 }}>
                  {hit.inherent ? "list" : "BUG "}
                </span>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {hit.label}
                </span>
                <span style={{ color: "#98a3b3", whiteSpace: "nowrap" }}>
                  {hit.overflowY > NOISE_PX ? `↕${Math.round(hit.overflowY)}` : ""}
                  {hit.overflowX > NOISE_PX ? ` ↔${Math.round(hit.overflowX)}` : ""}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>,
    document.body,
  );
}

function Row({ k, v, tone }: { k: string; v: string; tone?: "good" | "bad" | "warn" }) {
  const color = tone === "good" ? "#63e6a2" : tone === "bad" ? "#fb7185" : tone === "warn" ? "#f5c451" : "#e6e8ee";
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
      <span style={{ color: "#98a3b3" }}>{k}</span>
      <span style={{ color, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{v}</span>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  panel: {
    position: "fixed",
    left: 16,
    bottom: 16,
    zIndex: 99999,
    width: 340,
    maxHeight: "70vh",
    display: "flex",
    flexDirection: "column",
    background: "#13161f",
    border: "1px solid #2a2f3d",
    borderRadius: 10,
    boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
    color: "#e6e8ee",
    font: "12px/1.5 ui-monospace, Consolas, monospace",
  },
  head: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "8px 10px",
    borderBottom: "1px solid #2a2f3d",
  },
  btn: {
    background: "#2a2f3d",
    color: "#e6e8ee",
    border: "none",
    borderRadius: 5,
    padding: "4px 9px",
    cursor: "pointer",
    font: "inherit",
  },
  rows: { display: "grid", gap: 4, padding: "10px" },
  list: {
    borderTop: "1px solid #2a2f3d",
    overflowY: "auto",
    padding: "6px 10px 10px",
    display: "grid",
    gap: 3,
  },
  item: { display: "flex", gap: 8, alignItems: "baseline" },
};
