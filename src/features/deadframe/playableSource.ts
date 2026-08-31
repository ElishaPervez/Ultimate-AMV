import React from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { PlaybackPlan } from "../../types/clip";

/**
 * Turning a file on disk into something the embedded browser can actually show.
 *
 * The browser inside the app can read a ProRes / MKV / 10-bit file's header —
 * so it reports the right duration and draws a scrubber — but it cannot decode
 * a single picture from it, and it says nothing about that. The player just
 * stays black. The Scene Splitter already solved this: ask the backend whether
 * the file is playable as-is, and if it is not, have it write a small
 * always-playable copy ("proxy") and play that instead. This module is that
 * same two-step, packaged for the Dead Frame Remover's two players.
 *
 * The copy is whole-file, so the timeline lines up 1:1 with the original.
 *
 * No `height` is passed to either command on purpose: that argument is the
 * Scene Splitter's "preview quality" cap, and supplying one would push
 * perfectly playable files down the copy-first path for no reason. Omitting it
 * means only genuinely unplayable files ever get copied.
 */

export type PlayableSource =
  | { status: "empty" }
  | { status: "preparing" }
  | { status: "ready"; src: string }
  | { status: "failed" };

/** Original path -> the file that should actually be fed to the player. */
const resolvedFiles = new Map<string, string>();
/** Paths we already tried and could not make playable; never retried on select. */
const failedFiles = new Set<string>();
/** One build per path, shared by every caller that asks while it is running. */
const inFlight = new Map<string, Promise<string>>();

/** Tests only: the caches live at module scope so they survive re-renders. */
export function resetPlayableSourceCache(): void {
  resolvedFiles.clear();
  failedFiles.clear();
  inFlight.clear();
}

/**
 * Ask once per file, and only once even if both players (or a re-selection)
 * ask while the answer is still being worked out. The backend serialises the
 * actual encodes, so overlapping requests here would queue up behind each
 * other rather than run — deduplicating is what keeps re-selecting a clip free.
 */
function resolvePlayableFile(path: string): Promise<string> {
  const running = inFlight.get(path);
  if (running) return running;

  const job = (async () => {
    const plan = await invoke<PlaybackPlan>("clip_playback_plan", { sourcePath: path });
    if (plan.mode === "direct") return path;
    const proxy = await invoke<string>("build_source_proxy", { sourcePath: path, force: false });
    if (!proxy) throw new Error("The playable copy came back empty.");
    return proxy;
  })();

  inFlight.set(path, job);
  void job
    .then(
      (file) => {
        resolvedFiles.set(path, file);
      },
      () => {
        failedFiles.add(path);
      },
    )
    .finally(() => {
      inFlight.delete(path);
    });
  return job;
}

function cachedState(path: string | null): PlayableSource {
  if (!path) return { status: "empty" };
  const ready = resolvedFiles.get(path);
  if (ready) return { status: "ready", src: convertFileSrc(ready) };
  if (failedFiles.has(path)) return { status: "failed" };
  return { status: "preparing" };
}

/**
 * What this file should be played from right now. A path that was already
 * worked out comes back ready on the first render, so re-selecting a clip does
 * not flash "Preparing" or rebuild anything. Switching files mid-build drops
 * the old answer on the floor: the effect's cleanup marks it stale, so a copy
 * that finishes after the user has moved on cannot repaint the newer player.
 */
export function usePlayableSource(path: string | null): PlayableSource {
  const [state, setState] = React.useState<PlayableSource>(() => cachedState(path));

  React.useEffect(() => {
    const immediate = cachedState(path);
    if (immediate.status !== "preparing") {
      setState(immediate);
      return undefined;
    }
    let live = true;
    setState(immediate);
    void resolvePlayableFile(path as string).then(
      (file) => {
        if (live) setState({ status: "ready", src: convertFileSrc(file) });
      },
      () => {
        if (live) setState({ status: "failed" });
      },
    );
    return () => {
      live = false;
    };
  }, [path]);

  return state;
}
