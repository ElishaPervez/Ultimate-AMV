/**
 * AppearanceSettings tests
 * Theme color pickers, background image picker, Discord toggle.
 */

import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppearanceSettings } from './AppearanceSettings'
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

function renderAppearance(overrides: {
  backendConfig?: AppConfig | null
  discordEnabled?: boolean
  themeColors?: { primary: string; secondary: string }
} = {}) {
  const persistConfigField = vi.fn(async () => undefined)
  const toggleDiscordPresence = vi.fn()

  render(
    <AppearanceSettings
      backendConfig={overrides.backendConfig ?? baseConfig}
      persistConfigField={persistConfigField}
      themeColors={overrides.themeColors ?? { primary: '#48d7ff', secondary: '#63e6a2' }}
      discordEnabled={overrides.discordEnabled ?? true}
      toggleDiscordPresence={toggleDiscordPresence}
    />,
  )
  return { persistConfigField, toggleDiscordPresence }
}

describe('AppearanceSettings', () => {
  it('renders without crashing', () => {
    renderAppearance()
    expect(screen.getByText('Theme colors')).toBeInTheDocument()
  })

  it('shows color picker with current primary color value', () => {
    renderAppearance({ themeColors: { primary: '#aabbcc', secondary: '#112233' } })
    const color1 = screen.getByLabelText(/Theme color 1/i)
    expect(color1).toHaveValue('#aabbcc')
  })

  it('shows color picker with current secondary color value', () => {
    renderAppearance({ themeColors: { primary: '#aabbcc', secondary: '#112233' } })
    const color2 = screen.getByLabelText(/Theme color 2/i)
    expect(color2).toHaveValue('#112233')
  })

  it('calls persistConfigField("theme_color_a", ...) when color 1 changes and blurs', async () => {
    const { persistConfigField } = renderAppearance()
    const color1 = screen.getByLabelText(/Theme color 1/i)
    fireEvent.change(color1, { target: { value: '#ff0000' } })
    fireEvent.blur(color1)
    expect(persistConfigField).toHaveBeenCalledWith('theme_color_a', '#ff0000')
  })

  it('calls persistConfigField("theme_color_b", ...) when color 2 changes and blurs', async () => {
    const { persistConfigField } = renderAppearance()
    const color2 = screen.getByLabelText(/Theme color 2/i)
    fireEvent.change(color2, { target: { value: '#00ff00' } })
    fireEvent.blur(color2)
    expect(persistConfigField).toHaveBeenCalledWith('theme_color_b', '#00ff00')
  })

  it('dispatches theme-changed CustomEvent when color 1 changes and blurs', () => {
    const events: CustomEvent[] = []
    const handler = (e: Event) => events.push(e as CustomEvent)
    window.addEventListener('theme-changed', handler)
    renderAppearance()
    const color1 = screen.getByLabelText(/Theme color 1/i)
    fireEvent.change(color1, { target: { value: '#ff0000' } })
    fireEvent.blur(color1)
    window.removeEventListener('theme-changed', handler)
    expect(events.length).toBeGreaterThan(0)
  })

  it('shows "Choose background" button when no background image set', () => {
    renderAppearance({ backendConfig: { ...baseConfig, background_image: '' } })
    expect(screen.getByRole('button', { name: /Choose background/i })).toBeInTheDocument()
  })

  it('shows "Edit background" button when background image is set', () => {
    renderAppearance({ backendConfig: { ...baseConfig, background_image: '/path/to/bg.jpg' } })
    expect(screen.getByRole('button', { name: /Edit background/i })).toBeInTheDocument()
  })

  it('clicking background button dispatches bg-customize-open event', async () => {
    const user = userEvent.setup()
    const events: Event[] = []
    window.addEventListener('bg-customize-open', (e) => events.push(e))
    renderAppearance()
    await user.click(screen.getByRole('button', { name: /Choose background/i }))
    window.removeEventListener('bg-customize-open', (e) => events.push(e))
    expect(events).toHaveLength(1)
  })

  it('Discord toggle shows Enabled when discordEnabled=true', () => {
    renderAppearance({ discordEnabled: true })
    const toggle = screen.getByRole('switch', { name: /Show status on Discord/i })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
  })

  it('Discord toggle shows Disabled when discordEnabled=false', () => {
    renderAppearance({ discordEnabled: false })
    const toggle = screen.getByRole('switch', { name: /Show status on Discord/i })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('clicking Discord toggle calls toggleDiscordPresence', async () => {
    const user = userEvent.setup()
    const { toggleDiscordPresence } = renderAppearance({ discordEnabled: true })
    await user.click(screen.getByRole('switch', { name: /Show status on Discord/i }))
    expect(toggleDiscordPresence).toHaveBeenCalledTimes(1)
  })
})
