/* global React, Ic, Waveform */
const { useState: useStateVocal, useEffect: useEffectVocal } = React;

function VocalExtraction({ tweaks }) {
  const [tab, setTab] = useStateVocal("extract");
  const [stage, setStage] = useStateVocal(tweaks.demoState || "processing"); // idle | loaded | processing | complete

  // simulated processing progress
  const [progress, setProgress] = useStateVocal(0.42);
  useEffectVocal(() => {
    if (stage !== "processing") return;
    const id = setInterval(() => {
      setProgress((p) => {
        const n = p + 0.004;
        if (n >= 1) { setStage("complete"); return 1; }
        return n;
      });
    }, 80);
    return () => clearInterval(id);
  }, [stage]);

  // sync external override
  useEffectVocal(() => { setStage(tweaks.demoState || "processing"); }, [tweaks.demoState]);

  return (
    <div className="workspace">
      <div className="ws-header">
        <div className="ws-title">
          <h1>Vocal Extraction</h1>
          <span className="sub">Separate vocals and instrumentals from any source track.</span>
        </div>
        <div className="ws-tabs" style={{ marginLeft: 24 }}>
          <button className={"ws-tab" + (tab === "extract" ? " active" : "")} onClick={() => setTab("extract")}>Extract</button>
          <button className={"ws-tab" + (tab === "history" ? " active" : "")} onClick={() => setTab("history")}>History</button>
          <button className={"ws-tab" + (tab === "models" ? " active" : "")} onClick={() => setTab("models")}>Models</button>
        </div>
        <div className="ws-actions">
          <span className="chip"><Ic.cpu width="11" height="11" /> CUDA · 9.9 GB</span>
          <span className="chip accent"><span className="dot" /> Kim Vocal 2 (ONNX)</span>
          {stage === "processing"
            ? <span className="chip warn"><span className="dot pulse" /> Processing</span>
            : <span className="chip good"><span className="dot" /> Ready</span>}
        </div>
      </div>

      <div className="ws-body">
        <div className="ws-canvas" style={{ background: "var(--bg-0)" }}>
          {tab === "extract" && (stage === "processing" || stage === "complete") && (
            <ExtractCanvas progress={progress} stage={stage} />
          )}
          {tab === "extract" && stage === "idle" && <IdleCanvas />}
          {tab === "history" && <HistoryView />}
          {tab === "models" && <ModelsView />}
        </div>

        <aside className="inspector">
          <div className="insp-section">
            <h4>Source <span className="dim mono" style={{ fontWeight: 400, letterSpacing: 0 }}>1 file</span></h4>
            <div style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: 10,
              background: "var(--bg-0)", border: "1px solid var(--line-1)", borderRadius: "var(--r-2)",
            }}>
              <div style={{
                width: 38, height: 38, borderRadius: 4,
                background: "var(--accent-soft)", color: "var(--accent)",
                display: "grid", placeItems: "center", flex: "0 0 38px",
              }}>
                <Ic.music width="18" height="18" />
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 12, color: "var(--text-1)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  Yoasobi — Idol (TV size).flac
                </div>
                <div className="mono" style={{ fontSize: 10, color: "var(--text-3)", marginTop: 2 }}>
                  44.1 kHz · 24-bit · 03:38 · 38.2 MB
                </div>
              </div>
              <button className="btn icon ghost" title="More"><Ic.more width="14" height="14" /></button>
            </div>
          </div>

          <div className="insp-section">
            <h4>Model</h4>
            <div className="field">
              <label>Architecture</label>
              <select className="select" defaultValue="kim">
                <option value="kim">Kim Vocal 2 — MDX-Net</option>
                <option value="uvr">UVR-MDX-NET Voc FT</option>
                <option value="htdemucs">HTDemucs (4-stem)</option>
                <option value="mel">Mel-RoFormer (slow)</option>
              </select>
            </div>
            <div className="field">
              <label>Aggression <span className="hint">{tweaks.aggression}</span></label>
              <input className="slider" type="range" min="0" max="20" defaultValue={tweaks.aggression} />
            </div>
            <div className="field">
              <label>Output stems</label>
              <div className="seg">
                <button className="active">2-stem</button>
                <button>4-stem</button>
                <button>6-stem</button>
              </div>
            </div>
          </div>

          <div className="insp-section">
            <h4>Output</h4>
            <div className="field">
              <label>Format</label>
              <div className="seg">
                <button>WAV</button>
                <button className="active">FLAC</button>
                <button>MP3</button>
                <button>OGG</button>
              </div>
            </div>
            <div className="field">
              <label>Sample rate</label>
              <select className="select" defaultValue="44">
                <option value="44">44.1 kHz</option>
                <option value="48">48 kHz</option>
                <option value="96">96 kHz</option>
              </select>
            </div>
            <div className="field">
              <label>Save next to source</label>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span className="mono" style={{ fontSize: 10, color: "var(--text-3)" }}>D:\amv\stems\</span>
                <span className="toggle on" />
              </div>
            </div>
          </div>

          <div className="insp-section" style={{ borderBottom: 0 }}>
            <h4>Advanced</h4>
            <div className="field">
              <label>Denoise pass <span className="hint">+12s</span></label>
              <span className="toggle on" style={{ alignSelf: "flex-start" }} />
            </div>
            <div className="field">
              <label>Normalize loudness <span className="hint">-14 LUFS</span></label>
              <span className="toggle" style={{ alignSelf: "flex-start" }} />
            </div>
            <div className="field">
              <label>Phase invert mix-back</label>
              <span className="toggle on" style={{ alignSelf: "flex-start" }} />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

