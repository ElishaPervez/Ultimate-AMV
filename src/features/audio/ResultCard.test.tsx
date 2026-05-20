/**
 * src/features/audio/ResultCard.test.tsx
 *
 * Tests for ResultCard — success and error rendering, action buttons.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ResultCard } from './ResultCard'
import { mockInvoke } from '../../../tests/setup/tauri'

describe('ResultCard', () => {
  beforeEach(() => {
    // open_path may be invoked by "Open folder" button
    mockInvoke('open_path', () => null)
  })

  it('shows "Extraction complete" heading for success kind', () => {
    render(
      <ResultCard
        kind="success"
        fileName="vocals.wav"
        message="1/1 files extracted."
        onAgain={() => {}}
      />,
    )
    expect(screen.getByRole('heading', { name: /extraction complete/i })).toBeInTheDocument()
  })

  it('shows "Extraction failed" heading for error kind', () => {
    render(
      <ResultCard
        kind="error"
        fileName="vocals.wav"
        message="Something went wrong"
        onAgain={() => {}}
      />,
    )
    expect(screen.getByRole('heading', { name: /extraction failed/i })).toBeInTheDocument()
  })

  it('renders the file name', () => {
    render(
      <ResultCard
        kind="success"
        fileName="my-track.mp3"
        message="done"
        onAgain={() => {}}
      />,
    )
    expect(screen.getByText('my-track.mp3')).toBeInTheDocument()
  })

  it('renders the message text', () => {
    render(
      <ResultCard
        kind="success"
        fileName="x.wav"
        message="2/2 files extracted. 4 stems saved."
        onAgain={() => {}}
      />,
    )
    expect(screen.getByText('2/2 files extracted. 4 stems saved.')).toBeInTheDocument()
  })

  it('calls onAgain when "Extract another file" is clicked', async () => {
    const onAgain = vi.fn()
    render(
      <ResultCard kind="success" fileName="x.wav" message="done" onAgain={onAgain} />,
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /extract another file/i }))
    expect(onAgain).toHaveBeenCalledOnce()
  })

  it('does not show "Try again" button for success kind', () => {
    render(
      <ResultCard
        kind="success"
        fileName="x.wav"
        message="done"
        onAgain={() => {}}
        onRetry={() => {}}
      />,
    )
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument()
  })

  it('shows "Try again" button for error kind when onRetry provided', () => {
    render(
      <ResultCard
        kind="error"
        fileName="x.wav"
        message="error"
        onAgain={() => {}}
        onRetry={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
  })

  it('calls onRetry when "Try again" is clicked', async () => {
    const onRetry = vi.fn()
    render(
      <ResultCard
        kind="error"
        fileName="x.wav"
        message="error"
        onAgain={() => {}}
        onRetry={onRetry}
      />,
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /try again/i }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('shows "Open folder" button for success when outputDir is provided', () => {
    render(
      <ResultCard
        kind="success"
        fileName="x.wav"
        message="done"
        onAgain={() => {}}
        outputDir="/out/dir"
      />,
    )
    expect(screen.getByRole('button', { name: /open folder/i })).toBeInTheDocument()
  })

  it('does not show "Open folder" button for error kind', () => {
    render(
      <ResultCard
        kind="error"
        fileName="x.wav"
        message="error"
        onAgain={() => {}}
        outputDir="/out/dir"
      />,
    )
    expect(screen.queryByRole('button', { name: /open folder/i })).not.toBeInTheDocument()
  })
})
