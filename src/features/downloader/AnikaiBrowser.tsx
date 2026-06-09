import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import { Webview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Loader2, RefreshCw, Globe, Link } from "lucide-react";
import { extractEpisodeNumber } from "../../lib/episode";
import { logFrontend, safeLogValue } from "../../lib/log";
import { normalizeUrl } from "../../lib/url";
import { parseBridgePayload } from "../../utils/bridge";
import type { AppConfig } from "../../types/app";
import type {
  CaptureState,
  DownloadIdentity,
  DownloadProgress,
  DownloadQueueItem,
  MediaCandidate,
  MediaRequestDebug,
  ProviderNavigation,
  ProviderPageIdentity,
  StreamQuality,
} from "../../types/download";
import { EpisodeLabelModal, type EpisodeLabelResult } from "./EpisodeLabelModal";

type PendingLabeledDownload = {
  target: StreamQuality;
  baseIdentity: DownloadIdentity;
  initialAnime: string;
  initialEpisode: string;
};

type ProviderPreset = {
  id: "animesuge" | "aniwaves";
  label: string;
  url: string;
  hosts: string[];
};

const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: "animesuge", label: "AnimeSuge", url: "https://animesuge.cz", hosts: ["animesuge.cz"] },
  { id: "aniwaves", label: "AniWaves", url: "https://aniwaves.ru", hosts: ["aniwaves.ru", "aniwave.ru"] },
];

const DEFAULT_PROVIDER_URL = PROVIDER_PRESETS[0].url;

