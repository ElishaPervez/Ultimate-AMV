// DEV-tunables store for the featherweight offset-playback previews.
//
// A tiny reactive external store (useSyncExternalStore-backed) seeded from the
// bake-able universal defaults in src/lib/constants.ts. The DEV-only
// PreviewDevTools panel live-edits it on REAL footage; once a good universal
// margin is found it is baked back into the constants and the panel hidden. In
// PRODUCTION nothing mutates the store, so its values stay equal to the
// constants — components can read this store unconditionally.
//
// Keep the surface tiny: a snapshot value, subscribe(), getSnapshot(), and a
// setter per field. Consumers use the usesPreviewTunables() hook below.

import React from "react";
import {
  MAX_GRID_VIDEO_PLAYERS,
  PREVIEW_LOOP_END_MARGIN_FRAMES,
  PREVIEW_LOOP_START_MARGIN_FRAMES,
  PREVIEW_PLAY_AREA_MARGIN_PX,
} from "../lib/constants";

export type PreviewTunables = {
  /** Live mirror of the featherweight_previews config flag for the DEV panel.
   * NOTE: this is the DEV override only — the production gate is the persisted
   * `featherweight_previews` config read via get_config. */
  featherweightEnabled: boolean;
  endMarginFrames: number;
  startMarginFrames: number;
  /** Force the timeupdate fallback even when rVFC is available (for tuning the
   * coarse-loop margin against the worst-case path). */
  forceTimeupdateFallback: boolean;
  maxGridVideoPlayers: number;
  /** IntersectionObserver rootMargin (px, above & below the scroll viewport)
   * for the per-tile featherweight play-area gate. */
  playAreaMarginPx: number;
};

// `maxGridVideoPlayers` is REPURPOSED as the LIVE concurrent-<video> cap for the
// central geometry-driven mount set in ClipExtractorPanel (the user dials it
// against the DEV panel's activeCount readout). The mount set FLOORS it at the
// visible-tile count (so every visible tile mounts — no dead-zone) and clamps it
// to MAX_GRID_VIDEO_PLAYERS_CEILING (35) at the top, so this knob effectively
// adds pre-warm headroom above the visible band up to the hard ceiling. In DEV
// the React StrictMode double-invoke transiently DOUBLES in-flight decoders
// (mount -> cleanup -> mount); accounting for the play-area gate's hover +1
// (one hovered tile outside the capped set mounts an extra decoder),
// (35 + 1) × 2 = 72 < DECODER_SAFETY_LIMIT (75), so even the ceiling survives the
// 2x transient. We seed a conservative value; prod uses the baked
// MAX_GRID_VIDEO_PLAYERS (12).
const DEV_MAX_GRID_VIDEO_PLAYERS = 16;

// Initialized FROM the constants. In prod this is the final state.
const INITIAL: PreviewTunables = {
  featherweightEnabled: false,
  endMarginFrames: PREVIEW_LOOP_END_MARGIN_FRAMES,
  startMarginFrames: PREVIEW_LOOP_START_MARGIN_FRAMES,
  forceTimeupdateFallback: false,
  maxGridVideoPlayers: import.meta.env.DEV ? DEV_MAX_GRID_VIDEO_PLAYERS : MAX_GRID_VIDEO_PLAYERS,
  playAreaMarginPx: PREVIEW_PLAY_AREA_MARGIN_PX,
};

let snapshot: PreviewTunables = INITIAL;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): PreviewTunables {
  return snapshot;
}

/** Merge a partial patch into the snapshot (immutable swap) and notify. */
export function setPreviewTunables(patch: Partial<PreviewTunables>): void {
  const next = { ...snapshot, ...patch };
  // Skip churn if nothing actually changed (cheap shallow compare).
  let changed = false;
  for (const key of Object.keys(patch) as Array<keyof PreviewTunables>) {
    if (next[key] !== snapshot[key]) {
      changed = true;
      break;
    }
  }
  if (!changed) return;
  snapshot = next;
  emit();
}

/** Reactive read of the whole tunables snapshot. */
export function usePreviewTunables(): PreviewTunables {
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// Direct accessors for non-React reads / tests.
export const previewTunablesStore = { subscribe, getSnapshot, set: setPreviewTunables };

// ---------------------------------------------------------------------------
// DEV TOOLS live metrics registry.
//
// A separate, polled (not reactive) channel so active offset players can cheaply
// report their max boundary overshoot WITHOUT triggering React re-renders on
// the hot path. The integrate-phase offset players (useOffsetLoop callers) call
// reportOffsetMetrics on the falseâ†’true active edge and clear it on teardown;
// the DEV panel polls getOffsetMetricsSummary on an interval. No-op cost in
// prod (the panel that polls it is DEV-gated and never mounts).
// ---------------------------------------------------------------------------

export type OffsetMetric = {
  /** Max observed overshoot past the margined end, in ms (boundary tightness). */
  maxOvershootMs: number;
};

const offsetMetrics = new Map<string, OffsetMetric>();

/** Upsert a player's live metric. `id` is any stable per-tile/modal key. */
export function reportOffsetMetrics(id: string, metric: OffsetMetric): void {
  offsetMetrics.set(id, metric);
}

/** Drop a player's metric on teardown so the active count stays accurate. */
export function clearOffsetMetrics(id: string): void {
  offsetMetrics.delete(id);
}

/** Aggregate readout for the DEV panel: how many offset <video>s are live and
 * the worst boundary overshoot across them. */
export function getOffsetMetricsSummary(): { activeCount: number; maxOvershootMs: number } {
  let maxOvershootMs = 0;
  for (const metric of offsetMetrics.values()) {
    if (metric.maxOvershootMs > maxOvershootMs) maxOvershootMs = metric.maxOvershootMs;
  }
  return { activeCount: offsetMetrics.size, maxOvershootMs };
}
