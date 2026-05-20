/**
 * DirectStreamPlayer tests
 *
 * Covers:
 * - Renders a <video> element.
 * - Sets video src for non-HLS sources.
 * - Shows error message on video error event.
 * - Renders without error for HLS src (hls.js is not in jsdom — just checks mount).
 * - Re-initialises when src prop changes.
 */

import React from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { DirectStreamPlayer } from './DirectStreamPlayer'

// hls.js is a dynamic import — mock it so jsdom doesn't fail the test.
vi.mock('hls.js', () => ({
  default: {
    isSupported: () => false,
    Events: { ERROR: 'hlsError' },
  },
}))

// jsdom does not implement HTMLMediaElement methods — stub them to avoid
// "Not implemented" console noise. These stubs are inert; tests exercise
// the component's React layer, not actual media playback.
beforeAll(() => {
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  })
  Object.defineProperty(HTMLMediaElement.prototype, 'load', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  })
  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    configurable: true,
    writable: true,
    value: vi.fn(() => Promise.resolve()),
  })
})

describe('DirectStreamPlayer', () => {
  it('renders a video element', () => {
    render(<DirectStreamPlayer src="/stream/ep01.mp4" />)
    expect(document.querySelector('video')).toBeInTheDocument()
  })

  it('wraps in direct-stream-player div', () => {
    const { container } = render(<DirectStreamPlayer src="/stream/ep01.mp4" />)
    expect(container.querySelector('.direct-stream-player')).toBeInTheDocument()
  })

  it('does not show error overlay initially', () => {
    const { container } = render(<DirectStreamPlayer src="/stream/ep01.mp4" />)
    expect(container.querySelector('.direct-stream-error')).not.toBeInTheDocument()
  })

  it('shows error overlay when video fires error event', async () => {
    const { container } = render(<DirectStreamPlayer src="/stream/ep01.mp4" />)
    const video = container.querySelector('video') as HTMLVideoElement
    fireEvent.error(video)
    await waitFor(() =>
      expect(container.querySelector('.direct-stream-error')).toBeInTheDocument()
    )
    expect(screen.getByText(/could not be played/i)).toBeInTheDocument()
  })

  it('clears error when src changes', async () => {
    const { container, rerender } = render(<DirectStreamPlayer src="/stream/ep01.mp4" />)
    const video = container.querySelector('video') as HTMLVideoElement
    fireEvent.error(video)
    await waitFor(() =>
      expect(container.querySelector('.direct-stream-error')).toBeInTheDocument()
    )
    // Change src — error should be cleared
    rerender(<DirectStreamPlayer src="/stream/ep02.mp4" />)
    await waitFor(() =>
      expect(container.querySelector('.direct-stream-error')).not.toBeInTheDocument()
    )
  })

  it('mounts without crash for HLS src (hls.js mocked)', () => {
    expect(() =>
      render(<DirectStreamPlayer src="/stream/playlist.m3u8" />)
    ).not.toThrow()
  })

  it('video element has controls attribute', () => {
    const { container } = render(<DirectStreamPlayer src="/stream/ep01.mp4" />)
    const video = container.querySelector('video') as HTMLVideoElement
    expect(video).toHaveAttribute('controls')
  })

  it('video element has autoPlay attribute', () => {
    const { container } = render(<DirectStreamPlayer src="/stream/ep01.mp4" />)
    const video = container.querySelector('video') as HTMLVideoElement
    // jsdom represents autoplay as the attribute name 'autoplay' (lowercase)
    expect(video.autoplay).toBe(true)
  })
})
