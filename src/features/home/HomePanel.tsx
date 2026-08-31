import React from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowRight,
  AudioLines,
  Clapperboard,
  Download,
  Film,
  FolderOpen,
  Gauge,
  Library,
  Music2,
  RotateCcw,
  ScrollText,
  Scissors,
  Settings,
  Sparkles,
  Tv,
} from "lucide-react";
import { loadLastToolVisit } from "../../lib/lastTool";
import type { SectionId } from "../../types/app";
import { useHomeStatus } from "./useHomeStatus";

type HomeTool = {
  id: SectionId;
  title: string;
  description: string;
  icon: React.ReactNode;
};

type HomeStage = {
  /** Shown as the stage marker. These are a real sequence — this is the
   * order the tools get used on an actual edit, not decoration. */
  step: string;
  label: string;
  tools: HomeTool[];
};

const ICON_PROPS = { size: 19, strokeWidth: 1.9 } as const;

const HOME_STAGES: HomeStage[] = [
  {
    step: "01",
    label: "Get footage",
    tools: [
      {
        id: "downloader",
        title: "Downloader",
        description: "Pull anime episodes or YouTube videos straight into your library.",
        icon: <Tv {...ICON_PROPS} />,
      },
      {
        id: "tsukyio",
        title: "Tsukyio Vault",
        description: "Browse the clip vault and grab footage that is already cut.",
        icon: <Library {...ICON_PROPS} />,
      },
    ],
  },
  {
    step: "02",
    label: "Find your cuts",
    tools: [
      {
        id: "clip-hunting",
        title: "Scene Splitter",
        description: "Detect every scene change in an episode and export the keepers.",
        icon: <Clapperboard {...ICON_PROPS} />,
      },
      {
        id: "dead-frames",
        title: "Dead Frame Remover",
        description: "Drop the repeated frames anime holds on, so motion reads clean.",
        icon: <Scissors {...ICON_PROPS} />,
      },
    ],
  },
  {
    step: "03",
    label: "Clean up the footage",
    tools: [
      {
        id: "bg-removal",
        title: "BG Remover",
        description: "Cut characters out of the background with a clean transparent edge.",
        icon: <Sparkles {...ICON_PROPS} />,
      },
      {
        id: "interpolation",
        title: "Frame Interpolation",
        description: "Add in-between frames so slow motion stays smooth instead of stuttering.",
        icon: <Gauge {...ICON_PROPS} />,
      },
    ],
  },
  {
    step: "04",
    label: "Prep for your editor",
    tools: [
      {
        id: "audio-extraction",
        title: "Vocal Separation",
        description: "Split a song into vocals and instrumental so you can cut to either.",
        icon: <AudioLines {...ICON_PROPS} />,
      },
      {
        id: "video-conversion",
        title: "Video Conversion",
        description: "Re-encode to formats like ProRes so scrubbing stays instant.",
        icon: <Film {...ICON_PROPS} />,
      },
      {
        id: "audio-conversion",
        title: "Audio Conversion",
        description: "Convert audio, or rip the soundtrack out of any video, to WAV or MP3.",
        icon: <Music2 {...ICON_PROPS} />,
      },
    ],
  },
];

const TOOL_BY_ID = new Map<SectionId, HomeTool>(
  HOME_STAGES.flatMap((stage) => stage.tools.map((tool) => [tool.id, tool] as const)),
);

