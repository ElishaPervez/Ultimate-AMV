/* DEV TOOLS: on/off switches for the scene grid's render optimizations, so the
 * old and new behaviour can be measured side by side (scripts/bench/
 * grid_app_bench.py). Every switch is ON in real builds: the switches can only
 * be turned off in a dev build or in the grid bench build (which defines
 * VITE_AMV_GRID_BENCH=1). In a release build the condition below is a constant
 * false, so the lookup compiles away and every switch is a plain `true`.
 *
 * To flip one by hand in a dev build:
 *   localStorage.setItem("amv.gridPerf", JSON.stringify({ memoTiles: false }))
 * then reload. Read once at startup, so a switch never changes mid-session. */

export type GridPerfSwitch =
  /* Skip the grid's playback-window bookkeeping update when nothing in it
   * changed, instead of re-rendering the whole panel on every scroll frame. */
  | "quietDiagnostics"
  /* Re-render a scene tile only when its own props change. */
  | "memoTiles";

function readSwitches(): Partial<Record<GridPerfSwitch, boolean>> {
  if (!(import.meta.env.DEV || import.meta.env.VITE_AMV_GRID_BENCH === "1")) return {};
  try {
    const raw = typeof window !== "undefined" ? window.localStorage?.getItem("amv.gridPerf") : null;
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as Partial<Record<GridPerfSwitch, boolean>>) : {};
  } catch {
    return {};
  }
}

const SWITCHES = readSwitches();

export function gridPerfEnabled(name: GridPerfSwitch): boolean {
  return SWITCHES[name] !== false;
}
