/**
 * useOffsetLoop tests
 *
 * jsdom implements neither HTMLMediaElement playback methods nor
 * requestVideoFrameCallback, so we stub them per-test and drive the hook with
 * renderHook. The hook is imported FRESH in each test (vi.resetModules) because
 * its RVFC_SUPPORTED flag is captured at module-eval time off
 * HTMLVideoElement.prototype.
 *
 * Covers:
 * - rVFC path: seeks currentTime -> startSec on the active edge, and snaps back
 *   when a frame's mediaTime crosses endSec.
 * - rVFC-absent fallback: with rVFC removed from the prototype the hook attaches
 *   a `timeupdate` listener and snaps back via that path.
 * - Teardown: unmount cancels the rVFC handle, pauses, and removes listeners.
 */

import React from 'react'
import { renderHook, act } from '@testing-library/react'

// --- media-element stubs (jsdom has none) ----------------------------------
beforeAll(() => {
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  })
  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    configurable: true,
    writable: true,
    value: vi.fn(() => Promise.resolve()),
  })
  // currentTime is a getter/setter we want to observe; back it with a field.
  Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
    configurable: true,
    get() {
      return (this as { __ct?: number }).__ct ?? 0
    },
    set(v: number) {
      ;(this as { __ct?: number }).__ct = v
    },
  })
  // readyState defaults to 0 (nothing loaded) so loadedmetadata drives the kick.
  Object.defineProperty(HTMLMediaElement.prototype, 'readyState', {
    configurable: true,
    get() {
      return (this as { __rs?: number }).__rs ?? 0
    },
    set(v: number) {
      ;(this as { __rs?: number }).__rs = v
    },
  })
})

/**
 * Build a real <video> element plus a ref to it, and capture the rVFC callback
 * the hook registers (when rVFC is present).
 */
function makeVideo() {
  const video = document.createElement('video') as HTMLVideoElement
  const ref = { current: video } as React.RefObject<HTMLVideoElement | null>
  return { video, ref }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
  // Wipe any rVFC stub a test installed so the next test starts clean.
  delete (HTMLVideoElement.prototype as unknown as Record<string, unknown>).requestVideoFrameCallback
  delete (HTMLVideoElement.prototype as unknown as Record<string, unknown>).cancelVideoFrameCallback
})

describe('useOffsetLoop — rVFC path', () => {
  it('seeks currentTime to startSec on the active edge and snaps back at endSec', async () => {
    // Install an rVFC stub that records the latest frame callback so the test
    // can drive frames synchronously.
    let frameCb: VideoFrameRequestCallback | null = null
    const cancel = vi.fn()
    Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
      configurable: true,
      writable: true,
      value(this: HTMLVideoElement, cb: VideoFrameRequestCallback) {
        frameCb = cb
        return 1
      },
    })
    Object.defineProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback', {
      configurable: true,
      writable: true,
      value: cancel,
    })

    const { useOffsetLoop } = await import('./useOffsetLoop')
    const { video, ref } = makeVideo()

    const { unmount } = renderHook(() =>
      useOffsetLoop(ref, { startSec: 1.5, endSec: 3.0, active: true }),
    )

    // Metadata becomes available -> loadedmetadata kicks the initial seek + play.
    act(() => {
      video.dispatchEvent(new Event('loadedmetadata'))
    })
    expect(video.currentTime).toBe(1.5)
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled()

    // The hook registered an rVFC callback.
    expect(frameCb).toBeTypeOf('function')

    // A frame BEFORE endSec: no snap-back.
    video.currentTime = 2.0
    act(() => {
      frameCb!(performance.now(), { mediaTime: 2.0, presentedFrames: 1 } as VideoFrameCallbackMetadata)
    })
    expect(video.currentTime).toBe(2.0)

    // A frame AT/PAST endSec: snaps currentTime back to startSec.
    act(() => {
      frameCb!(performance.now(), { mediaTime: 3.01, presentedFrames: 2 } as VideoFrameCallbackMetadata)
    })
    expect(video.currentTime).toBe(1.5)

    // Unmount now, while the rVFC stubs are still installed, so the effect
    // cleanup's cancelVideoFrameCallback resolves (afterEach deletes the stubs).
    act(() => {
      unmount()
    })
    expect(cancel).toHaveBeenCalledWith(1)
  })
})

