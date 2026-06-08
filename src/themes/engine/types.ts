/**
 * Theme engine type contracts.
 *
 * A "theme" is a folder containing a `theme.json` manifest plus a CSS entry
 * file (default `theme.css`) and optional assets. The engine injects the
 * entry CSS into the high-priority `theme` cascade layer so it overrides the
 * app's `base` layer without `!important`.
 *
 * Themes are CSS-only: they restyle/relayout the existing DOM. They cannot
 * change which React component renders. The single documented exception is the
 * audio panel swap keyed on the `ultimate-amv-old` theme id (see App.tsx).
 */

/** Parsed `theme.json`. `entry` is the CSS file to load, relative to the folder. */
export type ThemeManifest = {
  /** Stable unique id. For external themes this is the folder name. */
  id: string;
  /** Human-friendly display name shown in the picker. */
  name: string;
  description?: string;
  author?: string;
  version?: string;
  /** CSS entry filename, relative to the theme folder. Defaults to "theme.css". */
  entry: string;
  /** True for themes bundled into the app at build time. */
  builtin: boolean;
};

/** Where a theme's CSS comes from. */
export type ThemeSource = "builtin" | "external";

/**
 * A theme as the frontend list/picker sees it: the manifest plus enough info
 * to resolve and apply it. `dir` is only present for external themes (the
 * absolute on-disk folder path, used to rewrite relative url() asset refs).
 */
export type ThemeEntry = ThemeManifest & {
  source: ThemeSource;
  /** Absolute folder path on disk. External themes only. */
  dir?: string;
};

/**
 * Shape returned by the Rust `list_themes` command for one external theme.
 * Field names are camelCase to match the serde rename on the Rust side.
 */
export type ExternalThemeManifest = {
  id: string;
  name: string;
  description?: string | null;
  author?: string | null;
  version?: string | null;
  entry: string;
  /** Absolute path to the theme folder on disk. */
  dir: string;
};

/** The default theme id, used when nothing is persisted yet. */
export const DEFAULT_THEME_ID = "ultimate-amv";
