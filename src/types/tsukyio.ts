// Shapes for the Tsukyio Vault API responses, as proxied by the Rust
// `tsukyio_*` commands. The vault wraps every payload as
// `{ success: boolean, data: ... }`. There are no structured anime/character
// fields — all semantic meaning lives in folder/file names + relPaths.

export type TsukyioCategoryId =
  | "precuts"
  | "raw"
  | "flow"
  | "vocals"
  | "overlays"
  | "sfx"
  | "remake_clips"
  | "green_screen"
  | "credits";

export type TsukyioItemType = "folder" | "video" | "audio";

export type TsukyioItem = {
  id: string;
  name: string;
  path?: string;
  relPath?: string;
  category?: string;
  type: TsukyioItemType;
  thumbnail?: string | null;
  size?: number | null;
  mtime?: string | null;
  createdAt?: string | null;
  downloadUrl?: string | null;
  count?: number | null;
};

export type TsukyioPagination = {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

export type TsukyioBrowseResponse = {
  success: boolean;
  data?: {
    items?: TsukyioItem[];
    pagination?: TsukyioPagination;
  };
};

// `/vault/search` and `/vault/deep-search` sometimes return `data` as a bare
// array, sometimes as `{ items: [...] }` — callers must handle both.
export type TsukyioSearchResponse = {
  success: boolean;
  data?: TsukyioItem[] | { items?: TsukyioItem[] };
};

// `/stats/global` (via `tsukyio_test_connection`). `vault.categories` is an
// array of per-category records; `files` is the clip count we surface on the
// discovery-home tiles (`assets` counts folders+files together). `id` is the
// canonical category id, `folder` the display name.
export type TsukyioStatsCategory = {
  id: string;
  folder: string;
  assets?: number;
  files?: number;
};

export type TsukyioStatsResponse = {
  success: boolean;
  data?: {
    vault?: {
      totalAssets?: number;
      categories?: TsukyioStatsCategory[];
    };
  };
};

// Per-category clip counts derived from `/stats/global`, keyed by canonical
// category id. Cached in panel state and used to label the home tiles.
export type TsukyioCategoryCounts = {
  totalAssets: number;
  files: Record<string, number>;
};

// Progress events emitted on the `tsukyio-download-progress` channel.
export type TsukyioDownloadProgress =
  | { type: "start"; assetId: string; totalBytes: number | null }
  | { type: "progress"; assetId: string; downloadedBytes: number; totalBytes: number | null }
  | { type: "done"; assetId: string; path: string; downloadedBytes: number }
  | { type: "error"; assetId: string; message: string };
