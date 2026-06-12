import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Download,
  ExternalLink,
  Film,
  Folder,
  Image as ImageIcon,
  Layers,
  Maximize2,
  Mic2,
  Music2,
  Play,
  Scissors,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  Type,
  Volume2,
  Wand2,
  Waves,
  X,
} from "lucide-react";
import { formatBytes } from "../../lib/format";
import { logFrontend, safeLogValue } from "../../lib/log";
import { parseBridgePayload, readBridgeError } from "../../utils/bridge";
import type { AppConfig } from "../../types/app";
import type {
  TsukyioBrowseResponse,
  TsukyioCategoryCounts,
  TsukyioDownloadProgress,
  TsukyioItem,
  TsukyioSearchResponse,
  TsukyioStatsResponse,
} from "../../types/tsukyio";
import {
  CATEGORIES,
  CATEGORY_ACCENTS,
  REAL_CATEGORIES,
  categoryIdFromDisplay,
  categoryLabel,
  isRealCategory,
} from "./categories";
import { TsukyioPlayer } from "./TsukyioPlayer";

const TSUKYIO_SITE = "https://tsukyio.com";

// localStorage key for the persisted dock collapsed state. Survives across
// sessions so the user's "I want the grid full-width" choice sticks.
const DOCK_COLLAPSED_KEY = "tsukyio.dock.collapsed";

