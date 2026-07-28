import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { logFrontend, safeLogValue } from "./log";

/**
 * Window-driven UI scaling.
 *
 * Every size in the stylesheets is an absolute pixel count, so a smaller
 * window used to mean "same-size content, less room for it" — which each
 * panel resolved by growing its own scrollbar. Instead of teaching 2.5k
 * declarations to shrink, we shrink the whole page: the webview's zoom is
 * driven from the window's logical size so the layout always gets at least
 * DESIGN_WIDTH x DESIGN_HEIGHT of CSS space to lay itself out in.
 *
 * INVARIANT (relied on elsewhere): because zoom never exceeds
 * logicalSize / DESIGN_SIZE, the CSS viewport is always >= 1440 x 900.
 * The window's minimum size in tauri.conf.json is set to DESIGN * MIN_ZOOM
 * so the floor is never hit before the window stops shrinking. Width-based
 * media queries below 1440px can therefore never match — do not add any.
 */

/** The size the UI was drawn at; zoom 1.0 means the window matches this. */
export const DESIGN_WIDTH = 1440;
export const DESIGN_HEIGHT = 900;

/**
 * Below this the text gets too small to read comfortably, so we stop
 * shrinking. The window minimum is pinned to this same floor
 * (1440 * 0.75 = 1080, 900 * 0.75 = 675) so the app never lands in the
 * region where the floor holds but the content no longer fits.
 */
export const MIN_ZOOM = 0.75;

/** Past this the UI reads as a kiosk rather than a desktop app. */
export const MAX_ZOOM = 1.25;

/**
 * Zoom is snapped to 5% steps, always downwards. Snapping keeps glyph
 * rasterisation stable (continuous zoom re-renders every font on every
 * mouse-move during a drag-resize) and rounding down can only ever hand the
 * layout more room than it asked for, never less.
 */
export const ZOOM_STEP = 0.05;

/** Guards against float noise when a ratio lands exactly on a step. */
const STEP_EPSILON = 1e-6;

/**
 * The zoom that lets a window of this logical size show the full design.
 * Pure — the resize plumbing below is the only thing with side effects.
 */
export function computeUiZoom(logicalWidth: number, logicalHeight: number): number {
  if (!Number.isFinite(logicalWidth) || !Number.isFinite(logicalHeight)) return 1;
  if (logicalWidth <= 0 || logicalHeight <= 0) return 1;

  // The tighter of the two axes wins: fitting the width but overflowing the
  // height would just move the scrollbar rather than remove it.
  const raw = Math.min(logicalWidth / DESIGN_WIDTH, logicalHeight / DESIGN_HEIGHT);
  const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, raw));
  const snapped = Math.floor(clamped / ZOOM_STEP + STEP_EPSILON) * ZOOM_STEP;

  // Snapping down can undershoot the floor by one step; the floor wins.
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(snapped.toFixed(4))));
}

let currentZoom = 1;

/**
 * The zoom currently applied to the page.
 *
 * Anything that hands a CSS-pixel measurement to a native API needs this:
 * `getBoundingClientRect()` reports CSS pixels, but the window manager works
 * in logical pixels, and once the page is zoomed those two units are no
 * longer the same. Multiply CSS by this to get logical.
 */
export function getUiZoom(): number {
  return currentZoom;
}

/** Fired on the window object whenever the applied zoom changes. */
export const UI_ZOOM_CHANGED_EVENT = "ui-zoom-changed";

function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function applyZoom(zoom: number): Promise<void> {
  // WebView2 re-rasterises the whole page on a zoom change, so skip the call
  // when the snapped value has not actually moved. During a drag-resize this
  // is the common case: several hundred resize events collapse to a handful
  // of real zoom changes.
  if (Math.abs(zoom - currentZoom) < STEP_EPSILON) return;
  try {
    await getCurrentWebview().setZoom(zoom);
    currentZoom = zoom;
    document.documentElement.style.setProperty("--ui-zoom", String(zoom));
    window.dispatchEvent(new CustomEvent(UI_ZOOM_CHANGED_EVENT, { detail: zoom }));
  } catch (error) {
    logFrontend("warn", "frontend.uiscale.apply.error", "Could not apply UI zoom", {
      zoom,
      error: safeLogValue(error),
    });
  }
}

/**
 * Starts driving the page zoom from the window size. Returns a teardown.
 *
 * The window's *logical* size is the input, never `window.innerWidth`:
 * innerWidth is reported in CSS pixels, which is the thing zoom changes, so
 * feeding it back in would make each resize chase the previous zoom instead
 * of settling.
 */
export function startUiScaling(): () => void {
  if (!isDesktop()) return () => undefined;

  const appWindow = getCurrentWindow();
  let disposed = false;
  let scaleFactor = 1;
  let pending = 0;
  const unlisteners: Array<() => void> = [];

  async function sync(): Promise<void> {
    if (disposed) return;
    try {
      const physical = await appWindow.innerSize();
      if (disposed) return;
      // Windows display scaling (125%, 150%, ...) already sits between
      // physical pixels and the logical pixels the layout is written in.
      await applyZoom(computeUiZoom(physical.width / scaleFactor, physical.height / scaleFactor));
    } catch (error) {
      logFrontend("warn", "frontend.uiscale.sync.error", "Could not read window size for UI zoom", {
        error: safeLogValue(error),
      });
    }
  }

  function scheduleSync(): void {
    if (disposed || pending) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      void sync();
    });
  }

  void (async () => {
    try {
      scaleFactor = await appWindow.scaleFactor();
    } catch {
      scaleFactor = 1;
    }
    if (disposed) return;
    await sync();

    const offResize = await appWindow.onResized(scheduleSync);
    if (disposed) {
      offResize();
      return;
    }
    unlisteners.push(offResize);

    // Dragging the window to a monitor with different Windows scaling drops
    // WebView2's zoom factor back to 1. Re-applying from a cleared baseline
    // forces the setZoom call through even when the target value is unchanged.
    const offScale = await appWindow.onScaleChanged(({ payload }) => {
      scaleFactor = payload.scaleFactor || 1;
      currentZoom = 1;
      scheduleSync();
    });
    if (disposed) {
      offScale();
      return;
    }
    unlisteners.push(offScale);
  })();

  return () => {
    disposed = true;
    if (pending) cancelAnimationFrame(pending);
    pending = 0;
    for (const off of unlisteners) off();
    unlisteners.length = 0;
  };
}
