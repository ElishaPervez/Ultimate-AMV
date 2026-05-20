/**
 * BackgroundCustomizer tests
 * Tests mount, apply invokes set_config, cancel callback, clear invokes clear_background_image.
 */

import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
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
    mockInvoke('set_config', () => '{}')
    mockInvoke('save_background_image', () => '/saved/bg.jpg')
    mockInvoke('clear_background_image', () => undefined)
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

  it('clicking Remove calls clear_background_image invoke', async () => {
    const user = userEvent.setup()
    renderCustomizer({ initial: stateWithImage })
    await user.click(screen.getByRole('button', { name: /Remove/i }))
    await waitFor(() => {
      const calls = mockInvokeFn.mock.calls
      expect(calls.some((c) => c[0] === 'clear_background_image')).toBe(true)
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
})
