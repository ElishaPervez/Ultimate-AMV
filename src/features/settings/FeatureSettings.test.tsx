/**
 * FeatureSettings tests
 * Covers hover-preview toggle, CustomEvent dispatch, set_config invoke, output format select.
 */

import React from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
  scene_preview_height: 240,
  clip_preview_speed: 1,
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
    // Non-account tests leave the initial account check pending.
    mockInvoke('tsukyio_get_auth_state', () => new Promise(() => {}))
    mockInvoke('frontend_log', async () => {})
  })

  it('keeps Disconnect available when the profile could not be loaded', async () => {
    mockInvoke('tsukyio_get_auth_state', async () => ({ isAuthenticated: true, user: null }))
    mockInvoke('tsukyio_disconnect', async () => { throw 'Could not remove saved account.' })
    renderFeatureSettings()
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not remove saved account.')
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument()
  })

  it('shows a sign-in failure in Settings', async () => {
    mockInvoke('tsukyio_get_auth_state', async () => ({ isAuthenticated: false }))
    mockInvoke('tsukyio_start_device_auth', async () => { throw 'Tsukyio is unavailable.' })
    mockInvoke('tsukyio_cancel_device_auth', async () => {})
    renderFeatureSettings()
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: 'Connect Tsukyio' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Tsukyio is unavailable.')
    expect(screen.getByRole('button', { name: 'Connect Tsukyio' })).toBeEnabled()
  })

  it('renders without crashing', () => {
    renderFeatureSettings()
    expect(screen.getByText('Hover-to-Play previews')).toBeInTheDocument()
  })

  it('toggle reflects initial clipHoverPreview=false', () => {
    renderFeatureSettings({ clipHoverPreview: false })
    const toggle = screen.getByRole('switch', { name: /Hover-to-Play previews/i })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    // Scope to this toggle's row — the page now has a second toggle
    // (Lightweight scene previews) that also renders Enabled/Disabled.
    expect(within(toggle.closest('.settings-toggle-wrap')!).getByText('Disabled')).toBeInTheDocument()
  })

  it('toggle reflects initial clipHoverPreview=true', () => {
    renderFeatureSettings({ clipHoverPreview: true })
    const toggle = screen.getByRole('switch', { name: /Hover-to-Play previews/i })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(within(toggle.closest('.settings-toggle-wrap')!).getByText('Enabled')).toBeInTheDocument()
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

  it('shows 240p as the default selected preview quality', () => {
    renderFeatureSettings()
    const trigger = screen.getByRole('button', { name: /240p/i })
    expect(trigger).toBeInTheDocument()
  })

  it('shows 720p when backendConfig.scene_preview_height is 720', () => {
    renderFeatureSettings({ backendConfig: { ...baseConfig, scene_preview_height: 720 } })
    const trigger = screen.getByRole('button', { name: /720p/i })
    expect(trigger).toBeInTheDocument()
  })

  it('changing preview quality calls persistConfigField with the stringified height', async () => {
    const user = userEvent.setup()
    const { persistConfigField } = renderFeatureSettings()
    const trigger = screen.getByRole('button', { name: /240p/i })
    await user.click(trigger)
    const option = screen.getByRole('option', { name: /720p/i })
    await user.click(option)
    expect(persistConfigField).toHaveBeenCalledWith('scene_preview_height', '720')
  })

  it('changing grid preview speed persists the new multiplier', () => {
    const { persistConfigField } = renderFeatureSettings({
      backendConfig: { ...baseConfig, featherweight_previews: true },
    })
    const speedSlider = screen
      .getAllByLabelText('Grid preview speed')
      .find((element) => element.getAttribute('type') === 'range')

    fireEvent.change(speedSlider!, { target: { value: '2' } })

    expect(persistConfigField).toHaveBeenCalledWith('clip_preview_speed', '2')
  })

  it('disables grid preview speed when lightweight previews are off', () => {
    renderFeatureSettings({
      backendConfig: { ...baseConfig, featherweight_previews: false },
    })

    for (const control of screen.getAllByLabelText('Grid preview speed')) {
      expect(control).toBeDisabled()
    }
    expect(screen.getAllByText('Grid preview speed')[0].closest('.setting-row')).toHaveAttribute(
      'title',
      'Preview speed needs the featherweight preview engine. Turn it on in Settings.',
    )
  })

  it('updates grid preview speed when the clip grid changes it', () => {
    renderFeatureSettings({
      backendConfig: { ...baseConfig, featherweight_previews: true },
    })

    act(() => {
      window.dispatchEvent(
        new CustomEvent('clip-preview-speed-changed', { detail: { speed: 1.75 } }),
      )
    })

    const speedNumber = screen
      .getAllByLabelText('Grid preview speed')
      .find((element) => element.getAttribute('type') === 'number')
    expect(speedNumber).toHaveValue(1.75)
  })
})
