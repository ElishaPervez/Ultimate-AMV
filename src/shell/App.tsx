import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AudioLines,
  Clapperboard,
  ChevronDown,
  Download,
  Film,
  FolderKanban,
  Github,
  Home,
  Layers,
  Library,
  MessageCircle,
  Music2,
  PanelLeftClose,
  PanelLeftOpen,
  ScrollText,
  Settings,
  Sparkles,
  Tv,
} from "lucide-react";
import { readBackgroundState } from "../lib/background";
import { APP_THEMES, DEFAULT_BG_STATE } from "../lib/constants";
import { setDiscordPanel } from "../lib/discord";
import { logFrontend, safeLogValue } from "../lib/log";
import { applyAppTheme, hasExplicitAccent, isHexColor, readThemeColors } from "../lib/theme";
import { parseBridgePayload } from "../utils/bridge";
import type { AppConfig, BackgroundState, SectionId } from "../types/app";
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
import { HomePanel } from "../features/home/HomePanel";
import { TsukyioPanel } from "../features/tsukyio/TsukyioPanel";
import { WindowChrome } from "./WindowChrome";

const DISCORD_INVITE_URL = "https://discord.gg/XuJrkeXKh6";
const GITHUB_ISSUES_URL = "https://github.com/ElishaPervez/Ultimate-AMV/issues";

// localStorage key for the persisted sidebar collapsed state. Survives across
// sessions so the user's compact-rail choice sticks.
const SIDEBAR_COLLAPSED_KEY = "ui.sidebar.collapsed";

function loadSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function saveSidebarCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // Ignore storage failures; the in-memory state still drives the UI.
  }
}

type RailItem = {
  id: SectionId;
  label: string;
  Icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
};

type RailEntry =
  | { kind: "item"; item: RailItem }
  | { kind: "divider" }
  | { kind: "spacer" };

// The collapsed sidebar is a FLAT icon rail: every destination is one click,
// with the grouped hierarchy reserved for the expanded sidebar (a collapsed
// group tree would force two clicks per navigation through flyouts). Order
// mirrors the expanded nav: Home, the Media group, the Downloads group, then
// Settings/Logs pinned to the bottom past a flexible spacer.
const RAIL_ENTRIES: RailEntry[] = (() => {
  const groups: RailItem[][] = [
    [{ id: "home", label: "Home", Icon: Home }],
    [
      { id: "audio-extraction", label: "Vocal Separation", Icon: AudioLines },
      { id: "clip-hunting", label: "Scene Splitter", Icon: Clapperboard },
      { id: "bg-removal", label: "BG Remover", Icon: Sparkles },
      { id: "audio-conversion", label: "Audio Conversion", Icon: Music2 },
      { id: "video-conversion", label: "Video Conversion", Icon: Film },
    ],
    [
      { id: "downloader", label: "Downloader", Icon: Tv },
      { id: "tsukyio", label: "Tsukyio Vault", Icon: Library },
    ],
  ];
  const footer: RailItem[] = [
    { id: "settings", label: "Settings", Icon: Settings },
    { id: "logs", label: "Logs", Icon: ScrollText },
  ];
  const entries: RailEntry[] = [];
  groups.forEach((group, gi) => {
    if (gi > 0) entries.push({ kind: "divider" });
    group.forEach((item) => entries.push({ kind: "item", item }));
  });
  entries.push({ kind: "spacer" });
  footer.forEach((item) => entries.push({ kind: "item", item }));
  return entries;
})();

// One icon button of the collapsed rail. The label lives in a hover/focus
// tooltip (the rail has no room for text); the stagger delay drives the
// cascading slide-in when the rail mounts.
function RailButton({
  item,
  delayMs,
  active,
  onSelect,
}: {
  item: RailItem;
  delayMs: number;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`sidebar-rail-btn ${active ? "is-active" : ""}`}
      style={{ animationDelay: `${delayMs}ms` }}
      onClick={onSelect}
      aria-label={item.label}
    >
      <item.Icon size={17} strokeWidth={2} />
      <span className="sidebar-rail-tip" role="tooltip">
        {item.label}
      </span>
    </button>
  );
}

