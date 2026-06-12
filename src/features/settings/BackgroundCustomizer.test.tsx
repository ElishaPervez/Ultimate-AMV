/**
 * BackgroundCustomizer tests
 * Tests mount, apply invokes set_config, cancel callback, and Remove semantics
 * (draft-only until Apply; file GC happens at Apply time, never at Remove time).
 */

import React from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockInvoke, mockInvokeFn } from '../../../tests/setup/tauri'
import { BackgroundCustomizer } from './BackgroundCustomizer'
import type { BackgroundState } from '../../types/app'

// BackgroundCustomizer uses useFileDrop which calls getCurrentWebview
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: vi.fn(() => ({
    onDragDropEvent: vi.fn(async () => () => {}),
  })),
}))

const initialState: BackgroundState = {
  imagePath: '',
  scale: 1,
  offsetX: 50,
  offsetY: 50,
  dim: 55,
  blur: 0,
  videoPath: '',
  videoSource: '',
  videoFps: 30,
  brightText: false,
}

const stateWithImage: BackgroundState = {
  imagePath: '/path/to/bg.jpg',
  scale: 1.5,
  offsetX: 30,
  offsetY: 70,
  dim: 40,
  blur: 5,
  videoPath: '',
  videoSource: '',
  videoFps: 30,
  brightText: false,
}

function renderCustomizer(overrides: {
  initial?: BackgroundState
} = {}) {
  const onPreview = vi.fn()
  const onCommit = vi.fn()
  const onCancel = vi.fn()

  render(
    <BackgroundCustomizer
      initial={overrides.initial ?? initialState}
      onPreview={onPreview}
      onCommit={onCommit}
      onCancel={onCancel}
    />,
  )
  return { onPreview, onCommit, onCancel }
}

