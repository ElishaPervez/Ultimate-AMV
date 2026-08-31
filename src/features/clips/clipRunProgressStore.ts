import { useSyncExternalStore } from "react";
import type { ClipProgress } from "../../types/clip";
import type { ConversionProgress } from "../../types/conversion";

export type ClipRunProgressSnapshot = {
  generation: number;
  detection: ClipProgress | null;
  proxyBySource: Readonly<Record<string, number>>;
  compatibility: ConversionProgress | null;
};

const listeners = new Set<() => void>();
let snapshot: ClipRunProgressSnapshot = {
  generation: 0,
  detection: null,
  proxyBySource: {},
  compatibility: null,
};

function replace(next: ClipRunProgressSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

export function getClipRunProgressSnapshot(): ClipRunProgressSnapshot {
  return snapshot;
}

export function subscribeClipRunProgress(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetClipRunProgress(): number {
  const generation = snapshot.generation + 1;
  replace({ generation, detection: null, proxyBySource: {}, compatibility: null });
  return generation;
}

export function beginClipRunProgress(): number {
  return resetClipRunProgress();
}

export function publishDetectionProgress(generation: number, detection: ClipProgress | null): void {
  if (generation !== snapshot.generation) return;
  replace({ ...snapshot, detection });
}

export function publishProxyProgress(sourcePath: string, percent: number): void {
  replace({
    ...snapshot,
    proxyBySource: { ...snapshot.proxyBySource, [sourcePath]: percent },
  });
}

export function removeProxyProgress(sourcePath: string): void {
  if (!(sourcePath in snapshot.proxyBySource)) return;
  const { [sourcePath]: _removed, ...proxyBySource } = snapshot.proxyBySource;
  replace({ ...snapshot, proxyBySource });
}

export function publishCompatibilityProgress(compatibility: ConversionProgress | null): void {
  replace({ ...snapshot, compatibility });
}

export function useClipRunProgressSnapshot(): ClipRunProgressSnapshot {
  return useSyncExternalStore(
    subscribeClipRunProgress,
    getClipRunProgressSnapshot,
    getClipRunProgressSnapshot,
  );
}
