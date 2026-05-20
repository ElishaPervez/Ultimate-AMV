/**
 * ClipExportProgressModal tests
 *
 * Covers all four phases: running / complete / error / cancelled.
 * Also covers: cancel button presence, close button, Escape key, backdrop click.
 */

import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ClipExportProgressModal } from './ClipExportProgressModal'
import type { ClipExportSession } from './ClipExportProgressModal'

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<ClipExportSession> = {}): ClipExportSession {
  return {
    mode: 'single',
    rows: [
      { id: 'clip-0', label: 'Scene 1', range: '0:01 - 0:05', status: 'active' },
      { id: 'clip-1', label: 'Scene 2', range: '0:10 - 0:14', status: 'pending' },
    ],
    activeIndex: 0,
    activePercent: 45,
    activeFps: '60',
    activeSpeed: '1.2x',
    activeMessage: 'Encoding Scene 1...',
    phase: 'running',
    outputDir: '/output',
    ...overrides,
  }
}

// ─── phase: running ──────────────────────────────────────────────────────────

describe('ClipExportProgressModal — running phase', () => {
  it('renders dialog with aria-label when session is provided', () => {
    const session = makeSession()
    render(
      <ClipExportProgressModal session={session} onCancel={vi.fn()} onClose={vi.fn()} />
    )
    expect(screen.getByRole('dialog', { name: /export progress/i })).toBeInTheDocument()
  })

  it('shows cancel button during running phase', () => {
    const session = makeSession({ phase: 'running' })
    render(
      <ClipExportProgressModal session={session} onCancel={vi.fn()} onClose={vi.fn()} />
    )
    expect(screen.getByRole('button', { name: /cancel export/i })).toBeInTheDocument()
  })

  it('calls onCancel when cancel button is clicked', async () => {
    const onCancel = vi.fn()
    const session = makeSession({ phase: 'running' })
    render(
      <ClipExportProgressModal session={session} onCancel={onCancel} onClose={vi.fn()} />
    )
    await userEvent.click(screen.getByRole('button', { name: /cancel export/i }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('does NOT show close button during running phase', () => {
    const session = makeSession({ phase: 'running' })
    render(
      <ClipExportProgressModal session={session} onCancel={vi.fn()} onClose={vi.fn()} />
    )
    expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument()
  })

  it('shows active clip label inside the active-section during running phase', () => {
    const session = makeSession({ phase: 'running', activePercent: 45 })
    render(
      <ClipExportProgressModal session={session} onCancel={vi.fn()} onClose={vi.fn()} />
    )
    // Portal renders into document.body — query there
    const activeSection = document.body.querySelector('.clip-export-active') as HTMLElement
    expect(activeSection).toBeInTheDocument()
    expect(activeSection).toHaveTextContent('Scene 1')
  })

  it('shows fps and speed stats during running phase', () => {
    const session = makeSession({ phase: 'running', activeFps: '60', activeSpeed: '1.2x' })
    render(
      <ClipExportProgressModal session={session} onCancel={vi.fn()} onClose={vi.fn()} />
    )
    expect(screen.getByText(/60 fps/i)).toBeInTheDocument()
    expect(screen.getByText(/1\.2x/i)).toBeInTheDocument()
  })

  it('does not close on Escape during running phase', () => {
    const onClose = vi.fn()
    const session = makeSession({ phase: 'running' })
    render(
      <ClipExportProgressModal session={session} onCancel={vi.fn()} onClose={onClose} />
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })
})

// ─── phase: complete ─────────────────────────────────────────────────────────

describe('ClipExportProgressModal — complete phase', () => {
  it('shows Close buttons (header + actions) when phase is complete', () => {
    const session = makeSession({
      phase: 'complete',
      rows: [
        { id: 'clip-0', label: 'Scene 1', range: '0:01 - 0:05', status: 'done' },
        { id: 'clip-1', label: 'Scene 2', range: '0:10 - 0:14', status: 'done' },
      ],
    })
    render(
      <ClipExportProgressModal session={session} onCancel={vi.fn()} onClose={vi.fn()} />
    )
    // Modal is rendered via createPortal into document.body — query there
    const closeButtons = screen.getAllByRole('button', { name: /close/i })
    expect(closeButtons.length).toBeGreaterThanOrEqual(1)
    // The actions-area Close button has class episode-label-confirm
    const actionsClose = document.body.querySelector('.episode-label-actions .episode-label-confirm')
    expect(actionsClose).toBeInTheDocument()
  })

  it('does NOT show cancel button when phase is complete', () => {
    const session = makeSession({ phase: 'complete' })
    render(
      <ClipExportProgressModal session={session} onCancel={vi.fn()} onClose={vi.fn()} />
    )
    expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument()
  })

  it('shows success header text when complete', () => {
    const session = makeSession({
      phase: 'complete',
      rows: [
        { id: 'clip-0', label: 'Scene 1', range: '0:01 - 0:05', status: 'done' },
        { id: 'clip-1', label: 'Scene 2', range: '0:10 - 0:14', status: 'done' },
      ],
    })
    render(
      <ClipExportProgressModal session={session} onCancel={vi.fn()} onClose={vi.fn()} />
    )
    // "Exported 2 of 2 clips"
    expect(screen.getByText(/exported.*clips/i)).toBeInTheDocument()
  })

  it('closes on Escape when phase is complete', () => {
    const onClose = vi.fn()
    const session = makeSession({ phase: 'complete' })
    render(
      <ClipExportProgressModal session={session} onCancel={vi.fn()} onClose={onClose} />
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on backdrop click when phase is complete', () => {
    const onClose = vi.fn()
    const session = makeSession({ phase: 'complete' })
    render(
      <ClipExportProgressModal session={session} onCancel={vi.fn()} onClose={onClose} />
    )
    const backdrop = document.querySelector('.clip-export-backdrop') as HTMLElement
    // Click the backdrop element itself (not a child)
    fireEvent.click(backdrop, { target: backdrop })
    // The onClick handler fires onClose only if event.target === event.currentTarget
    // In jsdom fireEvent sets target to the element clicked, so this is equivalent.
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when actions-area Close button is clicked', async () => {
    const onClose = vi.fn()
    const session = makeSession({ phase: 'complete' })
    render(
      <ClipExportProgressModal session={session} onCancel={vi.fn()} onClose={onClose} />
    )
    // Portal renders into document.body — container.querySelector misses it
    const actionsClose = document.body.querySelector(
      '.episode-label-actions .episode-label-confirm'
    ) as HTMLElement
    await userEvent.click(actionsClose)
    expect(onClose).toHaveBeenCalled()
  })
})

// ─── phase: error ────────────────────────────────────────────────────────────

describe('ClipExportProgressModal — error phase', () => {
  it('shows error header text', () => {
    const session = makeSession({
      phase: 'error',
      rows: [
        { id: 'clip-0', label: 'Scene 1', range: '0:01 - 0:05', status: 'error', errorMessage: 'NVENC crashed' },
      ],
    })
    render(
      <ClipExportProgressModal session={session} onCancel={vi.fn()} onClose={vi.fn()} />
    )
    expect(screen.getByText(/export failed/i)).toBeInTheDocument()
  })

  it('shows error message in the row', () => {
    const session = makeSession({
      phase: 'error',
      rows: [
        { id: 'clip-0', label: 'Scene 1', range: '0:01 - 0:05', status: 'error', errorMessage: 'NVENC crashed' },
      ],
    })
    render(
      <ClipExportProgressModal session={session} onCancel={vi.fn()} onClose={vi.fn()} />
    )
    expect(screen.getByText('NVENC crashed')).toBeInTheDocument()
  })

  it('shows Close button in actions area when phase is error', () => {
    const session = makeSession({ phase: 'error' })
    render(
      <ClipExportProgressModal session={session} onCancel={vi.fn()} onClose={vi.fn()} />
    )
    const actionsClose = document.body.querySelector('.episode-label-actions .episode-label-confirm')
    expect(actionsClose).toBeInTheDocument()
  })
})

// ─── phase: cancelled ────────────────────────────────────────────────────────

describe('ClipExportProgressModal — cancelled phase', () => {
  it('shows cancelled header text', () => {
    const session = makeSession({ phase: 'cancelled' })
    render(
      <ClipExportProgressModal session={session} onCancel={vi.fn()} onClose={vi.fn()} />
    )
    expect(screen.getByText(/export cancelled/i)).toBeInTheDocument()
  })

  it('shows Close button in actions area when phase is cancelled', () => {
    const session = makeSession({ phase: 'cancelled' })
    render(
      <ClipExportProgressModal session={session} onCancel={vi.fn()} onClose={vi.fn()} />
    )
    const actionsClose = document.body.querySelector('.episode-label-actions .episode-label-confirm')
    expect(actionsClose).toBeInTheDocument()
  })
})

// ─── null session ─────────────────────────────────────────────────────────────

describe('ClipExportProgressModal — null session', () => {
  it('renders nothing when session is null', () => {
    const { container } = render(
      <ClipExportProgressModal session={null} onCancel={vi.fn()} onClose={vi.fn()} />
    )
    expect(container.firstChild).toBeNull()
  })
})

// ─── merge mode ───────────────────────────────────────────────────────────────

describe('ClipExportProgressModal — merge mode', () => {
  it('shows "Merge complete" when mode=merge and phase=complete', () => {
    const session = makeSession({
      mode: 'merge',
      phase: 'complete',
      rows: [{ id: 'merge-1+2', label: '1+2.mov', range: '2 clips', status: 'done' }],
    })
    render(
      <ClipExportProgressModal session={session} onCancel={vi.fn()} onClose={vi.fn()} />
    )
    expect(screen.getByText(/merge complete/i)).toBeInTheDocument()
  })
})
