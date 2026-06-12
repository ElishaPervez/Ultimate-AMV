/**
 * CustomColorPicker tests
 * Screen eyedropper: EyeDropper API path + native overlay fallback
 * (WebView2 ships the API surface but open() rejects instantly).
 */

import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CustomColorPicker } from './CustomColorPicker'
import { mockInvoke, mockInvokeFn } from '../../../tests/setup/tauri'

function renderPicker() {
  const onChange = vi.fn()
  render(<CustomColorPicker label="Color 1" color="#48d7ff" onChange={onChange} />)
  return { onChange }
}

async function openPopover() {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: /Pick Color 1 color/i }))
  return user
}

const pickButton = () => screen.getByRole('button', { name: /Pick Color 1 from screen/i })
const queryOverlay = () => screen.queryByLabelText(/Sampling Color 1/i)

describe('CustomColorPicker eyedropper', () => {
  afterEach(() => {
    delete window.EyeDropper
  })

  it('applies the sampled color when the EyeDropper API works', async () => {
    const openMock = vi.fn(async () => ({ sRGBHex: '#AB12CD' }))
    window.EyeDropper = class {
      open = openMock
    } as unknown as typeof window.EyeDropper
    const { onChange } = renderPicker()
    const user = await openPopover()
    await user.click(pickButton())
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('#ab12cd'))
    expect(openMock).toHaveBeenCalledTimes(1)
    expect(queryOverlay()).not.toBeInTheDocument()
  })

  it('normalizes rgba() EyeDropper results to hex', async () => {
    window.EyeDropper = class {
      open = async () => ({ sRGBHex: 'rgba(255, 0, 128, 1)' })
    } as unknown as typeof window.EyeDropper
    const { onChange } = renderPicker()
    const user = await openPopover()
    await user.click(pickButton())
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('#ff0080'))
  })

  it('keeps the current color when the user cancels a working EyeDropper', async () => {
    // a human Esc takes longer than the instant-rejection threshold
    window.EyeDropper = class {
      open = () =>
        new Promise<{ sRGBHex: string }>((_, reject) => {
          setTimeout(() => reject(new DOMException('aborted', 'AbortError')), 300)
        })
    } as unknown as typeof window.EyeDropper
    const { onChange } = renderPicker()
    const user = await openPopover()
    await user.click(pickButton())
    await waitFor(() => expect(pickButton()).not.toBeDisabled(), { timeout: 2000 })
    expect(onChange).not.toHaveBeenCalled()
    expect(queryOverlay()).not.toBeInTheDocument()
  })

  it('falls back to the native overlay when EyeDropper rejects instantly (WebView2)', async () => {
    window.EyeDropper = class {
      open = () => Promise.reject(new DOMException('The user canceled the selection.', 'AbortError'))
    } as unknown as typeof window.EyeDropper
    mockInvoke('sample_screen_color', () => '#123456')
    const { onChange } = renderPicker()
    const user = await openPopover()
    await user.click(pickButton())
    await waitFor(() => expect(queryOverlay()).toBeInTheDocument())

    fireEvent.pointerMove(queryOverlay()!, { clientX: 100, clientY: 120 })
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('#123456'))
    expect(mockInvokeFn).toHaveBeenCalledWith('sample_screen_color')
  })

  it('uses the overlay directly when the EyeDropper API is missing, and click confirms', async () => {
    mockInvoke('sample_screen_color', () => '#a1b2c3')
    const { onChange } = renderPicker()
    const user = await openPopover()
    await user.click(pickButton())
    await waitFor(() => expect(queryOverlay()).toBeInTheDocument())

    fireEvent.click(queryOverlay()!)
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('#a1b2c3'))
    await waitFor(() => expect(queryOverlay()).not.toBeInTheDocument())
  })

  it('Esc cancels overlay sampling and restores the previous color', async () => {
    mockInvoke('sample_screen_color', () => '#222222')
    const { onChange } = renderPicker()
    const user = await openPopover()
    await user.click(pickButton())
    await waitFor(() => expect(queryOverlay()).toBeInTheDocument())

    fireEvent.pointerMove(queryOverlay()!, { clientX: 50, clientY: 60 })
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('#222222'))

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onChange).toHaveBeenLastCalledWith('#48d7ff')
    expect(queryOverlay()).not.toBeInTheDocument()
  })
})
