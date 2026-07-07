import type { AppThemeId, BackgroundState } from "../types/app";
import type { DownloadFormat } from "../types/download";

export const APP_THEMES: Array<{ id: Exclude<AppThemeId, "custom">; colors: [string, string] }> = [
  { id: "cyan", colors: ["#48d7ff", "#63e6a2"] },
  { id: "mint", colors: ["#63e6a2", "#48d7ff"] },
  { id: "violet", colors: ["#a98cff", "#48d7ff"] },
  { id: "rose", colors: ["#ff6d91", "#a98cff"] },
  { id: "amber", colors: ["#f4c267", "#ff6d91"] },
];

export const CLIP_AUDIO_SETTINGS_KEY = "ultimate-amv.clip-audio-settings";
export const CLIP_COLUMN_OPTIONS = [1, 2, 3, 4] as const;
export const MAX_GRID_AUTOPLAYERS = 100;

// Featherweight offset-playback preview defaults — the bake-able universal
// values. The DEV tunables store (src/dev/previewTunables.ts) is seeded from
// these; in production no panel mutates the store, so it equals these.
//
// Loop margins guard the boundary seam: turn the loop around a few frames
// BEFORE the cut and start a few frames AFTER it, so the loop never shows the
// adjacent scene's frame. Validated in src/dev/OffsetSpike.tsx.
export const PREVIEW_LOOP_END_MARGIN_FRAMES = 5;
export const PREVIEW_LOOP_START_MARGIN_FRAMES = 3;
// Minimum margined offset-window length (in frames, at the clip's clamped fps)
// required to take the featherweight offset-loop path. A clip whose total length
// is only just above the baked margins (START+END frames) produces an
// arbitrarily-tiny positive window — e.g. a hair over 8 frames @24fps yields a
// sub-millisecond window that technically passes a `> 0` gate but plays as a
// dead 0:00/0:00 frozen micro-loop. Requiring a genuinely-watchable minimum (a
// couple of frames) keeps short-but-real scenes on the offset loop while routing
// the sub-frame float band to the trimmed-mp4 (scene_clip_render) fallback.
export const MIN_OFFSET_WINDOW_FRAMES = 2;
// Chromium's approximate hard limit on concurrent video decoders before the
// WebView2 renderer/GPU process dies (the white-screen crash). Every ceiling
// below is chosen against this bound, INCLUDING the DEV StrictMode transient
// where each <video> is briefly double-mounted (2x).
export const DECODER_SAFETY_LIMIT = 75;
// Seeds the DEV tunable's "Max grid <video> players" field, which is REPURPOSED
// as the LIVE concurrent-<video> ceiling for the central, geometry-driven,
// hard-capped mount set in ClipExtractorPanel (computeGeometryMountVideoIds).
// The per-tile IntersectionObserver play-area gate that previously selected
// playing tiles was RETIRED from the mount decision — the panel's own scroll
// geometry is now the sole authority, always clamped by
// MAX_GRID_VIDEO_PLAYERS_CEILING. Prod runs at this value; DEV seeds 16
// (see previewTunables).
export const MAX_GRID_VIDEO_PLAYERS = 12;
// Absolute hard ceiling on concurrent offset-<video> decoders. Chosen so that
// even the DEV StrictMode transient (each <video> briefly mounted twice) stays
// under DECODER_SAFETY_LIMIT, accounting for the per-tile play-area gate's
// `|| isHovered` term, which lets ONE hovered tile outside the capped set mount
// an extra decoder (true peak is ceiling + 1):
// (ceiling + 1 hover) * 2 (StrictMode dev double-mount) = 72 < DECODER_SAFETY_LIMIT(75).
// Fast scrolling + overscan can never exceed this — the central geometry-driven
// mount set in ClipExtractorPanel always clamps its cap to this ceiling. Prod
// runs the MAX_GRID_VIDEO_PLAYERS cap (12); DEV seeds 16. The cap floor is the
// visible-tile count (so every visible tile mounts — no dead-zone), and the
// knob can only RAISE the cap between that floor and this ceiling.
export const MAX_GRID_VIDEO_PLAYERS_CEILING = 35;
// Fast-fling velocity threshold (px scrolled per rAF frame). While the scroller's
// per-frame |scrollTop delta| exceeds this, the panel suppresses NEW offset-<video>
// mounts (it holds the last committed set) so a fling allocates no new decoders.
// Cleared after a short settle, at which point the geometry-based mount set is
// recomputed immediately (no dead-zone). Slow scroll stays below this and never
// suppresses. ~50px/frame ≈ a deliberate fling at 60Hz, not a careful drag.
export const FAST_SCROLL_VELOCITY_PX_PER_FRAME = 50;
// Extra rows of <video> tiles kept live just outside the viewport (top and
// bottom) so a tile is already decoding by the time it scrolls into view.
export const GRID_VIDEO_OVERSCAN_ROWS = 1;
/** How far outside the visible scroll area (px, above & below) a featherweight
 *  preview tile starts playing — the IntersectionObserver rootMargin. Larger =
 *  clips pre-play further before they scroll into view. */
export const PREVIEW_PLAY_AREA_MARGIN_PX = 250;
export const CLIP_PREVIEW_BATCH_SIZE = 8;
export const CLIP_PREVIEW_CPU_BATCH_CONCURRENCY = 2;
export const CLIP_PREVIEW_GPU_BATCH_CONCURRENCY = 3;

export const BEST_FORMAT_ID = "__best__";

export const BEST_FORMAT_ENTRY: DownloadFormat = {
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

export const DEFAULT_BG_STATE: BackgroundState = {
  imagePath: "",
  scale: 1,
  offsetX: 50,
  offsetY: 50,
  dim: 55,
  blur: 5,
  videoPath: "",
  videoSource: "",
  videoFps: 30,
  brightText: false,
};

export const WALLPAPER_FPS_OPTIONS = [15, 24, 30, 60] as const;
export const WALLPAPER_VIDEO_EXTENSIONS = ["mp4", "mkv", "webm", "mov", "m4v"];
