import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AudioLines,
  Clapperboard,
  ChevronDown,
  Compass,
  Download,
  Film,
  FolderKanban,
  Github,
  Home,
  Layers,
  Library,
  MessageCircle,
  Music2,
  ScrollText,
  Settings,
  Sparkles,
  Tv,
} from "lucide-react";
import { readBackgroundState } from "../lib/background";
import { APP_THEMES, DEFAULT_BG_STATE } from "../lib/constants";
import { setDiscordPanel } from "../lib/discord";
import { logFrontend, safeLogValue } from "../lib/log";
import { applyAppTheme, isHexColor, readThemeColors } from "../lib/theme";
import { parseBridgePayload } from "../utils/bridge";
import type { AppConfig, BackgroundState, NavItem, SectionId } from "../types/app";
import type { DownloaderTab } from "../types/download";
import { NewAudioExtractionPanel } from "../features/audio/NewAudioExtractionPanel";
import { MediaToAudioPanel } from "../features/audio/MediaToAudioPanel";
import { ClipExtractorPanel } from "../features/clips/ClipExtractorPanel";
import { DownloaderPanel } from "../features/downloader/DownloaderPanel";
import { LogsPanel } from "../features/logs/LogsPanel";
import { BackgroundCustomizer } from "../features/settings/BackgroundCustomizer";
import { BackgroundLayer } from "../features/settings/BackgroundLayer";
import { SettingsPanel } from "../features/settings/SettingsPanel";
import { UpdateToast } from "../features/settings/UpdateToast";
import { VideoToVideoPanel } from "../features/video/VideoToVideoPanel";
import { BgRemovePanel } from "../features/bgremove/BgRemovePanel";
import { TsukyioPanel } from "../features/tsukyio/TsukyioPanel";
import { WindowChrome } from "./WindowChrome";

const DISCORD_INVITE_URL = "https://discord.gg/XuJrkeXKh6";
const GITHUB_ISSUES_URL = "https://github.com/ElishaPervez/Ultimate-AMV/issues";

const primaryItems: NavItem[] = [
  { id: "audio-extraction", label: "Vocal Separation", short: "Vocals", icon: AudioLines },
  { id: "clip-hunting", label: "Scene Splitter", short: "Splitter", icon: Compass },
  { id: "downloader", label: "Downloader", short: "Download", icon: Download },
  { id: "tsukyio", label: "Tsukyio Vault", short: "Vault", icon: Library },
  { id: "bg-removal", label: "BG Remover", short: "Matting", icon: Sparkles },
  { id: "audio-conversion", label: "Audio Conversion", short: "Audio", icon: Music2 },
  { id: "video-conversion", label: "Video Conversion", short: "Video", icon: Film },
];

const panelMeta: Record<SectionId, { kicker: string; title: string; stats: string[] }> = {
  "clip-hunting": {
    kicker: "Splitter",
    title: "Scene Splitter",
    stats: ["Scene ranges", "Preview", "Export"],
  },
  downloader: {
    kicker: "Download",
    title: "Downloader",
    stats: ["Anime", "YouTube", "Queue"],
  },
  tsukyio: {
    kicker: "Vault",
    title: "Tsukyio Vault",
    stats: ["Browse", "Preview", "Download"],
  },
  "audio-extraction": {
    kicker: "Separation",
    title: "Vocal Separation",
    stats: ["GPU", "CPU", "Stem export"],
  },
  "video-conversion": {
    kicker: "Conversion",
    title: "Video Conversion",
    stats: ["NVENC", "ProRes", "Progress"],
  },
  "audio-conversion": {
    kicker: "Conversion",
    title: "Audio Conversion",
    stats: ["WAV", "MP3", "Archive"],
  },
  "bg-removal": {
    kicker: "Isolation",
    title: "BG Remover",
    stats: ["SkyTNT", "Alpha", "Fast GPU"],
  },
  settings: {
    kicker: "Options",
    title: "Settings",
    stats: ["Paths", "Sources", "Hardware"],
  },
  logs: {
    kicker: "Events",
    title: "Logs",
    stats: ["Events", "Errors", "Setup"],
  },
};

