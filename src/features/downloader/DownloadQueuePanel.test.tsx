/**
 * Tests for DownloadQueuePanel component.
 * Covers: queue rendering, status display, cancel/remove buttons,
 * progress tracking, and empty-state display.
 */

import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { DownloadQueuePanel } from './DownloadQueuePanel'
import type { DownloadQueueItem } from '../../types/download'

function makeJob(overrides: Partial<DownloadQueueItem> = {}): DownloadQueueItem {
  return {
    id: `job-${Math.random().toString(16).slice(2)}`,
    kind: 'youtube',
    title: 'Test Video',
    subtitle: 'Episode 1',
    qualityLabel: '1080p',
    url: 'https://example.com/video.mp4',
    status: 'queued',
    progress: null,
    outputPath: null,
    error: null,
    warning: null,
    createdAt: Date.now(),
    ...overrides,
  }
}

describe('DownloadQueuePanel', () => {
  it('renders empty state when queue is empty', () => {
    render(<DownloadQueuePanel queue={[]} onCancel={vi.fn()} />)
    expect(screen.getByText('No queued downloads.')).toBeInTheDocument()
  })

  it('renders a queued item with title and subtitle', () => {
    const job = makeJob({ title: 'My Show', subtitle: 'Episode 5', qualityLabel: '720p' })
    render(<DownloadQueuePanel queue={[job]} onCancel={vi.fn()} />)
    expect(screen.getByText('My Show')).toBeInTheDocument()
    expect(screen.getByText('Episode 5 - 720p')).toBeInTheDocument()
  })

  it('shows Remove button for queued items', () => {
    const job = makeJob({ status: 'queued' })
    render(<DownloadQueuePanel queue={[job]} onCancel={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument()
  })

  it('shows Cancel button for downloading items', () => {
    const job = makeJob({
      status: 'downloading',
      progress: { jobId: 'j1', stage: 'downloading', percent: 42, message: 'Downloading...' },
    })
    render(<DownloadQueuePanel queue={[job]} onCancel={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('calls onCancel with the correct job when Remove is clicked', () => {
    const onCancel = vi.fn()
    const job = makeJob({ status: 'queued' })
    render(<DownloadQueuePanel queue={[job]} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onCancel).toHaveBeenCalledWith(job)
  })

  it('calls onCancel with the correct job when Cancel is clicked for downloading item', () => {
    const onCancel = vi.fn()
    const job = makeJob({
      status: 'downloading',
      progress: { jobId: 'j1', stage: 'downloading', percent: 10, message: 'Working' },
    })
    render(<DownloadQueuePanel queue={[job]} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledWith(job)
  })

  it('does not show a cancel/remove button for done items', () => {
    const job = makeJob({
      status: 'done',
      progress: { jobId: 'j1', stage: 'done', percent: 100, message: '/path/to/file.mp4' },
    })
    render(<DownloadQueuePanel queue={[job]} onCancel={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()
  })

  it('displays download progress percentage and message', () => {
    const job = makeJob({
      status: 'downloading',
      progress: { jobId: 'j1', stage: 'downloading', percent: 66.7, message: 'Fetching fragments...' },
    })
    render(<DownloadQueuePanel queue={[job]} onCancel={vi.fn()} />)
    expect(screen.getByText(/66\.7%/)).toBeInTheDocument()
    expect(screen.getByText(/Fetching fragments\.\.\./)).toBeInTheDocument()
  })

  it('shows progress bar for downloading status', () => {
    const job = makeJob({
      status: 'downloading',
      progress: { jobId: 'j1', stage: 'downloading', percent: 50, message: '...' },
    })
    const { container } = render(<DownloadQueuePanel queue={[job]} onCancel={vi.fn()} />)
    expect(container.querySelector('.stream-progress-track')).toBeInTheDocument()
    const fill = container.querySelector('.stream-progress-fill') as HTMLElement
    expect(fill).toBeTruthy()
    expect(fill.style.width).toBe('50%')
  })

  it('shows indeterminate progress bar when percent is null', () => {
    const job = makeJob({
      status: 'downloading',
      progress: { jobId: 'j1', stage: 'starting', percent: null, message: 'Starting...' },
    })
    const { container } = render(<DownloadQueuePanel queue={[job]} onCancel={vi.fn()} />)
    const track = container.querySelector('.stream-progress-track')
    expect(track?.classList.contains('is-indeterminate')).toBe(true)
  })

  it('displays error message for error status', () => {
    const job = makeJob({
      status: 'error',
      error: 'Network failure: connection refused',
      progress: { jobId: 'j1', stage: 'error', percent: null, message: 'Network failure: connection refused' },
    })
    const { container } = render(<DownloadQueuePanel queue={[job]} onCancel={vi.fn()} />)
    // The error appears in the .stream-error span specifically
    const errorSpan = container.querySelector('.stream-error')
    expect(errorSpan).toBeInTheDocument()
    expect(errorSpan?.textContent).toBe('Network failure: connection refused')
  })

  it('displays warning message on jobs that have warnings', () => {
    const job = makeJob({
      status: 'downloading',
      warning: 'Some audio tracks may not be available',
      progress: { jobId: 'j1', stage: 'downloading', percent: 10, message: '...' },
    })
    render(<DownloadQueuePanel queue={[job]} onCancel={vi.fn()} />)
    expect(screen.getByText(/Some audio tracks may not be available/)).toBeInTheDocument()
  })

  it('renders multiple queue items', () => {
    const jobs = [
      makeJob({ title: 'Video A', status: 'downloading', progress: { jobId: 'j1', stage: 'downloading', percent: 30, message: '...' } }),
      makeJob({ title: 'Video B', status: 'queued' }),
      makeJob({ title: 'Video C', status: 'queued' }),
    ]
    render(<DownloadQueuePanel queue={jobs} onCancel={vi.fn()} />)
    expect(screen.getByText('Video A')).toBeInTheDocument()
    expect(screen.getByText('Video B')).toBeInTheDocument()
    expect(screen.getByText('Video C')).toBeInTheDocument()
  })

  it('shows done items in the finished section (last 4)', () => {
    const jobs = [
      makeJob({ title: 'Done Video', status: 'done', progress: { jobId: 'j1', stage: 'done', percent: 100, message: '/path' } }),
    ]
    render(<DownloadQueuePanel queue={jobs} onCancel={vi.fn()} />)
    expect(screen.getByText('Done Video')).toBeInTheDocument()
  })

  it('shows the URL when both subtitle and qualityLabel are absent', () => {
    const job = makeJob({ subtitle: null, qualityLabel: null, url: 'https://example.com/video.mp4' })
    render(<DownloadQueuePanel queue={[job]} onCancel={vi.fn()} />)
    expect(screen.getByText('https://example.com/video.mp4')).toBeInTheDocument()
  })

  it('applies the correct status CSS class to each row', () => {
    const job = makeJob({ status: 'error', error: 'oops', progress: { jobId: 'j1', stage: 'error', percent: null, message: 'oops' } })
    const { container } = render(<DownloadQueuePanel queue={[job]} onCancel={vi.fn()} />)
    expect(container.querySelector('.download-queue-row.is-error')).toBeInTheDocument()
  })
})