describe('useOffsetLoop — rVFC-absent fallback', () => {
  it('attaches a timeupdate listener and snaps back via the fallback path', async () => {
    // Ensure rVFC is absent for this module evaluation so the hook picks the
    // timeupdate fallback (RVFC_SUPPORTED is read at import time).
    delete (HTMLVideoElement.prototype as unknown as Record<string, unknown>).requestVideoFrameCallback

    const { useOffsetLoop } = await import('./useOffsetLoop')
    const { video, ref } = makeVideo()

    const addSpy = vi.spyOn(video, 'addEventListener')

    renderHook(() => useOffsetLoop(ref, { startSec: 1.0, endSec: 2.0, active: true }))

    // Fallback path must subscribe to timeupdate (and NOT use rVFC).
    expect(addSpy.mock.calls.some(([type]) => type === 'timeupdate')).toBe(true)

    // Kick metadata so the initial seek lands.
    act(() => {
      video.dispatchEvent(new Event('loadedmetadata'))
    })
    expect(video.currentTime).toBe(1.0)

    // timeupdate past endSec snaps back to startSec.
    video.currentTime = 2.05
    act(() => {
      video.dispatchEvent(new Event('timeupdate'))
    })
    expect(video.currentTime).toBe(1.0)
  })

  it('does not loop while inactive', async () => {
    delete (HTMLVideoElement.prototype as unknown as Record<string, unknown>).requestVideoFrameCallback
    const { useOffsetLoop } = await import('./useOffsetLoop')
    const { video, ref } = makeVideo()
    const addSpy = vi.spyOn(video, 'addEventListener')

    renderHook(() => useOffsetLoop(ref, { startSec: 1.0, endSec: 2.0, active: false }))

    // Inactive: no listeners attached, no seek on loadedmetadata.
    expect(addSpy.mock.calls.some(([type]) => type === 'timeupdate')).toBe(false)
    act(() => {
      video.dispatchEvent(new Event('loadedmetadata'))
    })
    expect(video.currentTime).toBe(0)
  })
})

describe('useOffsetLoop — teardown', () => {
  it('cancels the rVFC handle, pauses, and removes listeners on unmount', async () => {
    const cancel = vi.fn()
    Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
      configurable: true,
      writable: true,
      value() {
        return 7
      },
    })
    Object.defineProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback', {
      configurable: true,
      writable: true,
      value: cancel,
    })

    const { useOffsetLoop } = await import('./useOffsetLoop')
    const { video, ref } = makeVideo()

    const removeSpy = vi.spyOn(video, 'removeEventListener')
    ;(HTMLMediaElement.prototype.pause as ReturnType<typeof vi.fn>).mockClear()

    const { unmount } = renderHook(() =>
      useOffsetLoop(ref, { startSec: 1.0, endSec: 2.0, active: true }),
    )

    act(() => {
      unmount()
    })

    expect(cancel).toHaveBeenCalledWith(7)
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled()
    expect(removeSpy.mock.calls.some(([type]) => type === 'loadedmetadata')).toBe(true)
  })

  it('tears down and re-arms when params change (no stale loop)', async () => {
    let frameCb: VideoFrameRequestCallback | null = null
    const cancel = vi.fn()
    Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
      configurable: true,
      writable: true,
      value(this: HTMLVideoElement, cb: VideoFrameRequestCallback) {
        frameCb = cb
        return 1
      },
    })
    Object.defineProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback', {
      configurable: true,
      writable: true,
      value: cancel,
    })

    const { useOffsetLoop } = await import('./useOffsetLoop')
    const { video, ref } = makeVideo()

    const { rerender, unmount } = renderHook(
      ({ startSec, endSec }) => useOffsetLoop(ref, { startSec, endSec, active: true }),
      { initialProps: { startSec: 1.0, endSec: 2.0 } },
    )
    expect(frameCb).toBeTypeOf('function')

    // Change the window — the previous effect must tear down (cancel) and re-arm
    // against the new endSec.
    act(() => {
      rerender({ startSec: 5.0, endSec: 8.0 })
    })
    expect(cancel).toHaveBeenCalled()

    // The re-armed loop snaps to the NEW startSec at the NEW endSec.
    video.currentTime = 8.5
    act(() => {
      frameCb!(performance.now(), { mediaTime: 8.5, presentedFrames: 10 } as VideoFrameCallbackMetadata)
    })
    expect(video.currentTime).toBe(5.0)

    // Unmount while the rVFC stubs are still installed (afterEach deletes them).
    act(() => {
      unmount()
    })
  })
})
