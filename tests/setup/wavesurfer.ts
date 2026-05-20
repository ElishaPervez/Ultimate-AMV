/**
 * tests/setup/wavesurfer.ts
 *
 * Mock for wavesurfer.js default export.
 *
 * WaveSurfer.create() returns a stub instance whose methods are all vi.fn().
 * Tests can inspect calls:
 *   import { mockWaveSurferInstance } from '../../tests/setup/wavesurfer'
 *   expect(mockWaveSurferInstance.play).toHaveBeenCalled()
 */

import { vi } from 'vitest'

export const mockWaveSurferInstance = {
  on: vi.fn(),
  un: vi.fn(),
  play: vi.fn(),
  pause: vi.fn(),
  stop: vi.fn(),
  destroy: vi.fn(),
  load: vi.fn(),
  setVolume: vi.fn(),
  setMuted: vi.fn(),
  setPlaybackRate: vi.fn(),
  getCurrentTime: vi.fn(() => 0),
  getDuration: vi.fn(() => 0),
  isPlaying: vi.fn(() => false),
  seekTo: vi.fn(),
  zoom: vi.fn(),
  exportPCM: vi.fn(),
  getActivePlugins: vi.fn(() => []),
}

export const mockWaveSurferCreate = vi.fn(() => mockWaveSurferInstance)

vi.mock('wavesurfer.js', () => ({
  default: {
    create: mockWaveSurferCreate,
  },
}))

export function installWaveSurferResets(): void {
  beforeEach(() => {
    // Reset call counts but keep implementations
    Object.values(mockWaveSurferInstance).forEach((fn) => {
      if (typeof fn === 'function' && 'mockClear' in fn) {
        ;(fn as ReturnType<typeof vi.fn>).mockClear()
      }
    })
    mockWaveSurferCreate.mockClear()
  })
}
