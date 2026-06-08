/**
 * Built-in theme registry.
 *
 * Discovered at BUILD TIME via Vite's `import.meta.glob`. Each theme under
 * `src/themes/builtin/<id>/` contributes:
 *   - `theme.json`  -> parsed manifest
 *   - the entry CSS (default `theme.css`) -> inlined as a string
 *
 * Both globs are `eager` so the registry is a plain synchronous map with no
 * async loading at runtime — built-in CSS is part of the JS bundle.
 *
 * External (drop-in) themes are NOT here; they're discovered at runtime by the
 * Rust `list_themes` command and loaded via `read_theme_css`.
 */
import type { ThemeManifest } from "./types";

type RawManifest = Partial<ThemeManifest> & { id?: string; name?: string };

// theme.json for every built-in theme. Path is relative to THIS file.
const manifestModules = import.meta.glob("../builtin/*/theme.json", {
  import: "default",
  eager: true,
}) as Record<string, RawManifest>;

// Every CSS file under each built-in theme folder, inlined as a string. We key
// by full path and resolve the manifest's `entry` against it per theme.
const cssModules = import.meta.glob("../builtin/*/**/*.css", {
  query: "?inline",
  import: "default",
  eager: true,
}) as Record<string, string>;

export type BuiltinTheme = {
  manifest: ThemeManifest;
  css: string;
};

/** Folder name segment from `../builtin/<id>/theme.json`. */
function folderIdFromPath(path: string): string | null {
  const match = path.match(/\/builtin\/([^/]+)\//);
  return match ? match[1] : null;
}

function buildRegistry(): Record<string, BuiltinTheme> {
  const registry: Record<string, BuiltinTheme> = {};

  for (const [path, raw] of Object.entries(manifestModules)) {
    const folderId = folderIdFromPath(path);
    if (!folderId) continue;

    const id = (raw?.id ?? folderId).trim();
    const entry = (raw?.entry ?? "theme.css").trim() || "theme.css";
    const cssPath = path.replace(/theme\.json$/, entry);
    const css = cssModules[cssPath];

    if (typeof css !== "string") {
      // Manifest points at an entry CSS that doesn't exist — skip rather than
      // ship a theme that injects nothing.
      // eslint-disable-next-line no-console
      console.warn(`[theme-engine] built-in theme "${id}" has no entry CSS at ${entry}; skipping`);
      continue;
    }

    const manifest: ThemeManifest = {
      id,
      name: (raw?.name ?? id).trim() || id,
      description: raw?.description,
      author: raw?.author,
      version: raw?.version,
      entry,
      builtin: true,
    };

    registry[id] = { manifest, css };
  }

  return registry;
}

export const BUILTIN_THEMES: Record<string, BuiltinTheme> = buildRegistry();

export function getBuiltinTheme(id: string): BuiltinTheme | undefined {
  return BUILTIN_THEMES[id];
}

export function listBuiltinThemes(): BuiltinTheme[] {
  return Object.values(BUILTIN_THEMES);
}
