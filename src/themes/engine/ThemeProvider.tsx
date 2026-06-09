/**
 * React glue for the theme engine.
 *
 * Exposes `{ themes, activeId, switchTheme, refresh }` via context. On mount it
 * bootstraps the persisted (or default) theme and loads the available theme
 * list (built-in + external drop-ins). `switchTheme` applies instantly and
 * persists in the background.
 *
 * This is ORTHOGONAL to the accent-color system (src/lib/theme.ts): an engine
 * theme sets the overall look; the accent gradient is a sub-axis that keeps
 * working inside whichever engine theme is active.
 */
import React from "react";
import { logFrontend, safeLogValue } from "../../lib/log";
import {
  applyTheme,
  listThemes,
  persistActiveThemeId,
  readActiveThemeId,
} from "./themeLoader";
import { DEFAULT_THEME_ID, type ThemeEntry } from "./types";

type ThemeContextValue = {
  themes: ThemeEntry[];
  activeId: string;
  /** Apply a theme by id (instant) and persist it. */
  switchTheme: (id: string) => Promise<void>;
  /**
   * Re-scan disk for external drop-in themes and refresh the list.
   *
   * Optional `shouldApply` is checked after the (async) scan resolves; if it
   * returns false the result is discarded. Lets a caller bail out when the UI
   * that triggered the scan (e.g. the theme picker) was dismissed before it
   * came back. The scan never throws and never disturbs the active selection.
   */
  refresh: (shouldApply?: () => boolean) => Promise<void>;
};

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [themes, setThemes] = React.useState<ThemeEntry[]>([]);
  const [activeId, setActiveId] = React.useState<string>(DEFAULT_THEME_ID);

  React.useEffect(() => {
    let cancelled = false;

    (async () => {
      // Apply the persisted (or default) theme FIRST so the first paint
      // already carries the right skin. Built-in CSS is bundled (no IPC
      // needed), and applyTheme resolves external ids by scanning disk on
      // demand — the picker list is not a prerequisite. A persisted id that
      // no longer exists (deleted external theme) makes applyTheme throw,
      // which falls back to the default rather than leaving the app unstyled.
      const persistedId = await readActiveThemeId();
      let appliedId = persistedId;
      try {
        await applyTheme(persistedId);
      } catch (error) {
        logFrontend("warn", "frontend.theme.engine.apply.error", "Could not apply engine theme", {
          themeId: persistedId,
          error: safeLogValue(error),
        });
        appliedId = DEFAULT_THEME_ID;
        if (persistedId !== DEFAULT_THEME_ID) {
          try {
            await applyTheme(DEFAULT_THEME_ID);
          } catch {
            /* base layer still renders; nothing more to do */
          }
        }
      }

      // Then load the picker list (built-in + external drop-ins).
      let available: ThemeEntry[] = [];
      try {
        available = await listThemes();
      } catch (error) {
        logFrontend("warn", "frontend.theme.engine.list.error", "Could not list engine themes", {
          error: safeLogValue(error),
        });
      }
      if (cancelled) return;

      setThemes(available);
      setActiveId(appliedId);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const switchTheme = React.useCallback(async (id: string) => {
    try {
      await applyTheme(id);
      setActiveId(id);
      await persistActiveThemeId(id);
    } catch (error) {
      logFrontend("warn", "frontend.theme.engine.switch.error", "Could not switch engine theme", {
        themeId: id,
        error: safeLogValue(error),
      });
    }
  }, []);

  const refresh = React.useCallback(async (shouldApply?: () => boolean) => {
    try {
      const available = await listThemes();
      if (shouldApply && !shouldApply()) return;
      setThemes(available);
    } catch (error) {
      logFrontend("warn", "frontend.theme.engine.refresh.error", "Could not refresh engine themes", {
        error: safeLogValue(error),
      });
    }
  }, []);

  const value = React.useMemo<ThemeContextValue>(
    () => ({ themes, activeId, switchTheme, refresh }),
    [themes, activeId, switchTheme, refresh],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useActiveTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useActiveTheme must be used within a ThemeProvider");
  }
  return ctx;
}
