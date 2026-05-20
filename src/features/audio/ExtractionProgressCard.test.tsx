/**
 * src/features/audio/ExtractionProgressCard.test.tsx
 *
 * Tests for ExtractionProgressCard — progress bar, stage headings, cancel button.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ExtractionProgressCard } from './ExtractionProgressCard'
import type { AudioProgress } from '../../types/audio'

// Ensure tauri mocks are loaded (no direct usage needed here, but the component
// imports nothing from tauri — kept for consistency and future-proofing).
import '../../../tests/setup/tauri'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProgress(overrides: Partial<AudioProgress> = {}): AudioProgress {
  return {
    type: 'progress',
    stage: 'loading',
    percent: -1,
    message: 'Loading AI model...',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ExtractionProgressCard', () => {
  it('renders the file name passed as prop', () => {
    render(<ExtractionProgressCard fileName="my-song.mp3" progress={null} />)
    expect(screen.getByText('my-song.mp3')).toBeInTheDocument()
  })

  it('shows "Loading AI model" heading when stage is loading', () => {
    const progress = makeProgress({ stage: 'loading' })
    render(<ExtractionProgressCard fileName="test.mp3" progress={progress} />)
    expect(screen.getByRole('heading', { name: /loading ai model/i })).toBeInTheDocument()
  })

  it('shows "Extracting vocals" with percent when stage is processing and percent >= 0', () => {
    const progress = makeProgress({ stage: 'processing', percent: 73 })
    render(<ExtractionProgressCard fileName="test.mp3" progress={progress} />)
    expect(screen.getByRole('heading', { name: /extracting vocals : 73%/i })).toBeInTheDocument()
  })

  it('shows "Extracting vocals" without percent when percent is negative', () => {
    const progress = makeProgress({ stage: 'processing', percent: -1 })
    render(<ExtractionProgressCard fileName="test.mp3" progress={progress} />)
    expect(screen.getByRole('heading', { name: /^extracting vocals$/i })).toBeInTheDocument()
  })

  it('shows "Downloading AI model" with percent when stage is model-download', () => {
    const progress = makeProgress({ stage: 'model-download', percent: 50 })
    render(<ExtractionProgressCard fileName="test.mp3" progress={progress} />)
    expect(screen.getByRole('heading', { name: /downloading ai model : 50%/i })).toBeInTheDocument()
  })

  it('shows "Saving stems" heading when stage is finalizing', () => {
    const progress = makeProgress({ stage: 'finalizing' })
    render(<ExtractionProgressCard fileName="test.mp3" progress={progress} />)
    expect(screen.getByRole('heading', { name: /saving stems/i })).toBeInTheDocument()
  })

  it('renders an indeterminate progress bar when percent is negative', () => {
    const progress = makeProgress({ percent: -1 })
    render(<ExtractionProgressCard fileName="test.mp3" progress={progress} />)
    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveClass('is-indeterminate')
    expect(bar).not.toHaveAttribute('aria-valuenow')
  })

  it('renders a determinate progress bar with aria-valuenow when percent >= 0', () => {
    const progress = makeProgress({ stage: 'processing', percent: 42 })
    render(<ExtractionProgressCard fileName="test.mp3" progress={progress} />)
    const bar = screen.getByRole('progressbar')
    expect(bar).not.toHaveClass('is-indeterminate')
    expect(bar).toHaveAttribute('aria-valuenow', '42')
  })

  it('shows the custom message subline from progress payload', () => {
    const progress = makeProgress({ message: 'Separating audio channels...' })
    render(<ExtractionProgressCard fileName="test.mp3" progress={progress} />)
    expect(screen.getByText('Separating audio channels...')).toBeInTheDocument()
  })

  it('shows default loading message when progress is null', () => {
    render(<ExtractionProgressCard fileName="test.mp3" progress={null} />)
    expect(screen.getByText('Loading AI model...')).toBeInTheDocument()
  })

  it('does not render a Cancel button when onCancel is not provided', () => {
    render(<ExtractionProgressCard fileName="test.mp3" progress={null} />)
    expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument()
  })

  it('renders a Cancel button when onCancel is provided', () => {
    render(<ExtractionProgressCard fileName="test.mp3" progress={null} onCancel={() => {}} />)
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument()
  })

  it('calls onCancel when Cancel button is clicked', async () => {
    const onCancel = vi.fn()
    render(<ExtractionProgressCard fileName="test.mp3" progress={null} onCancel={onCancel} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onCancel).toHaveBeenCalledOnce()
  })
})
