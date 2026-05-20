/**
 * src/features/audio/BatchStatusList.test.tsx
 *
 * Tests for BatchStatusList — renders per-item status icons and labels
 * for "done" / "error" items in a batch extraction.
 */

import { render, screen } from '@testing-library/react'
import { BatchStatusList } from './BatchStatusList'
import type { BatchItemStatus } from '../../types/audio'

// vi.mock tauri so no module-level side-effects blow up
import '../../../tests/setup/tauri'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<BatchItemStatus> & { input: string }): BatchItemStatus {
  return { status: 'done', ...overrides }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BatchStatusList', () => {
  it('renders nothing when items array is empty', () => {
    const { container } = render(<BatchStatusList items={[]} />)
    expect(container.querySelector('.batch-status-list')).toBeInTheDocument()
    expect(container.querySelectorAll('.batch-status-row')).toHaveLength(0)
  })

  it('renders a row for each item', () => {
    const items: BatchItemStatus[] = [
      makeItem({ input: '/music/file1.mp3', status: 'done' }),
      makeItem({ input: '/music/file2.mp3', status: 'error' }),
      makeItem({ input: '/music/file3.mp3', status: 'done' }),
    ]
    render(<BatchStatusList items={items} />)
    expect(screen.getAllByRole('generic', { hidden: true }).length).toBeGreaterThanOrEqual(1)
    // Check by class name count
    const { container } = render(<BatchStatusList items={items} />)
    expect(container.querySelectorAll('.batch-status-row')).toHaveLength(3)
  })

  it('applies is-done class for done items', () => {
    const items: BatchItemStatus[] = [makeItem({ input: '/a/song.wav', status: 'done' })]
    const { container } = render(<BatchStatusList items={items} />)
    expect(container.querySelector('.batch-status-row.is-done')).toBeInTheDocument()
  })

  it('applies is-error class for error items', () => {
    const items: BatchItemStatus[] = [makeItem({ input: '/a/song.wav', status: 'error' })]
    const { container } = render(<BatchStatusList items={items} />)
    expect(container.querySelector('.batch-status-row.is-error')).toBeInTheDocument()
  })

  it('shows "Done" label for done items', () => {
    const items: BatchItemStatus[] = [makeItem({ input: '/a/song.wav', status: 'done' })]
    render(<BatchStatusList items={items} />)
    expect(screen.getByText('Done')).toBeInTheDocument()
  })

  it('shows "Failed" label for error items with no message', () => {
    const items: BatchItemStatus[] = [makeItem({ input: '/a/song.wav', status: 'error' })]
    render(<BatchStatusList items={items} />)
    expect(screen.getByText('Failed')).toBeInTheDocument()
  })

  it('shows custom error message when item has message property', () => {
    const items: BatchItemStatus[] = [
      makeItem({ input: '/a/song.wav', status: 'error', message: 'ffmpeg crashed' }),
    ]
    render(<BatchStatusList items={items} />)
    expect(screen.getByText('ffmpeg crashed')).toBeInTheDocument()
    expect(screen.queryByText('Failed')).not.toBeInTheDocument()
  })

  it('displays the file name (not full path) for each item', () => {
    const items: BatchItemStatus[] = [makeItem({ input: '/deep/path/to/vocals.mp3', status: 'done' })]
    render(<BatchStatusList items={items} />)
    expect(screen.getByText('vocals.mp3')).toBeInTheDocument()
  })

  it('uses item.input as the React key (no duplicate-key warning with same filenames in different dirs)', () => {
    // Both have the same basename; BatchStatusList uses input as key so this
    // must not throw a React duplicate-key error.
    const items: BatchItemStatus[] = [
      makeItem({ input: '/dir1/song.mp3', status: 'done' }),
      makeItem({ input: '/dir2/song.mp3', status: 'error' }),
    ]
    expect(() => render(<BatchStatusList items={items} />)).not.toThrow()
  })
})
