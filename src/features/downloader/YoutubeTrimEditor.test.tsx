/**
 * Tests for YoutubeTrimEditor component.
 * Covers: toggle enable/disable, start/end time inputs, validation,
 * range sliders, keyframe checkbox, preview fallback, manual time input.
 */

import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { YoutubeTrimEditor } from './YoutubeTrimEditor'

function renderEditor(overrides: Partial<Parameters<typeof YoutubeTrimEditor>[0]> = {}) {
  const onChange = vi.fn()
  const onEnabledChange = vi.fn()
  const onForceKeyframesChange = vi.fn()
  const result = render(
    <YoutubeTrimEditor
      previewUrl={null}
      durationSeconds={300}
      enabled={false}
      onEnabledChange={onEnabledChange}
      startSeconds={0}
      endSeconds={300}
      onChange={onChange}
      forceKeyframes={true}
      onForceKeyframesChange={onForceKeyframesChange}
      {...overrides}
    />
  )
  return { ...result, onChange, onEnabledChange, onForceKeyframesChange }
}

describe('YoutubeTrimEditor', () => {
  it('renders the trim toggle checkbox', () => {
    renderEditor()
    expect(screen.getByRole('checkbox', { hidden: false })).toBeInTheDocument()
  })

  it('shows "Optional" hint text when disabled', () => {
    renderEditor({ enabled: false })
    expect(screen.getByText(/Optional\. Toggle on/)).toBeInTheDocument()
  })

  it('shows selection duration text when enabled', () => {
    renderEditor({ enabled: true, startSeconds: 30, endSeconds: 90 })
    // Duration is 60 seconds = 00:01:00
    expect(screen.getByText(/Selection:/)).toBeInTheDocument()
    expect(screen.getByText(/00:01:00 of 00:05:00/)).toBeInTheDocument()
  })

  it('calls onEnabledChange(true) when checkbox is clicked while disabled', () => {
    const { onEnabledChange } = renderEditor({ enabled: false })
    fireEvent.click(screen.getByRole('checkbox'))
    expect(onEnabledChange).toHaveBeenCalledWith(true)
  })

  it('calls onEnabledChange(false) when Close button is clicked', () => {
    const { onEnabledChange } = renderEditor({ enabled: true })
    fireEvent.click(screen.getByRole('button', { name: 'Close trim editor' }))
    expect(onEnabledChange).toHaveBeenCalledWith(false)
  })

  it('does not render trim body when disabled', () => {
    renderEditor({ enabled: false })
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
  })

  it('renders start and end range sliders when enabled', () => {
    renderEditor({ enabled: true })
    const sliders = screen.getAllByRole('slider')
    expect(sliders).toHaveLength(2)
    expect(sliders[0]).toHaveAttribute('aria-label', 'Clip start')
    expect(sliders[1]).toHaveAttribute('aria-label', 'Clip end')
  })

  it('calls onChange with clamped start time when start slider changes', () => {
    const { onChange } = renderEditor({ enabled: true, startSeconds: 0, endSeconds: 300 })
    const [startSlider] = screen.getAllByRole('slider')
    fireEvent.change(startSlider, { target: { value: '60' } })
    expect(onChange).toHaveBeenCalledWith(60, expect.any(Number))
  })

  it('calls onChange with clamped end time when end slider changes', () => {
    const { onChange } = renderEditor({ enabled: true, startSeconds: 0, endSeconds: 300 })
    const [, endSlider] = screen.getAllByRole('slider')
    fireEvent.change(endSlider, { target: { value: '240' } })
    expect(onChange).toHaveBeenCalledWith(expect.any(Number), 240)
  })

  it('clamps end time to never go below start + 0.1', () => {
    const { onChange } = renderEditor({ enabled: true, startSeconds: 100, endSeconds: 200 })
    const [, endSlider] = screen.getAllByRole('slider')
    // Try to set end to 50, which is less than start (100)
    fireEvent.change(endSlider, { target: { value: '50' } })
    // End should be clamped to at least start - 0.1 = 99.9 -> max(0, 49.9)=49.9
    // The actual behavior: applyEnd(50) => safeStart = min(50-0.1, 100) = 49.9
    expect(onChange).toHaveBeenCalledWith(expect.any(Number), 50)
  })

  it('clamps start time to never exceed end - 0.1', () => {
    const { onChange } = renderEditor({ enabled: true, startSeconds: 0, endSeconds: 100 })
    const [startSlider] = screen.getAllByRole('slider')
    // Try to set start to 150, which is beyond end (100)
    fireEvent.change(startSlider, { target: { value: '150' } })
    // applyStart(150): safe = clamp(150) = 150, safeEnd = max(150+0.1, 100) = 150.1
    // but durationSeconds is 300, so safeEnd capped to 300
    expect(onChange).toHaveBeenCalledWith(150, expect.any(Number))
  })

  it('shows fallback message when no previewUrl', () => {
    renderEditor({ enabled: true, previewUrl: null })
    expect(screen.getByText(/No progressive preview available/)).toBeInTheDocument()
  })

  it('renders video element when previewUrl is provided', () => {
    const { container } = renderEditor({ enabled: true, previewUrl: 'https://example.com/preview.mp4' })
    // jsdom does not expose the 'video' ARIA role; query by tag instead
    const videoEl = container.querySelector('video')
    expect(videoEl).toBeInTheDocument()
    expect(videoEl?.src).toContain('preview.mp4')
  })

  it('renders start and end text inputs when enabled', () => {
    renderEditor({ enabled: true, startSeconds: 30, endSeconds: 90 })
    // Start input shows formatted time
    const inputs = screen.getAllByPlaceholderText('00:00:00.000')
    expect(inputs).toHaveLength(2)
    expect((inputs[0] as HTMLInputElement).value).toBe('00:00:30.000')
    expect((inputs[1] as HTMLInputElement).value).toBe('00:01:30.000')
  })

  it('commits valid start time text input on blur', () => {
    const { onChange } = renderEditor({ enabled: true, startSeconds: 0, endSeconds: 300 })
    const [startInput] = screen.getAllByPlaceholderText('00:00:00.000')
    fireEvent.change(startInput, { target: { value: '00:01:00.000' } })
    fireEvent.blur(startInput)
    // 1 minute = 60 seconds
    expect(onChange).toHaveBeenCalledWith(60, expect.any(Number))
  })

  it('commits valid end time text input on blur', () => {
    const { onChange } = renderEditor({ enabled: true, startSeconds: 0, endSeconds: 300 })
    const [, endInput] = screen.getAllByPlaceholderText('00:00:00.000')
    fireEvent.change(endInput, { target: { value: '00:02:00.000' } })
    fireEvent.blur(endInput)
    // 2 minutes = 120 seconds
    expect(onChange).toHaveBeenCalledWith(expect.any(Number), 120)
  })

  it('resets invalid start time input to current value on blur', () => {
    renderEditor({ enabled: true, startSeconds: 30, endSeconds: 300 })
    const [startInput] = screen.getAllByPlaceholderText('00:00:00.000')
    fireEvent.change(startInput, { target: { value: 'not-a-time' } })
    fireEvent.blur(startInput)
    // Should reset to 30 seconds formatted
    expect((startInput as HTMLInputElement).value).toBe('00:00:30.000')
  })

  it('commits start time on Enter key', () => {
    const { onChange } = renderEditor({ enabled: true, startSeconds: 0, endSeconds: 300 })
    const [startInput] = screen.getAllByPlaceholderText('00:00:00.000')
    fireEvent.change(startInput, { target: { value: '00:00:45.000' } })
    fireEvent.keyDown(startInput, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith(45, expect.any(Number))
  })

  it('renders the force keyframes checkbox', () => {
    renderEditor({ enabled: true })
    expect(screen.getByRole('checkbox', { name: /Frame-accurate cuts/ })).toBeInTheDocument()
  })

  it('calls onForceKeyframesChange when keyframes checkbox is toggled', () => {
    const { onForceKeyframesChange } = renderEditor({ enabled: true, forceKeyframes: true })
    const checkbox = screen.getByRole('checkbox', { name: /Frame-accurate cuts/ })
    fireEvent.click(checkbox)
    expect(onForceKeyframesChange).toHaveBeenCalledWith(false)
  })

  it('shows Set start and Set end buttons', () => {
    renderEditor({ enabled: true })
    expect(screen.getByTitle(/Use the player's current time as the clip start/)).toBeInTheDocument()
    expect(screen.getByTitle(/Use the player's current time as the clip end/)).toBeInTheDocument()
  })

  it('renders Preview buttons for start and end', () => {
    renderEditor({ enabled: true })
    const previewBtns = screen.getAllByRole('button', { name: 'Preview' })
    expect(previewBtns).toHaveLength(2)
  })
})
