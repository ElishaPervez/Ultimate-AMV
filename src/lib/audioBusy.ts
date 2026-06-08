/**
 * Tiny cross-component signal for "a vocal-separation extraction is running".
 *
 * The two audio panels (NewAudioExtractionPanel and the legacy
 * AudioExtractionPanel) own the extraction lifecycle and the `audio-progress`
 * listener internally. App.tsx swaps WHICH of those two components renders based
 * on the active engine theme ("ultimate-amv-old" -> legacy, else new). Swapping
 * mid-extraction would unmount the running panel, tear down its progress
 * listener, and orphan the job. To avoid that, the active panel publishes its
 * busy state here and App defers the theme-driven swap until it goes idle.
 */
const AUDIO_BUSY_EVENT = "audio-busy-changed";

let busy = false;

export function isAudioBusy(): boolean {
  return busy;
}

export function setAudioBusy(next: boolean): void {
  if (busy === next) return;
  busy = next;
  try {
    window.dispatchEvent(new CustomEvent(AUDIO_BUSY_EVENT, { detail: next }));
  } catch {
    // window may be unavailable in non-DOM contexts; state is still tracked.
  }
}

/** Subscribe to busy transitions. Returns an unsubscribe function. */
export function onAudioBusyChange(handler: (busy: boolean) => void): () => void {
  const listener = (event: Event) => {
    handler((event as CustomEvent<boolean>).detail);
  };
  window.addEventListener(AUDIO_BUSY_EVENT, listener);
  return () => window.removeEventListener(AUDIO_BUSY_EVENT, listener);
}