// ── Idle / drop state ───────────────────────────────────────
function IdleCanvas() {
  return (
    <div style={{ flex: 1, display: "grid", placeItems: "center", padding: 40 }}>
      <div className="dropzone" style={{ width: "min(620px, 100%)" }}>
        <div style={{
          width: 52, height: 52, borderRadius: 12,
          background: "var(--accent-soft)", color: "var(--accent)",
          display: "grid", placeItems: "center",
        }}>
          <Ic.wave width="24" height="24" />
        </div>
        <div>
          <div style={{ fontSize: 16, color: "var(--text-0)", fontWeight: 600, marginBottom: 4 }}>
            Drop an audio or video file
          </div>
          <div style={{ fontSize: 12, color: "var(--text-3)" }}>
            WAV · FLAC · MP3 · OGG · M4A · MP4 · MKV — up to 30 minutes
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn primary"><Ic.plus width="14" height="14" /> Choose file</button>
          <button className="btn">From Library</button>
          <button className="btn">Paste URL</button>
        </div>
        <div className="row" style={{ gap: 8, marginTop: 4 }}>
          <span className="kbd">⌘O</span><span className="dim" style={{ fontSize: 11 }}>open</span>
          <span className="kbd" style={{ marginLeft: 12 }}>Space</span><span className="dim" style={{ fontSize: 11 }}>preview</span>
        </div>
      </div>
    </div>
  );
}

