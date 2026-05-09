/* global React, Ic, Waveform, CoverPlaceholder */
const { useState: useStateOther } = React;

// ── Clip Hunting ─────────────────────────────────────────
function ClipHunting() {
  const [tab, setTab] = useStateOther("scenes");
  const scenes = Array.from({ length: 24 }, (_, i) => ({
    id: i,
    inT: `00:${String(Math.floor(i * 47 / 60)).padStart(2, "0")}:${String((i * 47) % 60).padStart(2, "0")}.${String((i * 13) % 100).padStart(2, "0")}`,
    dur: `${(2 + (i % 6) * 0.4).toFixed(1)}s`,
    score: 0.6 + ((i * 13) % 40) / 100,
    flagged: [3, 7, 12, 18].includes(i),
  }));

  return (
    <div className="workspace">
      <div className="ws-header">
        <div className="ws-title">
          <h1>Clip Hunting</h1>
          <span className="sub">Auto-detect scene boundaries and surface clip-worthy moments.</span>
        </div>
        <div className="ws-tabs" style={{ marginLeft: 24 }}>
          <button className={"ws-tab" + (tab === "scenes" ? " active" : "")} onClick={() => setTab("scenes")}>Scenes</button>
          <button className={"ws-tab" + (tab === "review" ? " active" : "")} onClick={() => setTab("review")}>Review</button>
          <button className={"ws-tab" + (tab === "history" ? " active" : "")} onClick={() => setTab("history")}>History</button>
        </div>
        <div className="ws-actions">
          <span className="chip"><Ic.cpu width="11" height="11" /> CUDA</span>
          <span className="chip accent"><span className="dot" /> Hist + Flow (accurate)</span>
          <button className="btn">Re-detect</button>
          <button className="btn primary"><Ic.scissors width="13" height="13" /> Export selected</button>
        </div>
      </div>

      <div className="ws-body">
        <div className="ws-canvas" style={{ background: "var(--bg-0)", display: "flex", flexDirection: "column" }}>
          {/* Source preview / timeline */}
          <div style={{ padding: 20, borderBottom: "1px solid var(--line-1)", display: "flex", gap: 16 }}>
            <div style={{
              width: 280, aspectRatio: "16/9",
              background: `
                repeating-linear-gradient(135deg, oklch(0.22 0.04 280) 0 14px, oklch(0.18 0.04 280) 14px 28px),
                oklch(0.18 0.04 280)`,
              borderRadius: 6, border: "1px solid var(--line-1)",
              position: "relative", overflow: "hidden", flex: "0 0 280px",
            }}>
              <div style={{
                position: "absolute", inset: 0,
                background: "linear-gradient(to top, oklch(0.1 0.01 250 / 0.85) 0%, transparent 50%)",
              }} />
              <div style={{
                position: "absolute", left: 12, bottom: 12, fontSize: 11, color: "var(--text-1)",
              }}>
                <div style={{ fontWeight: 600 }}>Spy × Family</div>
                <div className="mono dim" style={{ fontSize: 10 }}>S02E07 · 1080p · 23m41s</div>
              </div>
              <button className="btn primary" style={{
                position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)",
                padding: "10px 14px",
              }}>
                <Ic.play width="13" height="13" /> Preview
              </button>
            </div>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
              <div className="row" style={{ gap: 10 }}>
                <h2 style={{ margin: 0, fontSize: 15, color: "var(--text-0)", fontWeight: 600 }}>S02E07 — A Dance with Dogs</h2>
                <span className="chip mono">23:41</span>
                <span className="chip mono">1080p</span>
                <span className="chip good"><Ic.check width="11" height="11" /> 247 scenes</span>
              </div>
              {/* timeline */}
              <div style={{
                position: "relative", height: 56,
                background: "var(--bg-1)", border: "1px solid var(--line-1)", borderRadius: 4,
                overflow: "hidden",
              }}>
                {/* scene density */}
                {Array.from({ length: 247 }, (_, i) => {
                  const x = (i / 247) * 100;
                  const h = 30 + ((i * 13) % 60);
                  return (
                    <div key={i} style={{
                      position: "absolute", left: `${x}%`, bottom: 0,
                      width: 0.5, height: `${h}%`,
                      background: i % 11 === 0 ? "var(--accent)" : "var(--text-4)",
                      opacity: i % 11 === 0 ? 0.9 : 0.4,
                    }} />
                  );
                })}
                {/* selected range */}
                <div style={{
                  position: "absolute", left: "32%", top: 0, bottom: 0, width: "18%",
                  background: "var(--accent-soft)",
                  borderLeft: "1.5px solid var(--accent)",
                  borderRight: "1.5px solid var(--accent)",
                }} />
                {/* time labels */}
                <div className="mono" style={{
                  position: "absolute", inset: "auto 0 4px 0",
                  display: "flex", justifyContent: "space-between",
                  padding: "0 8px", fontSize: 9, color: "var(--text-4)",
                }}>
                  <span>00:00</span><span>05:00</span><span>10:00</span><span>15:00</span><span>20:00</span><span>23:41</span>
                </div>
              </div>
              <div className="row" style={{ gap: 8 }}>
                <span className="chip mono">selected 12 scenes</span>
                <span className="chip mono">est. 38.4s</span>
                <div style={{ flex: 1 }} />
                <button className="btn ghost"><Ic.filter width="13" height="13" /> Filter</button>
                <div className="seg" style={{ width: 140 }}>
                  <button className="active">Grid</button>
                  <button>List</button>
                </div>
              </div>
            </div>
          </div>

          {/* scene grid */}
          <div style={{
            flex: 1, overflow: "auto", padding: 20,
            display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
            gap: 14,
          }}>
            {scenes.map((s) => (
              <SceneCard key={s.id} {...s} />
            ))}
          </div>
        </div>

        <aside className="inspector">
          <div className="insp-section">
            <h4>Detection</h4>
            <div className="field">
              <label>Algorithm</label>
              <select className="select" defaultValue="hist">
                <option value="hist">Histogram + Optical Flow</option>
                <option value="content">PySceneDetect (content)</option>
                <option value="adaptive">Adaptive (fast)</option>
                <option value="ml">ML transition detector (slow)</option>
              </select>
            </div>
            <div className="field">
              <label>Sensitivity <span className="hint">0.42</span></label>
              <input className="slider" type="range" min="0" max="100" defaultValue="42" />
            </div>
            <div className="field">
              <label>Min duration <span className="hint">0.8 s</span></label>
              <input className="slider" type="range" min="0" max="100" defaultValue="20" />
            </div>
            <div className="field">
              <label>Max duration <span className="hint">8.0 s</span></label>
              <input className="slider" type="range" min="0" max="100" defaultValue="60" />
            </div>
          </div>

          <div className="insp-section">
            <h4>Filters</h4>
            <div className="field">
              <label>Skip credits & OP/ED</label>
              <span className="toggle on" style={{ alignSelf: "flex-start" }} />
            </div>
            <div className="field">
              <label>Skip text-heavy frames</label>
              <span className="toggle on" style={{ alignSelf: "flex-start" }} />
            </div>
            <div className="field">
              <label>Action score min <span className="hint">0.55</span></label>
              <input className="slider" type="range" min="0" max="100" defaultValue="55" />
            </div>
          </div>

          <div className="insp-section" style={{ borderBottom: 0 }}>
            <h4>Export</h4>
            <div className="field">
              <label>Format</label>
              <div className="seg">
                <button className="active">MP4</button>
                <button>MOV</button>
                <button>PNG seq</button>
              </div>
            </div>
            <div className="field">
              <label>Codec</label>
              <select className="select" defaultValue="prores">
                <option value="prores">ProRes 422 LT</option>
                <option value="dnx">DNxHR LB</option>
                <option value="h264">H.264 (CRF 18)</option>
              </select>
            </div>
            <div className="field">
              <label>Naming</label>
              <input className="input" defaultValue="{show}_{episode}_scene_{index}.mp4" />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function SceneCard({ id, inT, dur, score, flagged }) {
  const hue = (id * 31) % 360;
  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 6,
      cursor: "pointer",
    }}>
      <div style={{
        position: "relative", aspectRatio: "16/9",
        borderRadius: 4, overflow: "hidden",
        border: flagged ? "1px solid var(--accent-line)" : "1px solid var(--line-1)",
        background: `
          repeating-linear-gradient(${(id * 47) % 180}deg,
            oklch(0.3 0.04 ${hue}) 0 8px,
            oklch(0.22 0.04 ${hue}) 8px 16px)`,
      }}>
        <div style={{
          position: "absolute", inset: 0,
          background: "linear-gradient(to top, oklch(0.1 0.01 250 / 0.7) 0%, transparent 60%)",
        }} />
        {flagged && (
          <div style={{
            position: "absolute", top: 6, left: 6,
            padding: "1px 6px", borderRadius: 3,
            background: "var(--accent)", color: "var(--accent-text)",
            fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase",
          }}>Pick</div>
        )}
        <div style={{
          position: "absolute", top: 6, right: 6,
          fontSize: 9, fontFamily: "var(--font-mono)",
          color: "var(--text-1)", background: "oklch(0.1 0 0 / 0.6)",
          padding: "1px 5px", borderRadius: 3,
        }}>{dur}</div>
        <div style={{
          position: "absolute", bottom: 6, left: 6, right: 6,
          display: "flex", justifyContent: "space-between", alignItems: "end",
          fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--text-2)",
        }}>
          <span>#{String(id + 1).padStart(3, "0")}</span>
          <span>{inT}</span>
        </div>
      </div>
      <div className="row" style={{ gap: 6, justifyContent: "space-between" }}>
        <span className="mono" style={{ fontSize: 10, color: "var(--text-3)" }}>action {score.toFixed(2)}</span>
        <div style={{ display: "flex", gap: 4 }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} style={{
              width: 4, height: 8,
              background: i < Math.round(score * 5) ? "var(--accent)" : "var(--bg-3)",
              borderRadius: 1,
            }} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Audio Conversion ─────────────────────────────────────
