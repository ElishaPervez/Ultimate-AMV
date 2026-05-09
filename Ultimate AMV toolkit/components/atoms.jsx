/* global React */
const { useState, useEffect, useRef, useMemo } = React;

// ── Icons (stroke = currentColor) ─────────────────────────
const Ic = {
  wave: (p) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" {...p}>
      <path d="M2 8h1M5 4v8M8 6v4M11 3v10M14 8h-1" />
    </svg>
  ),
  scissors: (p) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <circle cx="4" cy="11" r="2" /><circle cx="4" cy="5" r="2" />
      <path d="M5.5 6.5L14 13M5.5 9.5L14 3" />
    </svg>
  ),
  music: (p) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M6 12V3l8-1.5v9" /><circle cx="4.5" cy="12" r="1.5" /><circle cx="12.5" cy="10.5" r="1.5" />
    </svg>
  ),
  film: (p) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" {...p}>
      <rect x="2" y="2" width="12" height="12" rx="1.5" />
      <path d="M2 5h12M2 11h12M5 2v12M11 2v12" />
    </svg>
  ),
  library: (p) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" {...p}>
      <rect x="2" y="3" width="3" height="10" rx="0.5" />
      <rect x="6" y="3" width="3" height="10" rx="0.5" />
      <path d="M11 3.5l3 .8-2 9.2-3-.8z" />
    </svg>
  ),
  play: (p) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" {...p}>
      <path d="M5 3l8 5-8 5z" fill="currentColor" />
    </svg>
  ),
  download: (p) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M8 2v8M4.5 7l3.5 3.5L11.5 7" /><path d="M3 13h10" />
    </svg>
  ),
  logs: (p) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" {...p}>
      <rect x="3" y="2" width="10" height="12" rx="1" />
      <path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" />
    </svg>
  ),
  settings: (p) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" {...p}>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.5v2M8 12.5v2M14.5 8h-2M3.5 8h-2M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4M12.6 12.6l-1.4-1.4M4.8 4.8L3.4 3.4" strokeLinecap="round" />
    </svg>
  ),
  search: (p) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" {...p}>
      <circle cx="7" cy="7" r="4.5" /><path d="M10.3 10.3L13.5 13.5" />
    </svg>
  ),
  plus: (p) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" {...p}>
      <path d="M8 3v10M3 8h10" />
    </svg>
  ),
  arrowRight: (p) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M3 8h10M9 4l4 4-4 4" />
    </svg>
  ),
  check: (p) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  ),
  folder: (p) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" {...p}>
      <path d="M2 5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
    </svg>
  ),
  cpu: (p) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" {...p}>
      <rect x="4" y="4" width="8" height="8" rx="0.5" />
      <rect x="6" y="6" width="4" height="4" rx="0.5" />
      <path d="M6 4V2M10 4V2M6 14v-2M10 14v-2M4 6H2M4 10H2M14 6h-2M14 10h-2" strokeLinecap="round" />
    </svg>
  ),
  pause: (p) => (
    <svg viewBox="0 0 16 16" fill="currentColor" {...p}>
      <rect x="4.5" y="3" width="2.5" height="10" rx="0.5" />
      <rect x="9" y="3" width="2.5" height="10" rx="0.5" />
    </svg>
  ),
  more: (p) => (
    <svg viewBox="0 0 16 16" fill="currentColor" {...p}>
      <circle cx="3.5" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="12.5" cy="8" r="1.2" />
    </svg>
  ),
  close: (p) => (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" {...p}>
      <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
    </svg>
  ),
  min: (p) => (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" {...p}>
      <path d="M2.5 6h7" />
    </svg>
  ),
  max: (p) => (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" {...p}>
      <rect x="2.5" y="2.5" width="7" height="7" rx="0.5" />
    </svg>
  ),
  filter: (p) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" {...p}>
      <path d="M2 3h12M4 7.5h8M6.5 12h3" />
    </svg>
  ),
  sparkle: (p) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" {...p}>
      <path d="M8 2l1.4 4.6L14 8l-4.6 1.4L8 14l-1.4-4.6L2 8l4.6-1.4z" />
    </svg>
  ),
  step: (p) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M3 3v10M5 8l8-5v10z" fill="currentColor" />
    </svg>
  ),
  stepBack: (p) => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M13 3v10M11 8L3 3v10z" fill="currentColor" />
    </svg>
  ),
};

// Brand mark
function BrandMark({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <defs>
        <linearGradient id="bm-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="oklch(0.78 0.13 200)" />
          <stop offset="100%" stopColor="oklch(0.62 0.18 290)" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="22" height="22" rx="5" fill="url(#bm-grad)" />
      <g stroke="oklch(0.16 0.02 250)" strokeWidth="1.6" strokeLinecap="round">
        <path d="M6 12h1.5" />
        <path d="M9 8v8" />
        <path d="M12 6v12" />
        <path d="M15 9v6" />
        <path d="M17.5 12h.5" />
      </g>
    </svg>
  );
}

// Waveform visualizer (deterministic pseudo-random based on seed)
function Waveform({ seed = 1, color = "var(--text-2)", active = 0, total = 1, height = 64 }) {
  const bars = useMemo(() => {
    const out = [];
    let s = seed * 9301 + 49297;
    for (let i = 0; i < 220; i++) {
      s = (s * 9301 + 49297) % 233280;
      const r = s / 233280;
      const env = Math.sin((i / 220) * Math.PI * 4) * 0.4 + 0.6;
      const peak = Math.pow(r, 1.7) * env;
      out.push(Math.max(0.06, peak));
    }
    return out;
  }, [seed]);
  return (
    <div style={{ position: "relative", height, width: "100%" }}>
      <svg width="100%" height={height} preserveAspectRatio="none" viewBox={`0 0 220 ${height}`} style={{ display: "block" }}>
        {bars.map((b, i) => {
          const h = b * (height - 12);
          const isActive = i / 220 < active / total;
          return (
            <rect
              key={i}
              x={i * 1 + 0.15}
              y={(height - h) / 2}
              width={0.7}
              height={h}
              fill={isActive ? "var(--accent)" : color}
              opacity={isActive ? 1 : 0.55}
            />
          );
        })}
      </svg>
    </div>
  );
}

// Cover placeholder — striped bg with title
function CoverPlaceholder({ seed = 1, label, ep }) {
  const hue = (seed * 47) % 360;
  return (
    <div className="lib-cover" style={{
      background: `
        repeating-linear-gradient(${(seed * 31) % 180}deg,
          oklch(0.28 0.05 ${hue}) 0 12px,
          oklch(0.22 0.05 ${hue}) 12px 24px),
        oklch(0.22 0.05 ${hue})
      `,
    }}>
      <div style={{
        position: "absolute", inset: 0,
        background: "linear-gradient(to top, oklch(0.1 0.01 250 / 0.9) 0%, transparent 50%)",
      }} />
      <div style={{
        position: "absolute", left: 8, right: 8, bottom: 24,
        fontSize: 12, fontWeight: 600, color: "var(--text-0)", lineHeight: 1.2,
      }}>{label}</div>
      <div className="ep">{ep}</div>
    </div>
  );
}

Object.assign(window, { Ic, BrandMark, Waveform, CoverPlaceholder });
