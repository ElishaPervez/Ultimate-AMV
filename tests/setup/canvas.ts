/**
 * tests/setup/canvas.ts
 *
 * Polyfills for canvas and Image that jsdom leaves incomplete.
 *
 * Required so that useWebpThumbnail (ClipPreviewTile) can:
 *   1. call canvas.getContext('2d') and get back a non-null context object
 *      with drawImage / toDataURL present
 *   2. set Image.src and have onload fire asynchronously
 *
 * This module installs the polyfills at import time (idempotent).
 */

// ---------------------------------------------------------------------------
// HTMLCanvasElement polyfill
// ---------------------------------------------------------------------------

/** Minimum canvas 2D context surface used by useWebpThumbnail. */
const _fakeCtx = {
  drawImage: vi.fn(),
  fillRect: vi.fn(),
  clearRect: vi.fn(),
  getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4) })),
  putImageData: vi.fn(),
  createImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4) })),
  setTransform: vi.fn(),
  resetTransform: vi.fn(),
  save: vi.fn(),
  restore: vi.fn(),
  scale: vi.fn(),
  rotate: vi.fn(),
  translate: vi.fn(),
  beginPath: vi.fn(),
  closePath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  stroke: vi.fn(),
  fill: vi.fn(),
  arc: vi.fn(),
  rect: vi.fn(),
  fillText: vi.fn(),
  strokeText: vi.fn(),
  measureText: vi.fn(() => ({ width: 0 })),
  canvas: null as unknown as HTMLCanvasElement,
}

if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = vi.fn(
    (contextId: string) => (contextId === '2d' ? _fakeCtx : null)
  ) as typeof HTMLCanvasElement.prototype.getContext

  HTMLCanvasElement.prototype.toDataURL = vi.fn(
    (_type?: string, _quality?: unknown) =>
      'data:image/webp;base64,UklGRh4AAABXRUJQVlA4IBIAAAAwAQCdASoBAAEAAkA4JZACdAEO/gHOAAA='
  )
}

export { _fakeCtx as fakeCanvasCtx }

// ---------------------------------------------------------------------------
// HTMLMediaElement polyfill — jsdom throws "Not implemented" for play/pause/load
// ---------------------------------------------------------------------------
//
// The featherweight offset <video> layers call video.load() on mount and
// video.pause() + video.load() in their SYNCHRONOUS decoder-release cleanup, and
// useOffsetLoop calls video.play()/pause(). jsdom implements none of these and
// logs a noisy "Error: Not implemented" to stderr on each call. Stub them as
// no-ops (play resolves a Promise, matching the real API) so media-bearing
// component tests render and unmount cleanly.
if (typeof HTMLMediaElement !== 'undefined') {
  HTMLMediaElement.prototype.play = vi.fn(
    () => Promise.resolve(),
  ) as unknown as typeof HTMLMediaElement.prototype.play
  HTMLMediaElement.prototype.pause = vi.fn() as typeof HTMLMediaElement.prototype.pause
  HTMLMediaElement.prototype.load = vi.fn() as typeof HTMLMediaElement.prototype.load
}

// ---------------------------------------------------------------------------
// Image polyfill — setting .src fires onload on the next microtask
// ---------------------------------------------------------------------------

/**
 * Replace window.Image with a version that automatically fires onload
 * when .src is assigned.  jsdom's Image never fires onload because
 * there is no real network, breaking any hook that awaits image load.
 */
export function installImagePolyfill(): void {
  class MockImage {
    onload: (() => void) | null = null
    onerror: ((e: unknown) => void) | null = null
    width = 1
    height = 1
    naturalWidth = 1
    naturalHeight = 1
    complete = false
    private _src = ''

    get src(): string {
      return this._src
    }

    set src(value: string) {
      this._src = value
      // Fire onload asynchronously (next microtask) so React state updates work
      if (value) {
        this.complete = false
        Promise.resolve().then(() => {
          this.complete = true
          this.onload?.()
        })
      }
    }
  }

  // @ts-expect-error — intentionally replacing global Image
  globalThis.Image = MockImage
}

installImagePolyfill()