export function HomePanel({
  active = true,
  onNavigate,
}: {
  active?: boolean;
  onNavigate: (id: SectionId) => void;
}) {
  const status = useHomeStatus(active);
  const [lastVisit, setLastVisit] = React.useState(() => loadLastToolVisit());

  /* Re-read the resume record every time Home comes back into view, so the
   * rail reflects the tool the user just came from instead of a stale one. */
  React.useEffect(() => {
    if (active) setLastVisit(loadLastToolVisit());
  }, [active]);

  const lastTool = lastVisit ? TOOL_BY_ID.get(lastVisit.id) : undefined;

  return (
    <div className="home-panel">
      <div className="home-hero">
        <h2 className="home-hero-title">Welcome to Ultimate AMV</h2>
        <p className="home-hero-sub">
          Everything you need to go from raw episodes to edit-ready clips — pick a tool to get started.
        </p>
      </div>

      <div className="home-body">
        <div className="home-board">
          {HOME_STAGES.map((stage) => (
            <section className="home-stage" key={stage.step}>
              <header className="home-stage-head">
                <span className="home-stage-step">{stage.step}</span>
                <h3 className="home-stage-label">{stage.label}</h3>
                <span className="home-stage-rule" aria-hidden="true" />
              </header>
              <div className="home-stage-tools">
                {stage.tools.map((tool) => (
                  <button
                    key={tool.id}
                    type="button"
                    className="home-card"
                    onClick={() => onNavigate(tool.id)}
                  >
                    <span className="home-card-icon">{tool.icon}</span>
                    <span className="home-card-text">
                      <span className="home-card-title">{tool.title}</span>
                      <span className="home-card-desc">{tool.description}</span>
                    </span>
                    <ArrowRight className="home-card-arrow" size={15} strokeWidth={2} />
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>

        <aside className="home-rail">
          <ReadyPanel status={status} onNavigate={onNavigate} />
          <ResumePanel visit={lastVisit} tool={lastTool} onNavigate={onNavigate} />
          <DownloadsPanel status={status} onNavigate={onNavigate} />
          <div className="home-rail-footer">
            <button type="button" className="home-rail-link" onClick={() => onNavigate("settings")}>
              <Settings size={14} strokeWidth={1.9} />
              Settings
            </button>
            <button type="button" className="home-rail-link" onClick={() => onNavigate("logs")}>
              <ScrollText size={14} strokeWidth={1.9} />
              Logs
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}

function ReadyPanel({
  status,
  onNavigate,
}: {
  status: ReturnType<typeof useHomeStatus>;
  onNavigate: (id: SectionId) => void;
}) {
  return (
    <section className="home-rail-card">
      <header className="home-rail-head">
        <h3 className="home-rail-title">Ready to run</h3>
        {!status.loading && (
          <span className={`home-rail-badge is-${status.needsAttention ? "warn" : "ok"}`}>
            {status.needsAttention ? "Check this" : "All clear"}
          </span>
        )}
      </header>
      {status.loading ? (
        <p className="home-rail-empty">Checking your machine…</p>
      ) : (
        <>
          <ul className="home-check-list">
            {status.lines.map((line) => (
              <li className="home-check" key={line.key}>
                <span className={`home-check-dot is-${line.tone}`} aria-hidden="true" />
                <span className="home-check-text">
                  <span className="home-check-label">{line.label}</span>
                  <span className="home-check-detail">{line.detail}</span>
                </span>
              </li>
            ))}
          </ul>
          {status.needsAttention && (
            <button type="button" className="home-rail-action" onClick={() => onNavigate("settings")}>
              Change this in Settings
              <ArrowRight size={13} strokeWidth={2} />
            </button>
          )}
        </>
      )}
    </section>
  );
}

function ResumePanel({
  visit,
  tool,
  onNavigate,
}: {
  visit: ReturnType<typeof loadLastToolVisit>;
  tool: HomeTool | undefined;
  onNavigate: (id: SectionId) => void;
}) {
  return (
    <section className="home-rail-card">
      <header className="home-rail-head">
        <h3 className="home-rail-title">Pick up where you left off</h3>
      </header>
      {visit && tool ? (
        <button type="button" className="home-resume" onClick={() => onNavigate(tool.id)}>
          <span className="home-resume-icon">
            <RotateCcw size={16} strokeWidth={2} />
          </span>
          <span className="home-resume-text">
            <span className="home-resume-title">{tool.title}</span>
            <span className="home-resume-meta">{relativeTime(visit.at)}</span>
          </span>
          <ArrowRight className="home-card-arrow" size={15} strokeWidth={2} />
        </button>
      ) : (
        <>
          <p className="home-rail-empty">No tool opened yet. Scene Splitter is where most edits start.</p>
          <button type="button" className="home-rail-action" onClick={() => onNavigate("clip-hunting")}>
            Open Scene Splitter
            <ArrowRight size={13} strokeWidth={2} />
          </button>
        </>
      )}
    </section>
  );
}

function DownloadsPanel({
  status,
  onNavigate,
}: {
  status: ReturnType<typeof useHomeStatus>;
  onNavigate: (id: SectionId) => void;
}) {
  return (
    <section className="home-rail-card">
      <header className="home-rail-head">
        <h3 className="home-rail-title">Recent downloads</h3>
        {status.downloads.length > 0 && (
          <button type="button" className="home-rail-more" onClick={() => onNavigate("downloader")}>
            See all
          </button>
        )}
      </header>
      {!status.downloadsLoaded ? (
        <p className="home-rail-empty">Loading…</p>
      ) : status.downloads.length === 0 ? (
        <>
          <p className="home-rail-empty">Nothing downloaded yet.</p>
          <button type="button" className="home-rail-action" onClick={() => onNavigate("downloader")}>
            <Download size={13} strokeWidth={2} />
            Open Downloader
          </button>
        </>
      ) : (
        <ul className="home-download-list">
          {status.downloads.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="home-download"
                title={`Show ${item.title} in File Explorer`}
                onClick={() => void invoke("reveal_in_folder", { path: item.outputPath }).catch(() => {})}
              >
                <span className="home-download-text">
                  <span className="home-download-title">{item.title}</span>
                  <span className="home-download-meta">
                    {[item.subtitle, item.qualityLabel, relativeTime(Date.parse(item.createdAt))]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <FolderOpen className="home-download-reveal" size={14} strokeWidth={1.9} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** "just now" / "12 minutes ago" / "3 days ago". Returns an empty string for
 * a timestamp that could not be parsed, so callers can filter it out. */
function relativeTime(at: number): string {
  if (!Number.isFinite(at)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return days === 1 ? "yesterday" : `${days} days ago`;
  const months = Math.round(days / 30);
  return months === 1 ? "1 month ago" : `${months} months ago`;
}
