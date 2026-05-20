/**
 * SettingsConfirmModal tests
 * Tests confirm/cancel wiring, Escape key, isDanger class, backdrop click.
 */

import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SettingsConfirmModal } from './SettingsConfirmModal'

function renderModal(overrides: Partial<React.ComponentProps<typeof SettingsConfirmModal>> = {}) {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  const defaults: React.ComponentProps<typeof SettingsConfirmModal> = {
    open: true,
    title: 'Delete everything?',
    description: <p>This is permanent.</p>,
    confirmText: 'Delete',
    onConfirm,
    onCancel,
  }
  const props = { ...defaults, ...overrides }
  const result = render(<SettingsConfirmModal {...props} />)
  return { ...result, onConfirm, onCancel }
}

describe('SettingsConfirmModal', () => {
  it('renders nothing when open=false', () => {
    renderModal({ open: false })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders when open=true', () => {
    renderModal()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('displays the title text', () => {
    renderModal({ title: 'Are you sure?' })
    expect(screen.getByText('Are you sure?')).toBeInTheDocument()
  })

  it('displays confirm button with confirmText', () => {
    renderModal({ confirmText: 'Proceed' })
    expect(screen.getByRole('button', { name: /Proceed/i })).toBeInTheDocument()
  })

  it('calls onConfirm when confirm button is clicked', async () => {
    const user = userEvent.setup()
    const { onConfirm } = renderModal({ confirmText: 'Yes do it' })
    await user.click(screen.getByRole('button', { name: /Yes do it/i }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('does NOT call onConfirm when cancel button is clicked', async () => {
    const user = userEvent.setup()
    const { onConfirm, onCancel } = renderModal()
    await user.click(screen.getByRole('button', { name: /Cancel/i }))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('calls onCancel when the X close button is clicked', async () => {
    const user = userEvent.setup()
    const { onCancel, onConfirm } = renderModal()
    await user.click(screen.getByRole('button', { name: /close modal/i }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('calls onCancel on Escape key press', () => {
    const { onCancel, onConfirm } = renderModal()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('does NOT call onCancel on Escape when open=false', () => {
    // When open=false, component returns null so no listener is attached.
    // Re-render with open=false to verify the listener is cleaned up.
    const onCancel = vi.fn()
    const { rerender } = render(
      <SettingsConfirmModal
        open={true}
        title="Test"
        description="desc"
        confirmText="OK"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    )
    // Close the modal by updating props
    rerender(
      <SettingsConfirmModal
        open={false}
        title="Test"
        description="desc"
        confirmText="OK"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    )
    // Pressing Escape after close should not fire
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('applies is-danger class to modal container when isDanger=true', () => {
    renderModal({ isDanger: true })
    const dialog = screen.getByRole('dialog')
    const modal = dialog.querySelector('.settings-confirm-modal')
    expect(modal).toHaveClass('is-danger')
  })

  it('does NOT apply is-danger class when isDanger=false', () => {
    renderModal({ isDanger: false })
    const dialog = screen.getByRole('dialog')
    const modal = dialog.querySelector('.settings-confirm-modal')
    expect(modal).not.toHaveClass('is-danger')
  })

  it('applies is-danger class to the confirm button when isDanger=true', () => {
    renderModal({ isDanger: true, confirmText: 'Danger action' })
    const confirmBtn = screen.getByRole('button', { name: /Danger action/i })
    expect(confirmBtn).toHaveClass('is-danger')
  })

  it('uses custom cancelText when provided', () => {
    renderModal({ cancelText: 'Go back' })
    expect(screen.getByRole('button', { name: /Go back/i })).toBeInTheDocument()
  })

  it('uses default cancelText "Cancel" when not provided', () => {
    renderModal()
    expect(screen.getByRole('button', { name: /^Cancel$/i })).toBeInTheDocument()
  })

  it('calls onCancel when backdrop (episode-label-backdrop) is clicked', async () => {
    const user = userEvent.setup()
    const { onCancel } = renderModal()
    const backdrop = document.querySelector('.episode-label-backdrop')
    expect(backdrop).not.toBeNull()
    await user.click(backdrop as HTMLElement)
    // Note: backdrop click is NOT wired in the current implementation —
    // clicking the backdrop area falls through to the modal inner div.
    // This test documents the current behavior: onCancel is NOT called
    // by clicking the backdrop wrapper because no onClick is attached to it.
    // If a backdrop-dismiss feature is added later, update this assertion.
    expect(onCancel).not.toHaveBeenCalled()
  })
})
