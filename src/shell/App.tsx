import React from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AudioLines,
  ChevronsLeft,
  ChevronsRight,
  Compass,
  Download,
  Film,
  FolderKanban,
  Music2,
  ScrollText,
  Settings,
} from "lucide-react";
import { readBackgroundState } from "../lib/background";
import { APP_THEMES, DEFAULT_BG_STATE } from "../lib/constants";
import { setDiscordPanel } from "../lib/discord";
import { logFrontend, safeLogValue } from "../lib/log";
import { applyAppTheme, isHexColor, readThemeColors } from "../lib/theme";
import { parseBridgePayload } from "../utils/bridge";
import type { AppConfig, BackgroundState, NavItem, SectionId } from "../types/app";
import type { DownloaderTab } from "../types/download";
import { AudioExtractionPanel } from "../features/audio/AudioExtractionPanel";
import { MediaToAudioPanel } from "../features/audio/MediaToAudioPanel";
import { ClipExtractorPanel } from "../features/clips/ClipExtractorPanel";
import { DownloaderPanel } from "../features/downloader/DownloaderPanel";
import { LogsPanel } from "../features/logs/LogsPanel";
import { BackgroundCustomizer } from "../features/settings/BackgroundCustomizer";
import { BackgroundLayer } from "../features/settings/BackgroundLayer";
import { SettingsPanel } from "../features/settings/SettingsPanel";
import { UpdateToast } from "../features/settings/UpdateToast";
import { VideoToVideoPanel } from "../features/video/VideoToVideoPanel";
import { SidebarButton } from "./SidebarButton";
import { WindowChrome } from "./WindowChrome";

const primaryItems: NavItem[] = [
  { id: "audio-extraction", label: "Vocal Extraction", short: "Vocal", icon: AudioLines },
  { id: "clip-hunting", label: "Clip Hunting", short: "Hunt", icon: Compass },
  { id: "downloader", label: "Downloader", short: "Down", icon: Download },
  { id: "audio-conversion", label: "Any To Audio", short: "Audio", icon: Music2 },
  { id: "video-conversion", label: "Video To Video", short: "Video", icon: Film },
];

const panelMeta: Record<SectionId, { kicker: string; title: string; stats: string[] }> = {
  "clip-hunting": {
    kicker: "Hunt",
    title: "Clip Hunting",
    stats: ["Scene ranges", "Preview", "Export"],
  },
  downloader: {
    kicker: "Fetch",
    title: "Downloader",
    stats: ["Anime", "YouTube", "Queue"],
  },
  "audio-extraction": {
    kicker: "Vocals",
    title: "Vocal Extraction",
    stats: ["GPU", "CPU", "Stem export"],
  },
  "video-conversion": {
    kicker: "Encode",
    title: "Video To Video",
    stats: ["NVENC", "ProRes", "Progress"],
  },
  "audio-conversion": {
    kicker: "Convert",
    title: "Any To Audio",
    stats: ["WAV", "MP3", "Archive"],
  },
  settings: {
    kicker: "System",
    title: "Settings",
    stats: ["Paths", "Sources", "Hardware"],
  },
  logs: {
    kicker: "System",
    title: "Logs",
    stats: ["Events", "Errors", "Setup"],
  },
};

