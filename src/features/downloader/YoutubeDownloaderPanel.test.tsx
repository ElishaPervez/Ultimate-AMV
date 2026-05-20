/**
 * Tests for YoutubeDownloaderPanel component.
 * Covers: URL input, format inspection, format selection, queue action,
 * history rendering, re-download, trim editor integration.
 */

import React from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { YoutubeDownloaderPanel } from './YoutubeDownloaderPanel'
import { mockInvoke } from '../../../tests/setup/tauri'
import type { DownloadHistoryItem, DownloadFormatInspection } from '../../types/download'
import { BEST_FORMAT_ID } from '../../lib/constants'

const noop = vi.fn()

function makeInspection(overrides: Partial<DownloadFormatInspection> = {}): DownloadFormatInspection {
  return {
    durationSeconds: 300,
    isLive: false,
    videoId: 'dQw4w9WgXcQ',
    previewUrl: null,
    formats: [
      {
        id: 'f137',
        label: '1080p',
        ext: 'mp4',
        resolution: '1920x1080',
        width: 1920,
        height: 1080,
        bitrate: 5000000,
        filesize: null,
        vcodec: 'avc1',
        acodec: null,
        audioOnly: false,
      },
      {
        id: 'f140',
        label: '128kbps audio',
        ext: 'm4a',
        resolution: null,
        width: null,
        height: null,
        bitrate: 128000,
        filesize: 3000000,
        vcodec: null,
        acodec: 'mp4a',
        audioOnly: true,
      },
    ],
    ...overrides,
  }
}

function makeHistoryItem(overrides: Partial<DownloadHistoryItem> = {}): DownloadHistoryItem {
  return {
    id: 'h1',
    createdAt: new Date().toISOString(),
    kind: 'youtube',
    title: 'History Video',
    subtitle: null,
    qualityLabel: 'Best (auto-merge video + audio)',
    url: 'https://www.youtube.com/watch?v=abc123',
    referer: null,
    formatId: 'bestvideo*+bestaudio/best',
    outputPath: '/downloads/video.mp4',
    sourcePage: 'https://www.youtube.com/watch?v=abc123',
    ...overrides,
  }
}

