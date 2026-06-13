import React from "react";
import {
  ArrowRight,
  AudioLines,
  Clapperboard,
  Film,
  Library,
  Music2,
  Settings,
  Sparkles,
  Tv,
} from "lucide-react";
import type { SectionId } from "../../types/app";

type HomeFeature = {
  id: SectionId;
  group: "Media" | "Downloads" | "App";
  title: string;
  description: string;
  icon: React.ReactNode;
};

const HOME_FEATURES: HomeFeature[] = [
  {
    id: "clip-hunting",
    group: "Media",
    title: "Scene Splitter",
    description: "Auto-detect every scene cut in an episode, preview them in a grid, and export the keepers as edit-ready clips.",
    icon: <Clapperboard size={22} strokeWidth={1.9} />,
  },
  {
    id: "audio-extraction",
    group: "Media",
    title: "Vocal Separation",
    description: "Split a song into vocal and instrumental stems with GPU-accelerated separation (CPU works too).",
    icon: <AudioLines size={22} strokeWidth={1.9} />,
  },
  {
    id: "bg-removal",
    group: "Media",
    title: "BG Remover",
    description: "Isolate characters from the background and export footage with a clean alpha channel.",
    icon: <Sparkles size={22} strokeWidth={1.9} />,
  },
  {
    id: "audio-conversion",
    group: "Media",
    title: "Audio Conversion",
    description: "Convert audio files or rip the soundtrack out of any video to WAV or MP3.",
    icon: <Music2 size={22} strokeWidth={1.9} />,
  },
  {
    id: "video-conversion",
    group: "Media",
    title: "Video Conversion",
    description: "Re-encode videos to editor-friendly formats like ProRes so After Effects scrubbing stays smooth.",
    icon: <Film size={22} strokeWidth={1.9} />,
  },
  {
    id: "downloader",
    group: "Downloads",
    title: "Downloader",
    description: "Search and download anime episodes or YouTube videos straight into your library.",
    icon: <Tv size={22} strokeWidth={1.9} />,
  },
  {
    id: "tsukyio",
    group: "Downloads",
    title: "Tsukyio Vault",
    description: "Browse the Tsukyio clip vault and pull ready-made anime clips for your edits.",
    icon: <Library size={22} strokeWidth={1.9} />,
  },
  {
    id: "settings",
    group: "App",
    title: "Settings",
    description: "Configure download paths, hardware mode, themes, and the app background.",
    icon: <Settings size={22} strokeWidth={1.9} />,
  },
];

export function HomePanel({ onNavigate }: { onNavigate: (id: SectionId) => void }) {
  return (
    <div className="home-panel">
      <div className="home-hero">
        <h2 className="home-hero-title">Welcome to Ultimate AMV</h2>
        <p className="home-hero-sub">
          Everything you need to go from raw episodes to edit-ready clips — pick a tool to get started.
        </p>
      </div>
      <div className="home-grid">
        {HOME_FEATURES.map((feature) => (
          <button
            key={feature.id}
            type="button"
            className="home-card"
            onClick={() => onNavigate(feature.id)}
          >
            <div className="home-card-head">
              <div className="home-card-icon">{feature.icon}</div>
              <span className="home-card-group">{feature.group}</span>
            </div>
            <span className="home-card-title">{feature.title}</span>
            <p className="home-card-desc">{feature.description}</p>
            <div className="home-card-open">
              <span>Open</span>
              <ArrowRight size={14} />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