// ── Working canvas: dual-track + transport + queue ───────────
function ExtractCanvas({ progress, stage }) {
  const dur = 218; // seconds
  const cur = dur * progress;
  const fmt = (s) => {
    const m = Math.floor(s / 60).toString().padStart(2, "0");
    const sec = Math.floor(s % 60).toString().padStart(2, "0");
    const ms = Math.floor((s % 1) * 100).toString().padStart(2, "0");
    return `${m}:${sec}.${ms}`;
  };
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: 20, gap: 16, minHeight: 0, overflow: "auto" }}>

      {/* Now-playing card */}
      <div className="card" style={{ overflow: "hidden" }}>
        <div className="card-h">
          <h3>Yoasobi — Idol (TV size).flac</h3>
          <span className="chip mono" style={{ marginLeft: 8 }}>03:38</span>
          <span className="chip mono">44.1 kHz</span>
          <span className="chip mono">stereo</span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button className="btn ghost"><Ic.folder width="13" height="13" /> Reveal</button>
            <button className="btn ghost"><Ic.more width="14" height="14" /></button>
          </div>
        </div>

        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          <Track label="VOCALS" seed={3} progress={progress} stage={stage} role="vocals" />
          <Track label="INSTRUMENTAL" seed={11} progress={progress} stage={stage} role="instr" />

          {/* Transport */}
          <div style={{
            display: "flex", alignItems: "center", gap: 12,
            paddingTop: 6,
          }}>
            <div className="row" style={{ gap: 4 }}>
              <button className="btn ghost icon" title="Step back"><Ic.stepBack width="14" height="14" /></button>
              <button className="btn primary icon" style={{ padding: "8px 10px" }} title="Play">
                {stage === "processing" ? <Ic.pause width="14" height="14" /> : <Ic.play width="14" height="14" />}
              </button>
              <button className="btn ghost icon" title="Step forward"><Ic.step width="14" height="14" /></button>
            </div>
            <div className="row mono" style={{ gap: 8, color: "var(--text-2)", fontSize: 12 }}>
              <span style={{ color: "var(--text-0)" }}>{fmt(cur)}</span>
              <span className="dim">/</span>
              <span>{fmt(dur)}</span>
            </div>
            <div style={{ flex: 1 }} />
            <div className="row" style={{ gap: 8 }}>
              <span className="chip mono">A · vocals 0 dB</span>
              <span className="chip mono">B · instr -3 dB</span>
              <button className="btn ghost icon" title="Solo A">SOLO</button>
              <button className="btn ghost icon" title="Mute">MUTE</button>
            </div>
          </div>
        </div>
      </div>

      {/* Queue / progress */}
      <div className="card">
        <div className="card-h">
          <h3>Queue</h3>
          <span className="muted" style={{ fontSize: 11 }}>1 active · 2 pending</span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button className="btn ghost">Pause queue</button>
            <button className="btn ghost"><Ic.plus width="13" height="13" /> Add</button>
          </div>
        </div>
        <QueueRow
          name="Yoasobi — Idol (TV size).flac"
          status={stage === "complete" ? "done" : "processing"}
          progress={progress}
          eta={stage === "complete" ? "Saved" : "00:42 left"}
          model="Kim Vocal 2"
        />
        <QueueRow
          name="Lilas Ikuta — Wandering.wav"
          status="queued"
          progress={0}
          eta="queued"
          model="Kim Vocal 2"
        />
        <QueueRow
          name="Aimer — Zankyosanka.mp3"
          status="queued"
          progress={0}
          eta="queued"
          model="HTDemucs (4-stem)"
        />
      </div>

      {stage === "complete" && (
        <div className="card" style={{
          borderColor: "oklch(0.82 0.16 150 / 0.4)",
          background: "linear-gradient(180deg, var(--good-soft), transparent)",
        }}>
          <div style={{ padding: 16, display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 10,
              background: "var(--good-soft)", color: "var(--good)",
              display: "grid", placeItems: "center",
            }}>
              <Ic.check width="18" height="18" />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, color: "var(--text-0)", fontWeight: 600 }}>Extraction complete</div>
              <div className="mono" style={{ fontSize: 11, color: "var(--text-3)", marginTop: 2 }}>
                vocals.flac · instrumental.flac — 76.4 MB · 1m 12s · D:\amv\stems\Idol\
              </div>
            </div>
            <button className="btn">Reveal in folder</button>
            <button className="btn primary">Extract another <Ic.arrowRight width="13" height="13" /></button>
          </div>
        </div>
      )}
    </div>
  );
}