describe('BackgroundCustomizer', () => {
  beforeEach(() => {
    // Every render stamps the legibility-notice snooze timestamp; clear it so
    // each test starts from the "notice shows" state.
    window.localStorage.clear()
    mockInvoke('set_config', () => '{}')
    mockInvoke('save_background_image', () => '/saved/bg.jpg')
    mockInvoke('clear_background_image', () => undefined)
    mockInvoke('wallpaper_clear', () => undefined)
    mockInvoke('wallpaper_commit', () => undefined)
    mockInvoke('wallpaper_probe', () => ({ sourceFps: 30, durationSeconds: 10 }))
  })

  it('renders without crashing', () => {
    renderCustomizer()
    expect(screen.getByRole('dialog', { name: /Background customizer/i })).toBeInTheDocument()
  })

  it('shows close button', () => {
    renderCustomizer()
    expect(screen.getByRole('button', { name: /Close/i })).toBeInTheDocument()
  })

  it('clicking close calls onCancel', async () => {
    const user = userEvent.setup()
    const { onCancel } = renderCustomizer()
    await user.click(screen.getByRole('button', { name: /Close/i }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('clicking Cancel button calls onCancel', async () => {
    const user = userEvent.setup()
    const { onCancel } = renderCustomizer()
    await user.click(screen.getByRole('button', { name: /^Cancel$/i }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('shows Apply button', () => {
    renderCustomizer()
    expect(screen.getByRole('button', { name: /Apply/i })).toBeInTheDocument()
  })

  it('Apply button calls set_config multiple times and then onCommit', async () => {
    const user = userEvent.setup()
    const { onCommit } = renderCustomizer({ initial: stateWithImage })
    await user.click(screen.getByRole('button', { name: /Apply/i }))
    await waitFor(() => {
      const setCfgCalls = mockInvokeFn.mock.calls.filter((c) => c[0] === 'set_config')
      expect(setCfgCalls.length).toBeGreaterThanOrEqual(6)
      expect(onCommit).toHaveBeenCalledTimes(1)
    })
  })

  it('Apply with image path invokes set_config with background_image key', async () => {
    const user = userEvent.setup()
    renderCustomizer({ initial: stateWithImage })
    await user.click(screen.getByRole('button', { name: /Apply/i }))
    await waitFor(() => {
      const calls = mockInvokeFn.mock.calls
      const bgCall = calls.find(
        (c) => c[0] === 'set_config' && (c[1] as Record<string, unknown>)?.key === 'background_image',
      )
      expect(bgCall).toBeDefined()
    })
  })

  it('shows Remove button when image is set', () => {
    renderCustomizer({ initial: stateWithImage })
    expect(screen.getByRole('button', { name: /Remove/i })).toBeInTheDocument()
  })

  it('clicking Remove is draft-only: no destructive invoke until Apply', async () => {
    // Deleting files at Remove-click time while the persisted config still
    // referenced them is the bug that white-screened the whole app when the
    // user closed the modal without applying.
    const user = userEvent.setup()
    renderCustomizer({ initial: stateWithImage })
    await user.click(screen.getByRole('button', { name: /Remove/i }))
    expect(mockInvokeFn.mock.calls.some((c) => c[0] === 'clear_background_image')).toBe(false)
    expect(mockInvokeFn.mock.calls.some((c) => c[0] === 'set_config')).toBe(false)
  })

  it('Apply after Remove persists the empty image and then GCs the files', async () => {
    const user = userEvent.setup()
    const { onCommit } = renderCustomizer({ initial: stateWithImage })
    await user.click(screen.getByRole('button', { name: /Remove/i }))
    await user.click(screen.getByRole('button', { name: /Apply/i }))
    await waitFor(() => {
      const calls = mockInvokeFn.mock.calls
      const bgCall = calls.find(
        (c) => c[0] === 'set_config' && (c[1] as Record<string, unknown>)?.key === 'background_image',
      )
      expect(bgCall).toBeDefined()
      expect((bgCall?.[1] as Record<string, unknown>)?.value).toBe('')
      expect(calls.some((c) => c[0] === 'clear_background_image')).toBe(true)
      expect(onCommit).toHaveBeenCalledTimes(1)
    })
  })

  it('video Remove + Apply persists the removal and sweeps the wallpaper cache', async () => {
    const user = userEvent.setup()
    const stateWithVideo: BackgroundState = {
      ...initialState,
      videoPath: '/wallpapers/wp_clip.mp4',
      videoSource: '/source/clip.mp4',
    }
    const { onCommit } = renderCustomizer({ initial: stateWithVideo })
    await user.click(screen.getByRole('button', { name: /Remove/i }))
    // Remove itself must not delete anything on disk.
    expect(mockInvokeFn.mock.calls.some((c) => c[0] === 'wallpaper_clear')).toBe(false)
    // Apply must stay clickable so the removal can actually be persisted.
    const applyBtn = screen.getByRole('button', { name: /Apply/i })
    expect(applyBtn).toBeEnabled()
    await user.click(applyBtn)
    await waitFor(() => {
      const calls = mockInvokeFn.mock.calls
      const videoCall = calls.find(
        (c) => c[0] === 'set_config' && (c[1] as Record<string, unknown>)?.key === 'background_video',
      )
      expect(videoCall).toBeDefined()
      expect((videoCall?.[1] as Record<string, unknown>)?.value).toBe('')
      expect(calls.some((c) => c[0] === 'wallpaper_clear')).toBe(true)
      expect(onCommit).toHaveBeenCalledTimes(1)
    })
  })

  it('shows empty state prompt when no image path', () => {
    renderCustomizer({ initial: initialState })
    expect(screen.getByText(/Click to pick an image/i)).toBeInTheDocument()
  })

  it('zoom slider is disabled when no image', () => {
    renderCustomizer({ initial: initialState })
    const zoomSlider = screen.getByRole('slider', { name: /Zoom/i })
    expect(zoomSlider).toBeDisabled()
  })

  it('zoom slider is enabled when image is set', () => {
    renderCustomizer({ initial: stateWithImage })
    const zoomSlider = screen.getByRole('slider', { name: /Zoom/i })
    expect(zoomSlider).not.toBeDisabled()
  })

  it('locks controls until user dismisses the warning via the gated check button', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      renderCustomizer()
      // Visible, typing caret, container locked, dismiss button shows lock + 10s, disabled.
      expect(screen.getByRole('status')).toBeInTheDocument()
      expect(document.querySelector('.bg-customizer-warning-caret')).toBeTruthy()
      expect(document.querySelector('.bg-customizer.is-locked')).toBeTruthy()
      const dismissBtn = screen.getByRole('button', { name: /Dismiss available in/i })
      expect(dismissBtn).toBeDisabled()
      expect(dismissBtn.textContent).toContain('10s')

      // After 1s: countdown to 9s, still disabled.
      act(() => { vi.advanceTimersByTime(1000) })
      expect(screen.getByRole('button', { name: /Dismiss available in 9 seconds/i })).toBeDisabled()

      // After 9s more (total 10s): button becomes the "Got it" check, enabled, still locked.
      act(() => { vi.advanceTimersByTime(9000) })
      const readyBtn = screen.getByRole('button', { name: /Got it/i })
      expect(readyBtn).toBeEnabled()
      expect(document.querySelector('.bg-customizer.is-locked')).toBeTruthy()

      // Click dismisses: leaving class, still locked during fade.
      await user.click(readyBtn)
      expect(document.querySelector('.bg-customizer-warning.is-leaving')).toBeTruthy()
      expect(document.querySelector('.bg-customizer.is-locked')).toBeTruthy()

      // After 700ms fade: warning gone, lock lifted.
      act(() => { vi.advanceTimersByTime(700) })
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
      expect(document.querySelector('.bg-customizer.is-locked')).toBeFalsy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('warning persists past 10s if user has not clicked the check button', () => {
    vi.useFakeTimers()
    try {
      renderCustomizer()
      act(() => { vi.advanceTimersByTime(30_000) })
      // Still visible after 30s of inactivity - it is user-controlled now.
      expect(screen.getByRole('status')).toBeInTheDocument()
      expect(document.querySelector('.bg-customizer.is-locked')).toBeTruthy()
      expect(screen.getByRole('button', { name: /Got it/i })).toBeEnabled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stamps the snooze timestamp when the warning is shown', () => {
    renderCustomizer()
    const raw = window.localStorage.getItem('bg.legibilityNotice.lastShown')
    expect(raw).toBeTruthy()
    expect(Number(raw)).toBeGreaterThan(0)
  })

  it('skips the warning entirely when it was shown within the last 10 minutes', () => {
    window.localStorage.setItem('bg.legibilityNotice.lastShown', String(Date.now() - 60_000))
    renderCustomizer()
    // No banner, no lock - reopening to tweak must not re-pay the 10s wait.
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(document.querySelector('.bg-customizer.is-locked')).toBeFalsy()
  })

  it('shows the warning again once the snooze window has passed', () => {
    window.localStorage.setItem('bg.legibilityNotice.lastShown', String(Date.now() - 11 * 60_000))
    renderCustomizer()
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(document.querySelector('.bg-customizer.is-locked')).toBeTruthy()
  })

  it('shows the warning when the stored timestamp is garbage', () => {
    window.localStorage.setItem('bg.legibilityNotice.lastShown', 'not-a-number')
    renderCustomizer()
    expect(screen.getByRole('status')).toBeInTheDocument()
  })
})