const panelMeta: Record<SectionId, { kicker: string; title: string; stats: string[] }> = {
  home: {
    kicker: "Start",
    title: "Home",
    stats: ["Overview", "Tools", "Shortcuts"],
  },
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
  const [active, setActive] = React.useState<SectionId>("home");
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
  // Whether the sidebar is collapsed to the compact icon rail. Persisted so
  // it sticks across sessions.
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState<boolean>(loadSidebarCollapsed);
  const toggleSidebar = React.useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      saveSidebarCollapsed(next);
      return next;
    });
  }, []);
  // When EXPANDING, pre-open the group that owns the active section so the
  // highlighted item is visible instead of hidden behind a collapsed group
  // (rail navigation can land anywhere without touching openGroups).
  React.useEffect(() => {
    if (sidebarCollapsed) return;
    if (active === "downloader" || active === "tsukyio") {
      setOpenGroups((g) => (g.downloads ? g : { ...g, downloads: true }));
    } else if (active !== "settings" && active !== "logs" && active !== "home") {
      setOpenGroups((g) => (g.media ? g : { ...g, media: true }));
    }
    // Only when the collapsed state flips, not on every navigation — keeping
    // groups closed while browsing the expanded sidebar stays the user's call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidebarCollapsed]);
  // Home-card jumps also expand the sidebar group containing the target, so
  // the active subitem is visible instead of hidden behind a collapsed group.
  const handleHomeNavigate = React.useCallback((id: SectionId) => {
    setActive(id);
    if (id === "downloader" || id === "tsukyio") {
      setOpenGroups((g) => ({ ...g, downloads: true }));
    } else if (id !== "settings" && id !== "logs" && id !== "home") {
      setOpenGroups((g) => ({ ...g, media: true }));
    }
  }, []);
  const activeMeta = panelMeta[active];
  const isHome = active === "home";
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
    // Dark workspace ink for bright wallpapers (styles/bright-ink.css). Only
    // meaningful while a wallpaper is actually set.
    root.classList.toggle("bright-ink", hasBg && liveBg.brightText);
    if (hasBg) {
      root.style.setProperty("--app-bg-blur", `${Math.max(0, liveBg.blur)}px`);
    } else {
      root.style.removeProperty("--app-bg-blur");
    }
  }, [liveBg.imagePath, liveBg.videoPath, liveBg.blur, liveBg.brightText]);

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
        // The accent color is a sub-axis applied on top of the app's look. Only
        // push the inline `:root` override when the user has DELIBERATELY picked
        // an accent (preset or custom) through Settings -> Appearance — inline
        // styles beat any cascade layer, so on a fresh/legacy config we leave
        // them off and let the theme stylesheet's own accent show.
        if (hasExplicitAccent(payload)) {
          applyAppTheme(colors);
        }
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

  const modeTabs = isHome
    ? ([{ id: "home", label: "Home" }] as const)
    : isAudioExtraction
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
      <section className={`app-shell ${sidebarCollapsed ? "is-sidebar-collapsed" : ""}`}>
        <aside
          className={`sidebar ${sidebarCollapsed ? "is-collapsed" : ""}`}
          aria-label="Primary navigation"
        >
          {/* Brand + collapse toggle. The toggle leads the row, pinned to the
              LEFT edge with identical geometry in both states — the left edge
              is the only part of the sidebar that doesn't move during the
              width animation, so the button stays under the cursor and can be
              clicked repeatedly without re-aiming. */}
          <div className="sidebar-brand">
            <button
              type="button"
              className="sidebar-collapse-btn"
              onClick={toggleSidebar}
              title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-expanded={!sidebarCollapsed}
            >
              {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            </button>
            {!sidebarCollapsed && (
              <>
                <span className="sidebar-brand-text">Ultimate AMV</span>
                <span className="sidebar-brand-badge">{`v${__APP_VERSION__}`}</span>
              </>
            )}
          </div>

          {sidebarCollapsed ? (
            /* Compact icon rail: flat one-click nav, labels in tooltips. */
            <nav className="sidebar-rail" aria-label="Primary navigation (compact)">
              {RAIL_ENTRIES.map((entry, i) =>
                entry.kind === "divider" ? (
                  <span
                    key={`divider-${i}`}
                    className="sidebar-rail-divider"
                    aria-hidden="true"
                    style={{ animationDelay: `${i * 16}ms` }}
                  />
                ) : entry.kind === "spacer" ? (
                  <span key="spacer" className="sidebar-rail-spacer" aria-hidden="true" />
                ) : (
                  <RailButton
                    key={entry.item.id}
                    item={entry.item}
                    delayMs={i * 16}
                    active={active === entry.item.id}
                    onSelect={() => setActive(entry.item.id)}
                  />
                ),
              )}
            </nav>
          ) : (
            <>
          {/* Home */}
          <button
            type="button"
            className={`sidebar-home ${active === "home" ? "is-active" : ""}`}
            onClick={() => setActive("home")}
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
            <div className={`sidebar-subnav-wrap ${openGroups.media ? "is-open" : ""}`}>
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
            </div>
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
            <div className={`sidebar-subnav-wrap ${openGroups.downloads ? "is-open" : ""}`}>
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
            </div>
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

            <div className="sidebar-help-card">
              <div className="sidebar-help-title">Need help?</div>
              <div className="sidebar-help-text">Get support or report a bug</div>
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
            </>
          )}
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
                  <DownloaderPanel active={isDownloader} activeTab={downloaderTab} />
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
                    {isHome ? <HomePanel onNavigate={handleHomeNavigate} />
                      : isAudioConversion ? <MediaToAudioPanel />
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