function urlHost(value: string): string | null {
  try {
    return new URL(normalizeUrl(value)).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function presetForUrl(value: string): ProviderPreset | null {
  const host = urlHost(value);
  if (!host) return null;
  return PROVIDER_PRESETS.find((preset) =>
    preset.hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`)),
  ) ?? null;
}

function isHostAllowed(value: string, hosts: string[]): boolean {
  if (hosts.length === 0) return true;
  try {
    const url = new URL(normalizeUrl(value));
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    const host = url.hostname.toLowerCase();
    return hosts.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function buildAnikaiDownloadIdentity(
  pageUrl: string,
  qualityLabel: string,
  providerIdentity: ProviderPageIdentity | null,
): DownloadIdentity {
  const normalized = normalizeUrl(pageUrl.trim() || DEFAULT_PROVIDER_URL);
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
    // The slug sits one segment after a recognized prefix. /watch/ is the
    // AniKai/AniWaves convention, /anime/ is AnimeSuge. If neither prefix is
    // present we fall back to the first segment, but only if it doesn't look
    // like a generic top-level keyword that would title-case to garbage like
    // "Anime", "Watch", "Browse".
    const watchIndex = segments.findIndex((segment) => segment.toLowerCase() === "watch");
    const animeIndex = segments.findIndex((segment) => segment.toLowerCase() === "anime");
    const slugIndex = watchIndex >= 0
      ? watchIndex + 1
      : animeIndex >= 0
        ? animeIndex + 1
        : 0;
    const rawSlug = segments[slugIndex];
    if (!rawSlug) return null;
    // Reject if rawSlug is itself a generic keyword — happens when the URL
    // has no slug at all (e.g. /anime/ with nothing after, or /watch/).
    if (/^(anime|watch|browse|search|home)$/i.test(rawSlug)) return null;

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

export function AnikaiBrowser({
  active,
  enqueueDownload,
}: {
  active: boolean;
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
  const [providerMode, setProviderMode] = React.useState<"preset" | "custom">("preset");
  const [providerPresetId, setProviderPresetId] = React.useState<ProviderPreset["id"]>("animesuge");
  const [address, setAddress] = React.useState(DEFAULT_PROVIDER_URL);
  const [loadedUrl, setLoadedUrl] = React.useState<string | null>(null);
  const [currentPageUrl, setCurrentPageUrl] = React.useState(DEFAULT_PROVIDER_URL);
  const [reloadKey, setReloadKey] = React.useState(0);
  const configLoadedRef = React.useRef(false);
  const lastSavedUrlRef = React.useRef<string | null>(null);
  const allowedHostsRef = React.useRef<string[]>(PROVIDER_PRESETS[0].hosts);
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
  const [labelModalState, setLabelModalState] = React.useState<PendingLabeledDownload | null>(null);
  const [downloadDir, setDownloadDir] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void invoke<string>("get_config")
      .then((raw) => parseBridgePayload<AppConfig>(raw))
      .then((config) => {
        if (cancelled) return;
        setDownloadDir(config.download_path || null);
        const savedUrl = (config.provider_url || "").trim() || DEFAULT_PROVIDER_URL;
        const preset = presetForUrl(savedUrl);
        if (preset) {
          setProviderMode("preset");
          setProviderPresetId(preset.id);
          allowedHostsRef.current = preset.hosts;
        } else {
          setProviderMode("custom");
          allowedHostsRef.current = [];
        }
        setAddress(savedUrl);
        setCurrentPageUrl(savedUrl);
        setLoadedUrl(savedUrl);
        lastSavedUrlRef.current = savedUrl;
        configLoadedRef.current = true;
      })
      .catch(() => {
        if (cancelled) return;
        setDownloadDir(null);
        const fallback = DEFAULT_PROVIDER_URL;
        allowedHostsRef.current = PROVIDER_PRESETS[0].hosts;
        setLoadedUrl(fallback);
        lastSavedUrlRef.current = fallback;
        configLoadedRef.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    if (!configLoadedRef.current) return;
    if (!currentPageUrl) return;
    if (currentPageUrl === lastSavedUrlRef.current) return;
    const handle = window.setTimeout(() => {
      lastSavedUrlRef.current = currentPageUrl;
      void invoke("set_config", { key: "provider_url", value: currentPageUrl }).catch((error) => {
        logFrontend("warn", "frontend.provider.url.save.failed", "Could not persist provider URL", {
          error: safeLogValue(error),
        });
      });
    }, 1500);
    return () => window.clearTimeout(handle);
  }, [currentPageUrl]);

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

  const stashWebviewOffscreen = React.useCallback(async () => {
    const webview = webviewRef.current;
    if (!webview) return;
    try { await webview.setSize(new LogicalSize(1, 1)); } catch { }
    try { await webview.setPosition(new LogicalPosition(-32000, -32000)); } catch { }
  }, []);

  React.useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    if (!active) {
      void parkWebview().catch(() => undefined);
    } else if (labelModalState) {
      void stashWebviewOffscreen().catch(() => undefined);
    } else {
      void webview.show().then(() => syncWebviewBounds()).catch(() => undefined);
    }
  }, [active, labelModalState, parkWebview, stashWebviewOffscreen, syncWebviewBounds]);

  React.useEffect(() => {
    if (!active || labelModalState) return;

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
  }, [active, labelModalState, nudgeWebviewViewport, syncWebviewBounds]);

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
      if (!isHostAllowed(event.payload.url, allowedHostsRef.current)) {
        setSnifferMessage("Blocked navigation outside the active provider.");
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
    if (loadedUrl == null) return;
    const targetUrl = loadedUrl;
    let cancelled = false;
    let resizeObserver: ResizeObserver | null = null;
    const createRun = createRunRef.current + 1;
    createRunRef.current = createRun;
    const label = `anikai-provider-${createRun}`;
    const allowedHostsForRun = [...allowedHostsRef.current];

    async function createProviderView() {
      setStatus("loading");
      setMessage("Loading provider page inside the app...");
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
          url: normalizeUrl(targetUrl),
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
          setMessage("Provider page is running in a native WebView.");
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
          void invoke("install_media_sniffer", { label, allowedHosts: allowedHostsForRun }).catch((error) => {
            setSnifferMessage(`Stream detector error: ${String(error)}`);
          });
        });
        webview.once("tauri://error", (event) => {
          if (cancelled || createRunRef.current !== createRun || webviewRef.current !== webview) return;
          setStatus("ready");
          setMessage(String(event.payload ?? "Provider page is visible; WebView reported non-blocking setup noise."));
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
        referer: bestCandidate.referer,
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
              referer: candidate.referer ?? currentPageUrl,
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

  function startQueuedDownload(
    target: StreamQuality,
    identity: DownloadIdentity,
    overrides: { customOutputDir?: string | null } = {},
  ) {
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
      referer: target.referer ?? currentPageUrl,
      sourcePage: identity.sourcePage,
      folderName: null,
      formatId: null,
      customOutputDir: overrides.customOutputDir ?? null,
      progress: null,
      outputPath: null,
      error: null,
    });
    setSelectedQualityUrl(target.url);
    setSnifferMessage("Download queued. You can open another episode and add it while this queue runs.");
  }

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
    // Always confirm via the modal so the user can review/edit detected
    // values (anime, episode, save location) before the download is queued.
    // Detected fields pre-fill; blanks indicate detection missed.
    setLabelModalState({
      target,
      baseIdentity: identity,
      initialAnime: identity.animeTitle ?? "",
      initialEpisode: identity.episodeNumber ?? "",
    });
  }

  function handleLabelConfirm(result: EpisodeLabelResult) {
    if (!labelModalState) return;
    const { target, baseIdentity } = labelModalState;
    const finalIdentity: DownloadIdentity = {
      ...baseIdentity,
      animeTitle: result.animeTitle || baseIdentity.animeTitle,
      episodeNumber: result.episodeNumber,
      episodeLabel: `Episode ${result.episodeNumber}`,
    };
    const overrides = result.mode === "custom-dir" ? { customOutputDir: result.customDir } : {};
    setLabelModalState(null);
    startQueuedDownload(target, finalIdentity, overrides);
  }

  return (
    <div className="anikai-browser">
      <div className="provider-toolbar">
        <div className={`provider-status is-${status}`}>
          <span />
          {status === "ready" ? "Live" : status === "loading" ? "Loading" : "Error"}
        </div>
        <div className="provider-selector">
          {PROVIDER_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={providerMode === "preset" && providerPresetId === preset.id ? "is-active" : ""}
              onClick={() => {
                setProviderMode("preset");
                setProviderPresetId(preset.id);
                allowedHostsRef.current = preset.hosts;
                setAddress(preset.url);
                setCurrentPageUrl(preset.url);
                setLoadedUrl(preset.url);
                setReloadKey((k) => k + 1);
              }}
            >
              <Globe size={14} />
              {preset.label}
            </button>
          ))}
          <button
            type="button"
            className={providerMode === "custom" ? "is-active" : ""}
            onClick={() => {
              setProviderMode("custom");
              allowedHostsRef.current = [];
              setLoadedUrl(currentPageUrl);
              setReloadKey((k) => k + 1);
            }}
          >
            <Link size={14} />
            Custom
          </button>
        </div>
        <input
          value={address}
          aria-label="Provider address"
          className={providerMode === "custom" ? "provider-address" : "locked-provider-address"}
          readOnly={providerMode !== "custom"}
          spellCheck={false}
          placeholder={providerMode === "custom" ? "https://your-anime-site.example/watch/..." : undefined}
          onChange={providerMode === "custom" ? (event) => setAddress(event.target.value) : undefined}
          onKeyDown={
            providerMode === "custom"
              ? (event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    const next = normalizeUrl(address.trim());
                    if (!next) return;
                    allowedHostsRef.current = [];
                    resetCaptureState("Loading page. Start playback after it opens.");
                    setCurrentPageUrl(next);
                    setLoadedUrl(next);
                    setReloadKey((value) => value + 1);
                  }
                }
              : undefined
          }
        />
        {providerMode === "custom" && (
          <button
            type="button"
            onClick={() => {
              const next = normalizeUrl(address.trim());
              if (!next) return;
              allowedHostsRef.current = [];
              resetCaptureState("Loading page. Start playback after it opens.");
              setCurrentPageUrl(next);
              setLoadedUrl(next);
              setReloadKey((value) => value + 1);
            }}
          >
            Go
          </button>
        )}
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
      <EpisodeLabelModal
        open={labelModalState !== null}
        initialAnime={labelModalState?.initialAnime ?? ""}
        initialEpisode={labelModalState?.initialEpisode ?? ""}
        downloadDir={downloadDir}
        onConfirm={handleLabelConfirm}
        onCancel={() => setLabelModalState(null)}
      />
    </div>
  );
}
