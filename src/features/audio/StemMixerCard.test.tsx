/**
 * src/features/audio/StemMixerCard.test.tsx
 *
 * Tests for StemMixerCard — fallback when stems missing, full mixer when
 * both [Vocals] and [Instrumental] stems are present.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StemMixerCard } from './StemMixerCard'
import { mockInvoke } from '../../../tests/setup/tauri'
import { mockWaveSurferInstance } from '../../../tests/setup/wavesurfer'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VOCALS_PATH = '/out/track_(Vocals).wav'
const INSTRUMENTAL_PATH = '/out/track_(Instrumental).wav'
// Lowercase aliases used by classifyStems
const VOCALS_LOWER = '/out/track_[vocals].wav'
const INSTRUMENTAL_LOWER = '/out/track_[instrumental].wav'

function renderMixer(outputs: string[], onAgain = vi.fn()) {
  return render(
    <StemMixerCard
      outputs={outputs}
      fileLabel="my-track.mp3"
      outputDir="/out"
      onAgain={onAgain}
    />,
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StemMixerCard — fallback (stems missing)', () => {
  beforeEach(() => {
    mockInvoke('open_path', () => null)
  })

  it('renders fallback when outputs array is empty', () => {
    renderMixer([])
    expect(screen.getByText(/stems are saved but preview is unavailable/i)).toBeInTheDocument()
  })

  it('renders fallback when only vocals stem is present (no instrumental)', () => {
    renderMixer([VOCALS_LOWER])
    expect(screen.getByText(/stems are saved but preview is unavailable/i)).toBeInTheDocument()
  })

  it('renders fallback when only instrumental stem is present (no vocals)', () => {
    renderMixer([INSTRUMENTAL_LOWER])
    expect(screen.getByText(/stems are saved but preview is unavailable/i)).toBeInTheDocument()
  })

  it('does NOT crash when outputs array is empty', () => {
    expect(() => renderMixer([])).not.toThrow()
  })

  it('does NOT render the stem mixer waveform UI in fallback mode', () => {
    renderMixer([])
    expect(screen.queryByRole('region', { name: /stem mixer/i })).not.toBeInTheDocument()
  })

  it('renders "Open folder" button in fallback mode when outputDir is provided', () => {
    renderMixer([])
    expect(screen.getByRole('button', { name: /open folder/i })).toBeInTheDocument()
  })

  it('renders "Extract another file" button in fallback mode', () => {
    renderMixer([])
    expect(screen.getByRole('button', { name: /extract another file/i })).toBeInTheDocument()
  })

  it('calls onAgain when "Extract another file" is clicked in fallback mode', async () => {
    const onAgain = vi.fn()
    renderMixer([], onAgain)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /extract another file/i }))
    expect(onAgain).toHaveBeenCalledOnce()
  })
})

describe('StemMixerCard — full mixer (both stems present)', () => {
  beforeEach(() => {
    mockInvoke('open_path', () => null)
    // WaveSurfer.create() is already mocked; configure on() to do nothing by default
    mockWaveSurferInstance.on.mockReturnValue(undefined)
    mockWaveSurferInstance.getDuration.mockReturnValue(180)
  })

  it('renders the stem mixer region when both [vocals] and [instrumental] are present', () => {
    renderMixer([VOCALS_LOWER, INSTRUMENTAL_LOWER])
    expect(screen.getByRole('region', { name: /stem mixer/i })).toBeInTheDocument()
  })

  it('does NOT render fallback message when both stems are present', () => {
    renderMixer([VOCALS_LOWER, INSTRUMENTAL_LOWER])
    expect(screen.queryByText(/stems are saved but preview is unavailable/i)).not.toBeInTheDocument()
  })

  it('renders the file label in the mixer footer', () => {
    renderMixer([VOCALS_LOWER, INSTRUMENTAL_LOWER])
    expect(screen.getByText('my-track.mp3')).toBeInTheDocument()
  })

  it('renders Play button (initially not playing)', () => {
    renderMixer([VOCALS_LOWER, INSTRUMENTAL_LOWER])
    // The button is disabled until ready, but it should exist
    expect(screen.getByRole('button', { name: /play/i })).toBeInTheDocument()
  })

  it('renders Vocal and Music volume sliders', () => {
    renderMixer([VOCALS_LOWER, INSTRUMENTAL_LOWER])
    expect(screen.getByRole('slider', { name: /vocal volume/i })).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: /music volume/i })).toBeInTheDocument()
  })

  it('volume sliders are disabled when not ready', () => {
    // WaveSurfer is mocked — ready event is never fired automatically
    renderMixer([VOCALS_LOWER, INSTRUMENTAL_LOWER])
    expect(screen.getByRole('slider', { name: /vocal volume/i })).toBeDisabled()
    expect(screen.getByRole('slider', { name: /music volume/i })).toBeDisabled()
  })
})