export function App() {
  const [expanded, setExpanded] = React.useState(true);
  const [active, setActive] = React.useState<SectionId>("clip-hunting");
  const [downloaderTab, setDownloaderTab] = React.useState<DownloaderTab>("anime");
  const [bgRemoveTab, setBgRemoveTab] = React.useState<"video" | "image">("video");
  const [bgState, setBgState] = React.useState<BackgroundState>(DEFAULT_BG_STATE);
  const [bgPreview, setBgPreview] = React.useState<BackgroundState | null>(null);
  const [bgModalOpen, setBgModalOpen] = React.useState(false);
  // Theme state lives here (not inside SettingsPanel) so it survives the
  // Settings panel unmount/remount when the user navigates away. Otherwise
  // SettingsPanel's refreshConfig would race the still-in-flight set_config
  // write and re-fetch the pre-change colors from disk.
  const [themeColors, setThemeColors] = React.useState(() => readThemeColors(null));
  const [openGroups, setOpenGroups] = React.useState<Record<string, boolean>>({
    media: true,
    downloads: false,
  });
  const activeMeta = panelMeta[active];
  const isAudioExtraction = active === "audio-extraction";
  const isClipHunting = active === "clip-hunting";
  const isDownloader = active === "downloader";
  const isTsukyio = active === "tsukyio";
  const isAudioConversion = active === "audio-conversion";
  const isVideoConversion = active === "video-conversion";
  const isBgRemoval = active === "bg-removal";
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
    void invoke("warmup_ffmpeg").catch(() => { });

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
    : isBgRemoval
      ? ([
        { id: "video", label: "Video Isolate" },
        { id: "image", label: "Image Isolate" },
      ] as const)
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
              ? ([{ id: "extractor", label: "Scene splitter" }] as const)
              : isTsukyio
                ? ([{ id: "vault", label: "Vault" }] as const)
                : isAudioConversion || isVideoConversion
                ? ([{ id: "convert", label: "Convert" }] as const)
                : ([
                  { id: "media", label: "Media browser" },
                  { id: "clip", label: "Scene splitting" },
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
        <aside className="sidebar" aria-label="Primary navigation">
          {/* Brand */}
          <div className="sidebar-brand">
            <span className="sidebar-brand-text">Ultimate AMV</span>
            <span className="sidebar-brand-badge">v0.12</span>
          </div>

          {/* Home */}
          <button
            type="button"
            className={`sidebar-home ${active === "clip-hunting" ? "is-active" : ""}`}
            onClick={() => setActive("clip-hunting")}
          >
            <Home size={18} strokeWidth={2} />
            <span>Home</span>
          </button>

          {/* Main Section */}
          <div className="sidebar-section-label">Main</div>

          {/* Media Group */}
          <div className="sidebar-group">
            <button
              type="button"
              className={`sidebar-group-header ${["audio-extraction", "clip-hunting", "bg-removal", "audio-conversion", "video-conversion"].includes(active) ? "is-active" : ""}`}
              onClick={() => setOpenGroups((g) => ({ ...g, media: !g.media }))}
            >
              <Layers size={18} strokeWidth={2} />
              <span>Media</span>
              <ChevronDown size={14} className={`sidebar-chevron ${openGroups.media ? "is-open" : ""}`} />
            </button>
            {openGroups.media && (
              <div className="sidebar-subnav">
                <button
                  type="button"
                  className={`sidebar-subitem ${active === "audio-extraction" ? "is-active" : ""}`}
                  onClick={() => setActive("audio-extraction")}
                >
                  <AudioLines size={14} />
                  <span>Vocal Separation</span>
                </button>
                <button
                  type="button"
                  className={`sidebar-subitem ${active === "clip-hunting" ? "is-active" : ""}`}
                  onClick={() => setActive("clip-hunting")}
                >
                  <Clapperboard size={14} />
                  <span>Scene Splitter</span>
                </button>
                <button
                  type="button"
                  className={`sidebar-subitem ${active === "bg-removal" ? "is-active" : ""}`}
                  onClick={() => setActive("bg-removal")}
                >
                  <Sparkles size={14} />
                  <span>BG Remover</span>
                </button>
                <button
                  type="button"
                  className={`sidebar-subitem ${active === "audio-conversion" ? "is-active" : ""}`}
                  onClick={() => setActive("audio-conversion")}
                >
                  <Music2 size={14} />
                  <span>Audio Conversion</span>
                </button>
                <button
                  type="button"
                  className={`sidebar-subitem ${active === "video-conversion" ? "is-active" : ""}`}
                  onClick={() => setActive("video-conversion")}
                >
                  <Film size={14} />
                  <span>Video Conversion</span>
                </button>
              </div>
            )}
          </div>

          {/* Downloads Group */}
          <div className="sidebar-group">
            <button
              type="button"
              className={`sidebar-group-header ${["downloader", "tsukyio"].includes(active) ? "is-active" : ""}`}
              onClick={() => setOpenGroups((g) => ({ ...g, downloads: !g.downloads }))}
            >
              <Download size={18} strokeWidth={2} />
              <span>Downloads</span>
              <ChevronDown size={14} className={`sidebar-chevron ${openGroups.downloads ? "is-open" : ""}`} />
            </button>
            {openGroups.downloads && (
              <div className="sidebar-subnav">
                <button
                  type="button"
                  className={`sidebar-subitem ${active === "downloader" ? "is-active" : ""}`}
                  onClick={() => setActive("downloader")}
                >
                  <Tv size={14} />
                  <span>Downloader</span>
                </button>
                <button
                  type="button"
                  className={`sidebar-subitem ${active === "tsukyio" ? "is-active" : ""}`}
                  onClick={() => setActive("tsukyio")}
                >
                  <Library size={14} />
                  <span>Tsukyio Vault</span>
                </button>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="sidebar-footer-static">
            <div className="sidebar-footer-actions">
              <button
                type="button"
                className={`sidebar-footer-btn ${active === "settings" ? "is-active" : ""}`}
                onClick={() => setActive("settings")}
              >
                <Settings size={16} />
                <span>Settings</span>
              </button>
              <button
                type="button"
                className={`sidebar-footer-btn ${active === "logs" ? "is-active" : ""}`}
                onClick={() => setActive("logs")}
              >
                <ScrollText size={16} />
                <span>Logs</span>
              </button>
            </div>

            <div className="sidebar-theme-row">
              <span className="sidebar-theme-label">Theme</span>
              <div className="sidebar-theme-select">
                <span className="sidebar-theme-dot" />
                <span>Ultimate-AMV Modern</span>
              </div>
            </div>

            <div className="sidebar-help-card">
              <div className="sidebar-help-title">Need help?</div>
              <div className="sidebar-help-text">24/7 assistance available</div>
              <div className="sidebar-help-actions">
                <button
                  type="button"
                  className="sidebar-help-btn"
                  onClick={() => {
                    void openUrl(DISCORD_INVITE_URL).catch((error) => {
                      logFrontend("warn", "frontend.discord.invite.open.error", "Could not open Discord invite", {
                        error: safeLogValue(error),
                      });
                    });
                  }}
                >
                  <MessageCircle size={14} />
                  <span>Discord Server</span>
                </button>
                <button
                  type="button"
                  className="sidebar-help-btn is-secondary"
                  onClick={() => {
                    void openUrl(GITHUB_ISSUES_URL).catch((error) => {
                      logFrontend("warn", "frontend.github.open.error", "Could not open GitHub issues", {
                        error: safeLogValue(error),
                      });
                    });
                  }}
                >
                  <Github size={14} />
                  <span>GitHub Issues</span>
                </button>
              </div>
            </div>
          </div>
        </aside>

        <section className="workspace">
          <div className="workspace-header">
            <h1>{activeMeta.title}</h1>
          </div>
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
                          : isBgRemoval
                            ? bgRemoveTab === tab.id
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
                        } else if (isBgRemoval && (tab.id === "video" || tab.id === "image")) {
                          setBgRemoveTab(tab.id);
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
                  <NewAudioExtractionPanel />
                </div>
                <div className={`panel-view spring-motion ${isBgRemoval ? "is-active" : "is-hidden"}`} aria-hidden={!isBgRemoval}>
                  <BgRemovePanel activeTab={bgRemoveTab} />
                </div>
                <div className={`panel-view spring-motion ${isTsukyio ? "is-active" : "is-hidden"}`} aria-hidden={!isTsukyio}>
                  <TsukyioPanel active={isTsukyio} onOpenSettings={() => setActive("settings")} />
                </div>
                {!isClipHunting && !isDownloader && !isAudioExtraction && !isBgRemoval && !isTsukyio && (
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