export function App() {
  const [expanded, setExpanded] = React.useState(true);
  const [active, setActive] = React.useState<SectionId>("clip-hunting");
  const [downloaderTab, setDownloaderTab] = React.useState<DownloaderTab>("anime");
  const [bgState, setBgState] = React.useState<BackgroundState>(DEFAULT_BG_STATE);
  const [bgPreview, setBgPreview] = React.useState<BackgroundState | null>(null);
  const [bgModalOpen, setBgModalOpen] = React.useState(false);
  // Theme state lives here (not inside SettingsPanel) so it survives the
  // Settings panel unmount/remount when the user navigates away. Otherwise
  // SettingsPanel's refreshConfig would race the still-in-flight set_config
  // write and re-fetch the pre-change colors from disk.
  const [themeColors, setThemeColors] = React.useState(() => readThemeColors(null));
  const activeMeta = panelMeta[active];
  const isAudioExtraction = active === "audio-extraction";
  const isClipHunting = active === "clip-hunting";
  const isDownloader = active === "downloader";
  const isAudioConversion = active === "audio-conversion";
  const isVideoConversion = active === "video-conversion";
  const isLogs = active === "logs";
  const isSettings = active === "settings";

  const liveBg = bgPreview ?? bgState;
  React.useEffect(() => {
    const root = document.documentElement;
    const hasBg = Boolean(liveBg.videoPath) || Boolean(liveBg.imagePath);
    root.classList.toggle("has-app-bg", hasBg);
    if (hasBg) {
      root.style.setProperty("--app-bg-blur", `${Math.max(0, liveBg.blur)}px`);
    } else {
      root.style.removeProperty("--app-bg-blur");
    }
  }, [liveBg.imagePath, liveBg.videoPath, liveBg.blur]);

  React.useEffect(() => {
    setDiscordPanel(activeMeta?.title ?? "Idle");
  }, [active, activeMeta]);

  React.useEffect(() => {
    // Fire-and-forget ffmpeg warmup so the first scene preview click in the
    // session doesn't pay a ~1-2s cold-start tax (DLL loads + NVENC probe).
    // Runs in both clip modes - CPU users hit scene_clip_render too.
    void invoke("warmup_ffmpeg").catch(() => {});

    invoke<string>("get_config")
      .then((raw) => {
        const payload = parseBridgePayload<AppConfig>(raw);
        const colors = readThemeColors(payload);
        setThemeColors(colors);
        applyAppTheme(colors);
        setBgState(readBackgroundState(payload));
      })
      .catch((error) => {
        logFrontend("warn", "frontend.theme.config.error", "Could not load saved theme", {
          error: safeLogValue(error),
        });
      });

    const onThemeChanged = (event: Event) => {
      const colors = (event as CustomEvent<{ primary?: unknown; secondary?: unknown }>).detail;
      const next = {
        primary: isHexColor(colors?.primary) ? colors.primary : APP_THEMES[0].colors[0],
        secondary: isHexColor(colors?.secondary) ? colors.secondary : APP_THEMES[0].colors[1],
      };
      setThemeColors(next);
      applyAppTheme(next);
    };
    const onBgOpen = () => setBgModalOpen(true);
    window.addEventListener("theme-changed", onThemeChanged);
    window.addEventListener("bg-customize-open", onBgOpen);
    return () => {
      window.removeEventListener("theme-changed", onThemeChanged);
      window.removeEventListener("bg-customize-open", onBgOpen);
    };
  }, []);

  const modeTabs = isAudioExtraction
    ? ([{ id: "extract", label: "Extract" }] as const)
    : isLogs
      ? ([{ id: "logs", label: "Logs" }] as const)
      : isSettings
        ? ([{ id: "general", label: "General" }] as const)
        : isDownloader
          ? ([
            { id: "anime", label: "Anime Download" },
            { id: "youtube", label: "YouTube Download" },
          ] as const)
          : isClipHunting
            ? ([{ id: "extractor", label: "Clip extractor" }] as const)
          : isAudioConversion || isVideoConversion
            ? ([{ id: "convert", label: "Convert" }] as const)
            : ([
              { id: "media", label: "Media browser" },
              { id: "clip", label: "Clip extraction" },
            ] as const);

  return (
    <main className="desktop">
      <BackgroundLayer state={liveBg} />
      <WindowChrome />
      <UpdateToast />
      {bgModalOpen && (
        <BackgroundCustomizer
          initial={bgState}
          onPreview={setBgPreview}
          onCommit={(next) => {
            setBgState(next);
            setBgPreview(null);
            setBgModalOpen(false);
            window.dispatchEvent(new CustomEvent("bg-saved", { detail: next }));
          }}
          onCancel={() => {
            setBgPreview(null);
            setBgModalOpen(false);
          }}
        />
      )}
      <section className={`app-shell ${expanded ? "is-expanded" : "is-compact"}`}>
        <aside className="sidebar glass-strong" aria-label="Primary navigation">
          <div className="brand-strip">
            <button
              type="button"
              className="icon-button collapse-button spring-motion"
              aria-label={expanded ? "Compact sidebar" : "Expand sidebar"}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? <ChevronsLeft size={19} strokeWidth={2.5} /> : <ChevronsRight size={19} strokeWidth={2.5} />}
            </button>
            <div className="brand-cluster">
              <div className="brand-copy">
                <span className="brand-name">Ultimate AMV</span>
                <span className="brand-subtitle">Creative Engine</span>
              </div>
            </div>
          </div>

          <nav className="nav-list">
            {primaryItems.map((item) => (
              <SidebarButton
                key={item.id}
                item={item}
                active={active === item.id}
                expanded={expanded}
                onClick={() => setActive(item.id)}
              />
            ))}
          </nav>

          <div className="sidebar-footer">
            <button
              type="button"
              className={`settings-button spring-motion ${active === "logs" ? "is-active" : ""}`}
              aria-label="Logs"
              onClick={() => setActive("logs")}
            >
              <ScrollText size={21} strokeWidth={2.05} />
              <span>System Logs</span>
            </button>

            <button
              type="button"
              className={`settings-button spring-motion ${active === "settings" ? "is-active" : ""}`}
              aria-label="Settings"
              onClick={() => setActive("settings")}
            >
              <Settings size={22} strokeWidth={2.15} />
              <span>Engine Settings</span>
            </button>
          </div>
        </aside>

        <section className="workspace">
          <div className="canvas">
            <div className="canvas-grid" aria-hidden="true" />
            <div className="focus-panel glass">
              {modeTabs.length > 1 && (
                <div className="mode-switcher" aria-label="Workspace mode">
                  {modeTabs.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      className={`mode-tab spring-motion ${isAudioExtraction
                          ? "is-active"
                          : isDownloader
                            ? downloaderTab === tab.id
                              ? "is-active"
                              : ""
                            : isClipHunting
                              ? "is-active"
                              : isAudioConversion || isVideoConversion
                              ? "is-active"
                              : tab.id === "media" || tab.id === "logs" || tab.id === "general"
                                ? "is-active"
                                : ""
                        }`}
                      onClick={() => {
                        if (isDownloader && (tab.id === "anime" || tab.id === "youtube")) {
                          setDownloaderTab(tab.id);
                        }
                      }}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              )}
              <div className="panel-body">
                <div className={`panel-view spring-motion ${isClipHunting ? "is-active" : "is-hidden"}`} aria-hidden={!isClipHunting}>
                  <ClipExtractorPanel active={isClipHunting} />
                </div>
                <div className={`panel-view spring-motion ${isDownloader ? "is-active" : "is-hidden"}`} aria-hidden={!isDownloader}>
                  <DownloaderPanel active={isDownloader} activeTab={downloaderTab} sidebarExpanded={expanded} />
                </div>
                <div className={`panel-view spring-motion ${isAudioExtraction ? "is-active" : "is-hidden"}`} aria-hidden={!isAudioExtraction}>
                  <AudioExtractionPanel />
                </div>
                {!isClipHunting && !isDownloader && !isAudioExtraction && (
                  <div className="panel-view is-active spring-motion">
                    {isAudioConversion ? <MediaToAudioPanel />
                      : isVideoConversion ? <VideoToVideoPanel />
                        : isLogs ? <LogsPanel />
                          : isSettings ? <SettingsPanel themeColors={themeColors} />
                            : (
                              <div className="empty-surface">
                                <div className="surface-mark accent-glow">
                                  <FolderKanban size={34} strokeWidth={1.8} />
                                </div>
                                <h2>{activeMeta.title}</h2>
                              </div>
                            )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}
