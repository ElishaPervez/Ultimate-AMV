/**
 * FeatureSettings tests
 * Covers hover-preview toggle, CustomEvent dispatch, set_config invoke, output format select.
 */

import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockInvoke, mockInvokeFn } from '../../../tests/setup/tauri'
import { FeatureSettings } from './FeatureSettings'
import type { AppConfig } from '../../types/app'

const baseConfig: AppConfig = {
  type: 'config',
  force_cpu: false,
  setup_type: 'cpu',
  clip_extraction_mode: 'cpu',
  setup_complete: true,
  download_path: '/tmp',
  provider_url: '',
  theme: 'cyan',
  theme_color_a: '#48d7ff',
  theme_color_b: '#63e6a2',
  background_image: '',
  background_scale: 1,
  background_offset_x: 50,
  background_offset_y: 50,
  background_dim: 55,
  background_blur: 0,
  background_video: '',
  background_video_source: '',
  background_video_fps: 30,
  background_bright_text: '0',
  audio_output_format: 'wav',
  clip_hover_preview: false,
  featherweight_previews: false,
  tsukyio_api_key: '',
}

function renderFeatureSettings(overrides: {
  clipHoverPreview?: boolean
  backendConfig?: AppConfig | null
  currentMode?: 'cpu' | 'gpu'
} = {}) {
  const persistConfigField = vi.fn(async () => undefined)
  const setClipHoverPreview = vi.fn()
  const setLocalDownloadPath = vi.fn()

  const props = {
    backendConfig: overrides.backendConfig ?? baseConfig,
    persistConfigField,
    clipHoverPreview: overrides.clipHoverPreview ?? false,
    setClipHoverPreview,
    localDownloadPath: '/tmp',
    setLocalDownloadPath,
    currentMode: overrides.currentMode ?? 'cpu' as const,
  }

  const result = render(<FeatureSettings {...props} />)
  return { ...result, persistConfigField, setClipHoverPreview, setLocalDownloadPath }
}

describe('FeatureSettings', () => {
  beforeEach(() => {
    mockInvoke('set_config', () => JSON.stringify(baseConfig))
  })

  it('renders without crashing', () => {
    renderFeatureSettings()
    expect(screen.getByText('Hover-to-Play previews')).toBeInTheDocument()
  })

  it('toggle reflects initial clipHoverPreview=false', () => {
    renderFeatureSettings({ clipHoverPreview: false })
    const toggle = screen.getByRole('switch', { name: /Hover-to-Play previews/i })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText('Disabled')).toBeInTheDocument()
  })

  it('toggle reflects initial clipHoverPreview=true', () => {
    renderFeatureSettings({ clipHoverPreview: true })
    const toggle = screen.getByRole('switch', { name: /Hover-to-Play previews/i })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('Enabled')).toBeInTheDocument()
  })

  it('clicking toggle calls set_config with clip_hover_preview=true when currently false', async () => {
    const user = userEvent.setup()
    renderFeatureSettings({ clipHoverPreview: false })
    const toggle = screen.getByRole('switch', { name: /Hover-to-Play previews/i })
    await user.click(toggle)
    await waitFor(() => {
      const calls = mockInvokeFn.mock.calls
      const configCall = calls.find(
        (call) => call[0] === 'set_config' &&
          (call[1] as Record<string, unknown>)?.key === 'clip_hover_preview' &&
          (call[1] as Record<string, unknown>)?.value === 'true',
      )
      expect(configCall).toBeDefined()
    })
  })

  it('clicking toggle calls set_config with clip_hover_preview=false when currently true', async () => {
    const user = userEvent.setup()
    renderFeatureSettings({ clipHoverPreview: true })
    const toggle = screen.getByRole('switch', { name: /Hover-to-Play previews/i })
    await user.click(toggle)
    await waitFor(() => {
      const calls = mockInvokeFn.mock.calls
      const configCall = calls.find(
        (call) => call[0] === 'set_config' &&
          (call[1] as Record<string, unknown>)?.key === 'clip_hover_preview' &&
          (call[1] as Record<string, unknown>)?.value === 'false',
      )
      expect(configCall).toBeDefined()
    })
  })

  it('clicking toggle dispatches clip-hover-preview-changed CustomEvent', async () => {
    const user = userEvent.setup()
    const events: CustomEvent<{ enabled: boolean }>[] = []
    const handler = (e: Event) => events.push(e as CustomEvent<{ enabled: boolean }>)
    window.addEventListener('clip-hover-preview-changed', handler)

    renderFeatureSettings({ clipHoverPreview: false })
    const toggle = screen.getByRole('switch', { name: /Hover-to-Play previews/i })
    await user.click(toggle)

    window.removeEventListener('clip-hover-preview-changed', handler)
    expect(events).toHaveLength(1)
    expect(events[0].detail.enabled).toBe(true)
  })

  it('clicking toggle dispatches clip-hover-preview-changed with enabled=false when currently true', async () => {
    const user = userEvent.setup()
    const events: CustomEvent<{ enabled: boolean }>[] = []
    const handler = (e: Event) => events.push(e as CustomEvent<{ enabled: boolean }>)
    window.addEventListener('clip-hover-preview-changed', handler)

    renderFeatureSettings({ clipHoverPreview: true })
    const toggle = screen.getByRole('switch', { name: /Hover-to-Play previews/i })
    await user.click(toggle)

    window.removeEventListener('clip-hover-preview-changed', handler)
    expect(events).toHaveLength(1)
    expect(events[0].detail.enabled).toBe(false)
  })

  it('shows CPU badge when currentMode is cpu', () => {
    renderFeatureSettings({ currentMode: 'cpu' })
    expect(screen.getByText('CPU')).toBeInTheDocument()
  })

  it('shows GPU badge when currentMode is gpu', () => {
    renderFeatureSettings({ currentMode: 'gpu' })
    expect(screen.getByText('GPU')).toBeInTheDocument()
  })

  it('shows WAV as default selected audio output format', () => {
    renderFeatureSettings()
    const trigger = screen.getByRole('button', { name: /WAV \(high quality\)/i })
    expect(trigger).toBeInTheDocument()
  })

  it('shows MP3 when backendConfig.audio_output_format is mp3', () => {
    renderFeatureSettings({ backendConfig: { ...baseConfig, audio_output_format: 'mp3' } })
    const trigger = screen.getByRole('button', { name: /MP3 \(smaller size\)/i })
    expect(trigger).toBeInTheDocument()
  })

  it('changing audio output format calls persistConfigField with correct args', async () => {
    const user = userEvent.setup()
    const { persistConfigField } = renderFeatureSettings()
    const trigger = screen.getByRole('button', { name: /WAV \(high quality\)/i })
    await user.click(trigger)
    const mp3Option = screen.getByRole('option', { name: /MP3 \(smaller size\)/i })
    await user.click(mp3Option)
    expect(persistConfigField).toHaveBeenCalledWith('audio_output_format', 'mp3')
  })
})
