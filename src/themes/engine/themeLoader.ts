/**
 * Theme engine runtime.
 *
 * Responsibilities:
 *   - Maintain a single <style id="amv-theme"> element in <head> that holds the
 *     active theme's CSS, wrapped in `@layer theme { … }` so it always wins over
 *     the app's `base` layer (declared in src/styles.css) without `!important`.
 *   - Resolve a theme's CSS: built-in themes come from the build-time registry;
 *     external themes are read from disk via the Rust `read_theme_css` command,
 *     with relative `url(./…)` asset refs rewritten to asset-protocol URLs.
 *   - Merge built-in + external themes into one list for the picker.
 *   - Persist/read the active id under the `ui_theme` config key.
 *
 * Applying a theme is instant (textContent swap) — no reload.
 */
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { parseBridgePayload } from "../../utils/bridge";
import { BUILTIN_THEMES, getBuiltinTheme, listBuiltinThemes } from "./themeRegistry";
import {
  DEFAULT_THEME_ID,
  type ExternalThemeManifest,
  type ThemeEntry,
} from "./types";

const STYLE_EL_ID = "amv-theme";
const UI_THEME_CONFIG_KEY = "ui_theme";

/** In-memory cache of discovered external themes (id -> manifest+dir). */
let externalCache: Record<string, ExternalThemeManifest> = {};

function getStyleEl(): HTMLStyleElement {
  let el = document.getElementById(STYLE_EL_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_EL_ID;
    // Append last so it's the final stylesheet, though @layer ordering — not
    // DOM order — is what actually decides precedence here.
    document.head.appendChild(el);
  }
  return el;
}

/** Wrap raw theme CSS in the high-priority `theme` cascade layer. */
function wrapInThemeLayer(css: string): string {
  return `@layer theme {\n${css}\n}`;
}

/**
 * Rewrite relative `url(./foo.png)` / `url(foo.woff2)` references in external
 * theme CSS to asset-protocol URLs rooted at the theme folder, so images and
 * fonts resolve. Absolute URLs (http(s):, data:, blob:, asset:, leading `/`)
 * and already-absolute paths are left untouched.
 */
function rewriteExternalAssetUrls(css: string, themeDir: string): string {
  const base = themeDir.replace(/[\\/]+$/, "");
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (match, quote: string, ref: string) => {
    const raw = ref.trim();
    if (
      raw === "" ||
      /^[a-z][a-z0-9+.-]*:/i.test(raw) || // has a scheme (http:, data:, asset:, blob:, tsukyio:, …)
      raw.startsWith("//") ||
      raw.startsWith("/") || // root-absolute — leave alone
      raw.startsWith("#") // in-document ref (e.g. SVG filter)
    ) {
      return match;
    }
    const clean = raw.replace(/^\.\//, "");
    // Join with a forward slash; convertFileSrc handles OS-specific encoding.
    const abs = `${base}/${clean}`;
    const resolved = convertFileSrc(abs);
    return `url(${quote}${resolved}${quote})`;
  });
}

/** Resolve the raw (unlayered) CSS for a theme id, from built-in or disk. */
async function resolveThemeCss(id: string): Promise<string> {
  const builtin = getBuiltinTheme(id);
  if (builtin) {
    return builtin.css;
  }

  const external = externalCache[id];
  if (external) {
    const raw = await invoke<string>("read_theme_css", { id });
    return rewriteExternalAssetUrls(raw, external.dir);
  }

  // Unknown id: refresh the external list once in case it appeared on disk
  // after the last scan, then retry.
  await refreshExternalThemes();
  const refreshed = externalCache[id];
  if (refreshed) {
    const raw = await invoke<string>("read_theme_css", { id });
    return rewriteExternalAssetUrls(raw, refreshed.dir);
  }

  throw new Error(`Unknown theme id: ${id}`);
}

/** Scan disk for external themes and refresh the in-memory cache. */
export async function refreshExternalThemes(): Promise<ExternalThemeManifest[]> {
  try {
    const list = await invoke<ExternalThemeManifest[]>("list_themes");
    const next: Record<string, ExternalThemeManifest> = {};
    for (const m of list) {
      // Built-in ids win; an external folder can't shadow a built-in id.
      if (BUILTIN_THEMES[m.id]) continue;
      next[m.id] = m;
    }
    externalCache = next;
    return Object.values(next);
  } catch (error) {
    // Rust command missing or scan failed — degrade to built-ins only.
    // eslint-disable-next-line no-console
    console.warn("[theme-engine] could not list external themes", error);
    externalCache = {};
    return [];
  }
}

/** Built-in + external themes merged for the picker. Built-ins listed first. */
export async function listThemes(): Promise<ThemeEntry[]> {
  const external = await refreshExternalThemes();

  const builtinEntries: ThemeEntry[] = listBuiltinThemes().map((t) => ({
    ...t.manifest,
    source: "builtin",
  }));

  const externalEntries: ThemeEntry[] = external.map((m) => ({
    id: m.id,
    name: m.name,
    description: m.description ?? undefined,
    author: m.author ?? undefined,
    version: m.version ?? undefined,
    entry: m.entry,
    builtin: false,
    source: "external",
    dir: m.dir,
  }));

  return [...builtinEntries, ...externalEntries];
}

/**
 * Apply a theme by id: resolve its CSS, wrap it in the `theme` layer, write it
 * into the single <style id="amv-theme"> element, and flag the active id on the
 * document element. Instant. Throws if the id can't be resolved.
 */
export async function applyTheme(id: string): Promise<void> {
  const css = await resolveThemeCss(id);
  const styleEl = getStyleEl();
  styleEl.textContent = wrapInThemeLayer(css);
  document.documentElement.dataset.themeId = id;
}

/** Read the persisted active theme id, falling back to the default. */
export async function readActiveThemeId(): Promise<string> {
  try {
    const raw = await invoke<string>("get_config");
    // The Python bridge can emit preceding stdout lines before the JSON
    // payload; parse the last line like every other config consumer, otherwise
    // a preamble makes the parse throw and the saved theme silently resets.
    const config = parseBridgePayload<{ ui_theme?: unknown }>(raw);
    const id = typeof config.ui_theme === "string" ? config.ui_theme.trim() : "";
    return id || DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

/** Persist the active theme id under the `ui_theme` config key. */
export async function persistActiveThemeId(id: string): Promise<void> {
  await invoke("set_config", { key: UI_THEME_CONFIG_KEY, value: id });
}
