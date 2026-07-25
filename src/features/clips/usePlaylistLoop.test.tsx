import React from 'react'
import { act, renderHook } from '@testing-library/react'

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
  Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
    configurable: true,
    get() {
      return (this as { __playlistCt?: number }).__playlistCt ?? 0
    },
    set(v: number) {
      ;(this as { __playlistCt?: number }).__playlistCt = v
    },
  })
  Object.defineProperty(HTMLMediaElement.prototype, 'readyState', {
    configurable: true,
    get() {
      return 0
    },
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.resetModules()
})

function makeVideo() {
  const video = document.createElement('video')
  const ref = { current: video } as React.RefObject<HTMLVideoElement | null>
  return { video, ref }
}

describe('usePlaylistLoop — playback speed', () => {
  it('applies the requested speed when metadata loads', async () => {
    const { usePlaylistLoop } = await import('./usePlaylistLoop')
    const { video, ref } = makeVideo()

    renderHook(() =>
      usePlaylistLoop(ref, {
        segments: [{ previewStart: 1, previewEnd: 2 }],
        active: true,
        forceFallback: true,
        rate: 2,
      }),
    )

    act(() => {
      video.dispatchEvent(new Event('loadedmetadata'))
    })

    expect(video.playbackRate).toBe(2)
  })

  it('changes speed in place without restarting the playlist', async () => {
    const { usePlaylistLoop } = await import('./usePlaylistLoop')
    const { video, ref } = makeVideo()
    const segments = [{ previewStart: 1, previewEnd: 3 }]

    const { rerender } = renderHook(
      ({ rate }) =>
        usePlaylistLoop(ref, {
          segments,
          active: true,
          forceFallback: true,
          rate,
        }),
      { initialProps: { rate: 1 } },
    )

    act(() => {
      video.dispatchEvent(new Event('loadedmetadata'))
      video.dispatchEvent(new Event('seeked'))
    })
    video.currentTime = 2.25

    act(() => {
      rerender({ rate: 1.5 })
    })

    expect(video.playbackRate).toBe(1.5)
    expect(video.currentTime).toBe(2.25)
  })

  it('scales the fallback timer by playback speed', async () => {
    vi.useFakeTimers()
    const timeoutSpy = vi.spyOn(window, 'setTimeout')
    const { usePlaylistLoop } = await import('./usePlaylistLoop')
    const { video, ref } = makeVideo()

    renderHook(() =>
      usePlaylistLoop(ref, {
        segments: [{ previewStart: 1, previewEnd: 2 }],
        active: true,
        forceFallback: true,
        rate: 0.5,
      }),
    )

    act(() => {
      video.dispatchEvent(new Event('loadedmetadata'))
      video.dispatchEvent(new Event('seeked'))
    })
    video.currentTime = 1.6
    act(() => {
      video.dispatchEvent(new Event('timeupdate'))
    })

    expect(
      timeoutSpy.mock.calls.some(
        ([, delay]) => typeof delay === 'number' && Math.abs(delay - 800) < 0.01,
      ),
    ).toBe(true)
  })
})
