/* global React, Ic, BrandMark */
const { useState: useStateShell } = React;

function Titlebar({ workspace }) {
  return (
    <div className="titlebar">
      <div className="tb-brand">
        <BrandMark size={18} />
        <div className="tb-title">Ultimate AMV</div>
      </div>
      <div className="tb-divider" />
      <div className="tb-menu">
        <button>File</button>
        <button>Edit</button>
        <button>View</button>
        <button>Window</button>
        <button>Help</button>
      </div>
      <div className="tb-spacer" />
      <div className="tb-status">
        <span><span className="dot" /> CUDA · RTX 4070</span>
        <span>14.2 GB / 16 GB</span>
        <span>v0.4.2-beta</span>
      </div>
      <div className="tb-controls">
        <button title="Minimize"><Ic.min /></button>
        <button title="Maximize"><Ic.max /></button>
        <button className="close" title="Close"><Ic.close /></button>
      </div>
    </div>
  );
}

function Sidebar({ active, onChange }) {
  const create = [
    { id: "vocal", label: "Vocal Extraction", ic: <Ic.wave />, badge: "1" },
    { id: "clip", label: "Clip Hunting", ic: <Ic.scissors /> },
    { id: "audio", label: "Audio Conversion", ic: <Ic.music /> },
    { id: "video", label: "Video Conversion", ic: <Ic.film /> },
  ];
  const source = [
    { id: "library", label: "Library", ic: <Ic.library />, badge: "284" },
    { id: "downloads", label: "Downloads", ic: <Ic.download /> },
  ];
  return (
    <aside className="sidebar">
      <div className="sb-section-label">Source</div>
      <div className="sb-group">
        {source.map((it) => (
          <button key={it.id} className={"sb-item" + (active === it.id ? " active" : "")} onClick={() => onChange(it.id)}>
            <span className="ic">{it.ic}</span>
            <span>{it.label}</span>
            {it.badge && <span className="badge">{it.badge}</span>}
          </button>
        ))}
      </div>
      <div className="sb-section-label">Workshop</div>
      <div className="sb-group">
        {create.map((it) => (
          <button key={it.id} className={"sb-item" + (active === it.id ? " active" : "")} onClick={() => onChange(it.id)}>
            <span className="ic">{it.ic}</span>
            <span>{it.label}</span>
            {it.badge && <span className="badge">{it.badge}</span>}
          </button>
        ))}
      </div>

      <div className="sb-spacer" />

      <div className="sb-meter">
        <h5>System <span className="mono dim" style={{ letterSpacing: 0, textTransform: "none", fontWeight: 400 }}>live</span></h5>
        <div className="meter-row">
          <span className="lbl">CPU</span>
          <span className="bar"><i style={{ width: "32%" }} /></span>
          <span className="val">32%</span>
        </div>
        <div className="meter-row">
          <span className="lbl">GPU</span>
          <span className="bar"><i style={{ width: "78%", background: "var(--warn)" }} /></span>
          <span className="val">78%</span>
        </div>
        <div className="meter-row">
          <span className="lbl">RAM</span>
          <span className="bar"><i style={{ width: "44%" }} /></span>
          <span className="val">7.0G</span>
        </div>
        <div className="meter-row">
          <span className="lbl">VRAM</span>
          <span className="bar"><i style={{ width: "62%" }} /></span>
          <span className="val">9.9G</span>
        </div>
      </div>

      <div className="sb-group" style={{ paddingBottom: 8 }}>
        <button className="sb-item" onClick={() => onChange("logs")}>
          <span className="ic"><Ic.logs /></span>
          <span>Logs</span>
          <span className="badge" style={{ background: "var(--warn-soft)", color: "var(--warn)" }}>3</span>
        </button>
        <button className="sb-item" onClick={() => onChange("settings")}>
          <span className="ic"><Ic.settings /></span>
          <span>Settings</span>
        </button>
      </div>
    </aside>
  );
}

function Statusbar({ active }) {
  return (
    <div className="statusbar">
      <span className="sb-pill" title="Active workspace">
        <span style={{ width: 6, height: 6, borderRadius: 3, background: "var(--accent)" }} />
        {active.toUpperCase()}
      </span>
      <span>FPS 60</span>
      <span>1 task running</span>
      <span>queue 2</span>
      <span className="sb-spc" />
      <span>1920×1080 · 24p</span>
      <span>output: D:\amv\stems</span>
      <span className="sb-pill">⌘K  command</span>
      <span>↑ 0 KB/s   ↓ 0 KB/s</span>
    </div>
  );
}

Object.assign(window, { Titlebar, Sidebar, Statusbar });