function Track({ label, seed, progress, stage, role }) {
  return (
    <div className="track" style={{ height: 88 }}>
      <div className="label" style={{ color: role === "vocals" ? "var(--accent)" : "var(--text-2)" }}>{label}</div>
      <div className="meta">{role === "vocals" ? "44.1k · -2.4 dB peak" : "44.1k · -1.1 dB peak"}</div>
      <div style={{ position: "absolute", inset: "20px 8px 8px 8px" }}>
        <Waveform
          seed={seed}
          color={role === "vocals" ? "oklch(0.78 0.13 200 / 0.7)" : "var(--text-3)"}
          active={progress * 220}
          total={220}
          height={56}
        />
        {/* playhead */}
        <div style={{
          position: "absolute", top: -4, bottom: -4,
          left: `${progress * 100}%`,
          width: 1.5,
          background: "var(--accent)",
          boxShadow: "0 0 6px var(--accent)",
        }}>
          <div style={{
            position: "absolute", top: -4, left: -4,
            width: 9, height: 9, background: "var(--accent)",
            transform: "rotate(45deg)",
          }} />
        </div>
        {/* shimmer when processing */}
        {stage === "processing" && (
          <div style={{
            position: "absolute", top: 0, bottom: 0,
            left: `${progress * 100}%`, right: 0,
            background: "linear-gradient(90deg, oklch(0.16 0.01 255 / 0.65), oklch(0.16 0.01 255 / 0.85))",
          }} />
        )}
      </div>
    </div>
  );
}

function QueueRow({ name, status, progress, eta, model }) {
  const statusEl = {
    processing: <span className="chip warn" style={{ minWidth: 90, justifyContent: "center" }}><span className="dot pulse" /> Extracting</span>,
    queued: <span className="chip" style={{ minWidth: 90, justifyContent: "center" }}>Queued</span>,
    done: <span className="chip good" style={{ minWidth: 90, justifyContent: "center" }}><Ic.check width="11" height="11" /> Done</span>,
  }[status];

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "20px 1fr 110px 120px 90px 28px",
      alignItems: "center", gap: 12,
      padding: "10px 14px",
      borderTop: "1px solid var(--line-1)",
    }}>
      <div style={{ color: "var(--text-3)" }}><Ic.music width="14" height="14" /></div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, color: "var(--text-1)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</div>
        <div style={{ height: 3, background: "var(--bg-3)", marginTop: 6, borderRadius: 2, overflow: "hidden" }}>
          <div style={{
            height: "100%",
            width: `${(status === "done" ? 1 : status === "queued" ? 0 : progress) * 100}%`,
            background: status === "done" ? "var(--good)" : "var(--accent)",
            transition: "width 0.3s",
          }} />
        </div>
      </div>
      <div className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>{model}</div>
      <div>{statusEl}</div>
      <div className="mono" style={{ fontSize: 11, color: "var(--text-3)", textAlign: "right" }}>{eta}</div>
      <button className="btn ghost icon"><Ic.more width="14" height="14" /></button>
    </div>
  );
}