function AudioConversion() {
  const queue = [
    { name: "Idol_vocals.wav", from: "WAV 24-bit", to: "FLAC 16-bit", status: "done", progress: 1 },
    { name: "Inferno_inst.wav", from: "WAV 24-bit", to: "MP3 320k", status: "active", progress: 0.62 },
    { name: "Sparkle_full.flac", from: "FLAC 24-bit", to: "OGG q8", status: "queued", progress: 0 },
    { name: "Wandering_vox.flac", from: "FLAC 16-bit", to: "MP3 V0", status: "queued", progress: 0 },
  ];
  return (
    <div className="workspace">
      <div className="ws-header">
        <div className="ws-title">
          <h1>Audio Conversion</h1>
          <span className="sub">Batch convert audio between codecs, sample rates, and bit-depths.</span>
        </div>
        <div className="ws-actions">
          <span className="chip mono">4 files · 1.2 GB</span>
          <button className="btn"><Ic.plus width="13" height="13" /> Add files</button>
          <button className="btn primary"><Ic.play width="13" height="13" /> Start batch</button>
        </div>
      </div>

      <div className="ws-body">
        <div className="ws-canvas" style={{ background: "var(--bg-0)", padding: 20, gap: 16, display: "flex", flexDirection: "column", overflow: "auto" }}>
          <div className="card">
            <div className="card-h">
              <h3>Batch queue</h3>
              <span className="muted" style={{ fontSize: 11 }}>1 active · 2 queued · 1 done</span>
              <div style={{ marginLeft: "auto" }}>
                <button className="btn ghost">Clear done</button>
              </div>
            </div>
            {queue.map((q, i) => (
              <div key={i} style={{
                display: "grid",
                gridTemplateColumns: "20px 1fr 100px 24px 100px 90px 28px",
                alignItems: "center", gap: 12,
                padding: "12px 14px",
                borderTop: "1px solid var(--line-1)",
              }}>
                <Ic.music width="14" height="14" style={{ color: "var(--text-3)" }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: "var(--text-1)" }}>{q.name}</div>
                  <div style={{ height: 3, background: "var(--bg-3)", marginTop: 6, borderRadius: 2, overflow: "hidden" }}>
                    <div style={{
                      height: "100%", width: `${q.progress * 100}%`,
                      background: q.status === "done" ? "var(--good)" : "var(--accent)",
                    }} />
                  </div>
                </div>
                <span className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>{q.from}</span>
                <span style={{ color: "var(--text-4)", textAlign: "center" }}><Ic.arrowRight width="12" height="12" /></span>
                <span className="mono" style={{ fontSize: 11, color: "var(--accent)" }}>{q.to}</span>
                {q.status === "done" && <span className="chip good"><Ic.check width="11" height="11" /> Done</span>}
                {q.status === "active" && <span className="chip warn"><span className="dot pulse" /> 4.1×</span>}
                {q.status === "queued" && <span className="chip">Queued</span>}
                <button className="btn ghost icon"><Ic.more width="14" height="14" /></button>
              </div>
            ))}
          </div>

          <div className="card">
            <div className="card-h">
              <h3>Drop more files</h3>
            </div>
            <div className="dropzone" style={{ margin: 14, padding: 26 }}>
              <Ic.music width="22" height="22" style={{ color: "var(--accent)" }} />
              <div className="muted" style={{ fontSize: 12 }}>Drop audio files or folders here, or paste URLs</div>
              <button className="btn">Choose files…</button>
            </div>
          </div>
        </div>

        <aside className="inspector">
          <div className="insp-section">
            <h4>Output preset</h4>
            <div className="field">
              <label>Codec</label>
              <div className="seg">
                <button>WAV</button>
                <button>FLAC</button>
                <button className="active">MP3</button>
                <button>OGG</button>
                <button>OPUS</button>
              </div>
            </div>
            <div className="field">
              <label>Bitrate / Quality</label>
              <select className="select" defaultValue="320">
                <option value="v0">V0 (VBR)</option>
                <option value="320">320 kbps CBR</option>
                <option value="256">256 kbps CBR</option>
                <option value="192">192 kbps CBR</option>
              </select>
            </div>
            <div className="field">
              <label>Sample rate</label>
              <select className="select" defaultValue="44">
                <option>Match source</option>
                <option value="44">44.1 kHz</option>
                <option value="48">48 kHz</option>
                <option value="96">96 kHz</option>
              </select>
            </div>
            <div className="field">
              <label>Channels</label>
              <div className="seg">
                <button>Mono</button>
                <button className="active">Stereo</button>
                <button>5.1</button>
              </div>
            </div>
          </div>

          <div className="insp-section">
            <h4>Processing</h4>
            <div className="field">
              <label>Normalize <span className="hint">-14 LUFS</span></label>
              <span className="toggle on" style={{ alignSelf: "flex-start" }} />
            </div>
            <div className="field">
              <label>Trim silence <span className="hint">200 ms</span></label>
              <span className="toggle" style={{ alignSelf: "flex-start" }} />
            </div>
            <div className="field">
              <label>Embed cover art</label>
              <span className="toggle on" style={{ alignSelf: "flex-start" }} />
            </div>
          </div>

          <div className="insp-section" style={{ borderBottom: 0 }}>
            <h4>Output folder</h4>
            <div className="field">
              <input className="input mono" style={{ fontSize: 11 }} defaultValue="D:\amv\converted\" />
            </div>
            <div className="field">
              <label>Filename template</label>
              <input className="input mono" style={{ fontSize: 11 }} defaultValue="{stem}_{codec}.{ext}" />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

// ── Video Conversion ─────────────────────────────────────
function VideoConversion() {
  return (
    <div className="workspace">
      <div className="ws-header">
        <div className="ws-title">
          <h1>Video Conversion</h1>
          <span className="sub">Transcode, trim, and prepare clips for your editor of choice.</span>
        </div>
        <div className="ws-actions">
          <span className="chip"><Ic.cpu width="11" height="11" /> NVENC</span>
          <span className="chip mono">2 files</span>
          <button className="btn"><Ic.plus width="13" height="13" /> Add</button>
          <button className="btn primary"><Ic.play width="13" height="13" /> Render</button>
        </div>
      </div>
      <div className="ws-body">
        <div className="ws-canvas" style={{ background: "var(--bg-0)", padding: 20, gap: 16, display: "flex", flexDirection: "column", overflow: "auto" }}>
          <div className="card">
            <div className="card-h">
              <h3>Render queue</h3>
              <span className="muted" style={{ fontSize: 11 }}>1 active</span>
            </div>
            <div style={{ padding: 14, display: "grid", gridTemplateColumns: "180px 1fr 1fr", gap: 16 }}>
              <div style={{
                aspectRatio: "16/9",
                background: `repeating-linear-gradient(135deg, oklch(0.28 0.05 200) 0 12px, oklch(0.22 0.05 200) 12px 24px)`,
                borderRadius: 4, position: "relative",
              }}>
                <div style={{ position: "absolute", inset: 0, background: "linear-gradient(to top, oklch(0.1 0 0 / 0.7), transparent 60%)" }} />
                <div className="mono" style={{ position: "absolute", left: 8, bottom: 6, fontSize: 10, color: "var(--text-1)" }}>scene_004.mp4</div>
              </div>
              <div className="col" style={{ gap: 8 }}>
                <div style={{ fontSize: 13, color: "var(--text-0)", fontWeight: 600 }}>scene_004.mp4 → ProRes 422 LT</div>
                <div className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>1920×1080 → 1920×1080 · 23.976 fps · 2.4 GB est.</div>
                <div className="processing-bar" style={{ marginTop: 4 }} />
                <div className="row mono" style={{ fontSize: 11, color: "var(--text-3)", justifyContent: "space-between", marginTop: 4 }}>
                  <span>frame 4,221 / 14,802</span>
                  <span>28.5%</span>
                  <span>14.2 fps · ETA 02:47</span>
                </div>
              </div>
              <div className="col" style={{ gap: 6 }}>
                <div className="mono" style={{ fontSize: 10, color: "var(--text-4)", textTransform: "uppercase", letterSpacing: "0.12em" }}>NVENC encode</div>
                {[
                  ["GPU", 78], ["VRAM", 62], ["Disk write", 24], ["Encoder", 91],
                ].map(([l, v]) => (
                  <div key={l} className="row" style={{ gap: 8 }}>
                    <span className="mono" style={{ width: 70, fontSize: 10, color: "var(--text-3)" }}>{l}</span>
                    <span style={{ flex: 1, height: 4, background: "var(--bg-3)", borderRadius: 2, overflow: "hidden" }}>
                      <span style={{ display: "block", height: "100%", width: `${v}%`, background: v > 80 ? "var(--warn)" : "var(--accent)" }} />
                    </span>
                    <span className="mono" style={{ width: 28, textAlign: "right", fontSize: 10, color: "var(--text-2)" }}>{v}%</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
        <aside className="inspector">
          <div className="insp-section">
            <h4>Preset</h4>
            <div className="field">
              <select className="select" defaultValue="prores">
                <option value="prores">ProRes 422 LT (editor-ready)</option>
                <option value="dnx">DNxHR LB</option>
                <option value="h264">H.264 — high quality</option>
                <option value="h265">H.265 NVENC</option>
              </select>
            </div>
            <div className="field">
              <label>Resolution</label>
              <div className="seg">
                <button>Source</button>
                <button className="active">1080p</button>
                <button>1440p</button>
                <button>4K</button>
              </div>
            </div>
            <div className="field">
              <label>Frame rate</label>
              <div className="seg">
                <button>Source</button>
                <button className="active">23.976</button>
                <button>24</button>
                <button>30</button>
                <button>60</button>
              </div>
            </div>
          </div>
          <div className="insp-section">
            <h4>Color</h4>
            <div className="field">
              <label>Color space</label>
              <select className="select" defaultValue="rec709">
                <option value="rec709">Rec.709</option>
                <option value="rec2020">Rec.2020</option>
                <option value="srgb">sRGB</option>
              </select>
            </div>
            <div className="field">
              <label>Tonemap HDR → SDR</label>
              <span className="toggle on" style={{ alignSelf: "flex-start" }} />
            </div>
          </div>
          <div className="insp-section" style={{ borderBottom: 0 }}>
            <h4>Trim & frame</h4>
            <div className="field">
              <label>In point</label>
              <input className="input mono" defaultValue="00:00:00.000" />
            </div>
            <div className="field">
              <label>Out point</label>
              <input className="input mono" defaultValue="00:00:03.420" />
            </div>
            <div className="field">
              <label>Loop seamless</label>
              <span className="toggle" style={{ alignSelf: "flex-start" }} />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

// ── Library / Browse ─────────────────────────────────────
function Library() {
  const titles = [
    "Frieren: Beyond Journey's End", "Spy × Family", "Jujutsu Kaisen", "Vinland Saga",
    "Bocchi the Rock!", "Chainsaw Man", "Mob Psycho 100", "Cyberpunk: Edgerunners",
    "Demon Slayer", "Made in Abyss", "Violet Evergarden", "86 — Eighty Six",
    "Oshi no Ko", "Kaiju No. 8", "Solo Leveling", "Apothecary Diaries",
  ];
  return (
    <div className="workspace">
      <div className="ws-header">
        <div className="ws-title">
          <h1>Library</h1>
          <span className="sub">Browse, queue and download episodes — all from inside the app.</span>
        </div>
        <div className="ws-actions">
          <div className="row" style={{
            padding: "5px 10px", border: "1px solid var(--line-1)", borderRadius: 4,
            background: "var(--bg-1)", gap: 8, color: "var(--text-3)", width: 280,
          }}>
            <Ic.search width="13" height="13" />
            <input className="input" style={{ border: 0, background: "transparent", padding: 0 }} placeholder="Search 12,000+ titles…" />
            <span className="kbd">⌘F</span>
          </div>
          <button className="btn ghost"><Ic.filter width="13" height="13" /> Genre</button>
          <button className="btn ghost"><Ic.filter width="13" height="13" /> Year</button>
        </div>
      </div>
      <div className="ws-body" style={{ gridTemplateColumns: "1fr" }}>
        <div className="ws-canvas" style={{ background: "var(--bg-0)" }}>
          {/* row tabs */}
          <div style={{
            padding: "12px 22px", borderBottom: "1px solid var(--line-1)",
            display: "flex", gap: 18,
          }}>
            {["All", "Recently watched", "On your watchlist", "Trending", "Seasonal", "Shorts"].map((t, i) => (
              <button key={t} style={{
                fontSize: 12, color: i === 0 ? "var(--text-0)" : "var(--text-3)",
                fontWeight: i === 0 ? 600 : 400,
                paddingBottom: 4,
                borderBottom: i === 0 ? "1.5px solid var(--accent)" : "1.5px solid transparent",
              }}>{t}</button>
            ))}
          </div>
          <div className="lib-grid">
            {titles.map((t, i) => (
              <div key={i} className="lib-card">
                <CoverPlaceholder seed={i + 5} label={t} ep={`${12 + (i % 12)} ep`} />
                <div>
                  <div className="lib-title">{t}</div>
                  <div className="lib-meta">{2020 + (i % 6)} · {["Action", "Drama", "Slice of Life", "Sci-fi", "Fantasy"][i % 5]}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Downloads() {
  const items = [
    { name: "Frieren S01E12 — The Land Where Souls Rest", status: "active", progress: 0.47, size: "1.4 GB", speed: "12.4 MB/s" },
    { name: "Spy × Family S02E07 — A Dance with Dogs", status: "active", progress: 0.82, size: "1.1 GB", speed: "8.9 MB/s" },
    { name: "Bocchi the Rock! S01E08", status: "queued", progress: 0, size: "—", speed: "—" },
    { name: "Vinland Saga S02E22", status: "done", progress: 1, size: "1.6 GB", speed: "saved" },
    { name: "Cyberpunk: Edgerunners E04", status: "done", progress: 1, size: "1.3 GB", speed: "saved" },
  ];
  return (
    <div className="workspace">
      <div className="ws-header">
        <div className="ws-title">
          <h1>Downloads</h1>
          <span className="sub">Episodes pulled to disk, ready for the workshop.</span>
        </div>
        <div className="ws-actions">
          <span className="chip mono">↓ 21.3 MB/s</span>
          <span className="chip mono">D:\amv\library</span>
          <button className="btn ghost">Pause all</button>
          <button className="btn"><Ic.plus width="13" height="13" /> Add URL</button>
        </div>
      </div>
      <div className="ws-body" style={{ gridTemplateColumns: "1fr" }}>
        <div className="ws-canvas" style={{ background: "var(--bg-0)", padding: 20 }}>
          <div className="card">
            <div className="card-h">
              <h3>Active & recent</h3>
              <span className="muted" style={{ fontSize: 11 }}>{items.length} items</span>
            </div>
            {items.map((it, i) => (
              <div key={i} style={{
                display: "grid",
                gridTemplateColumns: "20px 1fr 110px 110px 100px 28px",
                alignItems: "center", gap: 14,
                padding: "12px 16px",
                borderTop: "1px solid var(--line-1)",
              }}>
                <Ic.film width="14" height="14" style={{ color: "var(--text-3)" }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: "var(--text-1)" }}>{it.name}</div>
                  <div style={{ height: 3, background: "var(--bg-3)", marginTop: 6, borderRadius: 2, overflow: "hidden" }}>
                    <div style={{
                      height: "100%", width: `${it.progress * 100}%`,
                      background: it.status === "done" ? "var(--good)" : "var(--accent)",
                    }} />
                  </div>
                </div>
                <span className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>{it.size}</span>
                <span className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>{it.speed}</span>
                {it.status === "active" && <span className="chip warn"><span className="dot pulse" /> {Math.round(it.progress * 100)}%</span>}
                {it.status === "queued" && <span className="chip">Queued</span>}
                {it.status === "done" && <span className="chip good"><Ic.check width="11" height="11" /> Saved</span>}
                <button className="btn ghost icon"><Ic.more width="14" height="14" /></button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Settings ─────────────────────────────────────────
function Settings() {
  return (
    <div className="workspace">
      <div className="ws-header">
        <div className="ws-title">
          <h1>Settings</h1>
          <span className="sub">Preferences, hardware acceleration, and storage.</span>
        </div>
      </div>
      <div className="ws-body" style={{ gridTemplateColumns: "1fr" }}>
        <div className="ws-canvas" style={{ background: "var(--bg-0)", padding: 22, overflow: "auto" }}>
          <div style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: 24, maxWidth: 900 }}>
            <nav style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {["General", "Hardware", "Storage", "Models", "Sources", "Shortcuts", "About"].map((s, i) => (
                <button key={s} style={{
                  textAlign: "left", padding: "8px 10px", borderRadius: 4,
                  background: i === 1 ? "var(--bg-2)" : "transparent",
                  color: i === 1 ? "var(--text-0)" : "var(--text-3)",
                  fontSize: 12,
                }}>{s}</button>
              ))}
            </nav>
            <div className="col" style={{ gap: 14 }}>
              <h2 style={{ margin: 0, fontSize: 15, color: "var(--text-0)" }}>Hardware acceleration</h2>
              <div className="card">
                <div style={{ padding: 16, borderBottom: "1px solid var(--line-1)" }}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <div>
                      <div style={{ fontSize: 13, color: "var(--text-0)", fontWeight: 600 }}>NVIDIA GeForce RTX 4070</div>
                      <div className="mono" style={{ fontSize: 11, color: "var(--text-3)", marginTop: 4 }}>
                        CUDA 12.4 · 16 GB VRAM · driver 552.22
                      </div>
                    </div>
                    <span className="chip good"><Ic.check width="11" height="11" /> Detected</span>
                  </div>
                </div>
                <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span style={{ fontSize: 12 }}>Use GPU for vocal extraction</span>
                    <span className="toggle on" />
                  </div>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span style={{ fontSize: 12 }}>Use NVENC for video encode</span>
                    <span className="toggle on" />
                  </div>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span style={{ fontSize: 12 }}>Allow GPU during system idle only</span>
                    <span className="toggle" />
                  </div>
                </div>
              </div>
              <div className="card">
                <div className="card-h"><h3>Storage</h3></div>
                <div style={{ padding: 16 }}>
                  <div className="mono" style={{ fontSize: 11, color: "var(--text-3)", marginBottom: 8 }}>D:\amv\ — 412 GB used / 2.0 TB</div>
                  <div style={{ height: 8, background: "var(--bg-3)", borderRadius: 4, overflow: "hidden", display: "flex" }}>
                    <span style={{ width: "32%", background: "var(--accent)" }} />
                    <span style={{ width: "12%", background: "oklch(0.7 0.15 280)" }} />
                    <span style={{ width: "8%", background: "var(--warn)" }} />
                  </div>
                  <div className="row" style={{ gap: 14, marginTop: 10, fontSize: 11, color: "var(--text-3)" }}>
                    <span><span className="dot" style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: "var(--accent)", marginRight: 6 }} />Episodes 264 GB</span>
                    <span><span className="dot" style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: "oklch(0.7 0.15 280)", marginRight: 6 }} />Stems 96 GB</span>
                    <span><span className="dot" style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: "var(--warn)", marginRight: 6 }} />Cache 52 GB</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function LogsView() {
  const lines = [
    ["INFO", "10:32:14.221", "extractor", "loaded model kim_vocal_2.onnx (67.4 MB)"],
    ["INFO", "10:32:14.318", "extractor", "warming up CUDA context on device 0 (RTX 4070)"],
    ["INFO", "10:32:14.701", "extractor", "starting job idol_tv_size.flac (218.4s)"],
    ["DEBUG", "10:32:14.712", "decoder", "ffmpeg pipe 44100/2/s24le ok"],
    ["DEBUG", "10:32:15.022", "extractor", "chunk 0 / 27 done in 244ms"],
    ["WARN", "10:32:18.402", "loudness", "input peaking +0.4 dBTP — clipping risk"],
    ["DEBUG", "10:32:21.110", "extractor", "chunk 12 / 27 done in 218ms"],
    ["INFO", "10:32:38.901", "writer", "wrote vocals.flac (38.1 MB)"],
    ["INFO", "10:32:39.812", "writer", "wrote instrumental.flac (38.3 MB)"],
    ["INFO", "10:32:39.815", "extractor", "job complete in 25.1s (8.7× realtime)"],
  ];
  return (
    <div className="workspace">
      <div className="ws-header">
        <div className="ws-title">
          <h1>Logs</h1>
          <span className="sub">Engine output across every workspace.</span>
        </div>
        <div className="ws-actions">
          <div className="seg" style={{ width: 240 }}>
            <button className="active">All</button>
            <button>Info</button>
            <button>Warn</button>
            <button>Error</button>
          </div>
          <button className="btn ghost">Clear</button>
          <button className="btn ghost">Export</button>
        </div>
      </div>
      <div className="ws-body" style={{ gridTemplateColumns: "1fr" }}>
        <div className="ws-canvas" style={{ background: "var(--bg-0)", padding: 20 }}>
          <div className="card" style={{ overflow: "hidden" }}>
            <div style={{ background: "oklch(0.13 0.01 255)", padding: "10px 0", fontFamily: "var(--font-mono)", fontSize: 11.5, lineHeight: 1.7 }}>
              {lines.map(([lvl, ts, src, msg], i) => (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "60px 110px 110px 1fr", gap: 12, padding: "0 16px" }}>
                  <span style={{
                    color: lvl === "WARN" ? "var(--warn)" : lvl === "ERROR" ? "var(--bad)" : lvl === "DEBUG" ? "var(--text-4)" : "var(--accent)",
                    fontWeight: 600,
                  }}>{lvl}</span>
                  <span style={{ color: "var(--text-4)" }}>{ts}</span>
                  <span style={{ color: "var(--text-3)" }}>[{src}]</span>
                  <span style={{ color: "var(--text-1)" }}>{msg}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ClipHunting, AudioConversion, VideoConversion, Library, Downloads, Settings, LogsView });
