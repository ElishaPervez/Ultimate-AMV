/**
 * ClipCompatConvertModal tests
 *
 * Covers:
 * - Renders null when open=false.
 * - Shows the file name from failedPath.
 * - Convert button calls onConvert; Cancel button calls onCancel.
 * - Escape closes via onCancel (when not converting).
 * - Escape does nothing while isConverting=true.
 * - Shows converting spinner/message when isConverting=true.
 * - Shows technical details on toggle.
 * - Convert button disabled when failedPath is null.
 * - Cancel button disabled when isConverting=true.
 */

import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ClipCompatConvertModal } from './ClipCompatConvertModal'

// ─── helpers ─────────────────────────────────────────────────────────────────

const defaultProps = {
  open: true,
  failedPath: '/videos/episode01.ts',
  rawError: 'Codec "mpeg4" isn\'t supported.',
  isConverting: false,
  convertMessage: null,
  onConvert: vi.fn(),
  onCancel: vi.fn(),
}

// ─── closed state ─────────────────────────────────────────────────────────────

describe('ClipCompatConvertModal — closed state', () => {
  it('renders nothing when open=false', () => {
    const { container } = render(
      <ClipCompatConvertModal {...defaultProps} open={false} />
    )
    expect(container.firstChild).toBeNull()
  })
})

// ─── open state ──────────────────────────────────────────────────────────────

describe('ClipCompatConvertModal — open state', () => {
  it('renders dialog with aria-label', () => {
    render(<ClipCompatConvertModal {...defaultProps} />)
    expect(screen.getByRole('dialog', { name: /unsupported format/i })).toBeInTheDocument()
  })

  it('shows the filename extracted from failedPath', () => {
    render(
      <ClipCompatConvertModal {...defaultProps} failedPath="/videos/episode01.ts" />
    )
    expect(screen.getByText(/episode01\.ts/)).toBeInTheDocument()
  })

  it('shows "This episode" when failedPath is null', () => {
    render(
      <ClipCompatConvertModal {...defaultProps} failedPath={null} />
    )
    expect(screen.getByText(/This episode/)).toBeInTheDocument()
  })

  it('has Convert button enabled when failedPath is provided', () => {
    render(<ClipCompatConvertModal {...defaultProps} />)
    expect(
      screen.getByRole('button', { name: /convert to compatible format/i })
    ).not.toBeDisabled()
  })

  it('has Convert button disabled when failedPath is null', () => {
    render(<ClipCompatConvertModal {...defaultProps} failedPath={null} />)
    expect(
      screen.getByRole('button', { name: /convert to compatible format/i })
    ).toBeDisabled()
  })

  it('calls onConvert when Convert button is clicked', async () => {
    const onConvert = vi.fn()
    render(<ClipCompatConvertModal {...defaultProps} onConvert={onConvert} />)
    await userEvent.click(
      screen.getByRole('button', { name: /convert to compatible format/i })
    )
    expect(onConvert).toHaveBeenCalledTimes(1)
  })

  it('calls onCancel when the actions-area Cancel button is clicked', async () => {
    const onCancel = vi.fn()
    render(<ClipCompatConvertModal {...defaultProps} onCancel={onCancel} />)
    // Modal is a createPortal into document.body — container.querySelector misses it.
    const actionsCancel = document.body.querySelector('.episode-label-cancel') as HTMLElement
    await userEvent.click(actionsCancel)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('calls onCancel when Escape is pressed while not converting', () => {
    const onCancel = vi.fn()
    // Re-render with a fresh open=true so the effect re-installs the listener
    render(
      <ClipCompatConvertModal
        {...defaultProps}
        isConverting={false}
        onCancel={onCancel}
      />
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})

// ─── technical details toggle ─────────────────────────────────────────────────

describe('ClipCompatConvertModal — technical details', () => {
  it('shows rawError text after clicking "Show technical details"', async () => {
    const rawError = 'Codec "mpeg4" isn\'t supported.'
    render(<ClipCompatConvertModal {...defaultProps} rawError={rawError} />)
    // Details are hidden initially
    expect(screen.queryByText(rawError)).not.toBeInTheDocument()
    await userEvent.click(screen.getByText(/show technical details/i))
    expect(screen.getByText(rawError)).toBeInTheDocument()
  })

  it('hides rawError after clicking "Hide technical details"', async () => {
    const rawError = 'Codec "mpeg4" isn\'t supported.'
    render(<ClipCompatConvertModal {...defaultProps} rawError={rawError} />)
    await userEvent.click(screen.getByText(/show technical details/i))
    expect(screen.getByText(rawError)).toBeInTheDocument()
    await userEvent.click(screen.getByText(/hide technical details/i))
    expect(screen.queryByText(rawError)).not.toBeInTheDocument()
  })
})

// ─── converting state ─────────────────────────────────────────────────────────

describe('ClipCompatConvertModal — isConverting state', () => {
  it('shows spinner / message when isConverting=true', () => {
    render(
      <ClipCompatConvertModal
        {...defaultProps}
        isConverting={true}
        convertMessage="Converting to compatible format..."
      />
    )
    expect(screen.getByText(/converting to compatible format/i)).toBeInTheDocument()
  })

  it('hides the header X button while converting', () => {
    render(
      <ClipCompatConvertModal {...defaultProps} isConverting={true} />
    )
    // Portal renders into document.body — query there.
    // The header X button (episode-label-close) is conditionally rendered only when !isConverting
    const headerClose = document.body.querySelector('.episode-label-header .episode-label-close')
    expect(headerClose).not.toBeInTheDocument()
  })

  it('does NOT call onCancel when Escape pressed while converting', () => {
    const onCancel = vi.fn()
    render(
      <ClipCompatConvertModal {...defaultProps} isConverting={true} onCancel={onCancel} />
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('disables the actions-area Cancel button while converting', () => {
    render(
      <ClipCompatConvertModal {...defaultProps} isConverting={true} />
    )
    // Portal renders into document.body
    const actionsCancel = document.body.querySelector('.episode-label-cancel') as HTMLElement
    expect(actionsCancel).toBeDisabled()
  })
})
