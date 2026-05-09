import React from "react";
import ReactDOM from "react-dom/client";
import { SetupWizard } from "./SetupWizard";
import { parseBridgePayload, readBridgeError } from "./utils/bridge";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { Webview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Virtuoso } from "react-virtuoso";
import {
  AlertTriangle,
  ArrowRight,
  AudioLines,
  CalendarDays,
  ChevronsLeft,
  ChevronsRight,
  CheckCircle2,
  Circle,
  Clapperboard,
  Copy,
  Cpu,
  Download,
  FileVideo,
  FolderOpen,
  Minus,
  Compass,
  ExternalLink,
  Film,
  FileAudio,
  FolderKanban,
  History,
  Info,
  ListPlus,
  Loader2,
  Maximize2,
  Music2,
  Pause,
  Play,
  RefreshCw,
  Search,
  ScrollText,
  Scissors,
  Sparkles,
  Star,
  Tv,
  Trash2,
  Volume2,
  VolumeX,
  X,
  Youtube,
  Settings,
  Zap,
} from "lucide-react";
import "./styles.css";

function safeLogValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value == null) {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function logFrontend(level: "info" | "warn" | "error", event: string, message: string, details?: Record<string, unknown>) {
  void invoke("frontend_log", {
    level,
    event,
    message,
    details: details ?? null,
  }).catch(() => undefined);
}

function installFrontendLogHandlers() {
  window.addEventListener("error", (event) => {
    logFrontend("error", "frontend.window.error", event.message || "Unhandled frontend error", {
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      error: safeLogValue(event.error),
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    logFrontend("error", "frontend.promise.unhandled_rejection", "Unhandled frontend promise rejection", {
      reason: safeLogValue(event.reason),
    });
  });
}

installFrontendLogHandlers();

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

function getThemePreset(theme: unknown) {
  return APP_THEMES.find((preset) => preset.id === theme) ?? APP_THEMES[0];
}

function hexToRgbParts(hex: string) {
  const normalized = isHexColor(hex) ? hex.slice(1) : "48d7ff";
  const value = Number.parseInt(normalized, 16);
  return `${(value >> 16) & 255} ${(value >> 8) & 255} ${value & 255}`;
}

function getReadableContrast(hex: string) {
  const normalized = isHexColor(hex) ? hex.slice(1) : "48d7ff";
  const red = Number.parseInt(normalized.slice(0, 2), 16) / 255;
  const green = Number.parseInt(normalized.slice(2, 4), 16) / 255;
  const blue = Number.parseInt(normalized.slice(4, 6), 16) / 255;
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  return luminance > 0.62 ? "#061116" : "#f7fbff";
}

function readThemeColors(config: Partial<Pick<AppConfig, "theme" | "theme_color_a" | "theme_color_b">> | null | undefined) {
  const preset = getThemePreset(config?.theme);
  const primary = isHexColor(config?.theme_color_a) ? config.theme_color_a : preset.colors[0];
  const secondary = isHexColor(config?.theme_color_b) ? config.theme_color_b : preset.colors[1];
  return { primary, secondary };
}

function applyAppTheme(colors: { primary: string; secondary: string }) {
  const root = document.documentElement;
  root.dataset.theme = "custom";
  root.style.setProperty("--theme-accent-rgb", hexToRgbParts(colors.primary));
  root.style.setProperty("--theme-accent-2-rgb", hexToRgbParts(colors.secondary));
  root.style.setProperty("--theme-accent-contrast", getReadableContrast(colors.primary));
}

type SectionId =
  | "clip-hunting"
  | "downloader"
  | "audio-extraction"
  | "video-conversion"
  | "audio-conversion"
  | "logs"
  | "settings";

type NavItem = {
  id: SectionId;
  label: string;
  short: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
};

type AudioTab = "extract" | "history";
type DownloaderTab = "anime" | "youtube";

type ClipPreviewItem = {
  id: string;
  index: number;
  label: string;
  range: string;
  sourceName: string;
  sourceSrc: string;
  sourceStart: number;
  sourceEnd: number;
  previewStart: number;
  previewEnd: number;
  previewState?: ClipPreviewState;
  fps: number;
  path?: string;
};

type ClipPreviewState = {
  status: "rendering" | "ready" | "error";
  path?: string;
  src?: string;
  duration?: number;
  error?: string;
};

type ClipPreviewBatchResult = {
  type: "done";
  items: Array<{
    sceneId: string;
    path?: string | null;
    duration: number;
    cached: boolean;
    error?: string | null;
  }>;
};

type ClipVideoRange = {
  id: string;
  src: string;
  start: number;
  end: number;
};

type ClipScene = {
  source: string;
  start: number;
  end: number;
  index: number;
  label: string;
};

type ClipProgress = {
  type: "progress";
  stage: string;
  percent: number;
  message: string;
  elapsedSeconds?: number;
};

type ClipBatchProgressContext = {
  activeIndex: number;
  total: number;
  inputPath: string;
};

type ClipExtractionResult = {
  type: "done";
  mode?: "cpu" | "gpu";
  input: string;
  scenes: ClipScene[];
  cuts: number[];
  sceneCount: number;
  fps: number;
  duration: number;
  totalSeconds: number;
};

type ClipAudioSettings = {
  muted: boolean;
  volume: number;
};

type AppThemeId = "cyan" | "mint" | "violet" | "rose" | "amber" | "custom";

const APP_THEMES: Array<{ id: Exclude<AppThemeId, "custom">; colors: [string, string] }> = [
  { id: "cyan", colors: ["#48d7ff", "#63e6a2"] },
  { id: "mint", colors: ["#63e6a2", "#48d7ff"] },
  { id: "violet", colors: ["#a98cff", "#48d7ff"] },
  { id: "rose", colors: ["#ff6d91", "#a98cff"] },
  { id: "amber", colors: ["#f4c267", "#ff6d91"] },
];

const CLIP_AUDIO_SETTINGS_KEY = "ultimate-amv.clip-audio-settings";
const CLIP_COLUMN_OPTIONS = [1, 2, 3, 4] as const;
const MAX_GRID_AUTOPLAYERS = 100;
const CLIP_PREVIEW_BATCH_SIZE = 8;
const CLIP_PREVIEW_CPU_BATCH_CONCURRENCY = 2;
const CLIP_PREVIEW_GPU_BATCH_CONCURRENCY = 3;

type AudioStatus = {
  type: "status";
  hardware: {
    device: string;
    device_short: string;
    gpu_type: string;
    fp16_capable: boolean;
    provider: string;
    vram?: string | null;
  };
  dependencies: {
    audio_separator: boolean;
    pydub: boolean;
    typing_extensions: boolean;
    torch: boolean;
    torch_version?: string | null;
    onnxruntime: boolean;
    onnxruntime_version?: string | null;
    runtime_ready: boolean;
    ready: boolean;
  };
  model_name: string;
};

type AudioProgress = {
  type: "progress";
  stage: string;
  percent: number;
  message: string;
};

type AudioSetupProgress = {
  type: "setup-progress";
  step: number;
  total: number;
  state: "running" | "done" | "error";
  message: string;
};

type AudioSetupPlan = {
  type: "setup-plan";
  mode: "cpu" | "gpu";
  rows: Array<{
    component: string;
    status: string;
  }>;
  issues: string[];
  installs: string[][];
  success_mode: "cpu" | "gpu" | null;
  gpu_name?: string | null;
};

type AudioHistoryItem = {
  created_at: string;
  input: string;
  outputs: string[];
  original_backup?: string | null;
  model: string;
  device: string;
};

type ConversionProgress = {
  stage: string;
  percent?: number | null;
  message: string;
  fps?: string | null;
  speed?: string | null;
};

type ConversionDone = {
  type: "done";
  input: string;
  output: string;
  archivedOriginal?: string | null;
  preset: string;
};

type BatchItemStatus = {
  input: string;
  output?: string;
  outputs?: string[];
  status: "done" | "error";
  message?: string;
};

type AudioOutputFormat = "wav" | "mp3";
type VideoTranscodePreset = "gpu-intra" | "prores-lt" | "prores-hq";
type ClipExportFormat = "gpu-intra" | "prores-lt" | "prores-hq" | "h264-nvenc" | "av1-nvenc" | "h264-cpu" | "hevc-cpu";

type VideoControlSpec = {
  label: string;
  valueLabel: string;
  help: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  suffix: string;
};

type VideoGpuStatus = {
  compatible: boolean;
  gpuName?: string | null;
  hasNvidiaGpu: boolean;
  hasFfmpeg: boolean;
  hasFfprobe: boolean;
  hasH264Cuvid: boolean;
  hasHevcCuvid: boolean;
  hasHevcNvenc: boolean;
  hasH264Nvenc: boolean;
  hasAv1Nvenc: boolean;
  message: string;
};

let cachedAudioStatus: AudioStatus | null = null;
let pendingAudioStatus: Promise<AudioStatus> | null = null;

type MediaCandidate = {
  url: string;
  kind: string;
};

type MediaRequestDebug = {
  url: string;
  count: number;
  interesting: boolean;
};

type ProviderNavigation = {
  url: string;
};

type ProviderPageIdentity = {
  animeTitle?: string | null;
  episodeNumber?: string | null;
  episodeLabel?: string | null;
  sourcePage?: string | null;
};

type DownloadProgress = {
  jobId?: string | null;
  stage: string;
  percent?: number | null;
  message: string;
  warning?: string | null;
};

type DownloadIdentity = {
  animeTitle?: string | null;
  episodeNumber?: string | null;
  episodeLabel?: string | null;
  qualityLabel?: string | null;
  sourcePage: string;
};

type StreamQuality = {
  id: string;
  label: string;
  url: string;
  width?: number | null;
  height?: number | null;
  bitrate?: number | null;
  codec?: string | null;
};

type CaptureState = "armed" | "inspecting" | "detected" | "downloading" | "consumed";

type DownloadFormat = {
  id: string;
  label: string;
  ext?: string | null;
  resolution?: string | null;
  width?: number | null;
  height?: number | null;
  bitrate?: number | null;
  filesize?: number | null;
  vcodec?: string | null;
  acodec?: string | null;
  audioOnly: boolean;
};

type DownloadHistoryItem = {
  id: string;
  createdAt: string;
  kind: string;
  title: string;
  subtitle?: string | null;
  qualityLabel?: string | null;
  url: string;
  referer?: string | null;
  formatId?: string | null;
  outputPath: string;
  sourcePage?: string | null;
};

type DownloadQueueItem = {
  id: string;
  kind: "anime" | "youtube";
  title: string;
  subtitle?: string | null;
  qualityLabel?: string | null;
  url: string;
  referer?: string | null;
  sourcePage?: string | null;
  formatId?: string | null;
  folderName?: string | null;
  status: "queued" | "downloading" | "done" | "error" | "cancelled";
  progress?: DownloadProgress | null;
  outputPath?: string | null;
  error?: string | null;
  warning?: string | null;
  createdAt: number;
};

type AnimeResult = {
  mal_id: number;
  title: string;
  title_english?: string | null;
  title_japanese?: string | null;
  synopsis?: string | null;
  episodes?: number | null;
  score?: number | null;
  year?: number | null;
  status?: string | null;
  type?: string | null;
  rating?: string | null;
  duration?: string | null;
  url?: string;
  images?: {
    jpg?: {
      image_url?: string;
      large_image_url?: string;
    };
    webp?: {
      image_url?: string;
      large_image_url?: string;
    };
  };
  trailer?: {
    youtube_id?: string | null;
    url?: string | null;
    embed_url?: string | null;
  };
};

type AnimeEpisode = {
  mal_id: number;
  title: string;
  title_japanese?: string | null;
  title_romanji?: string | null;
  aired?: string | null;
  score?: number | null;
  filler?: boolean;
  recap?: boolean;
  url?: string;
};

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

function App() {
  const [expanded, setExpanded] = React.useState(true);
  const [active, setActive] = React.useState<SectionId>("clip-hunting");
  const [audioTab, setAudioTab] = React.useState<AudioTab>("extract");
  const [downloaderTab, setDownloaderTab] = React.useState<DownloaderTab>("anime");
  const activeMeta = panelMeta[active];
  const isAudioExtraction = active === "audio-extraction";
  const isClipHunting = active === "clip-hunting";
  const isDownloader = active === "downloader";
  const isAudioConversion = active === "audio-conversion";
  const isVideoConversion = active === "video-conversion";
  const isLogs = active === "logs";
  const isSettings = active === "settings";

  React.useEffect(() => {
    applyAppTheme(readThemeColors(null));
    invoke<string>("get_config")
      .then((raw) => {
        const payload = parseBridgePayload<AppConfig>(raw);
        applyAppTheme(readThemeColors(payload));
      })
      .catch((error) => {
        logFrontend("warn", "frontend.theme.config.error", "Could not load saved theme", {
          error: safeLogValue(error),
        });
      });

    const onThemeChanged = (event: Event) => {
      const colors = (event as CustomEvent<{ primary?: unknown; secondary?: unknown }>).detail;
      applyAppTheme({
        primary: isHexColor(colors?.primary) ? colors.primary : APP_THEMES[0].colors[0],
        secondary: isHexColor(colors?.secondary) ? colors.secondary : APP_THEMES[0].colors[1],
      });
    };
    window.addEventListener("theme-changed", onThemeChanged);
    return () => window.removeEventListener("theme-changed", onThemeChanged);
  }, []);

  const modeTabs = isAudioExtraction
    ? ([
      { id: "extract", label: "Extract" },
      { id: "history", label: "History" },
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
            ? ([{ id: "extractor", label: "Clip extractor" }] as const)
          : isAudioConversion || isVideoConversion
            ? ([{ id: "convert", label: "Convert" }] as const)
            : ([
              { id: "media", label: "Media browser" },
              { id: "clip", label: "Clip extraction" },
            ] as const);

  return (
    <main className="desktop">
      <WindowChrome />
      <section className={`app-shell ${expanded ? "is-expanded" : "is-compact"}`}>
        <aside className="sidebar" aria-label="Primary navigation">
          <div className="brand-strip">
            <button
              type="button"
              className="icon-button collapse-button"
              aria-label={expanded ? "Compact sidebar" : "Expand sidebar"}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? <ChevronsLeft size={19} /> : <ChevronsRight size={19} />}
            </button>
            <div className="brand-cluster">
              <div className="brand-copy">
                <span className="brand-name">Ultimate AMV</span>
                <span className="brand-subtitle">Editor workspace</span>
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
              className={`settings-button ${active === "logs" ? "is-active" : ""}`}
              aria-label="Logs"
              onClick={() => setActive("logs")}
            >
              <ScrollText size={21} strokeWidth={2.05} />
              <span>Logs</span>
            </button>

            <button
              type="button"
              className={`settings-button ${active === "settings" ? "is-active" : ""}`}
              aria-label="Settings"
              onClick={() => setActive("settings")}
            >
              <Settings size={22} strokeWidth={2.15} />
              <span>Settings</span>
            </button>
          </div>
        </aside>

        <section className="workspace">
          <div className="canvas">
            <div className="canvas-grid" aria-hidden="true" />
            <div className="focus-panel">
              <div className="mode-switcher" aria-label="Workspace mode">
                {modeTabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    className={`mode-tab ${isAudioExtraction
                        ? audioTab === tab.id
                          ? "is-active"
                          : ""
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
                      if (isAudioExtraction && (tab.id === "extract" || tab.id === "history")) {
                        setAudioTab(tab.id);
                      }
                      if (isDownloader && (tab.id === "anime" || tab.id === "youtube")) {
                        setDownloaderTab(tab.id);
                      }
                    }}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
              <div className="panel-body">
                <div className={`panel-view ${isClipHunting ? "is-active" : "is-hidden"}`} aria-hidden={!isClipHunting}>
                  <ClipExtractorPanel active={isClipHunting} />
                </div>
                <div className={`panel-view ${isDownloader ? "is-active" : "is-hidden"}`} aria-hidden={!isDownloader}>
                  <DownloaderPanel active={isDownloader} activeTab={downloaderTab} sidebarExpanded={expanded} />
                </div>
                <div className={`panel-view ${isAudioExtraction ? "is-active" : "is-hidden"}`} aria-hidden={!isAudioExtraction}>
                  <AudioExtractionPanel activeTab={audioTab} />
                </div>
                {!isClipHunting && !isDownloader && !isAudioExtraction && (
                  <div className="panel-view is-active">
                    {isAudioConversion ? <MediaToAudioPanel />
                      : isVideoConversion ? <VideoToVideoPanel />
                        : isLogs ? <LogsPanel />
                          : isSettings ? <SettingsPanel />
                            : (
                              <div className="empty-surface">
                                <div className="surface-mark">
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

function DownloaderPanel({
  active,
  activeTab,
  sidebarExpanded,
}: {
  active: boolean;
  activeTab: DownloaderTab;
  sidebarExpanded: boolean;
}) {
  const [queue, setQueue] = React.useState<DownloadQueueItem[]>([]);
  const [history, setHistory] = React.useState<DownloadHistoryItem[]>([]);
  const activeJobIdRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    void refreshDownloadHistory();
  }, []);

  React.useEffect(() => {
    const unlisteners: Array<() => void> = [];
    void listen<DownloadProgress>("download-progress", (event) => {
      const jobId = event.payload.jobId ?? activeJobIdRef.current;
      if (!jobId) return;
      setQueue((current) => current.map((job) => (
        job.id === jobId
          ? {
            ...job,
            progress: event.payload,
            warning: event.payload.warning ?? job.warning ?? null,
          }
          : job
      )));
    }).then((unlisten) => unlisteners.push(unlisten));
    return () => unlisteners.forEach((unlisten) => unlisten());
  }, []);

  React.useEffect(() => {
    if (!activeJobIdRef.current) {
      const next = queue.find((job) => job.status === "queued");
      if (next) {
        void startQueuedDownload(next);
      }
    }
  }, [queue]);

  async function refreshDownloadHistory() {
    try {
      const payload = await invoke<DownloadHistoryItem[]>("download_history");
      setHistory(payload);
    } catch (error) {
      logFrontend("warn", "frontend.download.history.error", "Could not load download history", {
        error: safeLogValue(error),
      });
    }
  }

  function enqueueDownload(item: Omit<DownloadQueueItem, "id" | "status" | "createdAt">) {
    const id = `dl-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setQueue((current) => [
      ...current,
      {
        ...item,
        id,
        status: "queued",
        createdAt: Date.now(),
        progress: { jobId: id, stage: "queued", percent: null, message: "Waiting for current download..." },
      },
    ]);
    return id;
  }

  async function startQueuedDownload(job: DownloadQueueItem) {
    activeJobIdRef.current = job.id;
    setQueue((current) => current.map((item) => (
      item.id === job.id
        ? { ...item, status: "downloading", progress: { jobId: job.id, stage: "starting", percent: 0, message: "Starting download..." } }
        : item
    )));

    try {
      const configRaw = await invoke<string>("get_config");
      const config = parseBridgePayload<AppConfig>(configRaw);
      const savedPath = job.kind === "anime"
        ? await invoke<string>("download_stream", {
          jobId: job.id,
          url: job.url,
          referer: job.referer || job.sourcePage || "",
          animeTitle: job.title,
          episodeNumber: extractEpisodeNumber(job.subtitle ?? ""),
          episodeLabel: job.subtitle,
          qualityLabel: job.qualityLabel,
          sourcePage: job.sourcePage || job.referer || job.url,
          downloadDir: config.download_path || undefined,
        })
        : await invoke<string>("download_media", {
          jobId: job.id,
          url: job.url,
          referer: job.referer || undefined,
          formatId: job.formatId || undefined,
          title: job.title,
          subtitle: job.subtitle || undefined,
          qualityLabel: job.qualityLabel || undefined,
          sourcePage: job.sourcePage || job.url,
          downloadDir: config.download_path || undefined,
          kind: job.kind,
          folderName: job.folderName || undefined,
        });

      setQueue((current) => current.map((item) => (
        item.id === job.id
          ? {
            ...item,
            status: "done",
            outputPath: savedPath,
            progress: { jobId: job.id, stage: "done", percent: 100, message: savedPath },
          }
          : item
      )));
      if (job.kind === "anime" && config.clip_extraction_mode !== "cpu") {
        void invoke("warmup_clip_server").catch(() => {});
      }
      void refreshDownloadHistory();
    } catch (error) {
      const message = String(error);
      setQueue((current) => current.map((item) => (
        item.id === job.id
          ? {
            ...item,
            status: message.toLowerCase().includes("cancel") ? "cancelled" : "error",
            error: message,
            progress: { jobId: job.id, stage: "error", percent: null, message },
          }
          : item
      )));
    } finally {
      activeJobIdRef.current = null;
    }
  }

  function cancelQueuedDownload(job: DownloadQueueItem) {
    if (job.status === "downloading") {
      void invoke("cancel_download");
      setQueue((current) => current.map((item) => (
        item.id === job.id
          ? { ...item, progress: { jobId: job.id, stage: "cancelling", percent: item.progress?.percent ?? null, message: "Cancelling..." } }
          : item
      )));
      return;
    }
    setQueue((current) => current.map((item) => (
      item.id === job.id
        ? { ...item, status: "cancelled", progress: { jobId: job.id, stage: "cancelled", percent: null, message: "Removed from queue." } }
        : item
    )));
  }

  function redownload(item: DownloadHistoryItem) {
    enqueueDownload({
      kind: item.kind === "anime" ? "anime" : "youtube",
      title: item.title,
      subtitle: item.subtitle,
      qualityLabel: item.qualityLabel,
      url: item.url,
      referer: item.referer,
      sourcePage: item.sourcePage,
      formatId: item.formatId,
      folderName: item.kind === "anime" ? null : "youtube downloads",
      progress: null,
      outputPath: null,
      error: null,
    });
  }

  const visibleQueue = queue.filter((job) => job.status !== "cancelled" || job.progress?.stage === "cancelled");

  return (
    <section className="downloader-workspace">
      <div className={`downloader-panel ${activeTab === "anime" ? "is-active" : "is-hidden"}`}>
        <AnikaiBrowser active={active && activeTab === "anime"} sidebarExpanded={sidebarExpanded} enqueueDownload={enqueueDownload} />
      </div>
      <div className={`downloader-panel ${activeTab === "youtube" ? "is-active" : "is-hidden"}`}>
        <YoutubeDownloaderPanel enqueueDownload={enqueueDownload} history={history} onRedownload={redownload} />
      </div>
      <DownloadQueuePanel queue={visibleQueue} onCancel={cancelQueuedDownload} />
    </section>
  );
}

function AnikaiBrowser({
  active,
  sidebarExpanded,
  enqueueDownload,
}: {
  active: boolean;
  sidebarExpanded: boolean;
  enqueueDownload: (item: Omit<DownloadQueueItem, "id" | "status" | "createdAt">) => string;
}) {
  const frameRef = React.useRef<HTMLDivElement | null>(null);
  const webviewRef = React.useRef<Webview | null>(null);
  const activeRef = React.useRef(active);
  const createRunRef = React.useRef(0);
  const inspectRunRef = React.useRef(0);
  const captureStateRef = React.useRef<CaptureState>("armed");
  const episodeLabelTouchedRef = React.useRef(false);
  const seenCandidateUrlsRef = React.useRef<Set<string>>(new Set());
  const [providerUrl, setProviderUrl] = React.useState("https://anikai.to");
  const [address, setAddress] = React.useState("https://anikai.to");
  const [loadedUrl, setLoadedUrl] = React.useState("https://anikai.to");
  const [currentPageUrl, setCurrentPageUrl] = React.useState("https://anikai.to");
  const [reloadKey, setReloadKey] = React.useState(0);
  const [status, setStatus] = React.useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = React.useState("Starting provider view...");
  const [mediaCandidates, setMediaCandidates] = React.useState<MediaCandidate[]>([]);
  const [streamQualities, setStreamQualities] = React.useState<StreamQuality[]>([]);
  const [selectedQualityUrl, setSelectedQualityUrl] = React.useState("");
  const [qualityMenuOpen, setQualityMenuOpen] = React.useState(false);
  const [captureState, setCaptureState] = React.useState<CaptureState>("armed");
  const [recentRequests, setRecentRequests] = React.useState<MediaRequestDebug[]>([]);
  const [requestCount, setRequestCount] = React.useState(0);
  const [snifferMessage, setSnifferMessage] = React.useState("Play an episode to detect a stream.");
  const [downloadProgress, setDownloadProgress] = React.useState<DownloadProgress | null>(null);
  const [downloadError, setDownloadError] = React.useState<string | null>(null);
  const [inspectError, setInspectError] = React.useState<string | null>(null);
  const [activeDownloadLabel, setActiveDownloadLabel] = React.useState<string | null>(null);
  const [providerIdentity, setProviderIdentity] = React.useState<ProviderPageIdentity | null>(null);
  const [episodeLabelInput, setEpisodeLabelInput] = React.useState("");

  React.useEffect(() => {
    captureStateRef.current = captureState;
  }, [captureState]);

  React.useEffect(() => {
    activeRef.current = active;
  }, [active]);

  const handleWebviewLayoutError = React.useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("webview not found")) {
      return;
    }
    logFrontend("warn", "frontend.webview.layout.error", "Could not update provider WebView layout", {
      error: safeLogValue(error),
    });
  }, []);

  const syncWebviewBounds = React.useCallback(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    try {
      const frame = frameRef.current;
      const webview = webviewRef.current;
      if (!activeRef.current || !frame || !webview) return;

      const rect = frame.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      await webview.setPosition(new LogicalPosition(Math.round(rect.left), Math.round(rect.top)));
      if (webviewRef.current !== webview) return;
      await webview.setSize(new LogicalSize(width, height));
    } catch (error) {
      handleWebviewLayoutError(error);
    }
  }, [handleWebviewLayoutError]);

  const nudgeWebviewViewport = React.useCallback(async () => {
    try {
      const frame = frameRef.current;
      const webview = webviewRef.current;
      if (!activeRef.current || !frame || !webview) return;

      const rect = frame.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(2, Math.round(rect.height));
      const position = new LogicalPosition(Math.round(rect.left), Math.round(rect.top));
      await webview.setPosition(position);
      if (webviewRef.current !== webview) return;
      await webview.setSize(new LogicalSize(width, height - 1));
      if (webviewRef.current !== webview) return;
      await webview.setSize(new LogicalSize(width, height));
    } catch (error) {
      handleWebviewLayoutError(error);
    }
  }, [handleWebviewLayoutError]);

  const parkWebview = React.useCallback(async () => {
    const webview = webviewRef.current;
    if (!webview) return;

    await webview.hide().catch(() => undefined);
    try { await webview.setPosition(new LogicalPosition(-32000, -32000)); } catch { }
    try { await webview.setSize(new LogicalSize(1, 1)); } catch { }
  }, []);

  React.useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    if (active) {
      void webview.show().then(() => syncWebviewBounds()).catch(() => undefined);
    } else {
      void parkWebview().catch(() => undefined);
    }
  }, [active, parkWebview, syncWebviewBounds]);

  React.useEffect(() => {
    if (!active) return;

    const timers = [0, 80, 180, 320, 420].map((delay) =>
      window.setTimeout(() => {
        void syncWebviewBounds();
      }, delay),
    );
    const nudgeTimer = window.setTimeout(() => {
      void nudgeWebviewViewport();
    }, 360);

    return () => {
      timers.forEach(window.clearTimeout);
      window.clearTimeout(nudgeTimer);
    };
  }, [active, sidebarExpanded, nudgeWebviewViewport, syncWebviewBounds]);

  function resetCaptureState(nextMessage = "Stream detector armed. Start playback to catch the media URL.") {
    inspectRunRef.current += 1;
    seenCandidateUrlsRef.current = new Set();
    setMediaCandidates([]);
    setStreamQualities([]);
    setSelectedQualityUrl("");
    setQualityMenuOpen(false);
    setRecentRequests([]);
    setRequestCount(0);
    setDownloadProgress(null);
    setDownloadError(null);
    setInspectError(null);
    setActiveDownloadLabel(null);
    setProviderIdentity(null);
    setEpisodeLabelInput("");
    episodeLabelTouchedRef.current = false;
    setCaptureState("armed");
    setSnifferMessage(nextMessage);
  }

  React.useEffect(() => {
    const unlisteners: Array<() => void> = [];
    void listen<MediaCandidate>("media-candidate", (event) => {
      if (captureStateRef.current === "downloading") {
        return;
      }
      const url = event.payload.url;
      const isNewUrl = !seenCandidateUrlsRef.current.has(url);
      if (isNewUrl) {
        seenCandidateUrlsRef.current.add(url);
      }
      setMediaCandidates((current) => {
        if (current.some((candidate) => candidate.url === url)) return current;
        return [event.payload, ...current].slice(0, 8);
      });
      if (isNewUrl) {
        inspectRunRef.current += 1;
        setStreamQualities([]);
        setSelectedQualityUrl("");
        setInspectError(null);
        setDownloadError(null);
        setDownloadProgress(null);
        setActiveDownloadLabel(null);
      }
      setCaptureState("detected");
      setSnifferMessage(`${event.payload.kind.toUpperCase()} stream detected.`);
    }).then((unlisten) => unlisteners.push(unlisten));

    void listen<string>("media-sniffer-error", (event) => {
      setSnifferMessage(`Stream detector error: ${event.payload}`);
    }).then((unlisten) => unlisteners.push(unlisten));

    void listen<MediaRequestDebug>("media-request-debug", (event) => {
      setRequestCount(event.payload.count);
      setRecentRequests((current) => [event.payload, ...current].slice(0, 5));
    }).then((unlisten) => unlisteners.push(unlisten));

    void listen("media-sniffer-ready", () => {
      setSnifferMessage("Stream detector armed. Start playback to catch the media URL.");
    }).then((unlisten) => unlisteners.push(unlisten));

    void listen<ProviderNavigation>("provider-navigation", (event) => {
      if (captureStateRef.current === "downloading") return;
      if (!isAllowedAnikaiUrl(event.payload.url)) {
        setSnifferMessage("Blocked navigation outside AniKai.");
        return;
      }
      setAddress(event.payload.url);
      setCurrentPageUrl(event.payload.url);
      resetCaptureState("Page changed. Start playback to detect this episode stream.");
    }).then((unlisten) => unlisteners.push(unlisten));

    void listen<ProviderPageIdentity>("provider-page-identity", (event) => {
      const nextIdentity = event.payload;
      setProviderIdentity((current) => mergeProviderIdentity(current, nextIdentity));
      if (!episodeLabelTouchedRef.current) {
        const nextLabel = cleanIdentityText(nextIdentity.episodeLabel)
          ?? (cleanIdentityText(nextIdentity.episodeNumber) ? `Episode ${cleanIdentityText(nextIdentity.episodeNumber)}` : null);
        if (nextLabel) {
          setEpisodeLabelInput(nextLabel);
        }
      }
    }).then((unlisten) => unlisteners.push(unlisten));

    return () => {
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    let resizeObserver: ResizeObserver | null = null;
    const createRun = createRunRef.current + 1;
    createRunRef.current = createRun;
    const label = `anikai-provider-${createRun}`;

    async function createProviderView() {
      setStatus("loading");
      setMessage("Loading AniKai inside the app...");
      resetCaptureState("Loading page. Start playback after it opens.");
      try {
        const frame = frameRef.current;
        if (!frame) return;

        const existingViews = await Webview.getAll();
        await Promise.all(
          existingViews
            .filter((view) => view.label.startsWith("anikai-provider"))
            .map((view) => view.close().catch(() => undefined)),
        );

        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        if (cancelled || createRunRef.current !== createRun) return;

        const rect = frame.getBoundingClientRect();
        const webview = new Webview(getCurrentWindow(), label, {
          url: normalizeUrl(loadedUrl),
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.max(1, Math.round(rect.width)),
          height: Math.max(1, Math.round(rect.height)),
          focus: true,
          zoomHotkeysEnabled: true,
          devtools: true,
          backgroundColor: [15, 20, 24],
        });

        webviewRef.current = webview;
        webview.once("tauri://created", () => {
          if (cancelled || createRunRef.current !== createRun || webviewRef.current !== webview) return;
          setStatus("ready");
          setMessage("AniKai is running in a native WebView.");
          if (activeRef.current) {
            void syncWebviewBounds();
            window.setTimeout(() => {
              if (cancelled || createRunRef.current !== createRun || webviewRef.current !== webview) return;
              void nudgeWebviewViewport();
            }, 80);
            window.setTimeout(() => {
              if (cancelled || createRunRef.current !== createRun || webviewRef.current !== webview) return;
              void syncWebviewBounds();
            }, 180);
          } else {
            void parkWebview().catch(() => undefined);
          }
          void invoke("install_media_sniffer", { label }).catch((error) => {
            setSnifferMessage(`Stream detector error: ${String(error)}`);
          });
        });
        webview.once("tauri://error", (event) => {
          if (cancelled || createRunRef.current !== createRun || webviewRef.current !== webview) return;
          setStatus("ready");
          setMessage(String(event.payload ?? "AniKai is visible; WebView reported non-blocking setup noise."));
        });

        resizeObserver = new ResizeObserver(() => {
          void syncWebviewBounds();
        });
        resizeObserver.observe(frame);
        const browserHost = frame.parentElement;
        if (browserHost) resizeObserver.observe(browserHost);
        window.addEventListener("resize", syncWebviewBounds);
        window.addEventListener("scroll", syncWebviewBounds, true);
      } catch (error) {
        if (cancelled || createRunRef.current !== createRun) return;
        setStatus("error");
        setMessage(error instanceof Error ? error.message : String(error));
      }
    }

    void createProviderView();

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      window.removeEventListener("resize", syncWebviewBounds);
      window.removeEventListener("scroll", syncWebviewBounds, true);
      const webview = webviewRef.current;
      webviewRef.current = null;
      void webview?.close().catch(() => undefined);
    };
  }, [loadedUrl, parkWebview, reloadKey, nudgeWebviewViewport, syncWebviewBounds]);

  const bestCandidate = mediaCandidates.find((candidate) => candidate.kind === "hls") ?? mediaCandidates[0] ?? null;
  const candidateSignature = mediaCandidates.map((candidate) => candidate.url).join("\n");
  const selectedQuality =
    streamQualities.find((quality) => quality.url === selectedQualityUrl) ??
    streamQualities[0] ??
    (bestCandidate
      ? {
        id: "captured",
        label: `${bestCandidate.kind.toUpperCase()} playback stream`,
        url: bestCandidate.url,
        width: null,
        height: null,
        bitrate: null,
        codec: null,
      }
      : null);
  const canDownload = captureState === "detected" && Boolean(selectedQuality);

  React.useEffect(() => {
    if (
      mediaCandidates.length === 0 ||
      captureStateRef.current === "consumed" ||
      captureStateRef.current === "downloading"
    ) {
      return;
    }

    const run = inspectRunRef.current + 1;
    inspectRunRef.current = run;
    const candidates = [...mediaCandidates].sort((left, right) => {
      if (left.kind === right.kind) return 0;
      return left.kind === "hls" ? -1 : 1;
    }).slice(0, 4);

    const timer = window.setTimeout(() => {
      setCaptureState("inspecting");
      setInspectError(null);
      setStreamQualities([]);
      setSelectedQualityUrl("");

      void (async () => {
        const mergedQualities: StreamQuality[] = [];
        const seenQualityUrls = new Set<string>();
        let fallbackUrl = candidates[0]?.url ?? "";
        let lastError = "";

        const results = await Promise.allSettled(
          candidates.map((candidate) =>
            invoke<StreamQuality[]>("inspect_stream", {
              url: candidate.url,
              referer: currentPageUrl,
            }).then((qualities) => ({ candidate, qualities })),
          ),
        );
        if (inspectRunRef.current !== run) return;

        for (const result of results) {
          if (result.status === "rejected") {
            lastError = String(result.reason);
            continue;
          }
          const { candidate, qualities } = result.value;
          if (qualities.length === 0) continue;
          if (isBetterQualitySet(qualities, mergedQualities)) {
            fallbackUrl = candidate.url;
          }
          for (const quality of qualities) {
            if (seenQualityUrls.has(quality.url)) continue;
            seenQualityUrls.add(quality.url);
            mergedQualities.push(quality);
          }
        }

        if (inspectRunRef.current !== run) return;
        if (mergedQualities.length > 0) {
          const bestQualities = mergedQualities.sort(compareStreamQualities);
          setStreamQualities(bestQualities);
          setSelectedQualityUrl((current) => (
            current && bestQualities.some((quality) => quality.url === current)
              ? current
              : bestQualities[0]?.url ?? fallbackUrl
          ));
          setCaptureState("detected");
          setQualityMenuOpen(bestQualities.length > 1);
          setSnifferMessage(
            bestQualities.length > 1
              ? `${bestQualities.length} stream qualities found.`
              : "Captured playback stream is ready.",
          );
        } else {
          setInspectError(lastError || "No quality metadata was returned.");
          setSelectedQualityUrl(fallbackUrl);
          setCaptureState("detected");
          setSnifferMessage("Could not inspect variants; captured playback stream is ready.");
        }
      })();
    }, 450);

    return () => {
      window.clearTimeout(timer);
      if (inspectRunRef.current === run) {
        inspectRunRef.current += 1;
      }
    };
  }, [candidateSignature, currentPageUrl]);

  async function downloadBestCandidate() {
    if (!selectedQuality) return;
    const target = selectedQuality;
    const baseIdentity = buildAnikaiDownloadIdentity(currentPageUrl, target.label, providerIdentity);
    const editedEpisodeLabel = cleanIdentityText(episodeLabelInput);
    const identity = {
      ...baseIdentity,
      episodeLabel: editedEpisodeLabel ?? baseIdentity.episodeLabel,
      episodeNumber: editedEpisodeLabel
        ? extractEpisodeNumber(editedEpisodeLabel)
        : baseIdentity.episodeNumber,
    };
    setDownloadError(null);
    setQualityMenuOpen(false);
    setActiveDownloadLabel(formatDownloadIdentity(identity, target.label));
    setCaptureState("detected");
    setDownloadProgress({
      stage: "queued",
      percent: null,
      message: `${formatDownloadIdentity(identity, target.label)} added to the download queue.`,
    });
    enqueueDownload({
      kind: "anime",
      title: identity.animeTitle ?? "Unknown anime",
      subtitle: identity.episodeLabel,
      qualityLabel: identity.qualityLabel,
      url: target.url,
      referer: currentPageUrl,
      sourcePage: identity.sourcePage,
      folderName: null,
      formatId: null,
      progress: null,
      outputPath: null,
      error: null,
    });
    setSelectedQualityUrl(target.url);
    setSnifferMessage("Download queued. You can open another episode and add it while this queue runs.");
  }

  return (
    <div className="anikai-browser">
      <div className="provider-toolbar">
        <div className={`provider-status is-${status}`}>
          <span />
          {status === "ready" ? "Live" : status === "loading" ? "Loading" : "Error"}
        </div>
        <select
          value={providerUrl}
          onChange={(e) => {
            const url = e.target.value;
            setProviderUrl(url);
            setAddress(url);
            setLoadedUrl(url);
            setReloadKey((k) => k + 1);
          }}
          className="provider-select"
        >
          <option value="https://anikai.to">AniKai</option>
          <option value="https://aniwaves.ru">AniWaves</option>
        </select>
        <input
          value={address}
          aria-label="Provider address"
          className="locked-provider-address"
          readOnly
          spellCheck={false}
        />
        <button
          type="button"
          onClick={() => {
            resetCaptureState("Reloading page. Start playback after it opens.");
            setLoadedUrl(currentPageUrl);
            setReloadKey((value) => value + 1);
          }}
        >
          <RefreshCw size={15} />
          Reload
        </button>
      </div>

      <div className="provider-webview-frame" ref={frameRef}>
        <div className="provider-webview-placeholder">
          <Loader2 size={22} className={status === "loading" ? "is-spinning" : ""} />
          <span>{message}</span>
        </div>
      </div>

      <section
        className="stream-capture-bar"
        aria-label="Detected stream"
      >
        <div className="stream-capture-row">
          <div className="stream-capture-copy">
            <span>
              {captureState === "downloading"
                ? `Downloading ${activeDownloadLabel ?? "stream"}`
                : captureState === "consumed"
                  ? "Capture used"
                  : captureState === "inspecting"
                    ? "Inspecting qualities"
                    : selectedQuality
                      ? selectedQuality.label
                      : "No stream yet"}
            </span>
            <strong>
              {selectedQuality
                ? selectedQuality.url
                : `${snifferMessage} Requests seen: ${requestCount}`}
            </strong>
            {!bestCandidate && recentRequests[0] && (
              <small>
                Last {recentRequests[0].interesting ? "interesting" : "sample"} request: {recentRequests[0].url}
              </small>
            )}
            {inspectError && <small className="stream-warning">Quality scan failed: {inspectError}</small>}
            {downloadProgress && (
              <small>
                {downloadProgress.stage === "done"
                  ? "Done - "
                  : downloadProgress.stage === "finalizing"
                    ? "Finalizing - "
                    : downloadProgress.percent != null
                      ? `${downloadProgress.percent.toFixed(1)}% - `
                      : ""}
                {downloadProgress.message}
              </small>
            )}
            {downloadError && <small className="stream-error">{downloadError}</small>}
            {captureState === "consumed" && !downloadError && (
              <small>Open another episode, reload, or return to this page to arm detection again.</small>
            )}
            {downloadProgress && downloadProgress.stage !== "done" && captureState === "downloading" && (
              <div
                className={`stream-progress-track ${downloadProgress.percent == null ? "is-indeterminate" : ""}`}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={downloadProgress.percent == null ? undefined : downloadProgress.percent}
              >
                <div
                  className="stream-progress-fill"
                  style={
                    downloadProgress.percent == null
                      ? undefined
                      : { width: `${Math.max(0, Math.min(100, downloadProgress.percent))}%` }
                  }
                />
              </div>
            )}
          </div>
          <label
            className={`episode-label-editor${
              providerIdentity?.episodeNumber ? " is-detected" : " is-unknown"
            }`}
          >
            <span>Episode</span>
            <input
              value={episodeLabelInput}
              placeholder={providerIdentity?.episodeLabel ?? "Episode unknown - confirm manually"}
              disabled={captureState === "downloading"}
              onChange={(event) => {
                episodeLabelTouchedRef.current = true;
                setEpisodeLabelInput(event.target.value);
              }}
            />
            <small className="episode-label-hint">
              {providerIdentity?.episodeNumber
                ? `Detected: ${providerIdentity.episodeLabel ?? `Episode ${providerIdentity.episodeNumber}`}`
                : "Detection failed - confirm episode before downloading"}
            </small>
          </label>
          <div className="quality-picker">
            <button
              type="button"
              disabled={streamQualities.length <= 1 || captureState === "downloading"}
              onClick={() => setQualityMenuOpen((value) => !value)}
            >
              {streamQualities.length > 1 ? `${streamQualities.length} qualities` : "Quality"}
            </button>
          </div>
          <button type="button" disabled={!selectedQuality} onClick={() => selectedQuality && navigator.clipboard?.writeText(selectedQuality.url)}>
            Copy
          </button>
          <button type="button" disabled={!canDownload} onClick={() => void downloadBestCandidate()}>
            {captureState === "downloading" ? "Downloading" : "Download"}
          </button>
          {captureState === "downloading" && (
            <button
              type="button"
              className="stream-cancel-button"
              onClick={() => {
                setSnifferMessage("Cancelling download...");
                void invoke("cancel_download");
              }}
            >
              Cancel
            </button>
          )}
          <button type="button" disabled={captureState === "downloading"} onClick={() => resetCaptureState()}>
            Reset
          </button>
        </div>
        <div
          className={`quality-menu ${qualityMenuOpen && streamQualities.length > 1 ? "is-open" : ""}`}
          aria-hidden={!(qualityMenuOpen && streamQualities.length > 1)}
        >
          {streamQualities.map((quality) => (
            <button
              type="button"
              key={`${quality.id}-${quality.url}`}
              className={quality.url === selectedQuality?.url ? "is-selected" : ""}
              tabIndex={qualityMenuOpen && streamQualities.length > 1 ? 0 : -1}
              onClick={() => {
                setSelectedQualityUrl(quality.url);
                setQualityMenuOpen(false);
              }}
            >
              <span>{quality.label}</span>
              <small>{quality.codec ? `${quality.codec} - ` : ""}{quality.url}</small>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function YoutubeDownloaderPanel({
  enqueueDownload,
  history,
  onRedownload,
}: {
  enqueueDownload: (item: Omit<DownloadQueueItem, "id" | "status" | "createdAt">) => string;
  history: DownloadHistoryItem[];
  onRedownload: (item: DownloadHistoryItem) => void;
}) {
  const [url, setUrl] = React.useState("");
  const [formats, setFormats] = React.useState<DownloadFormat[]>([]);
  const [selectedFormatId, setSelectedFormatId] = React.useState(BEST_FORMAT_ID);
  const [inspecting, setInspecting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState("Paste a YouTube URL, inspect formats, then queue the version you want.");

  const displayFormats = React.useMemo<DownloadFormat[]>(() => [BEST_FORMAT_ENTRY, ...formats], [formats]);
  const selectedFormat = displayFormats.find((format) => format.id === selectedFormatId) ?? displayFormats[0] ?? null;
  const youtubeHistory = history.filter((item) => item.kind !== "anime").slice(0, 8);

  async function inspectFormats(event?: React.FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const targetUrl = url.trim();
    if (!targetUrl || inspecting) return;
    setInspecting(true);
    setError(null);
    setFormats([]);
    setSelectedFormatId(BEST_FORMAT_ID);
    setMessage("Inspecting downloadable formats...");
    try {
      const payload = await invoke<DownloadFormat[]>("inspect_download_formats", {
        url: targetUrl,
        referer: undefined,
      });
      setFormats(payload);
      setSelectedFormatId(BEST_FORMAT_ID);
      setMessage(payload.length > 0 ? `${payload.length} formats found.` : "Best (auto-merge) is ready.");
    } catch (formatError) {
      setError(String(formatError));
      setMessage("Format inspection failed.");
    } finally {
      setInspecting(false);
    }
  }

  function queueSelectedFormat() {
    const targetUrl = url.trim();
    if (!targetUrl || !selectedFormat) return;
    const formatSpec = buildYoutubeFormatSpec(selectedFormat);
    enqueueDownload({
      kind: "youtube",
      title: inferDownloadTitleFromUrl(targetUrl),
      subtitle: null,
      qualityLabel: selectedFormat.label,
      url: targetUrl,
      referer: null,
      sourcePage: targetUrl,
      formatId: formatSpec,
      folderName: "youtube downloads",
      progress: null,
      outputPath: null,
      error: null,
    });
    setMessage(`${selectedFormat.label} added to the download queue.`);
  }

  return (
    <section className="youtube-downloader">
      <form className="youtube-download-card" onSubmit={inspectFormats}>
        <div className="youtube-download-head">
          <span className="youtube-mark"><Youtube size={24} strokeWidth={2.1} /></span>
          <div>
            <strong>YouTube Download</strong>
            <small>{message}</small>
          </div>
        </div>
        <div className="youtube-url-row">
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://www.youtube.com/watch?v=..."
            aria-label="YouTube URL"
            spellCheck={false}
          />
          <button type="submit" disabled={!url.trim() || inspecting}>
            {inspecting ? "Inspecting" : "Inspect"}
          </button>
        </div>
        {error && <small className="stream-error">{error}</small>}
      </form>

      <div className="youtube-format-list" aria-label="Download formats">
        {displayFormats.map((format) => {
          const kind = describeFormatKind(format);
          return (
            <button
              key={format.id}
              type="button"
              className={`youtube-format-row is-${kind.tone}${selectedFormat?.id === format.id ? " is-selected" : ""}`}
              onClick={() => setSelectedFormatId(format.id)}
            >
              <span className="youtube-format-label">
                <strong>{format.label}</strong>
                <em className={`youtube-format-tag is-${kind.tone}`}>{kind.text}</em>
              </span>
              <small>
                {[
                  format.vcodec ? `v: ${format.vcodec}` : null,
                  format.acodec ? `a: ${format.acodec}` : null,
                  format.filesize ? formatBytes(format.filesize) : null,
                ].filter(Boolean).join(" - ") || "Auto-pick best video and audio streams"}
              </small>
            </button>
          );
        })}
      </div>

      <div className="youtube-actions">
        <button type="button" disabled={!selectedFormat || !url.trim()} onClick={queueSelectedFormat}>
          <Download size={16} strokeWidth={2.2} />
          Queue selected format
        </button>
      </div>

      <section className="download-history-panel">
        <div className="download-panel-head">
          <History size={17} strokeWidth={2.1} />
          <span>History</span>
        </div>
        {youtubeHistory.length === 0 ? (
          <small>No YouTube downloads yet.</small>
        ) : (
          youtubeHistory.map((item) => (
            <div key={item.id} className="download-history-row">
              <div>
                <strong>{item.title}</strong>
                <small>{item.qualityLabel ?? item.formatId ?? "Previous format"}</small>
              </div>
              <button type="button" onClick={() => onRedownload(item)}>
                Redownload
              </button>
            </div>
          ))
        )}
      </section>
    </section>
  );
}

function DownloadQueuePanel({
  queue,
  onCancel,
}: {
  queue: DownloadQueueItem[];
  onCancel: (job: DownloadQueueItem) => void;
}) {
  const activeOrQueued = queue.filter((job) => job.status === "queued" || job.status === "downloading");
  const recentFinished = queue.filter((job) => job.status === "done" || job.status === "error" || job.status === "cancelled").slice(-4).reverse();
  const rows = [...activeOrQueued, ...recentFinished];

  return (
    <aside className="download-queue-panel" aria-label="Download queue">
      <div className="download-panel-head">
        <ListPlus size={17} strokeWidth={2.1} />
        <span>Queue</span>
      </div>
      {rows.length === 0 ? (
        <div className="download-queue-empty">No queued downloads.</div>
      ) : (
        rows.map((job) => (
          <div key={job.id} className={`download-queue-row is-${job.status}`}>
            <div className="download-queue-copy">
              <strong>{job.title}</strong>
              <small>{[job.subtitle, job.qualityLabel].filter(Boolean).join(" - ") || job.url}</small>
              {job.progress && (
                <span>{job.progress.percent != null ? `${job.progress.percent.toFixed(1)}% - ` : ""}{job.progress.message}</span>
              )}
              {job.warning && <span className="stream-warning">⚠ {job.warning}</span>}
              {job.error && <span className="stream-error">{job.error}</span>}
            </div>
            {(job.status === "queued" || job.status === "downloading") && (
              <button type="button" className="stream-cancel-button" onClick={() => onCancel(job)}>
                {job.status === "downloading" ? "Cancel" : "Remove"}
              </button>
            )}
            {job.progress && job.status === "downloading" && (
              <div className={`stream-progress-track ${job.progress.percent == null ? "is-indeterminate" : ""}`}>
                <div
                  className="stream-progress-fill"
                  style={job.progress.percent == null ? undefined : { width: `${Math.max(0, Math.min(100, job.progress.percent))}%` }}
                />
              </div>
            )}
          </div>
        ))
      )}
    </aside>
  );
}

function AnimeBrowser() {
  const [query, setQuery] = React.useState("");
  const [submittedQuery, setSubmittedQuery] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [hasNextPage, setHasNextPage] = React.useState(false);
  const [results, setResults] = React.useState<AnimeResult[]>([]);
  const [selected, setSelected] = React.useState<AnimeResult | null>(null);
  const [episodes, setEpisodes] = React.useState<AnimeEpisode[]>([]);
  const [episodePage, setEpisodePage] = React.useState(1);
  const [hasMoreEpisodes, setHasMoreEpisodes] = React.useState(false);
  const [selectedEpisode, setSelectedEpisode] = React.useState<AnimeEpisode | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [episodesLoading, setEpisodesLoading] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [directInput, setDirectInput] = React.useState("");
  const [directStreamUrl, setDirectStreamUrl] = React.useState("");
  const [pageInput, setPageInput] = React.useState("");
  const [iframePageUrl, setIframePageUrl] = React.useState("");
  const [playerMode, setPlayerMode] = React.useState<"stream" | "page">("stream");
  const [embedTrailer, setEmbedTrailer] = React.useState(false);

  React.useEffect(() => {
    void loadAnime("", 1);
  }, []);

  async function loadAnime(search: string, nextPage: number) {
    setLoading(true);
    setErrorMessage(null);
    try {
      const endpoint = search.trim()
        ? `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(search.trim())}&sfw=true&limit=24&page=${nextPage}&order_by=popularity`
        : `https://api.jikan.moe/v4/top/anime?filter=bypopularity&sfw=true&limit=24&page=${nextPage}`;
      const payload = await readJson<{
        data: AnimeResult[];
        pagination?: { has_next_page?: boolean };
      }>(endpoint);
      setResults(payload.data ?? []);
      setPage(nextPage);
      setHasNextPage(Boolean(payload.pagination?.has_next_page));
      const first = payload.data?.[0] ?? null;
      setSelected(first);
      setSelectedEpisode(null);
      setDirectInput("");
      setDirectStreamUrl("");
      setPageInput("");
      setIframePageUrl("");
      setEmbedTrailer(false);
      if (first) {
        await loadEpisodes(first.mal_id, 1, true);
      } else {
        setEpisodes([]);
        setHasMoreEpisodes(false);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  async function loadEpisodes(animeId: number, nextPage = 1, replace = false) {
    setEpisodesLoading(true);
    try {
      const payload = await readJson<{
        data: AnimeEpisode[];
        pagination?: { has_next_page?: boolean };
      }>(`https://api.jikan.moe/v4/anime/${animeId}/episodes?page=${nextPage}`);
      const incoming = payload.data ?? [];
      setEpisodes((current) => (replace ? incoming : [...current, ...incoming]));
      setEpisodePage(nextPage);
      setHasMoreEpisodes(Boolean(payload.pagination?.has_next_page));
      setSelectedEpisode(incoming[0] ?? null);
    } catch (error) {
      setEpisodes(replace ? [] : episodes);
      setHasMoreEpisodes(false);
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setEpisodesLoading(false);
    }
  }

  async function selectAnime(anime: AnimeResult) {
    setSelected(anime);
    setSelectedEpisode(null);
    setDirectInput("");
    setDirectStreamUrl("");
    setPageInput("");
    setIframePageUrl("");
    setEmbedTrailer(false);
    setErrorMessage(null);
    await loadEpisodes(anime.mal_id, 1, true);
  }

  function submitSearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextQuery = query.trim();
    setSubmittedQuery(nextQuery);
    void loadAnime(nextQuery, 1);
  }

  function submitDirectStream(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setEmbedTrailer(false);
    if (playerMode === "stream") {
      setIframePageUrl("");
      setDirectStreamUrl(directInput.trim());
      return;
    }
    setDirectStreamUrl("");
    setIframePageUrl(normalizeUrl(pageInput.trim()));
  }

  const cover = selected ? animeCover(selected) : "";
  const trailerUrl = selected ? animeTrailer(selected) : "";
  const trailerPageUrl = selected ? animeTrailerPage(selected) : "";
  const trailerThumb = selected ? animeTrailerThumb(selected) : "";

  return (
    <div className="anime-browser">
      <section className="anime-results-pane">
        <form className="anime-search" onSubmit={submitSearch}>
          <Search size={17} strokeWidth={2.2} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search anime titles..."
            aria-label="Search anime titles"
          />
          <button type="submit" disabled={loading}>
            {loading ? "Searching" : "Search"}
          </button>
        </form>

        <div className="anime-browse-bar">
          <span>{submittedQuery ? `Results for "${submittedQuery}"` : "Popular anime"}</span>
          <div>
            <button type="button" disabled={loading || page <= 1} onClick={() => loadAnime(submittedQuery, page - 1)}>
              Prev
            </button>
            <button type="button" disabled={loading || !hasNextPage} onClick={() => loadAnime(submittedQuery, page + 1)}>
              Next
            </button>
          </div>
        </div>

        {errorMessage && (
          <div className="anime-error">
            <AlertTriangle size={16} /> {errorMessage}
          </div>
        )}

        <div className="anime-grid">
          {results.map((anime) => (
            <button
              type="button"
              key={anime.mal_id}
              className={`anime-tile ${selected?.mal_id === anime.mal_id ? "is-selected" : ""}`}
              onClick={() => void selectAnime(anime)}
            >
              <img src={animeCover(anime)} alt="" loading="lazy" />
              <span>{anime.title_english || anime.title}</span>
              <small>
                {anime.year || "Unknown"} {anime.type ? `- ${anime.type}` : ""}
              </small>
            </button>
          ))}
        </div>
      </section>

      <section className="anime-detail-pane">
        {selected ? (
          <>
            <div className="anime-player">
              {directStreamUrl ? (
                <DirectStreamPlayer src={directStreamUrl} />
              ) : iframePageUrl ? (
                <iframe
                  src={iframePageUrl}
                  title="Embedded watch page"
                  sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-presentation"
                  allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
                  allowFullScreen
                />
              ) : trailerUrl && embedTrailer ? (
                <iframe
                  src={trailerUrl}
                  title={`${selected.title} trailer`}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  allowFullScreen
                />
              ) : trailerPageUrl ? (
                <div
                  className="anime-player-empty anime-trailer-prompt"
                  style={{ backgroundImage: `url(${trailerThumb || cover})` }}
                >
                  <Play size={42} strokeWidth={1.7} />
                  <span>Official trailer available</span>
                  <div>
                    <button type="button" onClick={() => setEmbedTrailer(true)}>
                      Try in app
                    </button>
                    <button type="button" onClick={() => void openUrl(trailerPageUrl)}>
                      Open in browser
                    </button>
                  </div>
                </div>
              ) : (
                <div className="anime-player-empty" style={{ backgroundImage: cover ? `url(${cover})` : undefined }}>
                  <Play size={42} strokeWidth={1.7} />
                  <span>No official trailer found for this title.</span>
                </div>
              )}
            </div>

            <form className="anime-watch-url" onSubmit={submitDirectStream}>
              <div className="player-source-mode" aria-label="Player source type">
                <button
                  type="button"
                  className={playerMode === "stream" ? "is-active" : ""}
                  onClick={() => setPlayerMode("stream")}
                >
                  Stream
                </button>
                <button
                  type="button"
                  className={playerMode === "page" ? "is-active" : ""}
                  onClick={() => setPlayerMode("page")}
                >
                  Page
                </button>
              </div>
              {playerMode === "stream" ? (
                <input
                  value={directInput}
                  onChange={(event) => setDirectInput(event.target.value)}
                  placeholder="Paste MP4 or HLS .m3u8 stream URL"
                  aria-label="Direct video URL"
                />
              ) : (
                <input
                  value={pageInput}
                  onChange={(event) => setPageInput(event.target.value)}
                  placeholder="Paste a watch page URL to try iframe embedding"
                  aria-label="Watch page URL"
                />
              )}
              <button type="submit" disabled={playerMode === "stream" ? !directInput.trim() : !pageInput.trim()}>
                Load
              </button>
              {(directStreamUrl || iframePageUrl) && (
                <button
                  type="button"
                  onClick={() => {
                    setDirectInput("");
                    setDirectStreamUrl("");
                    setPageInput("");
                    setIframePageUrl("");
                  }}
                >
                  Clear
                </button>
              )}
            </form>

            <div className="anime-detail-header">
              <img src={cover} alt="" />
              <div>
                <h2>{selected.title_english || selected.title}</h2>
                <p>{selected.title_japanese || selected.title}</p>
                <div className="anime-facts">
                  <span>
                    <Star size={14} /> {selected.score ?? "N/A"}
                  </span>
                  <span>
                    <Tv size={14} /> {selected.episodes ?? "?"} eps
                  </span>
                  <span>
                    <CalendarDays size={14} /> {selected.year ?? "Unknown"}
                  </span>
                  <span>
                    <Clapperboard size={14} /> {selected.status || "Unknown"}
                  </span>
                </div>
              </div>
            </div>

            <p className="anime-synopsis">{selected.synopsis || "No synopsis available."}</p>

            <div className="anime-episodes-head">
              <h3>Episodes</h3>
              <button
                type="button"
                disabled={episodesLoading || !hasMoreEpisodes}
                onClick={() => selected && loadEpisodes(selected.mal_id, episodePage + 1)}
              >
                {episodesLoading ? "Loading" : hasMoreEpisodes ? "Load more" : "No more"}
              </button>
            </div>

            <div className="anime-episode-list">
              {episodes.length === 0 && (
                <div className="anime-empty-list">{episodesLoading ? "Loading episodes..." : "No episode metadata found."}</div>
              )}
              {episodes.map((episode) => (
                <button
                  type="button"
                  key={episode.mal_id}
                  className={selectedEpisode?.mal_id === episode.mal_id ? "is-active" : ""}
                  onClick={() => setSelectedEpisode(episode)}
                >
                  <span>EP {episode.mal_id}</span>
                  <strong>{episode.title}</strong>
                  <small>{episode.aired ? new Date(episode.aired).toLocaleDateString() : "No air date"}</small>
                </button>
              ))}
            </div>

            {selectedEpisode && (
              <div className="anime-selected-episode">
                <span>Selected episode</span>
                <strong>{selectedEpisode.title}</strong>
                {selectedEpisode.url && (
                  <a href={selectedEpisode.url} target="_blank" rel="noreferrer">
                    Source metadata <ExternalLink size={13} />
                  </a>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="anime-empty-detail">
            <Search size={34} />
            <h2>Search for an anime</h2>
          </div>
        )}
      </section>
    </div>
  );
}

function ClipExtractorPanel({ active }: { active: boolean }) {
  const [selectedVideos, setSelectedVideos] = React.useState<string[]>([]);
  const [clipMode, setClipMode] = React.useState<"cpu" | "gpu">("gpu");
  const [gridPreview, setGridPreview] = React.useState(true);
  const [gridCols, setGridCols] = React.useState(4);
  const [mergeMode, setMergeMode] = React.useState(false);
  const [mergeOrder, setMergeOrder] = React.useState<string[]>([]);
  const [selectedClipIds, setSelectedClipIds] = React.useState<Set<string>>(() => new Set());
  const [exportFormat, setExportFormat] = React.useState<ClipExportFormat>("prores-lt");
  const [visibleRowRange, setVisibleRowRange] = React.useState<{ startIndex: number; endIndex: number } | null>(null);
  const [progress, setProgress] = React.useState<ClipProgress | null>(null);
  const [result, setResult] = React.useState<ClipExtractionResult | null>(null);
  const [previewStates, setPreviewStates] = React.useState<Record<string, ClipPreviewState>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [isExtracting, setIsExtracting] = React.useState(false);
  const [serverStatus, setServerStatus] = React.useState<"cold" | "warming" | "ready">("cold");
  const [gpuStatus, setGpuStatus] = React.useState<VideoGpuStatus | null>(null);
  const [clipModeLoaded, setClipModeLoaded] = React.useState(false);
  const previewStatesRef = React.useRef(previewStates);
  const previewInFlightRef = React.useRef<Set<string>>(new Set());
  const previewBatchInFlightRef = React.useRef(0);
  const previewTokenRef = React.useRef(0);
  const clipBatchProgressRef = React.useRef<ClipBatchProgressContext | null>(null);

  React.useEffect(() => {
    void refreshClipMode();
    void refreshGpuStatus();
  }, []);

  async function refreshGpuStatus() {
    try {
      const raw = await invoke<string>("video_gpu_status");
      setGpuStatus(parseBridgePayload<VideoGpuStatus>(raw));
    } catch (e) {
      console.error("Could not load GPU status:", e);
      logFrontend("error", "frontend.clip.gpu_status.error", "Could not load GPU status", {
        error: safeLogValue(e),
      });
    }
  }

  React.useEffect(() => {
    const handler = (e: Event) => {
      setClipMode((e as CustomEvent<{ mode: "cpu" | "gpu" }>).detail.mode);
    };
    window.addEventListener("clipmode-changed", handler);
    return () => window.removeEventListener("clipmode-changed", handler);
  }, []);

  async function refreshClipMode() {
    try {
      const raw = await invoke<string>("get_config");
      const payload = parseBridgePayload<AppConfig>(raw);
      setClipMode(payload.clip_extraction_mode ?? "gpu");
      setClipModeLoaded(true);
    } catch (configError) {
      console.error("Could not load clip extraction mode:", configError);
      setClipModeLoaded(true);
      logFrontend("error", "frontend.clip.config.error", "Could not load clip extraction mode", {
        error: safeLogValue(configError),
      });
    }
  }

  React.useEffect(() => {
    if (!active || !clipModeLoaded || clipMode === "cpu" || serverStatus === "ready") return;
    setServerStatus("warming");
    void invoke("warmup_clip_server").catch((warmupError) => {
      setServerStatus("cold");
      logFrontend("warn", "frontend.clip.server_warmup.warning", "Clip server warmup failed", {
        error: safeLogValue(warmupError),
      });
    });
  }, [active, clipMode, clipModeLoaded, serverStatus]);

  React.useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void listen<ClipProgress>("clip-progress", (event) => {
      if (!cancelled) {
        setProgress(mapClipBatchProgress(event.payload, clipBatchProgressRef.current));
      }
    }).then((cleanup) => {
      if (cancelled) {
        cleanup();
      } else {
        unlisten = cleanup;
      }
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void listen<any>("clip-server-event", (event) => {
      if (cancelled) return;
      const payload = event.payload;
      if (payload.type === "ready") {
        setServerStatus("ready");
      } else if (payload.type === "stopped") {
        setServerStatus("cold");
      } else if (payload.type === "log" && payload.message.includes("warming up")) {
        setServerStatus("warming");
      }
    }).then((cleanup) => {
      if (cancelled) {
        cleanup();
      } else {
        unlisten = cleanup;
      }
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  React.useEffect(() => {
    previewStatesRef.current = previewStates;
  }, [previewStates]);

  React.useEffect(() => {
    previewTokenRef.current += 1;
    previewInFlightRef.current.clear();
    previewBatchInFlightRef.current = 0;
    setPreviewStates({});
  }, [result?.input]);

  async function pickVideo() {
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [
        {
          name: "Video",
          extensions: ["mp4", "mkv", "mov", "webm", "avi"],
        },
      ],
    });
    const paths = normalizeSelectedPaths(selected);
    if (paths.length === 0) return;
    setSelectedVideos(paths);
    setSelectedClipIds(new Set());
    setMergeOrder([]);
    setResult(null);
    setPreviewStates({});
    setProgress(null);
    setError(null);
    setMergeMode(false);

    // Video picked, high intent to extract - warm up the server
    if (clipMode !== "cpu") {
      void invoke("warmup_clip_server").catch(() => {});
    }
  }

  const selectedVideo = selectedVideos[0] ?? null;
  const displayName = selectedVideos.length > 1
    ? `${selectedVideos.length} episodes selected`
    : selectedVideo ? fileName(selectedVideo) : "No episode selected";
  const clips = React.useMemo<ClipPreviewItem[]>(() => {
    if (!result) return [];

    return result.scenes.map((scene) => {
      const sourceStart = Math.max(0, scene.start);
      const sourceEnd = Math.max(sourceStart + 0.2, scene.end);
      const previewRange = previewClipRange(sourceStart, sourceEnd, result.fps, scene.index);
      const sourceName = fileStem(scene.source);
      const id = `${sourceName}-${scene.index}-${scene.start.toFixed(3)}`;
      return {
        id,
        index: scene.index,
        label: scene.label,
        range: `${formatClipTime(sourceStart)} - ${formatClipTime(sourceEnd)}`,
        sourceName,
        sourceSrc: convertFileSrc(scene.source),
        sourceStart,
        sourceEnd,
        previewStart: previewRange.start,
        previewEnd: previewRange.end,
        previewState: previewStates[id],
        fps: result.fps,
        path: scene.source,
      };
    });
  }, [result, previewStates]);

  const hasClips = clips.length > 0;
  const selectedCount = selectedClipIds.size;
  const canExtract = selectedVideos.length > 0 && !isExtracting;
  const clipCancellingRef = React.useRef(false);
  const readyPreviewCount = React.useMemo(
    () => clips.reduce((count, clip) => count + (clip.previewState?.status === "ready" ? 1 : 0), 0),
    [clips],
  );
  const exportOptions = React.useMemo(
    () => clipExportOptions(clipMode, gpuStatus),
    [clipMode, gpuStatus],
  );
  const selectedExportOption = exportOptions.find((option) => option.value === exportFormat);

  React.useEffect(() => {
    const current = clipExportOptions(clipMode, gpuStatus);
    const active = current.find((option) => option.value === exportFormat);
    if (!active || active.disabled) {
      setExportFormat(current.find((option) => !option.disabled)?.value ?? "prores-lt");
    }
  }, [clipMode, exportFormat, gpuStatus]);

  const clipRows = React.useMemo<ClipPreviewItem[][]>(() => {
    if (!hasClips) return [];
    const rows: ClipPreviewItem[][] = [];
    for (let i = 0; i < clips.length; i += gridCols) {
      rows.push(clips.slice(i, i + gridCols));
    }
    return rows;
  }, [clips, gridCols, hasClips]);

  const activeGridClipIds = React.useMemo(() => {
    const active = new Set<string>();
    if (!gridPreview) return active;
    if (clipRows.length <= 0) return active;

    const autoplayLimit = MAX_GRID_AUTOPLAYERS;
    const startRow = Math.max(0, Math.min(visibleRowRange?.startIndex ?? 0, clipRows.length - 1));
    const minimumEndRow = startRow + Math.ceil(autoplayLimit / gridCols) - 1;
    const endRow = Math.min(
      clipRows.length - 1,
      Math.max(visibleRowRange?.endIndex ?? minimumEndRow, minimumEndRow),
    );

    for (let rowIndex = startRow; rowIndex <= endRow; rowIndex += 1) {
      for (const clip of clipRows[rowIndex] ?? []) {
        active.add(clip.id);
        if (active.size >= autoplayLimit) break;
      }
      if (active.size >= autoplayLimit) break;
    }
    return active;
  }, [clipRows, gridCols, gridPreview, visibleRowRange]);

  React.useEffect(() => {
    setVisibleRowRange(null);
  }, [result, gridCols]);

  function startPreviewRenderBatch(batch: ClipPreviewItem[], token: number) {
    const renderable = batch.filter((clip) => clip.path);
    if (renderable.length === 0) return;
    previewBatchInFlightRef.current += 1;
    for (const clip of renderable) {
      previewInFlightRef.current.add(clip.id);
    }
    setPreviewStates((current) => {
      let next = current;
      for (const clip of renderable) {
        const existing = next[clip.id];
        if (existing?.status === "ready" || existing?.status === "rendering") continue;
        next = { ...next, [clip.id]: { status: "rendering" } };
      }
      return next;
    });

    void invoke<string>("clip_preview_generate_batch", {
      jobs: renderable.map((clip) => ({
        sceneId: clip.id,
        sourcePath: clip.path,
        start: clip.previewStart,
        end: clip.previewEnd,
        fps: clip.fps,
      })),
    })
      .then((raw) => {
        if (token !== previewTokenRef.current) return;
        const payload = parseBridgePayload<ClipPreviewBatchResult>(raw);
        const byId = new Map(payload.items.map((item) => [item.sceneId, item]));
        setPreviewStates((current) => {
          let next = current;
          for (const clip of renderable) {
            const item = byId.get(clip.id);
            if (!item) {
              next = {
                ...next,
                [clip.id]: { status: "error", error: "Preview renderer did not return this clip." },
              };
              continue;
            }
            if (item.error || !item.path) {
              next = {
                ...next,
                [clip.id]: { status: "error", error: item.error || "Preview renderer did not create a cache file." },
              };
              continue;
            }
            const duration = Math.max(0.08, Number(item.duration) || clip.previewEnd - clip.previewStart);
            next = {
              ...next,
              [clip.id]: {
                status: "ready",
                path: item.path,
                src: convertFileSrc(item.path),
                duration,
              },
            };
          }
          return next;
        });
      })
      .catch((previewError) => {
        if (token !== previewTokenRef.current) return;
        const error = readBridgeError(previewError);
        setPreviewStates((current) => {
          let next = current;
          for (const clip of renderable) {
            next = { ...next, [clip.id]: { status: "error", error } };
          }
          return next;
        });
      })
      .finally(() => {
        previewBatchInFlightRef.current = Math.max(0, previewBatchInFlightRef.current - 1);
        for (const clip of renderable) {
          previewInFlightRef.current.delete(clip.id);
        }
      });
  }

  React.useEffect(() => {
    if (!hasClips || !gridPreview) return;

    const token = previewTokenRef.current;
    const ordered = [...clips].sort((left, right) => {
      const leftVisible = activeGridClipIds.has(left.id) ? 0 : 1;
      const rightVisible = activeGridClipIds.has(right.id) ? 0 : 1;
      if (leftVisible !== rightVisible) return leftVisible - rightVisible;
      return left.index - right.index;
    });

    const batchConcurrency = clipMode === "gpu"
      ? CLIP_PREVIEW_GPU_BATCH_CONCURRENCY
      : CLIP_PREVIEW_CPU_BATCH_CONCURRENCY;
    let availableBatches = batchConcurrency - previewBatchInFlightRef.current;
    let nextBatch: ClipPreviewItem[] = [];

    for (const clip of ordered) {
      if (availableBatches <= 0) break;
      if (previewInFlightRef.current.has(clip.id)) continue;
      const status = previewStatesRef.current[clip.id]?.status;
      if (status === "ready" || status === "rendering" || status === "error") continue;
      nextBatch.push(clip);
      if (nextBatch.length >= CLIP_PREVIEW_BATCH_SIZE) {
        startPreviewRenderBatch(nextBatch, token);
        nextBatch = [];
        availableBatches -= 1;
      }
    }

    if (availableBatches > 0 && nextBatch.length > 0) {
      startPreviewRenderBatch(nextBatch, token);
    }
  }, [activeGridClipIds, clipMode, clips, gridPreview, hasClips, previewStates]);

  async function startExtraction() {
    if (selectedVideos.length === 0 || isExtracting) return;
    setIsExtracting(true);
    setResult(null);
    setPreviewStates({});
    previewTokenRef.current += 1;
    previewInFlightRef.current.clear();
    previewBatchInFlightRef.current = 0;
    setError(null);
    setSelectedClipIds(new Set());
    setMergeOrder([]);
    setMergeMode(false);
    setProgress({
      type: "progress",
      stage: "starting",
      percent: 0,
      message: selectedVideos.length > 1
        ? `Starting ${selectedVideos.length} episode batch...`
        : clipMode === "gpu" ? "Starting RTX TransNetV2 extraction..." : "Starting PySceneDetect CPU extraction...",
    });

    try {
      if (clipMode === "gpu") {
        setServerStatus("warming");
        setProgress({
          type: "progress",
          stage: "dependencies",
          percent: 0,
          message: "Warming RTX clip server for batch extraction...",
        });
        await invoke("warmup_clip_server").catch((warmupError) => {
          setServerStatus("cold");
          logFrontend("warn", "frontend.clip.server_warmup.warning", "Clip server warmup failed; falling back to one-shot extraction", {
            error: safeLogValue(warmupError),
          });
        });
      }

      const results: ClipExtractionResult[] = [];
      for (let index = 0; index < selectedVideos.length; index += 1) {
        if (clipCancellingRef.current) break;
        const inputPath = selectedVideos[index];
        clipBatchProgressRef.current = {
          activeIndex: index,
          total: selectedVideos.length,
          inputPath,
        };
        setProgress({
          type: "progress",
          stage: "starting",
          percent: Math.round((index / selectedVideos.length) * 100),
          message: `Episode ${index + 1}/${selectedVideos.length}: ${fileName(inputPath)}`,
        });
        const raw = await invoke<string>("clip_extract", { inputPath, mode: clipMode });
        const payload = raw.includes("server_task_started")
          ? await waitForClipServerResult()
          : parseBridgePayload<ClipExtractionResult>(raw);
        results.push(payload);
        setResult(combineClipResults(results, clipMode));
        setProgress({
          type: "progress",
          stage: "complete",
          percent: Math.round(((index + 1) / selectedVideos.length) * 100),
          message: `Episode ${index + 1}/${selectedVideos.length} complete: ${fileName(inputPath)}`,
          elapsedSeconds: results.reduce((total, item) => total + (item.totalSeconds || 0), 0),
        });
      }

      if (results.length === 0) return;
      const payload = combineClipResults(results, clipMode);
      setResult(payload);
      setProgress({
        type: "progress",
        stage: "complete",
        percent: 100,
        message: `Detected ${payload.sceneCount} scenes in ${formatDuration(payload.totalSeconds)} with ${clipMode.toUpperCase()}`,
        elapsedSeconds: payload.totalSeconds,
      });
    } catch (clipError) {
      if (!clipCancellingRef.current) {
        setError(readBridgeError(clipError));
      }
    } finally {
      clipBatchProgressRef.current = null;
      clipCancellingRef.current = false;
      setIsExtracting(false);
    }
  }

  function toggleClipSelection(clipId: string) {
    setSelectedClipIds((current) => {
      const next = new Set(current);
      if (next.has(clipId)) {
        next.delete(clipId);
      } else {
        next.add(clipId);
      }
      return next;
    });
  }

  function toggleAllClipSelection() {
    if (!hasClips) return;
    setSelectedClipIds((current) => {
      if (current.size === clips.length) {
        return new Set();
      }
      return new Set(clips.map((clip) => clip.id));
    });
  }

  function handleClipClick(clip: ClipPreviewItem) {
    if (mergeMode) {
      toggleMergeOrder(clip.id);
    } else {
      toggleClipSelection(clip.id);
    }
  }

  function toggleMergeOrder(clipId: string) {
    setMergeOrder((prev) => {
      if (prev.includes(clipId)) return prev.filter((id) => id !== clipId);
      return [...prev, clipId];
    });
  }

  function toggleMergeMode() {
    setMergeMode((value) => {
      if (value) {
        setMergeOrder([]);
      } else {
        setSelectedClipIds(new Set());
      }
      return !value;
    });
  }

  const mergePositions = React.useMemo(() => {
    const map = new Map<string, number>();
    mergeOrder.forEach((id, index) => map.set(id, index + 1));
    return map;
  }, [mergeOrder]);

  const mergeOrderedClips = React.useMemo(
    () =>
      mergeOrder
        .map((id) => clips.find((clip) => clip.id === id))
        .filter((clip): clip is ClipPreviewItem => Boolean(clip)),
    [mergeOrder, clips],
  );

  const mergeFilenameStem = React.useMemo(
    () => mergeOrderedClips.map((clip) => clip.index + 1).join("+"),
    [mergeOrderedClips],
  );

  async function startMergeExport() {
    if (mergeOrderedClips.length < 2 || isExtracting) return;
    if (selectedExportOption?.disabled) {
      setError(selectedExportOption.reason ?? "This export format is not available on the current hardware/mode.");
      return;
    }

    const selected = await open({
      multiple: false,
      directory: true,
      title: "Select output folder for merged clip",
    });
    if (!selected || Array.isArray(selected)) return;

    const exportClips = mergeOrderedClips.map((clip) => ({
      source: clip.path,
      start: clip.sourceStart,
      end: clip.sourceEnd,
      index: clip.index,
      fps: clip.fps,
    }));

    setIsExtracting(true);
    setError(null);
    setProgress({
      type: "progress",
      stage: "starting",
      percent: 0,
      message: `Merging ${exportClips.length} clips into ${mergeFilenameStem}.mov...`,
    });

    try {
      const raw = await invoke<string>("clip_export_merged", {
        clips: exportClips,
        outputDir: selected,
        preset: exportFormat,
      });
      const payload = parseBridgePayload<ConversionDone>(raw);
      setProgress({
        type: "progress",
        stage: "complete",
        percent: 100,
        message: `Merged clip saved to ${payload.output}`,
      });
      setMergeOrder([]);
      setMergeMode(false);
    } catch (e) {
      setError(readBridgeError(e));
      setProgress(null);
    } finally {
      setIsExtracting(false);
    }
  }

  async function startExport() {
    if (selectedClipIds.size === 0 || isExtracting) return;
    if (selectedExportOption?.disabled) {
      setError(selectedExportOption.reason ?? "This export format is not available on the current hardware/mode.");
      return;
    }

    const selected = await open({
      multiple: false,
      directory: true,
      title: "Select output folder for exported clips",
    });

    if (!selected || Array.isArray(selected)) return;

    const outDir = selected;
    const exportClips = clips
      .filter((clip) => selectedClipIds.has(clip.id))
      .map((clip, index) => ({
        source: clip.path,
        start: clip.sourceStart,
        end: clip.sourceEnd,
        index: index,
        fps: clip.fps,
      }));

    setIsExtracting(true);
    setProgress({
      type: "progress",
      stage: "starting",
      percent: 0,
      message: `Preparing to export ${exportClips.length} clips...`,
    });
    setError(null);

    try {
      const raw = await invoke<string>("clip_export", {
        clips: exportClips,
        outputDir: outDir,
        preset: exportFormat,
      });
      const payload = parseBridgePayload<ConversionDone>(raw);
      setProgress({
        type: "progress",
        stage: "complete",
        percent: 100,
        message: `Exported ${exportClips.length} clips to ${payload.output}`,
      });
      setSelectedClipIds(new Set());
    } catch (e) {
      setError(readBridgeError(e));
      setProgress(null);
    } finally {
      setIsExtracting(false);
    }
  }

  const runMessage = error
    ?? (result
      ? `${result.sceneCount} scenes ready - ${readyPreviewCount}/${clips.length} previews cached`
      : progress?.message ?? "");

  return (
    <section className="clip-extractor">
      <div className="clip-extractor-rail">
        <button type="button" className="clip-import-button" onClick={pickVideo}>
          <span className="clip-import-mark">
            <Scissors size={32} strokeWidth={1.9} />
          </span>
          <span>{selectedVideos.length > 0 ? "Change episodes" : "Select episodes"}</span>
        </button>

        <div className="clip-source-card">
          <div className="clip-source-header">
            <div className="clip-source-info">
              <small>Source</small>
              <strong>{displayName}</strong>
            </div>
          <div
            className={`clip-server-badge ${serverStatus === "ready" ? "is-ready" : serverStatus === "warming" ? "is-warming" : ""}`}
            title={serverStatus === "ready" ? "Clip Server is warm and ready" : serverStatus === "warming" ? "Clip Server is warming up..." : "Clip Server is cold"}
          >
            {serverStatus === "ready" ? "Ready" : serverStatus === "warming" ? "Warming" : "Cold"}
          </div>
          </div>
          {selectedVideos.length > 0 && (
            <span>{selectedVideos.length === 1 ? selectedVideos[0] : selectedVideos.map(fileName).join(" / ")}</span>
          )}
          <em>{clipMode === "gpu" ? "GPU mode · RTX TransNetV2" : "CPU mode · PySceneDetect"}</em>
        </div>

        <div className="clip-tool-stack" aria-label="Clip extractor actions">
          <button
            type="button"
            className={`clip-tool-button ${gridPreview ? "is-active" : ""}`}
            onClick={() => setGridPreview((value) => !value)}
          >
            <Film size={18} strokeWidth={2} />
            <span>Grid preview</span>
          </button>

          <div className="clip-cols-control">
            <div className="clip-cols-label">
              <span>Columns</span>
              <strong>{gridCols}</strong>
            </div>
            <input
              type="range"
              className="clip-cols-slider"
              min={1}
              max={4}
              step={1}
              value={gridCols}
              onChange={(e) => setGridCols(Math.min(4, Math.max(1, Number(e.currentTarget.value))))}
              aria-label="Grid column count"
            />
            <div className="clip-cols-ticks">
              {CLIP_COLUMN_OPTIONS.map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`clip-cols-tick ${gridCols === n ? "is-active" : ""}`}
                  onClick={() => setGridCols(n)}
                  aria-label={`${n} column${n === 1 ? "" : "s"}`}
                >{n}</button>
              ))}
            </div>
          </div>

          <div className="clip-cols-control">
            <div className="clip-cols-label">
              <span>Export Format</span>
            </div>
            <select
              value={exportFormat}
              onChange={(e) => setExportFormat(e.target.value as ClipExportFormat)}
              className="clip-export-format-select"
              title={selectedExportOption?.reason ?? selectedExportOption?.label}
            >
              {exportOptions.map((option) => (
                <option key={option.value} value={option.value} disabled={option.disabled}>
                  {option.label}{option.disabled ? " unavailable" : ""}
                </option>
              ))}
            </select>
            {selectedExportOption?.reason && <small className="stream-warning">{selectedExportOption.reason}</small>}
          </div>

          {!mergeMode && (
            <>
              <button
                type="button"
                className={`clip-tool-button ${selectedCount > 0 ? 'is-active-primary' : ''}`}
                disabled={selectedCount === 0 || isExtracting}
                onClick={startExport}
              >
                <ArrowRight size={18} strokeWidth={2} />
                <span>{selectedCount === 0 ? "Select clips to export" : `Export ${selectedCount} clips`}</span>
              </button>

              <button
                type="button"
                className={`clip-tool-button ${hasClips && selectedCount === clips.length ? "is-active" : ""}`}
                disabled={!hasClips || isExtracting}
                onClick={toggleAllClipSelection}
              >
                <CheckCircle2 size={18} strokeWidth={2} />
                <span>{hasClips && selectedCount === clips.length ? "Clear selection" : "Select all clips"}</span>
              </button>
            </>
          )}

          <button
            type="button"
            className={`clip-tool-button ${mergeMode ? "is-active" : ""}`}
            disabled={!hasClips}
            onClick={toggleMergeMode}
          >
            <Scissors size={18} strokeWidth={2} />
            <span>{mergeMode ? "Cancel merge" : "Merge clip"}</span>
          </button>

          {mergeMode && (
            <button
              type="button"
              className="clip-confirm-button"
              disabled={mergeOrder.length < 2 || isExtracting}
              onClick={startMergeExport}
              title={mergeOrder.length < 2 ? "Select at least 2 clips to merge" : `Merge into ${mergeFilenameStem}.mov`}
            >
              <CheckCircle2 size={17} strokeWidth={2.1} />
              <span>
                {mergeOrder.length < 2
                  ? "Select 2+ clips"
                  : `Merge into ${mergeFilenameStem}.mov`}
              </span>
            </button>
          )}
        </div>

        {(progress || error || result) && (
          <div className={`clip-run-card ${error ? "is-error" : ""}`}>
            <div className="clip-run-line">
              <strong>{error ? "Extraction failed" : formatClipProgressStage(progress?.stage)}</strong>
              {progress && <span>{Math.round(progress.percent)}%</span>}
            </div>
            {progress && (
              <div className={`clip-progress-track ${isExtracting && progress.percent <= 0 ? "is-indeterminate" : ""}`}>
                <span style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }} />
              </div>
            )}
            <p>{runMessage}</p>
          </div>
        )}

        <div className="clip-format-note">
          <Info size={14} strokeWidth={2.5} />
          <span>ProRes and Intra frame formats are best for After Effects responsiveness.</span>
        </div>

        <button type="button" className="clip-primary-action" disabled={!canExtract} onClick={startExtraction}>
          {isExtracting ? "Extracting..." : hasClips ? "Extract again" : "Extract clips"}
        </button>
        {isExtracting && (
          <button
            type="button"
            className="clip-cancel-action"
            onClick={() => {
              clipCancellingRef.current = true;
              void invoke("cancel_clip");
            }}
          >
            <X size={14} strokeWidth={2.3} />
            Cancel
          </button>
        )}
      </div>

      <div className="clip-extractor-stage">
        {hasClips ? (
          <Virtuoso
            data={clipRows}
            overscan={1000}
            increaseViewportBy={1000}
            style={{ '--clip-cols': gridCols } as React.CSSProperties}
            components={{ Scroller: ClipPreviewScroller }}
            computeItemKey={(index, row) => `row-${gridCols}-${index}-${row[0]?.id ?? ""}`}
            rangeChanged={setVisibleRowRange}
            itemContent={(_index, row) => (
              <div
                className="clip-preview-grid-row"
                style={{ '--clip-cols': gridCols } as React.CSSProperties}
              >
                {row.map((clip) => (
                  <ClipPreviewTile
                    key={clip.id}
                    clip={clip}
                    mergeMode={mergeMode}
                    mergePosition={mergePositions.get(clip.id) ?? null}
                    paused={!gridPreview}
                    playable={activeGridClipIds.has(clip.id)}
                    selected={mergeMode ? mergePositions.has(clip.id) : selectedClipIds.has(clip.id)}
                    onClick={() => handleClipClick(clip)}
                    onToggleSelect={() =>
                      mergeMode ? toggleMergeOrder(clip.id) : toggleClipSelection(clip.id)
                    }
                  />
                ))}
              </div>
            )}
          />
        ) : !gridPreview ? null : (
          <div
            className="clip-preview-grid is-placeholder-grid"
            aria-label="Clip previews"
            style={
              {
                '--clip-cols': gridCols,
                '--clip-rows': Math.ceil(12 / gridCols),
              } as React.CSSProperties
            }
          >
            {Array.from({ length: 12 }, (_, index) => <div key={index} className="clip-preview-skeleton" />)}
          </div>
        )}

        {!hasClips && !gridPreview && (
          <div className="clip-preview-disabled">
            <Film size={34} strokeWidth={1.7} />
            <h2>Grid preview off</h2>
          </div>
        )}

        {!hasClips && gridPreview && (
          <div className="clip-empty-state">
            {isExtracting ? <Loader2 className="is-spinning" size={36} strokeWidth={1.8} /> : <Clapperboard size={36} strokeWidth={1.7} />}
            <h2>{isExtracting ? "Extracting clips" : "Clip extractor"}</h2>
            <p>{progress?.message ?? error ?? (selectedVideos.length > 0 ? "Ready for RTX TransNetV2." : "No clips yet.")}</p>
          </div>
        )}

        {mergeMode && (
          <div className={`merge-strip ${mergeOrderedClips.length > 0 ? "is-active" : "is-empty"}`} aria-live="polite">
            <div className="merge-strip-header">
              <strong>Merge order</strong>
              <span>
                {mergeOrderedClips.length === 0
                  ? "Click clips in the order they should play"
                  : mergeOrderedClips.length < 2
                    ? "Pick at least 2 clips"
                    : `→ ${mergeFilenameStem}.mov`}
              </span>
              {mergeOrderedClips.length > 0 && (
                <button
                  type="button"
                  className="merge-strip-clear"
                  onClick={() => setMergeOrder([])}
                  title="Clear merge order"
                >
                  Clear
                </button>
              )}
            </div>
            {mergeOrderedClips.length > 0 && (
              <ol className="merge-strip-list">
                {mergeOrderedClips.map((clip, index) => (
                  <li key={clip.id} className="merge-strip-item">
                    <span className="merge-strip-num">{index + 1}</span>
                    <span className="merge-strip-name" title={clip.label}>{clip.label}</span>
                    <button
                      type="button"
                      className="merge-strip-remove"
                      onClick={() => toggleMergeOrder(clip.id)}
                      aria-label={`Remove ${clip.label} from merge`}
                    >
                      <X size={12} strokeWidth={2.4} />
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function ClipPreviewTile({
  clip,
  selected,
  mergeMode,
  mergePosition,
  paused,
  playable,
  onClick,
  onToggleSelect,
}: {
  clip: ClipPreviewItem;
  selected: boolean;
  mergeMode: boolean;
  mergePosition: number | null;
  paused: boolean;
  playable: boolean;
  onClick: () => void;
  onToggleSelect: () => void;
}) {
  const previewRange = previewClipPlaybackRange(clip);
  const shouldPlay = Boolean(previewRange) && playable && !paused;
  const placeholderLoading = playable && clip.previewState?.status !== "error";
  const loopDuration = previewRange
    ? Math.max(0.45, previewRange.end - previewRange.start)
    : 0;
  const [isReady, setIsReady] = React.useState(false);

  React.useEffect(() => {
    setIsReady(false);
  }, [previewRange?.src]);

  return (
    <div className={`clip-preview-tile-wrapper ${selected ? "is-selected" : ""}`}>
      <button
        type="button"
        className={`clip-preview-tile ${selected ? "is-selected" : ""} ${mergeMode ? "is-selectable" : ""}`}
        onClick={onClick}
      >
        {shouldPlay && previewRange ? (
          <>
            <img
              src={previewRange.src}
              alt=""
              className={isReady ? "is-ready" : "is-loading"}
              onLoad={() => setIsReady(true)}
              onError={() => setIsReady(false)}
            />
            {!isReady && <span className="clip-video-placeholder is-loading" aria-hidden="true" />}
          </>
        ) : (
          <span className={`clip-video-placeholder ${placeholderLoading ? "is-loading" : ""}`} />
        )}
        {shouldPlay && previewRange && isReady && (
          <span
            className="clip-loop-progress"
            style={{ "--clip-loop-duration": `${loopDuration}s` } as React.CSSProperties}
            aria-hidden="true"
          >
            <span key={previewRange.id} />
          </span>
        )}
        <span className="clip-tile-scrim" />
        <span className="clip-source-badge">{clip.sourceName}</span>
        <span className="clip-tile-meta">
          <strong>{clip.label}</strong>
          <small>{clip.range}</small>
        </span>
        {mergeMode && mergePosition != null && (
          <span key={mergePosition} className="clip-merge-badge" aria-hidden="true">
            {mergePosition}
          </span>
        )}
      </button>
      <button
        type="button"
        className={`clip-corner-select ${selected ? "is-selected" : ""} ${mergeMode && mergePosition != null ? "is-merge" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggleSelect();
        }}
        aria-label={
          mergeMode
            ? mergePosition != null
              ? `Remove from merge (position ${mergePosition})`
              : "Add to merge"
            : selected
              ? "Deselect clip"
              : "Select clip"
        }
      >
        {mergeMode ? (
          mergePosition != null ? (
            <span className="clip-corner-num">{mergePosition}</span>
          ) : (
            <Circle size={20} strokeWidth={2.5} />
          )
        ) : selected ? (
          <CheckCircle2 size={20} strokeWidth={2.5} />
        ) : (
          <Circle size={20} strokeWidth={2.5} />
        )}
      </button>
    </div>
  );
}

function sourceClipPlaybackRange(clip: ClipPreviewItem): ClipVideoRange {
  const safeFps = Number.isFinite(clip.fps) && clip.fps > 0 ? clip.fps : 24;
  const offset = clip.index === 0 || clip.sourceStart <= 0 ? 0 : 1.5 / safeFps;
  return {
    id: `${clip.id}-source`,
    src: clip.sourceSrc,
    start: clip.sourceStart + offset,
    end: clip.sourceEnd,
  };
}

function previewClipPlaybackRange(clip: ClipPreviewItem): ClipVideoRange | null {
  const state = clip.previewState;
  if (state?.status !== "ready" || !state.src || !state.duration) return null;
  return {
    id: `${clip.id}-preview`,
    src: state.src,
    start: 0,
    end: state.duration,
  };
}

async function waitForClipServerResult(): Promise<ClipExtractionResult> {
  return new Promise((resolve, reject) => {
    let unlisten: (() => void) | null = null;
    void listen<any>("clip-server-event", (event) => {
      const payload = event.payload;
      if (payload.type === "done") {
        unlisten?.();
        resolve(payload as ClipExtractionResult);
      } else if (payload.type === "error") {
        unlisten?.();
        reject(new Error(payload.message ?? "Clip extraction failed."));
      }
    }).then((cleanup) => {
      unlisten = cleanup;
    }).catch(reject);
  });
}

function mapClipBatchProgress(progress: ClipProgress, context: ClipBatchProgressContext | null): ClipProgress {
  if (!context || context.total <= 1) return progress;

  const episodeSpan = 100 / context.total;
  const basePercent = context.activeIndex * episodeSpan;
  const episodePercent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
  const aggregatePercent = basePercent + (episodePercent / 100) * episodeSpan;
  return {
    ...progress,
    percent: Math.max(0, Math.min(100, aggregatePercent)),
    message: `Episode ${context.activeIndex + 1}/${context.total} · ${fileName(context.inputPath)} · ${progress.message}`,
  };
}

function formatClipProgressStage(stage?: string): string {
  switch (stage) {
    case "starting":
      return "Starting";
    case "dependencies":
      return "Checking Dependencies";
    case "probe":
      return "Reading Source";
    case "decode":
      return "Decoding";
    case "analyze":
      return "Analyzing";
    case "scenes":
      return "Building Scenes";
    case "complete":
      return "Complete";
    default:
      return stage ? titleCaseStage(stage) : "Ready";
  }
}

function titleCaseStage(stage: string): string {
  return stage
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function combineClipResults(results: ClipExtractionResult[], mode: "cpu" | "gpu"): ClipExtractionResult {
  const scenes: ClipScene[] = [];
  let sceneOffset = 0;
  let totalSeconds = 0;
  let duration = 0;
  let fps = 24;

  for (const result of results) {
    fps = result.fps || fps;
    duration += result.duration || 0;
    totalSeconds += result.totalSeconds || 0;
    for (const scene of result.scenes) {
      scenes.push({
        ...scene,
        index: sceneOffset + scene.index,
        label: `${fileStem(scene.source)} · ${scene.label}`,
      });
    }
    sceneOffset += result.scenes.length;
  }

  return {
    type: "done",
    mode,
    input: results.length === 1 ? results[0].input : `${results.length} files`,
    scenes,
    cuts: results.flatMap((result) => result.cuts ?? []),
    sceneCount: scenes.length,
    fps,
    duration,
    totalSeconds,
  };
}

type ClipExportOption = {
  value: ClipExportFormat;
  label: string;
  disabled: boolean;
  reason?: string;
};

function clipExportOptions(mode: "cpu" | "gpu", gpuStatus: VideoGpuStatus | null): ClipExportOption[] {
  const cpuModeReason = "GPU export presets are hidden in CPU clip mode. Switch clip extraction to GPU mode to use NVENC presets.";
  const gpuIntraReady = Boolean(gpuStatus?.hasHevcNvenc);
  const statusMessage = gpuStatus?.message ?? "Checking GPU export support...";
  const h264NvencReady = Boolean(gpuStatus?.hasH264Nvenc);
  const av1NvencReady = Boolean(gpuStatus?.hasAv1Nvenc);
  const gpuMode = mode === "gpu";

  return [
    {
      value: "prores-lt",
      label: "ProRes LT MOV",
      disabled: false,
    },
    {
      value: "prores-hq",
      label: "ProRes HQ MOV",
      disabled: false,
    },
    {
      value: "h264-cpu",
      label: "H.264 CPU MOV",
      disabled: false,
    },
    {
      value: "hevc-cpu",
      label: "HEVC CPU MOV",
      disabled: false,
    },
    {
      value: "gpu-intra",
      label: "GPU Intra MOV",
      disabled: !gpuMode || !gpuIntraReady,
      reason: !gpuMode ? cpuModeReason : gpuIntraReady ? undefined : statusMessage,
    },
    {
      value: "h264-nvenc",
      label: "H.264 NVENC MOV",
      disabled: !gpuMode || !h264NvencReady,
      reason: !gpuMode ? cpuModeReason : h264NvencReady ? undefined : "Bundled FFmpeg does not expose h264_nvenc on this machine.",
    },
    {
      value: "av1-nvenc",
      label: "AV1 NVENC MOV",
      disabled: !gpuMode || !av1NvencReady,
      reason: !gpuMode ? cpuModeReason : av1NvencReady ? undefined : "Bundled FFmpeg does not expose av1_nvenc on this machine.",
    },
  ];
}

// Custom scroller so the styled scrollbar lands on the actual scrollable
// element. By default react-virtuoso's `className` prop goes to the outer
// wrapper, not the scroller, so ::-webkit-scrollbar selectors miss.
const ClipPreviewScroller = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function ClipPreviewScroller({ className, children, ...rest }, ref) {
    return (
      <div
        {...rest}
        ref={ref}
        className={`clip-preview-grid-scroller${className ? ` ${className}` : ""}`}
      >
        {children}
      </div>
    );
  },
);


function previewClipRange(start: number, end: number, fps: number, index: number): { start: number; end: number } {
  const duration = Math.max(0, end - start);
  if (duration <= 0.2) return { start, end };

  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 24;
  const startFramePad = Math.min(0.16, Math.max(0.08, 3 / safeFps));
  const endFramePad = Math.min(0.22, Math.max(0.12, 5 / safeFps));
  const maxTotalPad = Math.max(0, duration - 0.2);
  const startPad = index === 0 || start <= 0 ? 0 : Math.min(startFramePad, maxTotalPad / 2);
  const endPad = Math.min(endFramePad, maxTotalPad - startPad);

  return {
    start: start + startPad,
    end: end - endPad,
  };
}

function DirectStreamPlayer({ src }: { src: string }) {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const [playbackError, setPlaybackError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;

    let hls: { destroy: () => void } | null = null;
    let cancelled = false;
    const isHlsStream = /\.m3u8($|[?#])/i.test(src);
    setPlaybackError(null);
    video.pause();
    video.removeAttribute("src");
    video.load();

    if (isHlsStream) {
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = src;
      } else {
        void import("hls.js")
          .then(({ default: Hls }) => {
            if (cancelled || !videoRef.current) return;
            if (!Hls.isSupported()) {
              setPlaybackError("This WebView does not support HLS playback.");
              return;
            }
            const instance = new Hls({
              enableWorker: true,
              lowLatencyMode: false,
            });
            hls = instance;
            instance.on(Hls.Events.ERROR, (_event, data) => {
              if (data.fatal) {
                setPlaybackError(`${data.type}: ${data.details}`);
              }
            });
            instance.loadSource(src);
            instance.attachMedia(video);
          })
          .catch((error) => {
            setPlaybackError(error instanceof Error ? error.message : String(error));
          });
      }
    } else {
      video.src = src;
    }

    return () => {
      cancelled = true;
      hls?.destroy();
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [src]);

  return (
    <div className="direct-stream-player">
      <video
        ref={videoRef}
        controls
        autoPlay
        crossOrigin="anonymous"
        onError={() => setPlaybackError("The stream could not be played by the WebView player.")}
      />
      {playbackError && (
        <div className="direct-stream-error">
          <AlertTriangle size={16} />
          <span>{playbackError}</span>
        </div>
      )}
    </div>
  );
}

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Catalog request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

function animeCover(anime: AnimeResult): string {
  return (
    anime.images?.webp?.large_image_url ||
    anime.images?.jpg?.large_image_url ||
    anime.images?.webp?.image_url ||
    anime.images?.jpg?.image_url ||
    ""
  );
}

function animeTrailer(anime: AnimeResult): string {
  if (anime.trailer?.embed_url) return anime.trailer.embed_url;
  if (anime.trailer?.youtube_id) return `https://www.youtube.com/embed/${anime.trailer.youtube_id}`;
  return "";
}

function animeTrailerPage(anime: AnimeResult): string {
  if (anime.trailer?.url) return anime.trailer.url;
  if (anime.trailer?.youtube_id) return `https://www.youtube.com/watch?v=${anime.trailer.youtube_id}`;
  return "";
}

function animeTrailerThumb(anime: AnimeResult): string {
  if (!anime.trailer?.youtube_id) return "";
  return `https://img.youtube.com/vi/${anime.trailer.youtube_id}/hqdefault.jpg`;
}

function extractEpisodeNumber(value: string): string | null {
  const match = value.match(/\b(?:episode|ep)\s*(\d+(?:\.\d+)?)\b/i);
  return match?.[1] ?? null;
}

function inferDownloadTitleFromUrl(value: string): string {
  try {
    const url = new URL(normalizeUrl(value));
    const id = url.searchParams.get("v") || url.pathname.split("/").filter(Boolean).pop() || "YouTube video";
    return `YouTube ${id}`;
  } catch {
    return "YouTube video";
  }
}

const BEST_FORMAT_ID = "__best__";

const BEST_FORMAT_ENTRY: DownloadFormat = {
  id: BEST_FORMAT_ID,
  label: "Best (auto-merge video + audio)",
  ext: "mp4",
  resolution: null,
  width: null,
  height: null,
  bitrate: null,
  filesize: null,
  vcodec: null,
  acodec: null,
  audioOnly: false,
};

function classifyDownloadFormat(format: DownloadFormat): "audio" | "video" | "combined" {
  if (format.audioOnly) return "audio";
  if (format.acodec && format.vcodec) return "combined";
  return "video";
}

function describeFormatKind(format: DownloadFormat): { text: string; tone: "best" | "combined" | "video" | "audio" } {
  if (format.id === BEST_FORMAT_ID) return { text: "Recommended - auto-merge", tone: "best" };
  switch (classifyDownloadFormat(format)) {
    case "audio":
      return { text: "Audio only", tone: "audio" };
    case "combined":
      return { text: "Video + Audio", tone: "combined" };
    case "video":
    default:
      return { text: "Video only - audio auto-merged", tone: "video" };
  }
}

function buildYoutubeFormatSpec(format: DownloadFormat): string {
  if (format.id === BEST_FORMAT_ID) return "bestvideo*+bestaudio/best";
  switch (classifyDownloadFormat(format)) {
    case "video":
      return `${format.id}+bestaudio/best`;
    case "audio":
    case "combined":
    default:
      return format.id;
  }
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

function normalizeUrl(value: string): string {
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value}`;
}

function isAllowedAnikaiUrl(value: string): boolean {
  try {
    const url = new URL(normalizeUrl(value));
    const allowed = ["aniwaves.ru", "aniwave.ru", "anikai.to"];
    return (url.protocol === "https:" || url.protocol === "http:") && allowed.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function buildAnikaiDownloadIdentity(
  pageUrl: string,
  qualityLabel: string,
  providerIdentity: ProviderPageIdentity | null,
): DownloadIdentity {
  const normalized = normalizeUrl(pageUrl.trim() || "https://aniwaves.ru");
  const title = cleanIdentityText(providerIdentity?.animeTitle) ?? inferAnikaiTitle(normalized);
  const episodeNumber = cleanIdentityText(providerIdentity?.episodeNumber) ?? inferAnikaiEpisodeNumber(normalized);
  const episodeLabel =
    cleanIdentityText(providerIdentity?.episodeLabel) ??
    (episodeNumber ? `Episode ${episodeNumber}` : null);
  return {
    animeTitle: title,
    episodeNumber,
    episodeLabel,
    qualityLabel,
    sourcePage: cleanIdentityText(providerIdentity?.sourcePage) ?? normalized,
  };
}

function formatDownloadIdentity(identity: DownloadIdentity, fallback: string): string {
  const parts = [identity.animeTitle, identity.episodeLabel, fallback].filter(Boolean);
  return parts.length > 0 ? parts.join(" - ") : fallback;
}

function mergeProviderIdentity(
  current: ProviderPageIdentity | null,
  next: ProviderPageIdentity,
): ProviderPageIdentity {
  return {
    animeTitle: cleanIdentityText(next.animeTitle) ?? cleanIdentityText(current?.animeTitle),
    episodeNumber: cleanIdentityText(next.episodeNumber) ?? cleanIdentityText(current?.episodeNumber),
    episodeLabel: cleanIdentityText(next.episodeLabel) ?? cleanIdentityText(current?.episodeLabel),
    sourcePage: cleanIdentityText(next.sourcePage) ?? cleanIdentityText(current?.sourcePage),
  };
}

function cleanIdentityText(value?: string | null): string | null {
  const cleaned = value?.replace(/\s+/g, " ").trim();
  return cleaned || null;
}

function inferAnikaiTitle(pageUrl: string): string | null {
  try {
    const url = new URL(pageUrl);
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const watchIndex = segments.findIndex((segment) => segment.toLowerCase() === "watch");
    const rawSlug = watchIndex >= 0 ? segments[watchIndex + 1] : segments[0];
    if (!rawSlug) return null;

    const cleanSlug = rawSlug.split('.')[0];
    const slugParts = cleanSlug.split("-").filter(Boolean);
    const lastPart = slugParts[slugParts.length - 1] ?? "";
    if (slugParts.length > 1 && /^[a-z0-9]{3,8}$/i.test(lastPart) && /\d/.test(lastPart)) {
      slugParts.pop();
    }

    const title = slugParts
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
    return title || null;
  } catch {
    return null;
  }
}

function inferAnikaiEpisodeNumber(pageUrl: string): string | null {
  try {
    const url = new URL(pageUrl);
    const params = ["ep", "episode", "episodeNumber", "e"];
    for (const key of params) {
      const value = url.searchParams.get(key);
      if (value && /^\d+(?:\.\d+)?$/.test(value.trim())) return value.trim();
    }

    const searchable = decodeURIComponent(`${url.pathname}${url.hash}`);
    const patterns = [
      /(?:^|[/?#&_-])episode[=/_-]?(\d+(?:\.\d+)?)(?:\b|$)/i,
      /(?:^|[/?#&_-])ep[=/_-]?(\d+(?:\.\d+)?)(?:\b|$)/i,
    ];
    for (const pattern of patterns) {
      const match = searchable.match(pattern);
      if (match?.[1]) return match[1];
    }

    const segments = url.pathname.split('/').filter(Boolean);
    const lastSegment = segments[segments.length - 1];
    if (lastSegment && /^\d+(?:\.\d+)?$/.test(lastSegment)) {
      return lastSegment;
    }
  } catch {
    return null;
  }
  return null;
}

function isBetterQualitySet(next: StreamQuality[], current: StreamQuality[]): boolean {
  if (current.length === 0) return true;
  const nextBestHeight = Math.max(...next.map((quality) => quality.height ?? 0));
  const currentBestHeight = Math.max(...current.map((quality) => quality.height ?? 0));
  if (next.length > current.length && nextBestHeight >= currentBestHeight) return true;
  return nextBestHeight > currentBestHeight;
}

function compareStreamQualities(left: StreamQuality, right: StreamQuality): number {
  const heightDiff = (right.height ?? 0) - (left.height ?? 0);
  if (heightDiff !== 0) return heightDiff;
  return (right.bitrate ?? 0) - (left.bitrate ?? 0);
}

function AudioExtractionPanel({ activeTab }: { activeTab: AudioTab }) {
  const [status, setStatus] = React.useState<AudioStatus | null>(cachedAudioStatus);
  const [history, setHistory] = React.useState<AudioHistoryItem[]>([]);
  const [selectedFiles, setSelectedFiles] = React.useState<string[]>([]);
  const [progress, setProgress] = React.useState<AudioProgress | null>(null);
  const [extracting, setExtracting] = React.useState(false);
  const [setupRunning, setSetupRunning] = React.useState<"cpu" | "gpu" | null>(null);
  const [setupProgress, setSetupProgress] = React.useState<AudioSetupProgress | null>(null);
  const [setupNotice, setSetupNotice] = React.useState<string | null>(null);
  const [resultMessage, setResultMessage] = React.useState<string | null>(null);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [outputPaths, setOutputPaths] = React.useState<string[]>([]);
  const [batchItems, setBatchItems] = React.useState<BatchItemStatus[]>([]);
  const audioCancellingRef = React.useRef(false);

  React.useEffect(() => {
    void refreshStatus();
    void refreshHistory();
  }, []);

  React.useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<AudioProgress>("audio-progress", (event) => {
      setProgress(event.payload);
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  React.useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<AudioSetupProgress>("audio-setup-progress", (event) => {
      setSetupProgress(event.payload);
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  async function refreshStatus(force = false) {
    let request: Promise<AudioStatus> | null = null;
    try {
      if (!force && cachedAudioStatus) {
        setStatus(cachedAudioStatus);
        return;
      }

      if (!force && pendingAudioStatus) {
        setStatus(await pendingAudioStatus);
        return;
      }

      request = invoke<string>("audio_status").then((raw) => parseBridgePayload<AudioStatus>(raw));
      pendingAudioStatus = request;
      const nextStatus = await request;
      cachedAudioStatus = nextStatus;
      setStatus(nextStatus);
    } catch (error) {
      setErrorMessage(readBridgeError(error));
    } finally {
      if (!request || pendingAudioStatus === request) {
        pendingAudioStatus = null;
      }
    }
  }

  async function refreshHistory() {
    try {
      const raw = await invoke<string>("audio_history");
      const payload = parseBridgePayload<{ type: "history"; items: AudioHistoryItem[] }>(raw);
      setHistory(payload.items ?? []);
    } catch (error) {
      console.error("Could not load audio history:", error);
      logFrontend("error", "frontend.audio.history.error", "Could not load audio history", {
        error: safeLogValue(error),
      });
    }
  }

  async function pickFile() {
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [
        {
          name: "Audio or video",
          extensions: ["wav", "mp3", "flac", "m4a", "mp4", "mkv", "avi", "webm", "mov"],
        },
      ],
    });
    const paths = normalizeSelectedPaths(selected);
    if (paths.length === 0) return;
    setSelectedFiles(paths);
    setResultMessage(null);
    setErrorMessage(null);
    setProgress(null);
    setBatchItems([]);
    void runExtraction(paths);
  }

  async function runExtraction(filePaths: string[]) {
    setExtracting(true);
    setResultMessage(null);
    setErrorMessage(null);
    setBatchItems([]);
    setProgress({ type: "progress", stage: "loading", percent: -1, message: "Loading AI model..." });
    try {
      const completed: BatchItemStatus[] = [];
      const allOutputs: string[] = [];
      for (let index = 0; index < filePaths.length; index += 1) {
        if (audioCancellingRef.current) break;
        const filePath = filePaths[index];
        setProgress({
          type: "progress",
          stage: "loading",
          percent: -1,
          message: `File ${index + 1}/${filePaths.length}: ${fileName(filePath)}`,
        });
        try {
          const raw = await invoke<string>("audio_extract", { inputPath: filePath });
          const payload = parseBridgePayload<{ type: "done"; outputs: string[] }>(raw);
          allOutputs.push(...(payload.outputs ?? []));
          completed.push({ input: filePath, outputs: payload.outputs ?? [], status: "done" });
        } catch (error) {
          if (audioCancellingRef.current) break;
          completed.push({ input: filePath, status: "error", message: readBridgeError(error) });
        }
        setBatchItems([...completed]);
      }
      setOutputPaths(allOutputs);
      const failures = completed.filter((item) => item.status === "error").length;
      setResultMessage(`${completed.length - failures}/${filePaths.length} files extracted. ${allOutputs.length} stems saved.`);
      await refreshHistory();
      await refreshStatus(true);
    } catch (error) {
      if (!audioCancellingRef.current) {
        setErrorMessage(readBridgeError(error));
      }
    } finally {
      audioCancellingRef.current = false;
      setExtracting(false);
      setProgress(null);
    }
  }

  function reset() {
    setSelectedFiles([]);
    setProgress(null);
    setResultMessage(null);
    setErrorMessage(null);
    setBatchItems([]);
  }

  async function startSetup(mode: "cpu" | "gpu") {
    setSetupRunning(mode);
    setSetupProgress({
      type: "setup-progress",
      step: 0,
      total: 0,
      state: "running",
      message: `Preparing ${mode.toUpperCase()} install...`,
    });
    setSetupNotice(null);
    setErrorMessage(null);
    try {
      await invoke<string>("audio_setup", { mode });
      setSetupNotice(`${mode === "gpu" ? "GPU" : "CPU"} engine ready. Pick a file to extract.`);
      await refreshStatus(true);
    } catch (error) {
      setErrorMessage(readBridgeError(error));
    } finally {
      setSetupRunning(null);
      setSetupProgress(null);
    }
  }

  if (activeTab === "history") {
    return (
      <div className="audio-history">
        {history.length === 0 ? (
          <div className="audio-empty">
            <History size={32} strokeWidth={1.8} />
            <h2>No extractions yet</h2>
          </div>
        ) : (
          history.map((item) => (
            <article className="history-row" key={`${item.created_at}-${item.input}`}>
              <div>
                <strong>{fileName(item.input)}</strong>
                <span>{item.created_at}</span>
              </div>
              <p>{item.outputs.map(fileName).join("  /  ")}</p>
            </article>
          ))
        )}
      </div>
    );
  }

  const depsReady = status?.dependencies.ready ?? true;
  const hasGpu = status?.hardware.gpu_type === "nvidia";
  const gpuSetupBlocked = status ? !hasGpu : false;
  const selectedFile = selectedFiles[0] ?? null;
  const selectedLabel = selectedFiles.length > 1 ? `${selectedFiles.length} files` : selectedFile ? fileName(selectedFile) : "";

  let stage: React.ReactNode;
  if (setupRunning) {
    stage = <SetupRunningCard mode={setupRunning} progress={setupProgress} />;
  } else if (status && !depsReady) {
    stage = (
      <DepInstallCard
        status={status}
        hasGpu={hasGpu}
        gpuSetupBlocked={gpuSetupBlocked}
        onChoose={startSetup}
      />
    );
  } else if (selectedFiles.length > 0 && extracting) {
    stage = (
      <ExtractionProgressCard
        fileName={selectedLabel}
        progress={progress}
        onCancel={() => {
          audioCancellingRef.current = true;
          void invoke("cancel_audio");
        }}
      />
    );
  } else if (selectedFiles.length > 0 && resultMessage) {
    const outputDir = outputPaths[0]?.replace(/[/\\][^/\\]+$/, "") ?? undefined;
    stage = (
      <ResultCard
        kind="success"
        fileName={selectedLabel}
        message={resultMessage}
        outputDir={outputDir}
        onAgain={reset}
      />
    );
  } else if (selectedFiles.length > 0 && errorMessage) {
    stage = (
      <ResultCard
        kind="error"
        fileName={selectedLabel}
        message={errorMessage}
        onAgain={reset}
        onRetry={() => runExtraction(selectedFiles)}
      />
    );
  } else {
    stage = <SelectFileButton onClick={pickFile} />;
  }

  return (
    <div className="audio-extract">
      <div className={`audio-status-line ${status ? "" : "is-pending"}`} aria-hidden={status ? undefined : true}>
        {status && (
          <>
            <span>
              <small>Engine</small>
              {status.hardware.device_short}
            </span>
            <span>
              <small>Model</small>
              {status.model_name}
            </span>
            <span className={depsReady ? "status-ready" : "status-warning"}>
              <small>Status</small>
              {depsReady ? "Ready" : "Setup required"}
            </span>
          </>
        )}
      </div>

      <div className="audio-stage">{stage}</div>

      {!selectedFile && setupNotice && (
        <div className="audio-message is-success">
          <CheckCircle2 size={17} /> {setupNotice}
        </div>
      )}
      {batchItems.length > 0 && <BatchStatusList items={batchItems} />}
    </div>
  );
}

function SelectFileButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="extract-vocals-button" onClick={onClick}>
      <span className="surface-mark extract-mark">
        <FolderKanban size={34} strokeWidth={1.8} />
      </span>
      <span>Select files</span>
      <span className="extract-hint">Audio or video — each file gets vocals and instrumental saved next to the original.</span>
    </button>
  );
}

function BatchStatusList({ items }: { items: BatchItemStatus[] }) {
  return (
    <div className="batch-status-list">
      {items.map((item) => (
        <div className={`batch-status-row is-${item.status}`} key={item.input}>
          {item.status === "done" ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
          <span>{fileName(item.input)}</span>
          <small>{item.status === "done" ? "Done" : item.message ?? "Failed"}</small>
        </div>
      ))}
    </div>
  );
}

function ExtractionProgressCard({
  fileName: name,
  progress,
  onCancel,
}: {
  fileName: string;
  progress: AudioProgress | null;
  onCancel?: () => void;
}) {
  const stage = progress?.stage ?? "loading";
  const percent = progress?.percent ?? -1;
  const indeterminate = percent < 0;
  const stageLabel = stageHeading(stage, percent);
  const subline = progress?.message ?? "Loading AI model...";

  return (
    <section className="audio-card extraction-card" aria-live="polite">
      <header className="audio-card-header">
        <span className="audio-card-icon">
          <Loader2 size={22} strokeWidth={2.2} className="audio-spin" />
        </span>
        <div>
          <h2>{stageLabel}</h2>
          <p className="audio-file-line">
            <FileAudio size={14} strokeWidth={2} /> {name}
          </p>
        </div>
      </header>

      <div
        className={`audio-progress-track ${indeterminate ? "is-indeterminate" : ""}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : percent}
      >
        <div
          className="audio-progress-fill"
          style={indeterminate ? undefined : { width: `${Math.max(0, Math.min(100, percent))}%` }}
        />
      </div>

      <p className="audio-card-status">{subline}</p>
      {onCancel && (
        <div className="result-actions">
          <button type="button" className="install-btn is-secondary" onClick={onCancel}>
            <X size={15} strokeWidth={2.3} />
            <span>Cancel</span>
          </button>
        </div>
      )}
    </section>
  );
}

function stageHeading(stage: string, percent: number): string {
  switch (stage) {
    case "loading":
      return "Loading AI model";
    case "model-download":
      return percent >= 0 ? `Downloading AI model — ${percent}%` : "Downloading AI model";
    case "processing":
      return percent >= 0 ? `Extracting vocals — ${percent}%` : "Extracting vocals";
    case "finalizing":
      return "Saving stems";
    case "complete":
      return "Complete";
    default:
      return "Working";
  }
}

function DepInstallCard({
  status,
  hasGpu,
  gpuSetupBlocked,
  onChoose,
}: {
  status: AudioStatus;
  hasGpu: boolean;
  gpuSetupBlocked: boolean;
  onChoose: (mode: "cpu" | "gpu") => void;
}) {
  return (
    <section className="audio-card install-card">
      <header className="audio-card-header">
        <span className="audio-card-icon install-icon">
          <Sparkles size={22} strokeWidth={2.2} />
        </span>
        <div>
          <h2>One-time engine setup</h2>
          <p className="audio-card-sub">
            Vocal Extraction needs PyTorch, audio-separator, and the model runtime. Pick a mode and we'll install
            everything for you.
          </p>
        </div>
      </header>

      <ul className="install-detect">
        {gpuSetupBlocked && (
          <li className="install-warning">
            <span className="install-detect-label">Compatible GPU not found</span>
            <span className="install-detect-value">GPU Vocal Extraction needs an NVIDIA CUDA GPU.</span>
          </li>
        )}
        <li>
          <span className="install-detect-label">Detected hardware</span>
          <span className="install-detect-value">{status.hardware.device}</span>
        </li>
        <li>
          <span className="install-detect-label">Active model</span>
          <span className="install-detect-value">{status.model_name}</span>
        </li>
      </ul>

      <div className="install-actions">
        <button
          type="button"
          className={`install-btn ${hasGpu ? "is-primary" : "is-secondary"}`}
          onClick={() => onChoose("gpu")}
          disabled={gpuSetupBlocked}
          title={hasGpu ? "Install GPU mode (CUDA 12.8)" : "Compatible GPU not found"}
        >
          <Zap size={16} strokeWidth={2.3} />
          <span>Install GPU mode</span>
          <small>{hasGpu ? "CUDA 12.8 — faster" : "Compatible GPU not found"}</small>
        </button>

        <button
          type="button"
          className={`install-btn ${hasGpu ? "is-secondary" : "is-primary"}`}
          onClick={() => onChoose("cpu")}
        >
          <Cpu size={16} strokeWidth={2.3} />
          <span>Install CPU only</span>
          <small>{hasGpu ? "Skip GPU — works anywhere" : "Recommended"}</small>
        </button>
      </div>
    </section>
  );
}

function SetupRunningCard({
  mode,
  progress,
}: {
  mode: "cpu" | "gpu";
  progress: AudioSetupProgress | null;
}) {
  const total = progress?.total ?? 0;
  const step = progress?.step ?? 0;
  const indeterminate = total === 0 || step === 0;
  const percent = total > 0 ? Math.min(100, Math.round((step / total) * 100)) : 0;
  const heading = `Installing ${mode === "gpu" ? "GPU" : "CPU"} engine`;
  const subheading =
    total > 0 ? `Step ${Math.min(step, total)} of ${total}` : "Preparing install...";
  const detail = progress?.message ? friendlySetupMessage(progress.message) : "Starting...";

  return (
    <section className="audio-card install-card is-running" aria-live="polite">
      <header className="audio-card-header">
        <span className="audio-card-icon install-icon">
          <Loader2 size={22} strokeWidth={2.2} className="audio-spin" />
        </span>
        <div>
          <h2>{heading}</h2>
          <p className="audio-card-sub">{subheading}</p>
        </div>
      </header>

      <div
        className={`audio-progress-track ${indeterminate ? "is-indeterminate" : ""}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : percent}
      >
        <div
          className="audio-progress-fill"
          style={{ width: indeterminate ? "100%" : `${Math.max(4, percent)}%` }}
        />
      </div>

      <p className="audio-card-status install-detail" title={progress?.message ?? ""}>
        {detail}
      </p>
    </section>
  );
}

function friendlySetupMessage(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return "Working...";
  if (trimmed.length > 120) return trimmed.slice(0, 117) + "...";
  return trimmed;
}

function ResultCard({
  kind,
  fileName: name,
  message,
  onAgain,
  onRetry,
  outputDir,
}: {
  kind: "success" | "error";
  fileName: string;
  message: string;
  onAgain: () => void;
  onRetry?: () => void;
  outputDir?: string;
}) {
  const isSuccess = kind === "success";
  return (
    <section className={`audio-card result-card is-${kind}`}>
      <header className="audio-card-header">
        <span className={`audio-card-icon ${isSuccess ? "result-success" : "result-error"}`}>
          {isSuccess ? <CheckCircle2 size={22} /> : <AlertTriangle size={22} />}
        </span>
        <div>
          <h2>{isSuccess ? "Extraction complete" : "Extraction failed"}</h2>
          <p className="audio-file-line">
            <FileAudio size={14} strokeWidth={2} /> {name}
          </p>
        </div>
      </header>
      <p className="audio-card-status">{message}</p>
      <div className="result-actions">
        {isSuccess && outputDir && (
          <button
            type="button"
            className="install-btn is-secondary"
            onClick={() => invoke("open_path", { path: outputDir })}
          >
            <FolderOpen size={15} strokeWidth={2.3} />
            <span>Open folder</span>
          </button>
        )}
        {!isSuccess && onRetry && (
          <button type="button" className="install-btn is-secondary" onClick={onRetry}>
            <RefreshCw size={15} strokeWidth={2.3} />
            <span>Try again</span>
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

function MediaToAudioPanel() {
  const [format, setFormat] = React.useState<AudioOutputFormat>("wav");
  const [selectedFiles, setSelectedFiles] = React.useState<string[]>([]);
  const [progress, setProgress] = React.useState<ConversionProgress | null>(null);
  const [result, setResult] = React.useState<ConversionDone | null>(null);
  const [batchItems, setBatchItems] = React.useState<BatchItemStatus[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [running, setRunning] = React.useState(false);

  React.useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<ConversionProgress>("conversion-progress", (event) => {
      setProgress(event.payload);
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  async function pickFile() {
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [
        {
          name: "Audio or video",
          extensions: ["wav", "mp3", "flac", "m4a", "ogg", "aac", "opus", "wma", "mp4", "mkv", "avi", "webm", "mov"],
        },
      ],
    });
    const paths = normalizeSelectedPaths(selected);
    if (paths.length === 0) return;
    setSelectedFiles(paths);
    setProgress(null);
    setResult(null);
    setBatchItems([]);
    setError(null);
  }

  async function startConversion() {
    if (selectedFiles.length === 0 || running) return;
    setRunning(true);
    setResult(null);
    setBatchItems([]);
    setError(null);
    setProgress({
      stage: "starting",
      percent: 0,
      message: selectedFiles.length > 1 ? `Preparing ${selectedFiles.length} audio conversions...` : `Preparing ${format.toUpperCase()} conversion...`,
    });
    try {
      const completed: BatchItemStatus[] = [];
      for (let index = 0; index < selectedFiles.length; index += 1) {
        const inputPath = selectedFiles[index];
        setProgress({
          stage: "starting",
          percent: Math.round((index / selectedFiles.length) * 100),
          message: `File ${index + 1}/${selectedFiles.length}: ${fileName(inputPath)}`,
        });
        try {
          const raw = await invoke<string>("media_to_audio", { inputPath, outputFormat: format });
          const payload = parseBridgePayload<ConversionDone>(raw);
          completed.push({ input: inputPath, output: payload.output, status: "done" });
          setResult(payload);
        } catch (conversionError) {
          completed.push({ input: inputPath, status: "error", message: readBridgeError(conversionError) });
        }
        setBatchItems([...completed]);
      }
      setProgress({
        stage: "complete",
        percent: 100,
        message: `Converted ${completed.filter((item) => item.status === "done").length}/${selectedFiles.length} files.`,
      });
    } catch (conversionError) {
      setError(readBridgeError(conversionError));
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="conversion-panel">
      <div className="conversion-hero">
        <div>
          <span className="conversion-kicker">Any To Audio</span>
          <h2>Extract a clean edit-ready audio file</h2>
        </div>
        <div className="conversion-format-card">
          <span>Output</span>
          <div className="conversion-segment" aria-label="Audio output format">
            <button type="button" className={format === "wav" ? "is-active" : ""} onClick={() => setFormat("wav")} disabled={running}>
              WAV
            </button>
            <button type="button" className={format === "mp3" ? "is-active" : ""} onClick={() => setFormat("mp3")} disabled={running}>
              MP3
            </button>
          </div>
        </div>
      </div>

      <div className="conversion-grid">
        <ConversionSourceCard
          icon={<FileAudio size={24} strokeWidth={1.9} />}
          label="Source media"
          selectedFiles={selectedFiles}
          pickLabel={selectedFiles.length > 0 ? "Change files" : "Select files"}
          onPick={pickFile}
          disabled={running}
        />
        <ConversionRunCard
          title={`Convert to ${format.toUpperCase()}`}
          subtitle={format === "wav" ? "PCM 16-bit, 44.1 kHz stereo" : "LAME V0 MP3, 44.1 kHz stereo"}
          canRun={selectedFiles.length > 0 && !running}
          running={running}
          progress={progress}
          result={result}
          error={error}
          batchItems={batchItems}
          onRun={startConversion}
        />
      </div>
    </section>
  );
}

function VideoToVideoPanel() {
  const [preset, setPreset] = React.useState<VideoTranscodePreset>("prores-lt");
  const [qualityValues, setQualityValues] = React.useState<Record<VideoTranscodePreset, number>>({
    "gpu-intra": 16,
    "prores-lt": 360,
    "prores-hq": 800,
  });
  const [selectedFiles, setSelectedFiles] = React.useState<string[]>([]);
  const [gpuStatus, setGpuStatus] = React.useState<VideoGpuStatus | null>(null);
  const [progress, setProgress] = React.useState<ConversionProgress | null>(null);
  const [result, setResult] = React.useState<ConversionDone | null>(null);
  const [batchItems, setBatchItems] = React.useState<BatchItemStatus[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [running, setRunning] = React.useState(false);
  const videoCancellingRef = React.useRef(false);

  React.useEffect(() => {
    void refreshGpuStatus();
  }, []);

  React.useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<ConversionProgress>("conversion-progress", (event) => {
      setProgress(event.payload);
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  React.useEffect(() => {
    if (gpuStatus && !gpuStatus.compatible && preset === "gpu-intra") {
      setPreset("prores-lt");
    }
  }, [gpuStatus, preset]);

  async function refreshGpuStatus() {
    try {
      const raw = await invoke<string>("video_gpu_status");
      setGpuStatus(parseBridgePayload<VideoGpuStatus>(raw));
    } catch (statusError) {
      setGpuStatus({
        compatible: false,
        gpuName: null,
        hasNvidiaGpu: false,
        hasFfmpeg: false,
        hasFfprobe: false,
        hasH264Cuvid: false,
        hasHevcCuvid: false,
        hasHevcNvenc: false,
        hasH264Nvenc: false,
        hasAv1Nvenc: false,
        message: readBridgeError(statusError),
      });
    }
  }

  async function pickFile() {
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [
        {
          name: "Video",
          extensions: ["mp4", "mkv", "mov", "webm", "avi", "m4v"],
        },
      ],
    });
    const paths = normalizeSelectedPaths(selected);
    if (paths.length === 0) return;
    setSelectedFiles(paths);
    setProgress(null);
    setResult(null);
    setBatchItems([]);
    setError(null);
  }

  async function startTranscode() {
    if (selectedFiles.length === 0 || running) return;
    if (preset === "gpu-intra" && gpuIntraLocked) {
      setError(gpuStatus?.message ?? "Compatible GPU not found.");
      return;
    }
    if (preset === "gpu-intra") {
      for (const inputPath of selectedFiles) {
        try {
          const codec = await invoke<string>("video_source_codec", { inputPath });
          if (!["h264", "hevc"].includes(codec)) {
            setError(`GPU Intra supports H.264 or HEVC sources only because it uses NVIDIA NVDEC. ${fileName(inputPath)} is ${codec}. Choose ProRes LT or ProRes HQ for this file.`);
            return;
          }
        } catch (codecError) {
          setError(readBridgeError(codecError));
          return;
        }
      }
    }
    setRunning(true);
    videoCancellingRef.current = false;
    setResult(null);
    setBatchItems([]);
    setError(null);
    setProgress({
      stage: "starting",
      percent: 0,
      message: selectedFiles.length > 1 ? `Preparing ${selectedFiles.length} video transcodes...` : "Preparing ffmpeg transcode...",
    });
    try {
      const completed: BatchItemStatus[] = [];
      for (let index = 0; index < selectedFiles.length; index += 1) {
        if (videoCancellingRef.current) break;
        const inputPath = selectedFiles[index];
        setProgress({
          stage: "starting",
          percent: Math.round((index / selectedFiles.length) * 100),
          message: `File ${index + 1}/${selectedFiles.length}: ${fileName(inputPath)}`,
        });
        try {
          const raw = await invoke<string>("video_transcode", {
            inputPath,
            preset,
            qualityValue: qualityValues[preset],
          });
          const payload = parseBridgePayload<ConversionDone>(raw);
          completed.push({ input: inputPath, output: payload.output, status: "done" });
          setResult(payload);
        } catch (conversionError) {
          if (videoCancellingRef.current) {
            completed.push({ input: inputPath, status: "error", message: "Cancelled" });
            break;
          }
          completed.push({ input: inputPath, status: "error", message: readBridgeError(conversionError) });
        }
        setBatchItems([...completed]);
      }
      if (videoCancellingRef.current) {
        setError("Video transcode cancelled.");
        setProgress({
          stage: "cancelled",
          percent: null,
          message: "Video transcode cancelled.",
        });
        return;
      }
      setProgress({
        stage: "complete",
        percent: 100,
        message: `Transcoded ${completed.filter((item) => item.status === "done").length}/${selectedFiles.length} files.`,
      });
    } catch (conversionError) {
      setError(readBridgeError(conversionError));
    } finally {
      setRunning(false);
      videoCancellingRef.current = false;
    }
  }

  const presetInfo = videoPresetInfo(preset);
  const controlSpec = videoControlSpec(preset);
  const gpuIntraLocked = gpuStatus ? !gpuStatus.compatible : true;
  const qualityValue = qualityValues[preset];

  function setPresetQuality(value: number) {
    const clamped = clampNumber(value, controlSpec.min, controlSpec.max);
    setQualityValues((current) => ({ ...current, [preset]: clamped }));
  }

  return (
    <section className="conversion-panel">
      <div className="conversion-hero">
        <div>
          <span className="conversion-kicker">Video To Video</span>
          <h2>Transcode footage for editing</h2>
        </div>
        <div className="conversion-format-card wide">
          {gpuStatus && (
            <div className={`conversion-compat ${gpuStatus.compatible ? "is-ready" : "is-locked"}`}>
              {gpuStatus.compatible ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
              <span>{gpuStatus.message}</span>
            </div>
          )}
          {preset === "gpu-intra" && (
            <div className="conversion-compat is-locked">
              <Info size={15} />
              <span>GPU Intra accepts H.264 or HEVC source videos only. ProRes presets accept broader input formats.</span>
            </div>
          )}
          <span>Preset</span>
          <div className="conversion-segment video-presets" aria-label="Video transcode preset">
            <button
              type="button"
              className={preset === "gpu-intra" ? "is-active" : ""}
              onClick={() => setPreset("gpu-intra")}
              disabled={running || gpuIntraLocked}
              title={gpuStatus?.message ?? "Checking GPU Intra compatibility..."}
            >
              GPU Intra
            </button>
            <button type="button" className={preset === "prores-lt" ? "is-active" : ""} onClick={() => setPreset("prores-lt")} disabled={running}>
              ProRes LT
            </button>
            <button type="button" className={preset === "prores-hq" ? "is-active" : ""} onClick={() => setPreset("prores-hq")} disabled={running}>
              ProRes HQ
            </button>
          </div>
          <VideoOutputControl
            spec={controlSpec}
            value={qualityValue}
            disabled={running}
            onChange={setPresetQuality}
          />
        </div>
      </div>

      <div className="conversion-grid">
        <ConversionSourceCard
          icon={<FileVideo size={24} strokeWidth={1.9} />}
          label="Source video"
          selectedFiles={selectedFiles}
          pickLabel={selectedFiles.length > 0 ? "Change videos" : "Select videos"}
          onPick={pickFile}
          disabled={running}
        />
        <ConversionRunCard
          title={presetInfo.title}
          subtitle={presetInfo.subtitle}
          canRun={selectedFiles.length > 0 && !running && !(preset === "gpu-intra" && gpuIntraLocked)}
          running={running}
          progress={progress}
          result={result}
          error={error}
          batchItems={batchItems}
          onRun={startTranscode}
          onCancel={() => {
            videoCancellingRef.current = true;
            void invoke("cancel_video");
          }}
        />
      </div>
    </section>
  );
}

function VideoOutputControl({
  spec,
  value,
  disabled,
  onChange,
}: {
  spec: VideoControlSpec;
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const percent = ((value - spec.min) / (spec.max - spec.min)) * 100;
  const [draftValue, setDraftValue] = React.useState(String(value));

  React.useEffect(() => {
    setDraftValue(String(value));
  }, [value, spec.label]);

  function commitDraft() {
    const next = Number(draftValue);
    onChange(Number.isFinite(next) ? next : spec.defaultValue);
  }

  return (
    <div className="video-output-control">
      <div className="video-output-control-head">
        <div>
          <small>{spec.label}</small>
          <span>{spec.help}</span>
        </div>
        <label className="video-output-value">
          <span>{spec.valueLabel}</span>
          <input
            type="number"
            min={spec.min}
            max={spec.max}
            step={spec.step}
            value={draftValue}
            disabled={disabled}
            onChange={(event) => {
              const next = event.currentTarget.value;
              if (/^\d*$/.test(next)) {
                setDraftValue(next);
              }
            }}
            onBlur={commitDraft}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
            aria-label={spec.label}
          />
          <b>{spec.suffix}</b>
        </label>
      </div>
      <input
        className="video-output-slider"
        type="range"
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        style={{ "--fill": `${percent}%` } as React.CSSProperties}
        aria-label={spec.label}
      />
    </div>
  );
}

function ConversionSourceCard({
  icon,
  label,
  selectedFiles,
  pickLabel,
  onPick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  selectedFiles: string[];
  pickLabel: string;
  onPick: () => void;
  disabled: boolean;
}) {
  const selectedLabel = selectedFiles.length > 1
    ? `${selectedFiles.length} files selected`
    : selectedFiles[0] ? fileName(selectedFiles[0]) : "No file selected";
  const selectedPathLabel = selectedFiles.length > 1 ? selectedFiles.map(fileName).join(" / ") : selectedFiles[0];

  return (
    <div className="conversion-card source-card">
      <span className="conversion-icon">{icon}</span>
      <div>
        <small>{label}</small>
        <strong>{selectedLabel}</strong>
        {selectedPathLabel && <p>{selectedPathLabel}</p>}
      </div>
      <button type="button" className="conversion-pick-btn" onClick={onPick} disabled={disabled}>
        <FolderKanban size={16} strokeWidth={2.2} />
        <span>{pickLabel}</span>
      </button>
    </div>
  );
}

function ConversionRunCard({
  title,
  subtitle,
  canRun,
  running,
  progress,
  result,
  error,
  batchItems,
  onRun,
  onCancel,
}: {
  title: string;
  subtitle: string;
  canRun: boolean;
  running: boolean;
  progress: ConversionProgress | null;
  result: ConversionDone | null;
  error: string | null;
  batchItems?: BatchItemStatus[];
  onRun: () => void;
  onCancel?: () => void;
}) {
  const percent = progress?.percent ?? null;
  const indeterminate = running && (percent === null || percent < 0);
  const width = percent === null ? 0 : Math.max(0, Math.min(100, percent));

  return (
    <div className={`conversion-card run-card ${error ? "is-error" : ""}`}>
      <div className="conversion-run-head">
        <div>
          <small>Action</small>
          <strong>{title}</strong>
          <p>{subtitle}</p>
        </div>
        {running && onCancel ? (
          <button type="button" className="conversion-run-btn is-cancel" onClick={onCancel}>
            <X size={17} strokeWidth={2.3} />
            <span>Cancel</span>
          </button>
        ) : (
          <button type="button" className="conversion-run-btn" onClick={onRun} disabled={!canRun}>
            {running ? <Loader2 size={17} className="audio-spin" /> : <Zap size={17} strokeWidth={2.3} />}
            <span>{running ? "Working" : "Start"}</span>
          </button>
        )}
      </div>

      {(running || progress || result || error) && (
        <div className="conversion-status">
          <div
            className={`conversion-progress ${indeterminate ? "is-indeterminate" : ""}`}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent === null ? undefined : Math.round(width)}
          >
            <span style={{ width: indeterminate ? "100%" : `${width}%` }} />
          </div>
          <p>{error || progress?.message || (result ? `Saved: ${result.output}` : "Ready")}</p>
          {progress && (progress.fps || progress.speed) && (
            <div className="conversion-metrics">
              {progress.fps && <span>fps {progress.fps}</span>}
              {progress.speed && <span>speed {progress.speed}</span>}
            </div>
          )}
          {result && (
            <div className="conversion-output">
              <CheckCircle2 size={16} />
              <span>{fileName(result.output)}</span>
            </div>
          )}
          {result?.archivedOriginal && (
            <div className="conversion-output is-muted">
              <History size={16} />
              <span>Original archived in {fileName(result.archivedOriginal)}</span>
            </div>
          )}
          {batchItems && batchItems.length > 1 && <BatchStatusList items={batchItems} />}
        </div>
      )}
    </div>
  );
}

function videoPresetInfo(preset: VideoTranscodePreset): { title: string; subtitle: string } {
  switch (preset) {
    case "gpu-intra":
      return {
        title: "GPU Intra MOV",
        subtitle: "NVDEC H.264/HEVC decode to HEVC NVENC Main10 all-intra",
      };
    case "prores-lt":
      return {
        title: "ProRes 422 LT",
        subtitle: "10-bit 4:2:2 ProRes LT MOV for lighter editing intermediates",
      };
    case "prores-hq":
      return {
        title: "ProRes 422 HQ",
        subtitle: "10-bit 4:2:2 ProRes HQ MOV for high-quality intermediates",
      };
  }
}

function videoControlSpec(preset: VideoTranscodePreset): VideoControlSpec {
  switch (preset) {
    case "gpu-intra":
      return {
        label: "Constant quality",
        valueLabel: "QP",
        help: "Lower values keep more detail and create larger files.",
        min: 10,
        max: 28,
        step: 1,
        defaultValue: 16,
        suffix: "",
      };
    case "prores-lt":
      return {
        label: "Bitrate density",
        valueLabel: "Density",
        help: "Higher density raises ProRes LT file size and headroom.",
        min: 180,
        max: 700,
        step: 10,
        defaultValue: 360,
        suffix: "",
      };
    case "prores-hq":
      return {
        label: "Bitrate density",
        valueLabel: "Density",
        help: "Higher density raises ProRes HQ file size and headroom.",
        min: 400,
        max: 1400,
        step: 10,
        defaultValue: 800,
        suffix: "",
      };
  }
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function LogsPanel() {
  const [lines, setLines] = React.useState<string[]>([]);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [copyState, setCopyState] = React.useState<"idle" | "copied" | "error">("idle");
  const [clearing, setClearing] = React.useState(false);

  React.useEffect(() => {
    void refreshLogs();
    const interval = window.setInterval(() => {
      void refreshLogs();
    }, 2500);
    return () => window.clearInterval(interval);
  }, []);

  async function refreshLogs() {
    try {
      const raw = await invoke<string>("app_logs");
      const payload = parseBridgePayload<{ type: "logs"; lines: string[] }>(raw);
      setLines(payload.lines ?? []);
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(readBridgeError(error));
    }
  }

  async function copyLogs() {
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopyState("copied");
      logFrontend("info", "frontend.logs.copy", "Copied logs to clipboard", {
        lineCount: lines.length,
      });
      window.setTimeout(() => setCopyState("idle"), 1600);
    } catch (error) {
      setCopyState("error");
      setErrorMessage(readBridgeError(error));
      logFrontend("error", "frontend.logs.copy.error", "Could not copy logs to clipboard", {
        error: safeLogValue(error),
      });
      window.setTimeout(() => setCopyState("idle"), 2200);
    }
  }

  async function clearLogs() {
    try {
      setClearing(true);
      await invoke("clear_app_logs");
      setLines([]);
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(readBridgeError(error));
    } finally {
      setClearing(false);
    }
  }

  return (
    <div className="logs-panel">
      <div className="logs-toolbar">
        <span>{lines.length} log lines</span>
        <div className="logs-actions">
          <button className="logs-clear-button" type="button" onClick={clearLogs} disabled={lines.length === 0 || clearing}>
            <Trash2 size={15} />
            {clearing ? "Clearing" : "Clear logs"}
          </button>
          <button type="button" onClick={copyLogs} disabled={lines.length === 0}>
            <Copy size={15} />
            {copyState === "copied" ? "Copied" : copyState === "error" ? "Copy failed" : "Copy logs"}
          </button>
          <button type="button" onClick={refreshLogs}>
            Refresh
          </button>
        </div>
      </div>

      {errorMessage && (
        <div className="audio-message is-error">
          <AlertTriangle size={17} /> {errorMessage}
        </div>
      )}

      {lines.length === 0 ? (
        <div className="audio-empty">
          <ScrollText size={32} strokeWidth={1.8} />
          <h2>No logs yet</h2>
        </div>
      ) : (
        <pre className="terminal-log" aria-label="Application logs">
          {lines.join("\n")}
        </pre>
      )}
    </div>
  );
}

type AppConfig = {
  type: "config";
  force_cpu: boolean;
  setup_type: string;
  clip_extraction_mode: "cpu" | "gpu";
  setup_complete: boolean;
  download_path: string;
  theme: AppThemeId;
  theme_color_a: string;
  theme_color_b: string;
};

function SettingsPanel() {
  const [backendConfig, setBackendConfig] = React.useState<AppConfig | null>(null);
  const [localClipMode, setLocalClipMode] = React.useState<"cpu" | "gpu">("gpu");
  const [localDownloadPath, setLocalDownloadPath] = React.useState("");
  const [localThemeColors, setLocalThemeColors] = React.useState(() => readThemeColors(null));
  const [status, setStatus] = React.useState<AudioStatus | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [setupRunning, setSetupRunning] = React.useState<"cpu" | "gpu" | null>(null);
  const [setupProgress, setSetupProgress] = React.useState<AudioSetupProgress | null>(null);
  const [setupLines, setSetupLines] = React.useState<string[]>([]);
  const [setupNotice, setSetupNotice] = React.useState<string | null>(null);
  const setupLogRef = React.useRef<HTMLPreElement | null>(null);
  const [clearingCache, setClearingCache] = React.useState(false);
  const [cacheNotice, setCacheNotice] = React.useState<string | null>(null);
  const [cacheError, setCacheError] = React.useState<string | null>(null);

  React.useEffect(() => {
    void refreshConfig();
    void refreshStatus();
  }, []);

  React.useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<AudioSetupProgress>("audio-setup-progress", (event) => {
      setSetupProgress(event.payload);
      setSetupLines((current) => {
        const nextLine = formatSetupLogLine(event.payload);
        if (!nextLine || current[current.length - 1] === nextLine) return current;
        return [...current, nextLine].slice(-80);
      });
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  React.useEffect(() => {
    const log = setupLogRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [setupLines]);

  async function refreshConfig() {
    try {
      const raw = await invoke<string>("get_config");
      const payload = parseBridgePayload<AppConfig>(raw);
      setBackendConfig(payload);
      setLocalClipMode(payload.clip_extraction_mode ?? "gpu");
      setLocalDownloadPath(payload.download_path ?? "");
      const nextThemeColors = readThemeColors(payload);
      setLocalThemeColors(nextThemeColors);
      applyAppTheme(nextThemeColors);
      setError(null);
    } catch (e) {
      setError(readBridgeError(e));
    }
  }

  async function refreshStatus() {
    try {
      const raw = await invoke<string>("audio_status");
      const payload = parseBridgePayload<AudioStatus>(raw);
      setStatus(payload);
    } catch (e) {
      console.error("Could not load status:", e);
      logFrontend("error", "frontend.settings.status.error", "Could not load dependency status", {
        error: safeLogValue(e),
      });
    }
  }

  async function persistConfigField(key: string, value: string) {
    try {
      const raw = await invoke<string>("set_config", { key, value });
      const latest = parseBridgePayload<AppConfig>(raw);
      setBackendConfig(latest);
      setError(null);
    } catch (e) {
      setError(readBridgeError(e));
    }
  }

  async function switchMode(mode: "cpu" | "gpu") {
    setSetupRunning(mode);
    setSetupLines([]);
    setSetupProgress({
      type: "setup-progress",
      step: 0,
      total: 0,
      state: "running",
      message: `Preparing ${mode.toUpperCase()} install...`,
    });
    setSetupNotice(null);
    setError(null);
    try {
      await invoke<string>("set_config", { key: "setup_type", value: mode });
      await invoke<string>("set_config", { key: "clip_extraction_mode", value: mode });
      await invoke<string>("audio_setup", { mode });
      setSetupNotice(`${mode === "gpu" ? "GPU" : "CPU"} engine ready.`);
      window.dispatchEvent(new CustomEvent("clipmode-changed", { detail: { mode } }));
      await refreshConfig();
      await refreshStatus();
      window.setTimeout(() => setSetupLines([]), 10000);
    } catch (e) {
      setError(readBridgeError(e));
    } finally {
      setSetupRunning(null);
      setSetupProgress(null);
    }
  }

  async function clearCache() {
    setClearingCache(true);
    setCacheNotice(null);
    setCacheError(null);
    try {
      const report = await invoke<{ files_removed: number; bytes_freed: number }>("clear_app_cache");
      const files = report.files_removed ?? 0;
      const bytes = report.bytes_freed ?? 0;
      setCacheNotice(
        files === 0
          ? "Cache already empty."
          : `Cleared ${files} preview file${files === 1 ? "" : "s"} (${formatBytes(bytes)}).`,
      );
      window.setTimeout(() => setCacheNotice(null), 6000);
    } catch (e) {
      setCacheError(readBridgeError(e));
    } finally {
      setClearingCache(false);
    }
  }

  const rawMode = backendConfig?.setup_type ?? "cpu";
  const currentMode = rawMode;
  const hasGpu = status?.hardware.gpu_type === "nvidia";
  const settingsChecking = !status || !backendConfig;
  const gpuSetupBlocked = status ? !hasGpu : false;
  const depsReady = status?.dependencies.ready ?? false;
  const gpuAllSet = currentMode === "gpu" && depsReady && hasGpu;
  const cpuAllSet = currentMode === "cpu" && depsReady;

  return (
    <div className="settings-panel">
      <div className="settings-toolbar">
        <span>System preferences</span>
      </div>

      <div className="settings-groups">


        <div className="settings-group">
          <div className="settings-group-header">AI Hardware Engine</div>
          <div className="settings-engine-warning">
            <AlertTriangle size={15} />
            <span>
              This engine is shared between <strong>Vocal Extraction</strong> and <strong>Clip Extraction</strong>.
              Because they share a single PyTorch environment, you must use the same hardware mode for both.
            </span>
          </div>

          <div className="setting-row deps-row">
            <div className="setting-info">
              <span className="setting-label">Active mode</span>
              <span className="setting-desc">
                {currentMode === "gpu" ? "GPU (CUDA)" : "CPU-only"}{" · "}
                {status
                  ? `${status.hardware.device} · ${status.hardware.provider}`
                  : "Checking..."}
              </span>
            </div>

            <div className="deps-badge">
              {depsReady ? (
                <span className="deps-badge-ready">{currentMode.toUpperCase()} READY</span>
              ) : (
                <span className="deps-badge-missing">Not installed</span>
              )}
            </div>
          </div>

          <div className="setting-row deps-row">
            <div className="setting-info">
              <span className="setting-label">Dependency status</span>
              <span className="setting-desc">
                {status
                  ? [
                    status.dependencies.torch ? `PyTorch ${status.dependencies.torch_version ?? ""}` : "PyTorch missing",
                    status.dependencies.onnxruntime ? "ONNX OK" : "ONNX missing",
                    status.dependencies.audio_separator ? "audio-separator OK" : "audio-separator missing",
                    status.dependencies.typing_extensions ? "typing_extensions OK" : "typing_extensions missing",
                    status.dependencies.pydub ? "pydub OK" : "pydub missing",
                  ].join("  ·  ")
                  : "Loading..."}
              </span>
            </div>
          </div>

          <div className="deps-switch-actions">
            {gpuSetupBlocked && (
              <div className="settings-gpu-warning">
                <AlertTriangle size={15} />
                <span>Compatible GPU not found. GPU Vocal Extraction needs an NVIDIA CUDA GPU.</span>
              </div>
            )}
            <button
              type="button"
              className={`install-btn ${currentMode === "gpu" ? "is-primary" : "is-secondary"}`}
              onClick={() => switchMode("gpu")}
              disabled={settingsChecking || gpuAllSet || setupRunning !== null || gpuSetupBlocked}
              title={
                settingsChecking ? "Checking GPU compatibility..." :
                  gpuAllSet ? "GPU mode is ready" :
                    gpuSetupBlocked ? "Compatible GPU not found" :
                      "Switch to GPU mode (CUDA 12.8)"
              }
            >
              <Zap size={16} strokeWidth={2.3} />
              <span>{settingsChecking ? "Checking GPU" : gpuAllSet ? "GPU ready" : "Switch to GPU"}</span>
              <small>{settingsChecking ? "Please wait" : gpuAllSet ? "Already set up" : hasGpu ? "CUDA 12.8 — faster" : "Compatible GPU not found"}</small>
            </button>

            <button
              type="button"
              className={`install-btn ${currentMode === "cpu" ? "is-primary" : "is-secondary"}`}
              onClick={() => switchMode("cpu")}
              disabled={settingsChecking || cpuAllSet || setupRunning !== null}
              title={settingsChecking ? "Checking current setup..." : cpuAllSet ? "CPU mode is ready" : "Switch to CPU mode"}
            >
              <Cpu size={16} strokeWidth={2.3} />
              <span>{settingsChecking ? "Checking CPU" : cpuAllSet ? "CPU ready" : "Switch to CPU"}</span>
              <small>{settingsChecking ? "Please wait" : cpuAllSet ? "Already set up" : hasGpu ? "Fallback — works anywhere" : "Recommended"}</small>
            </button>
          </div>

          {setupRunning && (
            <div className="settings-setup-status">
              <Loader2 size={16} className="audio-spin" />
              <span>
                Installing {setupRunning === "gpu" ? "GPU" : "CPU"} engine{setupProgress ? ` — step ${setupProgress.step}/${setupProgress.total}` : ""}
              </span>
            </div>
          )}

          {setupLines.length > 0 && (
            <pre ref={setupLogRef} className="settings-live-log" aria-label="Dependency setup log">
              {setupLines.join("\n")}
            </pre>
          )}

          {setupNotice && (
            <div className="settings-notice is-success">
              <CheckCircle2 size={16} /> {setupNotice}
            </div>
          )}

          {error && (
            <div className="settings-notice is-error">
              <AlertTriangle size={16} /> {error}
            </div>
          )}
        </div>

        <div className="settings-group">
          <div className="settings-group-header">Clip Extraction</div>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">Detection engine</span>
              <span className="setting-desc">
                {currentMode === "gpu"
                  ? "RTX TransNetV2 with NVDEC analysis decode (Locked to AI Hardware Engine)"
                  : "PySceneDetect CPU detection for broad hardware support (Locked to AI Hardware Engine)"}
              </span>
            </div>
            <div className="deps-badge">
              <span className="deps-badge-ready" style={{ color: "var(--fg-muted)", border: "1px solid var(--border)", background: "transparent" }}>
                {currentMode.toUpperCase()}
              </span>
            </div>
          </div>

        </div>

        <div className="settings-group">
          <div className="settings-group-header">Downloads</div>
          <div className="setting-row">
            <div className="setting-info" style={{ flex: 1, minWidth: 0 }}>
              <span className="setting-label">Download folder</span>
              <span className="setting-desc">
                Where anime episodes are saved. Defaults to Videos\Ultimate AMV\anime downloads.
              </span>
            </div>
          </div>
          <div className="settings-download-path-row">
            <input
              type="text"
              className="settings-path-input"
              value={localDownloadPath}
              placeholder="Default: Videos\Ultimate AMV\anime downloads"
              readOnly
              aria-label="Download folder path"
            />
            <button
              type="button"
              className="settings-path-browse-btn"
              onClick={async () => {
                const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
                const selected = await openDialog({ directory: true, multiple: false });
                if (selected && typeof selected === "string") {
                  setLocalDownloadPath(selected);
                  void persistConfigField("download_path", selected);
                }
              }}
            >
              Browse
            </button>
          </div>
        </div>

        <div className="settings-group">
          <div className="settings-group-header">Appearance</div>
          <div className="setting-row theme-setting-row">
            <div className="setting-info">
              <span className="setting-label">Gradient theme</span>
              <span className="setting-desc">Choose one or two custom colors for buttons, active tabs, highlights, progress, and action states.</span>
            </div>
            <div className="theme-customizer" aria-label="Gradient theme colors">
              <label className="theme-color-field">
                <span>Color 1</span>
                <input
                  type="color"
                  value={localThemeColors.primary}
                  onChange={(event) => {
                    const next = { ...localThemeColors, primary: event.currentTarget.value };
                    setLocalThemeColors(next);
                    applyAppTheme(next);
                    window.dispatchEvent(new CustomEvent("theme-changed", { detail: next }));
                    void persistConfigField("theme_color_a", next.primary);
                  }}
                  aria-label="Gradient theme color 1"
                />
              </label>
              <label className="theme-color-field">
                <span>Color 2</span>
                <input
                  type="color"
                  value={localThemeColors.secondary}
                  onChange={(event) => {
                    const next = { ...localThemeColors, secondary: event.currentTarget.value };
                    setLocalThemeColors(next);
                    applyAppTheme(next);
                    window.dispatchEvent(new CustomEvent("theme-changed", { detail: next }));
                    void persistConfigField("theme_color_b", next.secondary);
                  }}
                  aria-label="Gradient theme color 2"
                />
              </label>
              <div
                className="theme-gradient-preview"
                style={{
                  background: `linear-gradient(120deg, ${localThemeColors.primary}, ${localThemeColors.secondary})`,
                }}
                aria-hidden="true"
              />
            </div>
          </div>
        </div>

        <div className="settings-group">
          <div className="settings-group-header">Storage</div>
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">Preview cache</span>
              <span className="setting-desc">
                Generated thumbnail clips used by the clip grid. Safe to clear &mdash; previews regenerate on demand.
              </span>
            </div>
            <button
              type="button"
              className="install-btn is-secondary"
              onClick={() => void clearCache()}
              disabled={clearingCache}
              title="Delete cached clip preview files"
            >
              {clearingCache ? <Loader2 size={16} className="audio-spin" /> : <Trash2 size={16} strokeWidth={2.3} />}
              <span>{clearingCache ? "Clearing..." : "Clear cache"}</span>
              <small>{clearingCache ? "Please wait" : "Frees disk space"}</small>
            </button>
          </div>
          {cacheNotice && (
            <div className="settings-notice is-success">
              <CheckCircle2 size={16} /> {cacheNotice}
            </div>
          )}
          {cacheError && (
            <div className="settings-notice is-error">
              <AlertTriangle size={16} /> {cacheError}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


function formatSetupLogLine(progress: AudioSetupProgress): string {
  const parts = [];
  if (progress.total > 0 && progress.step > 0) {
    parts.push(`[${Math.min(progress.step, progress.total)}/${progress.total}]`);
  }
  if (progress.state !== "running") parts.push(progress.state.toUpperCase());
  parts.push(progress.message.trim() || "Working...");
  return parts.join(" ");
}


function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function fileStem(path: string): string {
  return fileName(path).replace(/\.[^.]+$/, "");
}

function normalizeSelectedPaths(selected: string | string[] | null): string[] {
  if (!selected) return [];
  return Array.isArray(selected) ? selected : [selected];
}

function formatClipTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function formatPreciseClipTime(seconds: number): string {
  const safeSeconds = Math.max(0, seconds);
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = Math.floor(safeSeconds % 60);
  const tenths = Math.floor((safeSeconds % 1) * 10);
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}.${tenths}`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  return formatClipTime(Math.max(0, seconds));
}

function readClipAudioSettings(): ClipAudioSettings {
  if (typeof window === "undefined") return { muted: true, volume: 0.6 };
  try {
    const raw = window.localStorage.getItem(CLIP_AUDIO_SETTINGS_KEY);
    if (!raw) return { muted: true, volume: 0.6 };
    const parsed = JSON.parse(raw) as Partial<ClipAudioSettings>;
    return {
      muted: Boolean(parsed.muted),
      volume: Math.max(0, Math.min(1, Number(parsed.volume ?? 0.6))),
    };
  } catch {
    return { muted: true, volume: 0.6 };
  }
}

function writeClipAudioSettings(settings: ClipAudioSettings) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    CLIP_AUDIO_SETTINGS_KEY,
    JSON.stringify({
      muted: settings.muted,
      volume: Math.max(0, Math.min(1, settings.volume)),
    }),
  );
}

function WindowChrome() {
  const isDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  async function withWindow(action: (appWindow: ReturnType<typeof getCurrentWindow>) => Promise<void>) {
    if (!isDesktop) return;
    try {
      await action(getCurrentWindow());
    } catch (error) {
      console.error("Window action failed:", error);
      logFrontend("error", "frontend.window.action.error", "Window action failed", {
        error: safeLogValue(error),
      });
    }
  }

  function startWindowDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    void withWindow((appWindow) => appWindow.startDragging());
  }

  return (
    <div className="window-chrome">
      <div className="drag-zone" onPointerDown={startWindowDrag} />
      <div className="window-controls">
        <button
          type="button"
          aria-label="Minimize"
          onClick={() => withWindow((appWindow) => appWindow.minimize())}
        >
          <Minus size={15} />
        </button>
        <button
          type="button"
          aria-label="Maximize"
          onClick={() => withWindow((appWindow) => appWindow.toggleMaximize())}
        >
          <Maximize2 size={13} />
        </button>
        <button
          type="button"
          className="close-window"
          aria-label="Close"
          onClick={() => withWindow((appWindow) => appWindow.close())}
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
}

function SidebarButton({
  item,
  active,
  expanded,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  expanded: boolean;
  onClick: () => void;
}) {
  const Icon = item.icon;

  return (
    <button
      type="button"
      className={`nav-button ${active ? "is-active" : ""}`}
      aria-label={item.label}
      title={expanded ? undefined : item.label}
      onClick={onClick}
    >
      <span className="nav-text">{item.label}</span>
      <span className="nav-icon">
        <Icon size={18} strokeWidth={2.1} />
      </span>
    </button>
  );
}

function Root() {
  const [setupComplete, setSetupComplete] = React.useState<boolean | null>(null);
  const [startupState, setStartupState] = React.useState<"idle" | "checking" | "ready" | "needs-repair" | "repairing" | "error">("idle");
  const [startupMode, setStartupMode] = React.useState<"cpu" | "gpu" | null>(null);
  const [startupPlan, setStartupPlan] = React.useState<AudioSetupPlan | null>(null);
  const [startupError, setStartupError] = React.useState<string | null>(null);
  const [startupProgress, setStartupProgress] = React.useState<AudioSetupProgress | null>(null);
  const [startupLines, setStartupLines] = React.useState<string[]>([]);
  const startupRepairRunningRef = React.useRef(false);

  React.useEffect(() => {
    invoke<string>("get_config")
      .then((raw) => {
        try {
          const config = parseBridgePayload<AppConfig>(raw);
          setSetupComplete(config.setup_complete === true);
        } catch {
          setSetupComplete(false);
        }
      })
      .catch(() => setSetupComplete(false));
  }, []);

  React.useEffect(() => {
    if (setupComplete === true) {
      void checkStartupDependencies();
    }
  }, [setupComplete]);

  React.useEffect(() => {
    const handler = () => {
      if (setupComplete === true) {
        void checkStartupDependencies();
      }
    };
    window.addEventListener("clipmode-changed", handler);
    return () => window.removeEventListener("clipmode-changed", handler);
  }, [setupComplete]);

  function parseSetupMode(value: unknown): "cpu" | "gpu" | null {
    return value === "cpu" || value === "gpu" ? value : null;
  }

  async function checkStartupDependencies() {
    setStartupState("checking");
    setStartupError(null);
    setStartupProgress(null);
    try {
      const rawConfig = await invoke<string>("get_config");
      const config = parseBridgePayload<AppConfig>(rawConfig);
      if (config.setup_complete !== true) {
        setSetupComplete(false);
        setStartupState("idle");
        return;
      }

      const mode = parseSetupMode(config.setup_type);
      if (!mode) {
        throw new Error(`Invalid setup mode in config: ${config.setup_type || "missing"}`);
      }
      setStartupMode(mode);

      const rawPlan = await invoke<string>("audio_setup_plan", { mode });
      const plan = parseBridgePayload<AudioSetupPlan>(rawPlan);
      setStartupPlan(plan);
      setStartupState(plan.installs.length === 0 ? "ready" : "needs-repair");
    } catch (error) {
      setStartupError(readBridgeError(error));
      setStartupState("error");
    }
  }

  async function repairStartupDependencies() {
    if (!startupMode || startupRepairRunningRef.current) return;

    startupRepairRunningRef.current = true;
    setStartupState("repairing");
    setStartupError(null);
    setStartupProgress(null);
    setStartupLines([]);

    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listen<AudioSetupProgress>("audio-setup-progress", (event) => {
        setStartupProgress(event.payload);
        setStartupLines((current) => {
          const line = formatStartupSetupLine(event.payload);
          if (!line || current[current.length - 1] === line) return current;
          return [...current, line].slice(-80);
        });
      });

      await invoke<string>("audio_setup", { mode: startupMode });
      await checkStartupDependencies();
    } catch (error) {
      setStartupError(readBridgeError(error));
      setStartupState("error");
    } finally {
      unlisten?.();
      startupRepairRunningRef.current = false;
    }
  }

  function formatStartupSetupLine(progress: AudioSetupProgress): string {
    const parts: string[] = [];
    if (progress.total > 0 && progress.step > 0) {
      parts.push(`[${Math.min(progress.step, progress.total)}/${progress.total}]`);
    }
    if (progress.state !== "running") {
      parts.push(progress.state.toUpperCase());
    }
    parts.push(progress.message.trim() || "Working...");
    return parts.join(" ");
  }

  function startupStatusClass(component: string, status: string): string {
    const normalizedComponent = component.toLowerCase();
    const normalized = status.toLowerCase();
    if (
      normalized === "not installed" &&
      (normalizedComponent === "cpu runtime" || normalizedComponent === "gpu runtime")
    ) {
      return "is-installed";
    }
    if (normalized.includes("needs install") || normalized.includes("missing") || normalized.includes("not installed")) {
      return "is-missing";
    }
    if (normalized.includes("will remove")) {
      return "is-missing";
    }
    if (normalized.includes("installed") || normalized.includes("ready") || normalized === "gpu" || normalized === "cpu") {
      return "is-installed";
    }
    return "";
  }

  if (setupComplete === null) {
    return (
      <div className="startup-gate">
        <div className="startup-gate-card">
          <Loader2 size={22} className="audio-spin" />
          <span>Loading setup state...</span>
        </div>
      </div>
    );
  }

  if (!setupComplete) {
    return <SetupWizard onComplete={() => setSetupComplete(true)} />;
  }

  if (startupState === "idle" || startupState === "checking") {
    return (
      <div className="startup-gate">
        <div className="startup-gate-card">
          <Loader2 size={22} className="audio-spin" />
          <span>Checking {startupMode ? startupMode.toUpperCase() : "engine"} dependencies...</span>
        </div>
      </div>
    );
  }

  if (startupState === "needs-repair" || startupState === "repairing" || startupState === "error") {
    const mode = startupMode ?? "cpu";
    const isRepairing = startupState === "repairing";
    const issueRows = startupPlan?.issues ?? [];
    const detailRows = startupPlan?.rows ?? [];

    return (
      <div className="startup-gate">
        <div className="startup-gate-card startup-gate-card-wide">
          {isRepairing ? (
            <Loader2 size={28} className="audio-spin startup-gate-icon" />
          ) : startupState === "error" ? (
            <AlertTriangle size={30} className="startup-gate-icon is-error" />
          ) : (
            <AlertTriangle size={30} className="startup-gate-icon" />
          )}
          <h2>
            {isRepairing
              ? `Repairing ${mode.toUpperCase()} Engine`
              : startupState === "error"
                ? "Dependency Check Failed"
                : `${mode.toUpperCase()} Engine Needs Setup`}
          </h2>
          <p>
            {isRepairing
              ? "Installing the missing packages into the bundled Python runtime."
              : "Startup checked the configured engine and found packages that need repair before all features are ready."}
          </p>

          {issueRows.length > 0 && (
            <div className="startup-gate-list">
              {issueRows.map((issue) => (
                <span key={issue}>{issue}</span>
              ))}
            </div>
          )}

          {detailRows.length > 0 && (
            <div className="startup-gate-table">
              {detailRows.map((row) => (
                <React.Fragment key={row.component}>
                  <span>{row.component}</span>
                  <strong className={startupStatusClass(row.component, row.status)}>{row.status}</strong>
                </React.Fragment>
              ))}
            </div>
          )}

          {startupError && (
            <div className="startup-gate-error">
              <AlertTriangle size={16} />
              <span>{startupError}</span>
            </div>
          )}

          {startupProgress && (
            <div className="startup-gate-progress">
              <Loader2 size={15} className="audio-spin" />
              <span>
                {startupProgress.total > 0
                  ? `Step ${Math.min(startupProgress.step, startupProgress.total)} / ${startupProgress.total}: ${startupProgress.message}`
                  : startupProgress.message}
              </span>
            </div>
          )}

          {startupLines.length > 0 && (
            <pre className="startup-gate-log">{startupLines.join("\n")}</pre>
          )}

          <div className="startup-gate-actions">
            <button type="button" className="install-btn" onClick={repairStartupDependencies} disabled={isRepairing || !startupMode}>
              {isRepairing ? <Loader2 size={16} className="audio-spin" /> : mode === "gpu" ? <Zap size={16} /> : <Cpu size={16} />}
              <span>{isRepairing ? "Repairing" : `Repair ${mode.toUpperCase()} Engine`}</span>
            </button>
            <button type="button" className="install-btn is-secondary" onClick={() => void checkStartupDependencies()} disabled={isRepairing}>
              <RefreshCw size={16} />
              <span>Retry Check</span>
            </button>
            <button type="button" className="install-btn is-secondary" onClick={() => setStartupState("ready")} disabled={isRepairing}>
              <ArrowRight size={16} />
              <span>Continue Anyway</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  return <App />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
