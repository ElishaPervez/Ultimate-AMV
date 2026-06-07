// Shared vault category metadata. Lives in its own module so both the panel
// and the preview modal can render category labels without duplicating the
// id -> label map.

// id -> short label. Mirrors the vault's category set; "all" is a UI-only
// pseudo-category that omits the `category` param.
export const CATEGORIES: { id: string; label: string }[] = [
  { id: "all", label: "All" },
  { id: "precuts", label: "Precuts" },
  { id: "raw", label: "Raw" },
  { id: "flow", label: "Flow" },
  { id: "vocals", label: "Vocals" },
  { id: "overlays", label: "Overlays" },
  { id: "sfx", label: "SFX" },
  { id: "remake_clips", label: "Remake" },
  { id: "green_screen", label: "Green Screen" },
  { id: "credits", label: "Credits" },
];

// The 9 real vault categories (excludes the "all" UI pseudo-category), in
// canonical display order. Used to drive the discovery home tiles and the
// per-category parallel search fan-out.
export const REAL_CATEGORIES = CATEGORIES.filter((c) => c.id !== "all");

export function categoryLabel(id: string | undefined): string {
  if (!id) return "";
  const match = CATEGORIES.find((c) => c.id === id);
  if (match) return match.label;
  // Search-result items carry the vault's DISPLAY name (e.g. "Green Screen",
  // "Precuts") rather than the id. If we were handed a display name, return it
  // verbatim instead of upper-casing it into noise.
  if (categoryIdFromDisplay(id)) return id;
  return id.toUpperCase();
}

// The vault returns the DISPLAY name as a category on search-result items and
// in `/stats/global` (`vault.categories[].folder`), e.g. "Precuts", "Green
// Screen", "Remake Clips". Map that back to the canonical id used by
// `tsukyio_browse`/`tsukyio_search`. Falls back to a slug match so an unknown
// display name still resolves to something browse-able. Returns null when no
// mapping is found.
const DISPLAY_TO_ID: Record<string, string> = {
  precuts: "precuts",
  raw: "raw",
  flow: "flow",
  vocals: "vocals",
  overlays: "overlays",
  sfx: "sfx",
  "remake clips": "remake_clips",
  remake: "remake_clips",
  "green screen": "green_screen",
  credits: "credits",
};

export function categoryIdFromDisplay(display: string | undefined): string | null {
  if (!display) return null;
  const key = display.trim().toLowerCase();
  if (!key) return null;
  // Already a canonical id?
  if (CATEGORIES.some((c) => c.id === key)) return key;
  return DISPLAY_TO_ID[key] ?? null;
}

// True when an item's `category` belongs to one of the 9 real vault categories.
// The vault also serves a legacy/orphaned "Audio" duplicate tree: every file in
// it is a dead twin of a live Vocals file and 404s on BOTH stream and download.
// Those items carry a category ("Audio") that maps to no real id, so callers
// drop them before rendering — leaving only the live copy. Items with no
// category are kept (lenient): the dead tree always carries the "Audio" tag, so
// a blank category is never the thing we're filtering out.
export function isRealCategory(category: string | null | undefined): boolean {
  if (!category || !category.trim()) return true;
  return categoryIdFromDisplay(category) !== null;
}

// Per-category visual accent for the discovery-home tiles. Pure CSS gradients
// (no remote images — tiles must not trigger N extra network calls). The class
// is applied alongside `.tsukyio-tile`; the gradient/icon-tint live in
// tsukyio.css under `.tsukyio-tile.<accent>`.
export const CATEGORY_ACCENTS: Record<string, string> = {
  precuts: "accent-precuts",
  raw: "accent-raw",
  flow: "accent-flow",
  vocals: "accent-vocals",
  overlays: "accent-overlays",
  sfx: "accent-sfx",
  remake_clips: "accent-remake",
  green_screen: "accent-green",
  credits: "accent-credits",
};