function HistoryView() {
  const rows = [
    { name: "Yoasobi — Idol (TV size).flac", date: "2026-04-12 21:09", model: "Kim Vocal 2", dur: "1m 12s", size: "76 MB" },
    { name: "Aimer — Zankyosanka.wav", date: "2026-04-11 18:42", model: "Kim Vocal 2", dur: "1m 04s", size: "82 MB" },
    { name: "Lilas Ikuta — Wandering.wav", date: "2026-04-09 14:05", model: "HTDemucs", dur: "2m 48s", size: "164 MB" },
    { name: "Eve — Kaikai Kitan.mp3", date: "2026-04-08 09:22", model: "UVR-MDX-NET", dur: "0m 58s", size: "48 MB" },
    { name: "Mrs. Green Apple — Inferno.flac", date: "2026-04-06 23:14", model: "Kim Vocal 2", dur: "1m 22s", size: "94 MB" },
    { name: "Radwimps — Sparkle.flac", date: "2026-04-04 11:02", model: "Mel-RoFormer", dur: "3m 41s", size: "121 MB" },
  ];
  return (
    <div style={{ flex: 1, padding: 20, overflow: "auto" }}>
      <div className="card">
        <div className="card-h">
          <h3>Recent extractions</h3>
          <span className="muted" style={{ fontSize: 11 }}>{rows.length} jobs</span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <div className="row" style={{
              padding: "5px 10px", border: "1px solid var(--line-1)", borderRadius: 4,
              background: "var(--bg-0)", gap: 8, color: "var(--text-3)",
            }}>
              <Ic.search width="13" height="13" />
              <input className="input" style={{ border: 0, background: "transparent", padding: 0, width: 180 }} placeholder="Search history…" />
            </div>
            <button className="btn ghost"><Ic.filter width="13" height="13" /> Filter</button>
          </div>
        </div>
        <div style={{
          display: "grid", gridTemplateColumns: "16px 1fr 130px 110px 80px 80px 28px",
          gap: 12, padding: "8px 14px",
          fontSize: 10, fontWeight: 600, letterSpacing: "0.12em", textTransform: "uppercase",
          color: "var(--text-4)", borderBottom: "1px solid var(--line-1)",
        }}>
          <span /><span>File</span><span>Date</span><span>Model</span><span>Time</span><span style={{ textAlign: "right" }}>Size</span><span />
        </div>
        {rows.map((r, i) => (
          <div key={i} style={{
            display: "grid", gridTemplateColumns: "16px 1fr 130px 110px 80px 80px 28px",
            gap: 12, padding: "10px 14px", alignItems: "center",
            borderBottom: i === rows.length - 1 ? 0 : "1px solid var(--line-1)",
          }}>
            <Ic.music width="14" height="14" style={{ color: "var(--text-3)" }} />
            <span style={{ fontSize: 12, color: "var(--text-1)" }}>{r.name}</span>
            <span className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>{r.date}</span>
            <span className="mono" style={{ fontSize: 11, color: "var(--text-2)" }}>{r.model}</span>
            <span className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>{r.dur}</span>
            <span className="mono" style={{ fontSize: 11, color: "var(--text-3)", textAlign: "right" }}>{r.size}</span>
            <button className="btn ghost icon"><Ic.more width="14" height="14" /></button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ModelsView() {
  const models = [
    { name: "Kim Vocal 2", arch: "MDX-Net", size: "67 MB", best: "Vocals", status: "installed", note: "Default" },
    { name: "UVR-MDX-NET Voc FT", arch: "MDX-Net", size: "63 MB", best: "Vocals (clean)", status: "installed" },
    { name: "HTDemucs v4", arch: "Hybrid Demucs", size: "320 MB", best: "4-stem", status: "installed" },
    { name: "Mel-RoFormer", arch: "RoFormer", size: "514 MB", best: "Highest quality", status: "available" },
    { name: "BS-RoFormer", arch: "RoFormer", size: "488 MB", best: "Vocals (slow)", status: "available" },
  ];
  return (
    <div style={{ flex: 1, padding: 20, overflow: "auto" }}>
      <div className="card">
        <div className="card-h">
          <h3>Model library</h3>
          <span className="muted" style={{ fontSize: 11 }}>3 installed · 2 available</span>
          <div style={{ marginLeft: "auto" }}>
            <button className="btn"><Ic.plus width="13" height="13" /> Import .ckpt</button>
          </div>
        </div>
        {models.map((m, i) => (
          <div key={i} style={{
            display: "grid", gridTemplateColumns: "1fr 140px 80px 140px 110px",
            gap: 12, padding: "12px 14px", alignItems: "center",
            borderTop: "1px solid var(--line-1)",
          }}>
            <div>
              <div style={{ fontSize: 13, color: "var(--text-0)", fontWeight: 500 }}>
                {m.name} {m.note && <span className="chip accent" style={{ marginLeft: 8 }}>{m.note}</span>}
              </div>
              <div className="mono" style={{ fontSize: 10, color: "var(--text-3)", marginTop: 2 }}>{m.best}</div>
            </div>
            <span className="mono" style={{ fontSize: 11, color: "var(--text-2)" }}>{m.arch}</span>
            <span className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>{m.size}</span>
            <span>
              {m.status === "installed"
                ? <span className="chip good"><Ic.check width="11" height="11" /> Installed</span>
                : <span className="chip"><Ic.download width="11" height="11" /> Available</span>}
            </span>
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
              {m.status === "installed"
                ? <button className="btn ghost">Use</button>
                : <button className="btn primary">Download</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

Object.assign(window, { VocalExtraction });