function loadDockCollapsed(): boolean {
  try {
    return window.localStorage.getItem(DOCK_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function saveDockCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(DOCK_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // Ignore storage failures; the in-memory state still drives the UI.
  }
}
const PAGE_LIMIT = 24;
// Per-category server-side result cap (the vault returns at most this many
// items per `tsukyio_search` call). When a category section is full we surface
// it honestly rather than implying the list is complete.
const SEARCH_CATEGORY_CAP = 250;
// How many clips a category section shows before the "Show all (N)" control.
const SECTION_PREVIEW = 12;

type Crumb = { name: string; relPath: string };

type DownloadState = {
  status: "downloading" | "done" | "error";
  percent: number;
  path?: string;
  message?: string;
};

// A derived folder hit from search: an ancestor path segment that matches every
// query token. `relPath` is the path prefix `tsukyio_browse` expects.
type SearchFolder = {
  name: string;
  relPath: string;
  category: string; // display name carried on the source clip
  count: number;
};

// One category's clips from a search, plus whether the server capped it.
type SearchSection = {
  id: string; // canonical category id
  label: string; // display label
  clips: TsukyioItem[];
  capped: boolean;
};

// The full grouped result for a query.
type SearchResult = {
  folders: SearchFolder[];
  sections: SearchSection[];
  totalClips: number;
};

// Per-category icon for the discovery-home tiles.
const CATEGORY_ICONS: Record<string, React.ComponentType<{ size?: number; strokeWidth?: number }>> = {
  precuts: Scissors,
  raw: Film,
  flow: Waves,
  vocals: Mic2,
  overlays: Layers,
  sfx: Volume2,
  remake_clips: Wand2,
  green_screen: ImageIcon,
  credits: Type,
};

// Public origin that actually serves the vault's static files (thumbnails).
const TSUKYIO_ORIGIN = "https://tsukyio.com";

// Percent-encode a URL path while preserving its `/` separators, so thumbnail
// paths containing spaces / brackets / parens (e.g. ".../[Tsukyio ...] Raw
// Clips (3).jpg") resolve as valid `<img src>` URLs.
function encodeThumbnailPath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

// Local-proxy URL for a vault thumbnail path that the webview cannot load
// directly. The per-segment-encoded path is packed into ONE URI segment
// (slashes included) so the Rust handler (`thumb_path_from_uri`) recovers it
// with a single decode. Same per-platform scheme branch as `streamUrl` below.
function thumbProxyUrl(encodedPath: string): string {
  const segment = encodeURIComponent(encodedPath);
  const isWindows = navigator.userAgent.includes("Windows");
  return isWindows
    ? `http://tsukyio.localhost/thumb/${segment}`
    : `tsukyio://thumb/${segment}`;
}

// Route a vault thumbnail path (e.g. `/files/thumbnails/...` or
// `/api/v/links/...`) to a URL the webview will actually PAINT:
//
// - `/files/...` is public static with no cross-origin restrictions — load it
//   straight from the public origin (no proxy hop).
// - `/api/...` responses carry `Cross-Origin-Resource-Policy: same-origin`.
//   WebView2 enforces CORP on cross-origin <img> loads, so the request
//   succeeds (200) but the bytes are never handed to the renderer — the card
//   shows a black box. Serve those through the app-trusted `tsukyio://` proxy
//   (same trick as stream playback), which fetches upstream from Rust where
//   CORP doesn't apply.
function routeVaultThumbnail(path: string): string {
  const encoded = encodeThumbnailPath(path);
  if (path.startsWith("/api/")) return thumbProxyUrl(encoded);
  return TSUKYIO_ORIGIN + encoded;
}

// Normalize a thumbnail URL into something the webview can actually load.
//
// Clip thumbnails come back glued to the vault's PRIVATE dev host
// (`https://localhost:3133/files/thumbnails/...` or
// `https://localhost:3133/api/v/links/...`), and the asset-detail endpoint
// returns the same path RELATIVE (`/files/thumbnails/...`). The path itself is
// real and publicly served from `https://tsukyio.com`, so rather than discard
// these (which left every clip card iconless), rewrite them onto the public
// origin (or through the local proxy when CORP blocks a direct load — see
// `routeVaultThumbnail`). Folder / search thumbnails are already real MAL CDN
// URLs and pass through untouched.
function usableThumbnail(url: string | null | undefined): string | null {
  if (!url || typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  // Relative path → serve from the public origin / proxy.
  if (trimmed.startsWith("/")) return routeVaultThumbnail(trimmed);
  // Any localhost host (the dev box, any port) → swap to the public origin /
  // proxy, keep and encode the path.
  const localhost = trimmed.match(/^https?:\/\/localhost(?::\d+)?(\/.*)$/i);
  if (localhost) return routeVaultThumbnail(localhost[1]);
  // Already a real absolute http(s) URL (e.g. MAL CDN) → use as-is.
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return null;
}

// Preview stream URL pointing at the local Tsukyio proxy protocol. The Rust
// handler adds the Bearer key server-side and forwards Range, so WebView2 plays
// the otherwise-blocked cross-origin remote stream and the API key never appears
// in the DOM. The key is pushed separately into Rust session state via
// `tsukyio_set_session_key`.
//
// Per-platform scheme: WebView2 (Windows) cannot navigate a raw custom scheme,
// so Tauri serves registered protocols from `http://<scheme>.localhost` there;
// macOS/Linux use the real `<scheme>://localhost` form. Emitting the wrong one
// makes `<video>` fail with MEDIA_ERR_SRC_NOT_SUPPORTED before the proxy is ever
// hit. This mirrors Tauri's own `convertFileSrc` platform branch. The Rust URI
// parser (`asset_id_from_uri`) accepts both shapes.
function streamUrl(assetId: string): string {
  const id = encodeURIComponent(assetId);
  const isWindows = navigator.userAgent.includes("Windows");
  return isWindows
    ? `http://tsukyio.localhost/stream/${id}`
    : `tsukyio://stream/${id}`;
}

function extractSearchItems(data: TsukyioSearchResponse["data"]): TsukyioItem[] {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  return data.items ?? [];
}

// The text we match query tokens against for a clip.
function clipSearchText(item: TsukyioItem): string {
  return `${item.name ?? ""} ${item.relPath ?? ""} ${item.path ?? ""}`.toLowerCase();
}

// Split a query into lowercase, whitespace-delimited tokens (empties dropped).
function tokenizeQuery(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

// The most selective token to hand the server: the longest (ties → first).
function primaryToken(tokens: string[]): string {
  let best = "";
  for (const t of tokens) {
    if (t.length > best.length) best = t;
  }
  return best;
}

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

// Group a deduped set of matched clips into the stacked search layout:
// derived folders first, then one section per category (in CATEGORIES order).
function buildSearchResult(
  clips: TsukyioItem[],
  tokens: string[],
  cappedIds: Set<string>,
): SearchResult {
  // ---- Sections (per category) ----
  // Bucket clips by their canonical category id (search items carry the
  // DISPLAY name, so map it back). Unknown categories fall into a synthetic
  // bucket keyed by the raw display so nothing is silently dropped.
  const byCategory = new Map<string, TsukyioItem[]>();
  for (const clip of clips) {
    const id = categoryIdFromDisplay(clip.category) ?? ((clip.category ?? "").trim() || "unknown");
    const bucket = byCategory.get(id);
    if (bucket) bucket.push(clip);
    else byCategory.set(id, [clip]);
  }
  const sections: SearchSection[] = [];
  for (const cat of REAL_CATEGORIES) {
    const bucket = byCategory.get(cat.id);
    if (bucket && bucket.length > 0) {
      sections.push({
        id: cat.id,
        label: cat.label,
        clips: bucket,
        capped: cappedIds.has(cat.id),
      });
      byCategory.delete(cat.id);
    }
  }
  // Any leftover (unknown id) categories, appended in insertion order.
  for (const [id, bucket] of byCategory) {
    if (bucket.length > 0) {
      sections.push({
        id,
        label: categoryLabel(id),
        clips: bucket,
        capped: cappedIds.has(id),
      });
    }
  }

  // ---- Derived folders ----
  // For each matched clip, walk its relPath ancestor segments (excluding the
  // final filename) and emit a folder for each ancestor whose text matches every
  // query token. Dedupe by category + relPath; count the number of matched clips
  // beneath each.
  //
  // Use relPath ONLY — it is category-RELATIVE, which is exactly the shape
  // `tsukyio_browse` expects for its `path` arg (verified against the live API).
  // `clip.path` is category-PREFIXED (e.g. "Raw/Characters/..."), so navigating
  // to a folder derived from it would double the category segment and browse
  // empty; skip a clip with no relPath rather than fall back to path.
  const folderMap = new Map<string, SearchFolder>();
  for (const clip of clips) {
    const rel = (clip.relPath ?? "").replace(/\\/g, "/");
    if (!rel) continue;
    const segments = rel.split("/").filter((s) => s.length > 0);
    // Exclude the final segment (the filename itself).
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i];
      const lower = segment.toLowerCase();
      if (!tokens.every((tok) => lower.includes(tok))) continue;
      const relPath = segments.slice(0, i + 1).join("/");
      const cat = (clip.category ?? "").trim();
      const key = `${cat}|${relPath}`;
      const existing = folderMap.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        folderMap.set(key, { name: segment, relPath, category: cat, count: 1 });
      }
    }
  }
  const folders = Array.from(folderMap.values()).sort((a, b) => b.count - a.count);

  return { folders, sections, totalClips: clips.length };
}

interface TsukyioPanelProps {
  active: boolean;
  onOpenSettings: () => void;
}

export function TsukyioPanel({ active, onOpenSettings }: TsukyioPanelProps) {
  const [apiKey, setApiKey] = React.useState<string | null>(null);
  const [downloadPath, setDownloadPath] = React.useState<string>("");
  const [configLoaded, setConfigLoaded] = React.useState(false);

  const [category, setCategory] = React.useState<string>("all");
  const [crumbs, setCrumbs] = React.useState<Crumb[]>([]);
  const [searchTerm, setSearchTerm] = React.useState("");
  const [activeSearch, setActiveSearch] = React.useState("");

  // Browse state (flat grid for a drilled-in category / folder).
  const [items, setItems] = React.useState<TsukyioItem[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [page, setPage] = React.useState(0);
  const [hasMore, setHasMore] = React.useState(false);
  const [total, setTotal] = React.useState(0);

  // Search state (grouped, stacked sections). Kept separate from browse so the
  // two render paths never fight over `items`.
  const [searchClips, setSearchClips] = React.useState<TsukyioItem[]>([]);
  const [searchCapped, setSearchCapped] = React.useState<string[]>([]);
  const [expandedSections, setExpandedSections] = React.useState<Record<string, boolean>>({});

  // Live `/stats/global` snapshot for the discovery-home tiles. Null until
  // fetched; the home renders without counts if stats fail (never blocks).
  const [stats, setStats] = React.useState<TsukyioCategoryCounts | null>(null);

  const [downloads, setDownloads] = React.useState<Record<string, DownloadState>>({});
  // The clip currently loaded into the persistent right-side preview dock
  // (null = empty dock). Persists across browse/search/page changes so playback
  // keeps going while the user keeps browsing; clicking another clip swaps it.
  const [previewItem, setPreviewItem] = React.useState<TsukyioItem | null>(null);
  // Whether the dock is collapsed (grid takes full width). Persisted so it
  // sticks across sessions.
  const [dockCollapsed, setDockCollapsed] = React.useState<boolean>(loadDockCollapsed);
  // Whether the dock's player should autoplay on its next mount. True when the
  // user picks a clip (selecting B while A plays → B loads/plays); false when
  // re-opening a collapsed dock so the same clip comes back PAUSED rather than
  // springing back to life unexpectedly.
  const [dockAutoplay, setDockAutoplay] = React.useState(true);
  // Bumped on every explicit pick so the player's key changes — this makes
  // re-selecting the SAME clip (e.g. replaying a 2s vocal that just ended)
  // remount and restart, while browse/search navigation (which never bumps it)
  // leaves the player mounted and playing.
  const [selectNonce, setSelectNonce] = React.useState(0);
  // A function the dock can call to fullscreen the current clip's <video>.
  // Registered by TsukyioPlayer (null for audio, which has no picture).
  const fullscreenRef = React.useRef<(() => void) | null>(null);

  // Select a clip into the dock. Always autoplays (it's an explicit user pick)
  // and un-collapses the dock so the chosen clip is actually visible.
  const selectPreview = React.useCallback((item: TsukyioItem) => {
    setDockAutoplay(true);
    setSelectNonce((n) => n + 1);
    setDockCollapsed(false);
    saveDockCollapsed(false);
    setPreviewItem(item);
  }, []);

  // A monotonically increasing token guards against out-of-order responses:
  // a slow earlier fetch must not overwrite a newer view. Browse and search
  // share it (a newer browse must beat a stale search and vice-versa).
  const fetchToken = React.useRef(0);
  // Separate guard for the background stats fetch so a slow stats response
  // can't clobber a newer one (and so it never interferes with browse/search).
  const statsToken = React.useRef(0);
  // Asset ids the user asked to cancel, so `startDownload`'s rejection handler
  // can tell a cancel apart from a real failure (clip export's pattern).
  const cancellingRef = React.useRef<Set<string>>(new Set());

  const currentPath = crumbs.length > 0 ? crumbs[crumbs.length - 1].relPath : "";
  const isSearching = activeSearch.trim().length > 0;
  // The discovery home: connected, no active search, sitting at the "all" root
  // with no folder drilled in. Selecting a category or opening a folder leaves
  // it; the existing browse grid takes over.
  const isHome = !isSearching && category === "all" && crumbs.length === 0;

  // ---- Config (API key) -------------------------------------------------

  const loadConfig = React.useCallback(async () => {
    try {
      const raw = await invoke<string>("get_config");
      const payload = parseBridgePayload<AppConfig>(raw);
      const key = (payload.tsukyio_api_key ?? "").trim();
      setApiKey(key.length > 0 ? key : null);
      setDownloadPath((payload.download_path ?? "").trim());
      // Push the key into Rust session state so the `tsukyio://` streaming proxy
      // can authenticate preview requests without the token ever entering the
      // DOM. Pass an empty key when none is set so a removed key clears it (the
      // proxy then replies 401 rather than serving stale media).
      try {
        await invoke("tsukyio_set_session_key", { key: key.length > 0 ? key : null });
      } catch (keyErr) {
        logFrontend("warn", "tsukyio.session_key.error", "Could not set Tsukyio session key", {
          error: safeLogValue(keyErr),
        });
      }
    } catch (e) {
      logFrontend("warn", "tsukyio.config.error", "Could not read Tsukyio config", {
        error: safeLogValue(e),
      });
      setApiKey(null);
      setDownloadPath("");
      void invoke("tsukyio_set_session_key", { key: null }).catch(() => {});
    } finally {
      setConfigLoaded(true);
    }
  }, []);

  React.useEffect(() => {
    void loadConfig();
    // The key can change while we're mounted (user edits it in Settings and
    // saves); pick that up so the empty-state clears without a remount.
    const onConfigSaved = () => void loadConfig();
    window.addEventListener("tsukyio-config-changed", onConfigSaved);
    return () => window.removeEventListener("tsukyio-config-changed", onConfigSaved);
  }, [loadConfig]);

  // Re-read config whenever the panel becomes active (covers the common
  // flow of: empty-state -> Settings -> save key -> back to panel).
  React.useEffect(() => {
    if (active) void loadConfig();
  }, [active, loadConfig]);

  // ---- Stats fetch (discovery-home tile counts) ------------------------

  const loadStats = React.useCallback(async () => {
    if (!apiKey) return;
    const token = ++statsToken.current;
    try {
      const raw = await invoke<TsukyioStatsResponse>("tsukyio_test_connection", { apiKey });
      if (token !== statsToken.current) return;
      const vault = raw?.data?.vault;
      const files: Record<string, number> = {};
      for (const cat of vault?.categories ?? []) {
        const id = categoryIdFromDisplay(cat.id) ?? categoryIdFromDisplay(cat.folder) ?? cat.id;
        if (id) files[id] = typeof cat.files === "number" ? cat.files : 0;
      }
      setStats({ totalAssets: vault?.totalAssets ?? 0, files });
    } catch (e) {
      // Never block the home on stats — tiles just render without counts.
      if (token !== statsToken.current) return;
      logFrontend("warn", "tsukyio.stats.error", "Could not load Tsukyio stats", {
        error: safeLogValue(e),
      });
    }
  }, [apiKey]);

  // Fetch stats once when the panel becomes active and connected. Re-fetches
  // if the key changes. Cached in state across view changes.
  React.useEffect(() => {
    if (active && apiKey && !stats) void loadStats();
  }, [active, apiKey, stats, loadStats]);

  // ---- Data fetch (browse + search) ------------------------------------

  const runFetch = React.useCallback(async () => {
    if (!apiKey) return;
    // Bump the out-of-order guard FIRST, before the home short-circuit, so a
    // transition INTO the home (which does no fetch) still invalidates any
    // in-flight browse/search — otherwise a stale fan-out could resolve and
    // overwrite state after the user has already left the search.
    const token = ++fetchToken.current;
    // The discovery home renders tiles, not a browse grid — no fetch needed.
    if (isHome) {
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      if (isSearching) {
        const tokens = tokenizeQuery(activeSearch);
        const primary = primaryToken(tokens);
        // Fan out one server call per real category in parallel. Per-category
        // querying avoids the 250-cap starvation a single no-category call
        // suffers (one big category swallows the whole result set).
        const settled = await Promise.allSettled(
          REAL_CATEGORIES.map(async (cat) => {
            const raw = await invoke<TsukyioSearchResponse>("tsukyio_search", {
              apiKey,
              q: primary,
              category: cat.id,
            });
            return { id: cat.id, items: extractSearchItems(raw.data) };
          }),
        );
        if (token !== fetchToken.current) return;
        // AND-filter every returned clip against ALL tokens (order-independent
        // substring match), dedupe by id across categories, and note which
        // categories hit the server cap so the UI can be honest about it.
        const seen = new Set<string>();
        const matched: TsukyioItem[] = [];
        const capped = new Set<string>();
        for (let i = 0; i < settled.length; i++) {
          const outcome = settled[i];
          if (outcome.status !== "fulfilled") continue; // tolerate per-category failure
          const { id, items: catItems } = outcome.value;
          if (catItems.length >= SEARCH_CATEGORY_CAP) capped.add(id);
          for (const clip of catItems) {
            if (clip.type === "folder") continue; // folders are derived client-side
            // Drop the vault's dead "Audio" duplicate tree (404s on stream +
            // download); its live twin lives under a real category (Vocals).
            if (!isRealCategory(clip.category)) continue;
            if (!clip.id || seen.has(clip.id)) continue;
            const text = clipSearchText(clip);
            if (!tokens.every((tok) => text.includes(tok))) continue;
            seen.add(clip.id);
            matched.push(clip);
          }
        }
        setSearchClips(matched);
        setSearchCapped(Array.from(capped));
        setExpandedSections({});
      } else {
        const raw = await invoke<TsukyioBrowseResponse>("tsukyio_browse", {
          apiKey,
          category: category === "all" ? null : category,
          path: currentPath || null,
          limit: PAGE_LIMIT,
          offset: page * PAGE_LIMIT,
        });
        if (token !== fetchToken.current) return;
        const data = raw.data ?? {};
        // Defensively drop dead "Audio"-tree duplicates here too, so they can
        // never render even if a browse path surfaces them (browse is normally
        // clean, but this keeps the dead tree out everywhere).
        const browseItems = (data.items ?? []).filter((it) => isRealCategory(it.category));
        setItems(browseItems);
        setTotal(data.pagination?.total ?? browseItems.length);
        setHasMore(data.pagination?.hasMore ?? false);
      }
    } catch (e) {
      if (token !== fetchToken.current) return;
      setError(readBridgeError(e));
      setItems([]);
      setSearchClips([]);
      setSearchCapped([]);
      setHasMore(false);
    } finally {
      if (token === fetchToken.current) setLoading(false);
    }
  }, [apiKey, isHome, isSearching, activeSearch, category, currentPath, page]);

  React.useEffect(() => {
    if (active && apiKey) void runFetch();
    // NOTE: the dock preview intentionally PERSISTS across view changes
    // (category/folder/search/page) so playback keeps going while the user
    // browses. Do not reset `previewItem` here.
  }, [active, apiKey, runFetch]);

  // ---- Grouped search result (derived) ---------------------------------

  const searchResult = React.useMemo<SearchResult | null>(() => {
    if (!isSearching) return null;
    const tokens = tokenizeQuery(activeSearch);
    if (tokens.length === 0) return null;
    return buildSearchResult(searchClips, tokens, new Set(searchCapped));
  }, [isSearching, activeSearch, searchClips, searchCapped]);

  // ---- Download progress events ----------------------------------------

  React.useEffect(() => {
    // The listener promise may resolve after the effect cleanup has already
    // run (fast unmount). Track cancellation so we always call the unlisten
    // function, whether it resolves before or after cleanup — otherwise the
    // Tauri event subscription leaks.
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<TsukyioDownloadProgress>("tsukyio-download-progress", (event) => {
      const p = event.payload;
      setDownloads((prev) => {
        const next = { ...prev };
        if (p.type === "start") {
          next[p.assetId] = { status: "downloading", percent: 0 };
        } else if (p.type === "progress") {
          const percent = p.totalBytes && p.totalBytes > 0
            ? Math.min(100, Math.round((p.downloadedBytes / p.totalBytes) * 100))
            : prev[p.assetId]?.percent ?? 0;
          next[p.assetId] = { status: "downloading", percent };
        } else if (p.type === "done") {
          next[p.assetId] = { status: "done", percent: 100, path: p.path };
        } else if (p.type === "cancelled") {
          // A cancelled download leaves no trace — back to a plain Download button.
          delete next[p.assetId];
        } else if (p.type === "error") {
          next[p.assetId] = { status: "error", percent: 0, message: p.message };
        }
        return next;
      });
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

  // ---- Navigation helpers ----------------------------------------------

  function selectCategory(id: string) {
    setCategory(id);
    setCrumbs([]);
    setPage(0);
    setSearchTerm("");
    setActiveSearch("");
  }

  function openFolder(item: TsukyioItem) {
    const relPath = item.relPath ?? item.path ?? "";
    // A folder opened from an "All"/cross-category view carries its owning
    // category on the item. Adopt it so the subsequent `tsukyio_browse` is
    // scoped to the right category (browsing with category="all" + a path can
    // resolve empty/wrong) and the category chip stays in sync with the
    // breadcrumb. Plain in-category navigation already matches, so this is a
    // no-op there.
    const owningCategory = (item.category ?? "").trim();
    if (owningCategory && owningCategory !== category) {
      setCategory(owningCategory);
    }
    setCrumbs((prev) => [...prev, { name: item.name, relPath }]);
    setPage(0);
    setSearchTerm("");
    setActiveSearch("");
  }

  // Navigate into a folder derived from search results. The folder carries the
  // owning clip's DISPLAY category, which `tsukyio_browse` does NOT accept —
  // map it back to the canonical id before scoping. Then mirror `openFolder`:
  // push a single breadcrumb at the folder's relPath and clear the search so
  // the existing browse grid loads it.
  function openSearchFolder(folder: SearchFolder) {
    const id = categoryIdFromDisplay(folder.category) ?? folder.category;
    setCategory(id || "all");
    setCrumbs([{ name: folder.name, relPath: folder.relPath }]);
    setPage(0);
    setSearchTerm("");
    setActiveSearch("");
  }

  function goToCrumb(index: number) {
    // index === -1 means the category root.
    setCrumbs((prev) => (index < 0 ? [] : prev.slice(0, index + 1)));
    setPage(0);
    setActiveSearch("");
    setSearchTerm("");
  }

  function goUp() {
    setCrumbs((prev) => prev.slice(0, -1));
    setPage(0);
  }

  function submitSearch() {
    const term = searchTerm.trim();
    setActiveSearch(term);
    setCrumbs([]);
    setPage(0);
  }

  function clearSearch() {
    setSearchTerm("");
    setActiveSearch("");
    setPage(0);
  }

  // Return to the discovery home: "all" category, no crumbs, no search.
  function goHome() {
    setCategory("all");
    setCrumbs([]);
    setPage(0);
    setSearchTerm("");
    setActiveSearch("");
    // Returning from home later should not surprise-autoplay the clip that's
    // still selected in the (currently hidden) dock.
    setDockAutoplay(false);
  }

  function toggleSection(id: string) {
    setExpandedSections((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  // Collapse the dock: the player is unmounted while collapsed, so its
  // teardown effect pauses + releases the stream (no invisible audio keeps
  // playing). The selected clip is kept so re-opening shows it (paused).
  function collapseDock() {
    setDockCollapsed(true);
    saveDockCollapsed(true);
  }

  function expandDock() {
    // Re-opening shows the same clip PAUSED — suppress autoplay on the player's
    // remount so it doesn't spring back to life.
    setDockAutoplay(false);
    setDockCollapsed(false);
    saveDockCollapsed(false);
  }

  // Clear the dock selection → empty state. (Distinct from collapse, which
  // keeps the selection.)
  function clearPreview() {
    setPreviewItem(null);
  }

  async function startDownload(item: TsukyioItem) {
    if (!apiKey) return;
    cancellingRef.current.delete(item.id);
    setDownloads((prev) => ({
      ...prev,
      [item.id]: { status: "downloading", percent: 0 },
    }));
    try {
      await invoke<string>("tsukyio_download", {
        apiKey,
        assetId: item.id,
        name: item.name,
        category: item.category ?? (category === "all" ? null : category),
        pathHint: item.path ?? item.relPath ?? null,
        destDir: downloadPath || null,
      });
    } catch (e) {
      // A user-initiated cancel rejects too — clear the entry instead of
      // surfacing it as a failure (the `cancelled` event does the same, so
      // either arrival order converges on the cleared state).
      if (cancellingRef.current.delete(item.id)) {
        setDownloads((prev) => {
          const next = { ...prev };
          delete next[item.id];
          return next;
        });
        return;
      }
      const message = readBridgeError(e);
      setDownloads((prev) => ({
        ...prev,
        [item.id]: { status: "error", percent: 0, message },
      }));
    }
  }

  function cancelDownload(item: TsukyioItem) {
    cancellingRef.current.add(item.id);
    void invoke("tsukyio_cancel_download").catch(() => {});
  }

  // ---- Render: not-yet-loaded / empty-state ----------------------------

  if (!configLoaded) {
    return (
      <div className="tsukyio-panel">
        <div className="tsukyio-loading">
          <span className="tsukyio-spinner" aria-hidden="true" />
          <p>Loading Tsukyio Vault…</p>
        </div>
      </div>
    );
  }

  if (!apiKey) {
    return (
      <div className="tsukyio-panel">
        <div className="tsukyio-connect">
          <div className="tsukyio-connect-card glass u-material">
            <div className="tsukyio-brand-mark" aria-hidden="true">T</div>
            <h2>Connect the Tsukyio Vault</h2>
            <p>
              Tsukyio is a curated anime asset library — precuts, raw footage, overlays,
              green-screen, SFX, vocals and more. Connect your free API key to browse,
              preview and download clips right inside Ultimate AMV.
            </p>
            <div className="tsukyio-connect-actions">
              <button type="button" className="install-btn" onClick={onOpenSettings}>
                <SettingsIcon size={16} />
                <span>Add API key in Settings</span>
              </button>
              <a
                className="install-btn is-secondary"
                href={TSUKYIO_SITE}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink size={16} />
                <span>Get a free key at tsukyio.com</span>
              </a>
            </div>
            <span className="tsukyio-credit">Powered by Tsukyio</span>
          </div>
        </div>
      </div>
    );
  }

  // ---- Render: connected browser ---------------------------------------

  const showingFrom = total === 0 ? 0 : page * PAGE_LIMIT + 1;
  const showingTo = Math.min((page + 1) * PAGE_LIMIT, total);

  return (
    <div className="tsukyio-panel">
      <header className="tsukyio-header">
        <button type="button" className="tsukyio-header-brand tsukyio-home-link" onClick={goHome} title="Back to the vault home">
          <span className="tsukyio-brand-mark sm" aria-hidden="true">T</span>
          <div>
            <span className="tsukyio-kicker">Anime Asset Vault</span>
            <h2>Tsukyio Vault</h2>
          </div>
        </button>
        <a className="tsukyio-header-link" href={TSUKYIO_SITE} target="_blank" rel="noreferrer">
          <span>Powered by Tsukyio — browse the full vault</span>
          <ExternalLink size={14} />
        </a>
      </header>

      <div className="tsukyio-console u-material">
      <div className={`tsukyio-toolbar ${isHome ? "is-home" : ""}`}>
        <div className="tsukyio-search">
          <Search size={15} className="tsukyio-search-icon" />
          <input
            type="text"
            value={searchTerm}
            placeholder="Search the vault…"
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitSearch();
            }}
            aria-label="Search the Tsukyio vault"
          />
          {activeSearch && (
            <button type="button" className="tsukyio-search-clear" onClick={clearSearch}>
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="tsukyio-categories" role="tablist" aria-label="Vault categories">
        {CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            type="button"
            role="tab"
            aria-selected={isSearching ? false : category === cat.id}
            className={`tsukyio-cat-chip spring-motion ${!isSearching && category === cat.id ? "is-active" : ""}`}
            onClick={() => (cat.id === "all" ? goHome() : selectCategory(cat.id))}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {!isSearching && !isHome && (
        <nav className="tsukyio-breadcrumb" aria-label="Folder path">
          {crumbs.length > 0 && (
            <button type="button" className="tsukyio-crumb-up" onClick={goUp} aria-label="Up one folder">
              <ArrowLeft size={14} />
            </button>
          )}
          <button type="button" className="tsukyio-crumb" onClick={() => goToCrumb(-1)}>
            {categoryLabel(category) || "Vault"}
          </button>
          {crumbs.map((crumb, i) => (
            <React.Fragment key={`${crumb.relPath}-${i}`}>
              <span className="tsukyio-crumb-sep">›</span>
              {i < crumbs.length - 1 ? (
                <button type="button" className="tsukyio-crumb" onClick={() => goToCrumb(i)}>
                  {crumb.name}
                </button>
              ) : (
                <span className="tsukyio-crumb is-current">{crumb.name}</span>
              )}
            </React.Fragment>
          ))}
        </nav>
      )}

      {!isHome && (
        <div className="tsukyio-results-meta">
          {isSearching ? (
            <span>
              {searchResult
                ? `${formatCount(searchResult.totalClips)} clip${searchResult.totalClips === 1 ? "" : "s"}` +
                  `${searchResult.folders.length > 0 ? ` · ${formatCount(searchResult.folders.length)} folder${searchResult.folders.length === 1 ? "" : "s"}` : ""}` +
                  ` for “${activeSearch}”`
                : `Searching for “${activeSearch}”`}
            </span>
          ) : total > 0 ? (
            <span>Showing {showingFrom}–{showingTo} of {total}</span>
          ) : (
            <span />
          )}
        </div>
      )}
      </div>

      {isHome ? (
        // Discovery home: full-width tiles, NO dock.
        <div className="tsukyio-grid-scroll">
          <DiscoveryHome stats={stats} onSelectCategory={selectCategory} />
        </div>
      ) : (
        // Browse / search: two-column row — scrolling results on the left, the
        // persistent preview dock on the right. When the dock is collapsed the
        // left column reflows to full width.
        <div className={`tsukyio-results-row ${dockCollapsed ? "is-dock-collapsed" : ""}`}>
          <div className="tsukyio-results-col">
            <div className="tsukyio-grid-scroll">
              {loading ? (
                <div className="tsukyio-loading">
                  <span className="tsukyio-spinner" aria-hidden="true" />
                  <p>{isSearching ? "Searching the vault…" : "Loading vault…"}</p>
                </div>
              ) : error ? (
                <div className="tsukyio-empty">
                  <h3>Could not reach Tsukyio</h3>
                  <p>{error}</p>
                  <button type="button" className="install-btn is-secondary" onClick={() => void runFetch()}>
                    Retry
                  </button>
                </div>
              ) : isSearching ? (
                searchResult && (searchResult.folders.length > 0 || searchResult.sections.length > 0) ? (
                  <SearchResults
                    result={searchResult}
                    expanded={expandedSections}
                    downloads={downloads}
                    activeId={previewItem?.id}
                    onToggleSection={toggleSection}
                    onOpenFolder={openSearchFolder}
                    onPreview={selectPreview}
                    onDownload={(item) => void startDownload(item)}
                    onCancel={cancelDownload}
                  />
                ) : (
                  <div className="tsukyio-empty">
                    <h3>No matches for “{activeSearch}”</h3>
                    <p>Try fewer or different words.</p>
                  </div>
                )
              ) : items.length === 0 ? (
                <div className="tsukyio-empty">
                  <h3>Nothing here</h3>
                  <p>This folder is empty.</p>
                </div>
              ) : (
                <div className="tsukyio-grid">
                  {items.map((item) =>
                    item.type === "folder" ? (
                      <FolderCard key={item.id} item={item} onOpen={() => openFolder(item)} />
                    ) : (
                      <ClipCard
                        key={item.id}
                        item={item}
                        download={downloads[item.id]}
                        active={previewItem?.id === item.id}
                        onPreview={() => selectPreview(item)}
                        onDownload={() => void startDownload(item)}
                        onCancel={() => cancelDownload(item)}
                      />
                    ),
                  )}
                </div>
              )}
            </div>

            {!isSearching && total > PAGE_LIMIT && (
              <div className="tsukyio-pagination">
                <button
                  type="button"
                  className="install-btn is-secondary"
                  disabled={page === 0 || loading}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  <ChevronLeft size={15} />
                  <span>Prev</span>
                </button>
                <span className="tsukyio-page-info">
                  Page {page + 1} of {Math.max(1, Math.ceil(total / PAGE_LIMIT))}
                </span>
                <button
                  type="button"
                  className="install-btn is-secondary"
                  disabled={(!hasMore && (page + 1) * PAGE_LIMIT >= total) || loading}
                  onClick={() => setPage((p) => p + 1)}
                >
                  <span>Next</span>
                  <ChevronRight size={15} />
                </button>
              </div>
            )}
          </div>

          {dockCollapsed ? (
            // Slim re-open affordance when collapsed.
            <button
              type="button"
              className="tsukyio-dock-reopen"
              onClick={expandDock}
              title="Show preview dock"
              aria-label="Show preview dock"
            >
              <ChevronsLeft size={18} />
            </button>
          ) : (
            <TsukyioDock
              item={previewItem}
              download={previewItem ? downloads[previewItem.id] : undefined}
              autoPlay={dockAutoplay}
              nonce={selectNonce}
              fullscreenRef={fullscreenRef}
              onDownload={() => previewItem && void startDownload(previewItem)}
              onCancel={() => previewItem && cancelDownload(previewItem)}
              onReveal={(path) => void invoke("reveal_in_folder", { path })}
              onClear={clearPreview}
              onCollapse={collapseDock}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ---- Right-side preview dock -------------------------------------------
// The persistent preview surface. Hosts the reusable TsukyioPlayer plus the
// clip metadata + Download/Reveal/expand/clear/collapse chrome (the chrome the
// old modal used to own). Empty state when no clip is selected.

interface TsukyioDockProps {
  item: TsukyioItem | null;
  download: DownloadState | undefined;
  // Whether the player should autoplay when it mounts (true on a fresh pick,
  // false when the dock is merely being re-expanded).
  autoPlay: boolean;
  // Bumped on every explicit pick; part of the player key so re-picking the
  // same clip remounts (replays) it.
  nonce: number;
  // Shared ref the player registers its fullscreen function into (null = audio).
  fullscreenRef: React.MutableRefObject<(() => void) | null>;
  onDownload: () => void;
  onCancel: () => void;
  onReveal: (path: string) => void;
  onClear: () => void;
  onCollapse: () => void;
}

function TsukyioDock({
  item,
  download,
  autoPlay,
  nonce,
  fullscreenRef,
  onDownload,
  onCancel,
  onReveal,
  onClear,
  onCollapse,
}: TsukyioDockProps) {
  const isAudio = item?.type === "audio";
  const size = item && typeof item.size === "number" ? formatBytes(item.size) : "";
  const downloading = download?.status === "downloading";
  const done = download?.status === "done";
  const failed = download?.status === "error";

  function triggerFullscreen() {
    fullscreenRef.current?.();
  }

  // Stable so the player's registration effect doesn't re-run every render.
  const registerFullscreen = React.useCallback(
    (fn: (() => void) | null) => {
      fullscreenRef.current = fn;
    },
    [fullscreenRef],
  );

  return (
    <aside className="tsukyio-dock" aria-label="Clip preview">
      <div className="tsukyio-dock-bar">
        <span className="tsukyio-dock-bar-title">Preview</span>
        <div className="tsukyio-dock-bar-actions">
          {item && (
            <button
              type="button"
              className="tsukyio-dock-icon-btn"
              onClick={onClear}
              title="Clear preview"
              aria-label="Clear preview"
            >
              <X size={15} />
            </button>
          )}
          <button
            type="button"
            className="tsukyio-dock-icon-btn"
            onClick={onCollapse}
            title="Collapse preview dock"
            aria-label="Collapse preview dock"
          >
            <ChevronsRight size={16} />
          </button>
        </div>
      </div>

      {!item ? (
        <div className="tsukyio-dock-empty">
          <span className="tsukyio-dock-empty-icon" aria-hidden="true">
            <Play size={26} strokeWidth={1.7} />
          </span>
          <p className="tsukyio-dock-empty-title">Select a clip to preview</p>
          <span className="tsukyio-dock-empty-sub">Powered by Tsukyio</span>
        </div>
      ) : (
        <div className="tsukyio-dock-body">
          <div className="tsukyio-dock-media">
            <TsukyioPlayer
              key={`${item.id}:${nonce}`}
              item={item}
              streamSrc={streamUrl(item.id)}
              autoPlay={autoPlay}
              registerFullscreen={registerFullscreen}
            />
            {!isAudio && (
              <button
                type="button"
                className="tsukyio-dock-expand"
                onClick={triggerFullscreen}
                title="Expand to fullscreen"
                aria-label="Expand to fullscreen"
              >
                <Maximize2 size={15} />
              </button>
            )}
          </div>

          <div className="tsukyio-dock-meta">
            <span className="tsukyio-dock-kicker">{categoryLabel(item.category) || "Tsukyio"}</span>
            <h3 className="tsukyio-dock-title" title={item.name}>{item.name}</h3>
            <p className="tsukyio-dock-sub">{size ? `${size} • ` : ""}via Tsukyio</p>
          </div>

          {downloading && (
            <div className="tsukyio-progress">
              <div className="tsukyio-progress-fill" style={{ width: `${download?.percent ?? 0}%` }} />
            </div>
          )}

          <div className="tsukyio-dock-actions">
            {done ? (
              <button
                type="button"
                className="install-btn is-secondary tsukyio-dl-btn"
                onClick={() => download?.path && onReveal(download.path)}
              >
                <Folder size={14} />
                <span>Reveal file</span>
              </button>
            ) : downloading ? (
              <button
                type="button"
                className="install-btn is-secondary tsukyio-dl-btn"
                onClick={onCancel}
              >
                <X size={14} />
                <span>Cancel {download?.percent ?? 0}%</span>
              </button>
            ) : (
              <button
                type="button"
                className="install-btn tsukyio-dl-btn"
                onClick={onDownload}
              >
                <Download size={14} />
                <span>{failed ? "Retry download" : "Download"}</span>
              </button>
            )}
          </div>
          {failed && <span className="tsukyio-dl-error" title={download?.message}>{download?.message}</span>}
        </div>
      )}
    </aside>
  );
}

// ---- Discovery home ----------------------------------------------------

function DiscoveryHome({
  stats,
  onSelectCategory,
}: {
  stats: TsukyioCategoryCounts | null;
  onSelectCategory: (id: string) => void;
}) {
  const total = stats?.totalAssets ?? 0;
  return (
    <div className="tsukyio-home">
      <div className="tsukyio-home-head">
        <h3>Browse the anime asset vault</h3>
        <p>
          {total > 0
            ? `${formatCount(total)} assets across ${REAL_CATEGORIES.length} categories — powered by Tsukyio`
            : `${REAL_CATEGORIES.length} categories of precuts, raw footage, overlays and more — powered by Tsukyio`}
        </p>
      </div>
      <div className="tsukyio-tiles">
        {REAL_CATEGORIES.map((cat) => {
          const Icon = CATEGORY_ICONS[cat.id] ?? Sparkles;
          const accent = CATEGORY_ACCENTS[cat.id] ?? "";
          const count = stats?.files[cat.id];
          return (
            <button
              key={cat.id}
              type="button"
              className={`tsukyio-tile spring-motion ${accent}`}
              onClick={() => onSelectCategory(cat.id)}
            >
              <span className="tsukyio-tile-glow" aria-hidden="true" />
              <span className="tsukyio-tile-icon" aria-hidden="true">
                <Icon size={26} strokeWidth={1.6} />
              </span>
              <span className="tsukyio-tile-name">{cat.label}</span>
              <span className="tsukyio-tile-count">
                {typeof count === "number" ? `${formatCount(count)} clips` : "Browse"}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---- Grouped search results --------------------------------------------

interface SearchResultsProps {
  result: SearchResult;
  expanded: Record<string, boolean>;
  downloads: Record<string, DownloadState>;
  activeId: string | undefined;
  onToggleSection: (id: string) => void;
  onOpenFolder: (folder: SearchFolder) => void;
  onPreview: (item: TsukyioItem) => void;
  onDownload: (item: TsukyioItem) => void;
  onCancel: (item: TsukyioItem) => void;
}

function SearchResults({
  result,
  expanded,
  downloads,
  activeId,
  onToggleSection,
  onOpenFolder,
  onPreview,
  onDownload,
  onCancel,
}: SearchResultsProps) {
  return (
    <div className="tsukyio-sections">
      {result.folders.length > 0 && (
        <section className="tsukyio-section">
          <header className="tsukyio-section-head">
            <h3>Folders <span className="tsukyio-section-count">{formatCount(result.folders.length)}</span></h3>
          </header>
          <div className="tsukyio-grid">
            {result.folders.map((folder) => (
              <FolderCard
                key={`${folder.category}|${folder.relPath}`}
                item={{
                  id: `folder:${folder.category}|${folder.relPath}`,
                  name: folder.name,
                  type: "folder",
                  category: folder.category,
                  relPath: folder.relPath,
                  count: folder.count,
                }}
                onOpen={() => onOpenFolder(folder)}
              />
            ))}
          </div>
        </section>
      )}

      {result.sections.map((section) => {
        const isExpanded = !!expanded[section.id];
        const shown = isExpanded ? section.clips : section.clips.slice(0, SECTION_PREVIEW);
        const hidden = section.clips.length - shown.length;
        return (
          <section className="tsukyio-section" key={section.id}>
            <header className="tsukyio-section-head">
              <h3>
                {section.label}
                <span className="tsukyio-section-count">{formatCount(section.clips.length)}</span>
                {section.capped && (
                  <span
                    className="tsukyio-section-cap"
                    title={`The vault returns at most ${SEARCH_CATEGORY_CAP} matches per category for one word, so some matches further down may be missing — narrow your search to see them.`}
                  >
                    may be incomplete
                  </span>
                )}
              </h3>
              {section.clips.length > SECTION_PREVIEW && (
                <button type="button" className="tsukyio-show-all" onClick={() => onToggleSection(section.id)}>
                  {isExpanded ? "Show fewer" : `Show all (${formatCount(section.clips.length)})`}
                </button>
              )}
            </header>
            <div className="tsukyio-grid">
              {shown.map((item) => (
                <ClipCard
                  key={item.id}
                  item={item}
                  download={downloads[item.id]}
                  active={activeId === item.id}
                  onPreview={() => onPreview(item)}
                  onDownload={() => onDownload(item)}
                  onCancel={() => onCancel(item)}
                />
              ))}
            </div>
            {!isExpanded && hidden > 0 && (
              <button type="button" className="tsukyio-show-all is-foot" onClick={() => onToggleSection(section.id)}>
                Show all {formatCount(section.clips.length)} {section.label} clips
              </button>
            )}
          </section>
        );
      })}
    </div>
  );
}

function FolderCard({ item, onOpen }: { item: TsukyioItem; onOpen: () => void }) {
  const thumb = usableThumbnail(item.thumbnail);
  return (
    <button type="button" className="tsukyio-card tsukyio-folder-card spring-motion" onClick={onOpen}>
      <div className="tsukyio-thumb">
        {thumb ? (
          <img src={thumb} alt="" loading="lazy" />
        ) : (
          <Folder size={34} strokeWidth={1.6} />
        )}
        <span className="tsukyio-thumb-tag">Folder</span>
      </div>
      <div className="tsukyio-card-body">
        <span className="tsukyio-card-title" title={item.name}>{item.name}</span>
        {typeof item.count === "number" && item.count > 0 && (
          <span className="tsukyio-card-sub">{item.count} item{item.count === 1 ? "" : "s"}</span>
        )}
      </div>
    </button>
  );
}

interface ClipCardProps {
  item: TsukyioItem;
  download: DownloadState | undefined;
  active?: boolean;
  onPreview: () => void;
  onDownload: () => void;
  onCancel: () => void;
}

function ClipCard({ item, download, active, onPreview, onDownload, onCancel }: ClipCardProps) {
  const thumb = usableThumbnail(item.thumbnail);
  const isAudio = item.type === "audio";
  const size = typeof item.size === "number" ? formatBytes(item.size) : "";
  const downloading = download?.status === "downloading";
  const done = download?.status === "done";
  const failed = download?.status === "error";

  return (
    <div className={`tsukyio-card tsukyio-clip-card ${active ? "is-active" : ""}`}>
      <button
        type="button"
        className="tsukyio-thumb tsukyio-thumb-preview"
        onClick={onPreview}
        aria-label={`Preview ${item.name}`}
        title="Click to preview"
      >
        {thumb ? (
          <img src={thumb} alt="" loading="lazy" />
        ) : (
          <div className="tsukyio-thumb-fallback">
            {isAudio ? <Music2 size={30} strokeWidth={1.6} /> : <Film size={30} strokeWidth={1.6} />}
          </div>
        )}
        <span className="tsukyio-play-affordance" aria-hidden="true">
          <Play size={20} fill="currentColor" />
        </span>
        <span className="tsukyio-cat-badge">{categoryLabel(item.category)}</span>
        <span className="tsukyio-via-badge" title="Sourced from the Tsukyio vault">
          <Play size={9} fill="currentColor" /> via Tsukyio
        </span>
      </button>
      <div className="tsukyio-card-body">
        <span className="tsukyio-card-title" title={item.name}>{item.name}</span>
        <div className="tsukyio-card-meta">
          {size && <span className="tsukyio-card-sub">{size}</span>}
        </div>

        {downloading && (
          <div className="tsukyio-progress">
            <div className="tsukyio-progress-fill" style={{ width: `${download?.percent ?? 0}%` }} />
          </div>
        )}

        {done ? (
          <button
            type="button"
            className="install-btn is-secondary tsukyio-dl-btn"
            onClick={(e) => {
              // Never let the download/reveal control open the preview.
              e.stopPropagation();
              if (download?.path) void invoke("reveal_in_folder", { path: download.path });
            }}
          >
            <Folder size={14} />
            <span>Reveal file</span>
          </button>
        ) : downloading ? (
          <button
            type="button"
            className="install-btn is-secondary tsukyio-dl-btn"
            onClick={(e) => {
              e.stopPropagation();
              onCancel();
            }}
          >
            <X size={14} />
            <span>Cancel {download?.percent ?? 0}%</span>
          </button>
        ) : (
          <button
            type="button"
            className="install-btn tsukyio-dl-btn"
            onClick={(e) => {
              e.stopPropagation();
              onDownload();
            }}
          >
            <Download size={14} />
            <span>{failed ? "Retry download" : "Download"}</span>
          </button>
        )}
        {failed && <span className="tsukyio-dl-error" title={download?.message}>{download?.message}</span>}
      </div>
    </div>
  );
}
