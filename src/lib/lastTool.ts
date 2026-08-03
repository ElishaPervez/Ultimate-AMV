import type { SectionId } from "../types/app";

/* Remembers which tool the user was last working in, so Home can offer a
 * one-click way back. Written on every navigation (App.tsx watches `active`),
 * read once when Home mounts. */

const LAST_TOOL_KEY = "ui.home.lastTool";

export type LastToolVisit = {
  id: SectionId;
  /** Epoch ms of the visit — Home renders this as "2 hours ago". */
  at: number;
};

/* Home, Settings and Logs are destinations, not work. Landing on one of them
 * must not overwrite the record, or every trip to Settings would erase the
 * thing the user actually wants to resume. */
const NOT_A_TOOL: readonly SectionId[] = ["home", "settings", "logs"];

export function recordToolVisit(id: SectionId): void {
  if (NOT_A_TOOL.includes(id)) return;
  try {
    window.localStorage.setItem(LAST_TOOL_KEY, JSON.stringify({ id, at: Date.now() }));
  } catch {
    // Storage disabled — Home falls back to its empty state, nothing breaks.
  }
}

export function loadLastToolVisit(): LastToolVisit | null {
  try {
    const raw = window.localStorage.getItem(LAST_TOOL_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LastToolVisit> | null;
    if (typeof parsed?.id !== "string" || typeof parsed?.at !== "number") return null;
    if (NOT_A_TOOL.includes(parsed.id as SectionId)) return null;
    return { id: parsed.id as SectionId, at: parsed.at };
  } catch {
    return null;
  }
}
