/**
 * src/features/audio/SetupRunningCard.test.tsx
 *
 * Tests for SetupRunningCard — GPU/CPU heading, step progress, indeterminate bar.
 */

import { render, screen } from '@testing-library/react'
import { SetupRunningCard } from './SetupRunningCard'
import type { AudioSetupProgress } from '../../types/audio'

import '../../../tests/setup/tauri'

function makeProgress(overrides: Partial<AudioSetupProgress> = {}): AudioSetupProgress {
  return {
    type: 'setup-progress',
    step: 1,
    total: 5,
    state: 'running',
    message: 'Downloading packages...',
    ...overrides,
  }
}

describe('SetupRunningCard', () => {
  it('shows "Installing GPU engine" heading for gpu mode', () => {
    render(<SetupRunningCard mode="gpu" progress={null} />)
    expect(screen.getByRole('heading', { name: /installing gpu engine/i })).toBeInTheDocument()
  })

  it('shows "Installing CPU engine" heading for cpu mode', () => {
    render(<SetupRunningCard mode="cpu" progress={null} />)
    expect(screen.getByRole('heading', { name: /installing cpu engine/i })).toBeInTheDocument()
  })

  it('shows "Preparing install..." subheading when progress is null', () => {
    render(<SetupRunningCard mode="cpu" progress={null} />)
    expect(screen.getByText('Preparing install...')).toBeInTheDocument()
  })

  it('shows "Step N of M" subheading when total > 0', () => {
    const progress = makeProgress({ step: 2, total: 4 })
    render(<SetupRunningCard mode="gpu" progress={progress} />)
    expect(screen.getByText('Step 2 of 4')).toBeInTheDocument()
  })

  it('renders an indeterminate progress bar when total is 0', () => {
    const progress = makeProgress({ step: 0, total: 0 })
    render(<SetupRunningCard mode="cpu" progress={progress} />)
    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveClass('is-indeterminate')
    expect(bar).not.toHaveAttribute('aria-valuenow')
  })

  it('renders a determinate progress bar with correct aria-valuenow', () => {
    // step=2, total=4 → 50%
    const progress = makeProgress({ step: 2, total: 4 })
    render(<SetupRunningCard mode="cpu" progress={progress} />)
    const bar = screen.getByRole('progressbar')
    expect(bar).not.toHaveClass('is-indeterminate')
    expect(bar).toHaveAttribute('aria-valuenow', '50')
  })

  it('shows the progress message detail', () => {
    const progress = makeProgress({ message: 'Extracting torch wheel...' })
    render(<SetupRunningCard mode="gpu" progress={progress} />)
    expect(screen.getByText('Extracting torch wheel...')).toBeInTheDocument()
  })

  it('truncates very long messages to 120 chars + ellipsis', () => {
    const long = 'A'.repeat(130)
    const progress = makeProgress({ message: long })
    render(<SetupRunningCard mode="gpu" progress={progress} />)
    const truncated = 'A'.repeat(117) + '...'
    expect(screen.getByText(truncated)).toBeInTheDocument()
  })

  it('shows "Working..." for empty message (falls through to friendlySetupMessage default)', () => {
    const progress = makeProgress({ message: '' })
    render(<SetupRunningCard mode="cpu" progress={progress} />)
    expect(screen.getByText('Working...')).toBeInTheDocument()
  })

  it('shows "Starting..." when progress is null (no setup-progress event yet)', () => {
    render(<SetupRunningCard mode="cpu" progress={null} />)
    expect(screen.getByText('Starting...')).toBeInTheDocument()
  })
})
