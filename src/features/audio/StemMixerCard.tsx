import React from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import WaveSurfer from "wavesurfer.js";
import { ArrowRight, FolderOpen, Pause, Play } from "lucide-react";

type StemRef = { path: string; url: string };
type Stems = { vocals?: StemRef; music?: StemRef };

function classifyStems(outputs: string[]): Stems {
  const result: Stems = {};
  for (const path of outputs) {
    const lower = path.toLowerCase();
    if (lower.includes("[vocals]")) {
      result.vocals = { path, url: convertFileSrc(path) };
    } else if (lower.includes("[instrumental]")) {
      result.music = { path, url: convertFileSrc(path) };
    }
  }
  return result;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const DRIFT_THRESHOLD_S = 0.1;

export function StemMixerCard({
  outputs,
  fileLabel,
  outputDir,
  onAgain,
}: {
  outputs: string[];
  fileLabel: string;
  outputDir?: string;
  onAgain: () => void;
}) {
  const stems = React.useMemo(() => classifyStems(outputs), [outputs]);
  const vocalContainerRef = React.useRef<HTMLDivElement | null>(null);
  const musicContainerRef = React.useRef<HTMLDivElement | null>(null);
  const vocalWSRef = React.useRef<WaveSurfer | null>(null);
  const musicWSRef = React.useRef<WaveSurfer | null>(null);

  const [isPlaying, setIsPlaying] = React.useState(false);
  const [currentTime, setCurrentTime] = React.useState(0);
  const [duration, setDuration] = React.useState(0);
  const [vocalVolume, setVocalVolume] = React.useState(100);
  const [musicVolume, setMusicVolume] = React.useState(100);
  const [ready, setReady] = React.useState(false);

  const vocalUrl = stems.vocals?.url;
  const musicUrl = stems.music?.url;

  React.useEffect(() => {
    if (!vocalContainerRef.current || !musicContainerRef.current) return;
    if (!vocalUrl || !musicUrl) return;

    setReady(false);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);

    const vocalWS = WaveSurfer.create({
      container: vocalContainerRef.current,
      url: vocalUrl,
      waveColor: "rgba(169, 140, 255, 0.40)",
      progressColor: "#a98cff",
      cursorColor: "rgba(255, 255, 255, 0.65)",
      cursorWidth: 1,
      height: 56,
      barWidth: 2,
      barGap: 1,
      barRadius: 1,
      normalize: true,
      interact: true,
      dragToSeek: true,
    });

    const musicWS = WaveSurfer.create({
      container: musicContainerRef.current,
      url: musicUrl,
      waveColor: "rgba(99, 230, 162, 0.35)",
      progressColor: "#63e6a2",
      cursorColor: "rgba(255, 255, 255, 0.65)",
      cursorWidth: 1,
      height: 56,
      barWidth: 2,
      barGap: 1,
      barRadius: 1,
      normalize: true,
      interact: true,
      dragToSeek: true,
    });

    vocalWSRef.current = vocalWS;
    musicWSRef.current = musicWS;

    let readyCount = 0;
    const onReady = () => {
      readyCount += 1;
      if (readyCount >= 2) {
        setReady(true);
        setDuration(Math.max(vocalWS.getDuration(), musicWS.getDuration()));
      }
    };
    vocalWS.on("ready", onReady);
    musicWS.on("ready", onReady);

    // Master = vocals; mirror time / play / pause / seek onto music.
    vocalWS.on("timeupdate", (t) => {
      setCurrentTime(t);
      const slave = musicWSRef.current;
      if (slave && Math.abs(slave.getCurrentTime() - t) > DRIFT_THRESHOLD_S) {
        slave.setTime(t);
      }
    });
    vocalWS.on("play", () => {
      setIsPlaying(true);
      const slave = musicWSRef.current;
      if (slave && !slave.isPlaying()) void slave.play();
    });
    vocalWS.on("pause", () => {
      setIsPlaying(false);
      musicWSRef.current?.pause();
    });
    vocalWS.on("finish", () => setIsPlaying(false));
    vocalWS.on("interaction", (t) => musicWSRef.current?.setTime(t));
    musicWS.on("interaction", (t) => vocalWSRef.current?.setTime(t));

    return () => {
      vocalWSRef.current = null;
      musicWSRef.current = null;
      try { vocalWS.destroy(); } catch { /* ignore */ }
      try { musicWS.destroy(); } catch { /* ignore */ }
    };
  }, [vocalUrl, musicUrl]);

  React.useEffect(() => {
    vocalWSRef.current?.setVolume(Math.max(0, Math.min(1, vocalVolume / 100)));
  }, [vocalVolume]);

  React.useEffect(() => {
    musicWSRef.current?.setVolume(Math.max(0, Math.min(1, musicVolume / 100)));
  }, [musicVolume]);

  const togglePlay = React.useCallback(() => {
    const ws = vocalWSRef.current;
    if (!ws) return;
    if (ws.isPlaying()) {
      ws.pause();
    } else {
      void ws.play();
    }
  }, []);

  React.useEffect(() => {
    if (!ready) return;
    const handler = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) return;
      }
      event.preventDefault();
      togglePlay();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [ready, togglePlay]);

  if (!stems.vocals || !stems.music) {
    return (
      <section className="audio-card stem-mixer is-fallback">
        <p className="stem-mixer-fallback-msg">Stems are saved but preview is unavailable for this set of files.</p>
        <div className="result-actions">
          {outputDir && (
            <button type="button" className="install-btn is-secondary" onClick={() => invoke("open_path", { path: outputDir })}>
              <FolderOpen size={15} strokeWidth={2.3} />
              <span>Open folder</span>
            </button>
          )}
          <button type="button" className="install-btn is-primary" onClick={onAgain}>
            <ArrowRight size={15} strokeWidth={2.3} />
            <span>Extract another file</span>
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="audio-card stem-mixer" aria-label="Stem mixer">
      <div className="stem-mixer-transport">
        <button
          type="button"
          className="stem-mixer-play"
          onClick={togglePlay}
          disabled={!ready}
          aria-label={isPlaying ? "Pause" : "Play"}
          title={isPlaying ? "Pause (Space)" : "Play (Space)"}
        >
          {isPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
        </button>
        <div className="stem-mixer-time">
          <span>{formatTime(currentTime)}</span>
          <span className="stem-mixer-time-sep">/</span>
          <span>{formatTime(duration)}</span>
        </div>
        <div className="stem-mixer-spacer" />
        <span className="stem-mixer-hint">{ready ? "Space plays/pauses" : "Loading stems..."}</span>
      </div>

      <div className="stem-mixer-tracks">
        <div className="stem-mixer-track">
          <div className="stem-mixer-label">
            <span className="stem-mixer-name is-music">Music</span>
            <input
              type="range"
              min={0}
              max={100}
              value={musicVolume}
              onChange={(event) => setMusicVolume(Number(event.currentTarget.value))}
              className="stem-mixer-volume is-music"
              aria-label="Music volume"
              disabled={!ready}
            />
            <span className="stem-mixer-vol-num">{musicVolume}</span>
          </div>
          <div ref={musicContainerRef} className="stem-mixer-waveform" aria-hidden="true" />
        </div>
        <div className="stem-mixer-track">
          <div className="stem-mixer-label">
            <span className="stem-mixer-name is-vocal">Vocal</span>
            <input
              type="range"
              min={0}
              max={100}
              value={vocalVolume}
              onChange={(event) => setVocalVolume(Number(event.currentTarget.value))}
              className="stem-mixer-volume is-vocal"
              aria-label="Vocal volume"
              disabled={!ready}
            />
            <span className="stem-mixer-vol-num">{vocalVolume}</span>
          </div>
          <div ref={vocalContainerRef} className="stem-mixer-waveform" aria-hidden="true" />
        </div>
      </div>

      <div className="stem-mixer-actions">
        <span className="stem-mixer-filename" title={fileLabel}>{fileLabel}</span>
        <div className="stem-mixer-buttons">
          {outputDir && (
            <button type="button" className="install-btn is-secondary" onClick={() => invoke("open_path", { path: outputDir })}>
              <FolderOpen size={15} strokeWidth={2.3} />
              <span>Open folder</span>
            </button>
          )}
          <button type="button" className="install-btn is-primary" onClick={onAgain}>
            <ArrowRight size={15} strokeWidth={2.3} />
            <span>Extract another file</span>
          </button>
        </div>
      </div>
    </section>
  );
}