describe('YoutubeDownloaderPanel', () => {
  it('renders URL input and Inspect button', () => {
    render(<YoutubeDownloaderPanel enqueueDownload={noop} history={[]} onRedownload={noop} />)
    expect(screen.getByPlaceholderText(/https:\/\/www\.youtube\.com/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Inspect' })).toBeInTheDocument()
  })

  it('Inspect button is disabled when URL is empty', () => {
    render(<YoutubeDownloaderPanel enqueueDownload={noop} history={[]} onRedownload={noop} />)
    const btn = screen.getByRole('button', { name: 'Inspect' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('Inspect button becomes enabled when URL is typed', async () => {
    render(<YoutubeDownloaderPanel enqueueDownload={noop} history={[]} onRedownload={noop} />)
    const input = screen.getByPlaceholderText(/https:\/\/www\.youtube\.com/)
    fireEvent.change(input, { target: { value: 'https://www.youtube.com/watch?v=abc123' } })
    const btn = screen.getByRole('button', { name: 'Inspect' }) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
  })

  it('calls invoke("inspect_download_formats") on form submit', async () => {
    const inspectHandler = vi.fn(async () => makeInspection({ formats: [] }))
    mockInvoke('inspect_download_formats', inspectHandler)

    render(<YoutubeDownloaderPanel enqueueDownload={noop} history={[]} onRedownload={noop} />)
    const input = screen.getByPlaceholderText(/https:\/\/www\.youtube\.com/)
    fireEvent.change(input, { target: { value: 'https://www.youtube.com/watch?v=xyz' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => {
      expect(inspectHandler).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'https://www.youtube.com/watch?v=xyz' })
      )
    })
  })

  it('renders "Best" format entry by default even before inspection', () => {
    render(<YoutubeDownloaderPanel enqueueDownload={noop} history={[]} onRedownload={noop} />)
    expect(screen.getByText('Best (auto-merge video + audio)')).toBeInTheDocument()
  })

  it('renders fetched formats after inspection', async () => {
    mockInvoke('inspect_download_formats', async () => makeInspection())
    render(<YoutubeDownloaderPanel enqueueDownload={noop} history={[]} onRedownload={noop} />)
    const input = screen.getByPlaceholderText(/https:\/\/www\.youtube\.com/)
    fireEvent.change(input, { target: { value: 'https://www.youtube.com/watch?v=abc' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(screen.getByText('1080p')).toBeInTheDocument())
    expect(screen.getByText('128kbps audio')).toBeInTheDocument()
  })

  it('allows selecting a format from the list', async () => {
    mockInvoke('inspect_download_formats', async () => makeInspection())
    render(<YoutubeDownloaderPanel enqueueDownload={noop} history={[]} onRedownload={noop} />)
    const input = screen.getByPlaceholderText(/https:\/\/www\.youtube\.com/)
    fireEvent.change(input, { target: { value: 'https://www.youtube.com/watch?v=abc' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => screen.getByText('1080p'))
    fireEvent.click(screen.getByText('1080p').closest('button')!)
    // 1080p row should now have is-selected class
    expect(screen.getByText('1080p').closest('button')?.className).toContain('is-selected')
  })

  it('calls enqueueDownload when Queue button is clicked', async () => {
    const enqueueDownload = vi.fn(() => 'job-id-1')
    mockInvoke('inspect_download_formats', async () => makeInspection({ formats: [] }))
    render(<YoutubeDownloaderPanel enqueueDownload={enqueueDownload} history={[]} onRedownload={noop} />)
    const input = screen.getByPlaceholderText(/https:\/\/www\.youtube\.com/)
    fireEvent.change(input, { target: { value: 'https://www.youtube.com/watch?v=testid' } })
    // Queue button should be enabled even without inspection because Best format is always there
    fireEvent.click(screen.getByRole('button', { name: /Queue selected format/i }))
    expect(enqueueDownload).toHaveBeenCalledOnce()
    expect(enqueueDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'youtube',
        url: 'https://www.youtube.com/watch?v=testid',
        formatId: 'bestvideo*+bestaudio/best',
        folderName: 'youtube downloads',
      })
    )
  })

  it('shows history section with past downloads', () => {
    const history = [makeHistoryItem({ title: 'Cool Video', qualityLabel: '720p' })]
    render(<YoutubeDownloaderPanel enqueueDownload={noop} history={history} onRedownload={noop} />)
    expect(screen.getByText('Cool Video')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Redownload' })).toBeInTheDocument()
  })

  it('calls onRedownload when Redownload button clicked', () => {
    const onRedownload = vi.fn()
    const item = makeHistoryItem()
    render(<YoutubeDownloaderPanel enqueueDownload={noop} history={[item]} onRedownload={onRedownload} />)
    fireEvent.click(screen.getByRole('button', { name: 'Redownload' }))
    expect(onRedownload).toHaveBeenCalledWith(item)
  })

  it('shows empty history message when no history', () => {
    render(<YoutubeDownloaderPanel enqueueDownload={noop} history={[]} onRedownload={noop} />)
    expect(screen.getByText('No YouTube downloads yet.')).toBeInTheDocument()
  })

  it('filters out anime items from history display', () => {
    const history = [
      makeHistoryItem({ kind: 'anime', title: 'Anime Episode' }),
      makeHistoryItem({ kind: 'youtube', title: 'YouTube Video' }),
    ]
    render(<YoutubeDownloaderPanel enqueueDownload={noop} history={history} onRedownload={noop} />)
    expect(screen.queryByText('Anime Episode')).not.toBeInTheDocument()
    expect(screen.getByText('YouTube Video')).toBeInTheDocument()
  })

  it('shows error message when inspection fails', async () => {
    mockInvoke('inspect_download_formats', async () => { throw new Error('Rate limited') })
    render(<YoutubeDownloaderPanel enqueueDownload={noop} history={[]} onRedownload={noop} />)
    const input = screen.getByPlaceholderText(/https:\/\/www\.youtube\.com/)
    fireEvent.change(input, { target: { value: 'https://www.youtube.com/watch?v=fail' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(screen.getByText(/Rate limited/)).toBeInTheDocument())
  })

  it('shows trim editor when duration is available and video is not live', async () => {
    mockInvoke('inspect_download_formats', async () => makeInspection({ durationSeconds: 300, isLive: false }))
    render(<YoutubeDownloaderPanel enqueueDownload={noop} history={[]} onRedownload={noop} />)
    const input = screen.getByPlaceholderText(/https:\/\/www\.youtube\.com/)
    fireEvent.change(input, { target: { value: 'https://www.youtube.com/watch?v=abc' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => screen.getByText(/Trim a section/))
    expect(screen.getByText(/Trim a section/)).toBeInTheDocument()
  })

  it('shows live stream message for live videos', async () => {
    mockInvoke('inspect_download_formats', async () => makeInspection({ isLive: true, durationSeconds: 0 }))
    render(<YoutubeDownloaderPanel enqueueDownload={noop} history={[]} onRedownload={noop} />)
    const input = screen.getByPlaceholderText(/https:\/\/www\.youtube\.com/)
    fireEvent.change(input, { target: { value: 'https://www.youtube.com/watch?v=live' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => screen.getByText(/Live streams cannot be clipped/))
    expect(screen.getByText(/Live streams cannot be clipped/)).toBeInTheDocument()
  })

  it('queues clip range when trim is enabled and range is not whole video', async () => {
    const enqueueDownload = vi.fn(() => 'job-clip-1')
    mockInvoke('inspect_download_formats', async () => makeInspection({ durationSeconds: 300, isLive: false }))
    render(<YoutubeDownloaderPanel enqueueDownload={enqueueDownload} history={[]} onRedownload={noop} />)
    const input = screen.getByPlaceholderText(/https:\/\/www\.youtube\.com/)
    fireEvent.change(input, { target: { value: 'https://www.youtube.com/watch?v=cliptest' } })
    fireEvent.submit(input.closest('form')!)
    // Enable trim
    await waitFor(() => screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('checkbox'))
    // Set start range to non-zero via the range input
    const [startRange] = screen.getAllByRole('slider')
    fireEvent.change(startRange, { target: { value: '60' } }) // 60 seconds in
    fireEvent.click(screen.getByRole('button', { name: /Queue clip/i }))
    expect(enqueueDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        clip: expect.objectContaining({ startSeconds: 60 }),
      })
    )
  })
})
