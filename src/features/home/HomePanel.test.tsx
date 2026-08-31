/**
 * Tests for HomePanel.
 * Covers: every sidebar tool has a card, stage grouping, navigation,
 * the readiness rail's plain-language verdicts, the resume row, and
 * the recent-downloads list.
 */

import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { mockInvoke, mockInvokeFn } from '../../../tests/setup/tauri'
import { HomePanel } from './HomePanel'

/** Renders Home and waits for the machine check to settle, so the async
 * status load never lands after a test has already finished. */
async function renderHome(onNavigate = vi.fn()) {
  const result = render(<HomePanel onNavigate={onNavigate} />)
  await waitFor(() =>
    expect(result.container.querySelector('.home-check-list')).not.toBeNull()
  )
  return { ...result, onNavigate }
}

const GPU_OK = {
  compatible: true,
  gpuName: 'NVIDIA GeForce RTX 4070',
  hasNvidiaGpu: true,
  hasFfmpeg: true,
  hasFfprobe: true,
  hasH264Cuvid: true,
  hasHevcCuvid: true,
  hasHevcNvenc: true,
  hasH264Nvenc: true,
  hasAv1Nvenc: false,
  message: 'ok',
}

function setupMocks(overrides: {
  config?: Record<string, unknown>
  gpu?: Record<string, unknown>
  tools?: unknown
  history?: unknown[]
} = {}) {
  mockInvoke('get_config', async () =>
    JSON.stringify({
      clip_extraction_mode: 'gpu',
      force_cpu: false,
      ...(overrides.config ?? {}),
    })
  )
  mockInvoke('video_gpu_status', async () =>
    JSON.stringify({ ...GPU_OK, ...(overrides.gpu ?? {}) })
  )
  mockInvoke('tools_status', async () =>
    overrides.tools ?? { ok: true, toolsDir: 'C:/tools', binaries: [] }
  )
  mockInvoke('download_history', async () => overrides.history ?? [])
  mockInvoke('reveal_in_folder', async () => undefined)
}

describe('HomePanel', () => {
  beforeEach(() => {
    setupMocks()
    window.localStorage.clear()
  })

  // -- Tool board ---------------------------------------------------------

  it('renders a card for every tool in the sidebar, including the two that used to be missing', async () => {
    await renderHome()
    for (const title of [
      'Downloader',
      'Tsukyio Vault',
      'Scene Splitter',
      'Dead Frame Remover',
      'BG Remover',
      'Frame Interpolation',
      'Vocal Separation',
      'Video Conversion',
      'Audio Conversion',
    ]) {
      expect(screen.getByText(title)).toBeInTheDocument()
    }
  })

  it('groups the tools into the four stages of an edit, in order', async () => {
    const { container } = await renderHome()
    const labels = Array.from(container.querySelectorAll('.home-stage-label')).map(
      (node) => node.textContent
    )
    expect(labels).toEqual([
      'Get footage',
      'Find your cuts',
      'Clean up the footage',
      'Prep for your editor',
    ])
  })

  it('navigates to the tool when its card is clicked', async () => {
    const { onNavigate } = await renderHome()
    fireEvent.click(screen.getByText('Frame Interpolation'))
    expect(onNavigate).toHaveBeenCalledWith('interpolation')
  })

  it('reaches Settings and Logs from the rail footer', async () => {
    const { onNavigate } = await renderHome()
    fireEvent.click(screen.getByRole('button', { name: /^Settings$/ }))
    expect(onNavigate).toHaveBeenCalledWith('settings')
    fireEvent.click(screen.getByRole('button', { name: /^Logs$/ }))
    expect(onNavigate).toHaveBeenCalledWith('logs')
  })

  // -- Ready to run -------------------------------------------------------

  it('reports a healthy machine with no call to action', async () => {
    render(<HomePanel onNavigate={vi.fn()} />)
    expect(await screen.findByText('Running on your graphics card')).toBeInTheDocument()
    expect(screen.getByText('NVIDIA GeForce RTX 4070 is doing the heavy work.')).toBeInTheDocument()
    expect(screen.getByText('All clear')).toBeInTheDocument()
    expect(screen.queryByText('Change this in Settings')).not.toBeInTheDocument()
  })

  it('warns when GPU mode is selected but no usable GPU was found', async () => {
    setupMocks({ gpu: { compatible: false, gpuName: null, hasH264Nvenc: false, hasHevcNvenc: false } })
    render(<HomePanel onNavigate={vi.fn()} />)
    expect(
      await screen.findByText('Set to graphics card, but none was found')
    ).toBeInTheDocument()
    expect(screen.getByText('Check this')).toBeInTheDocument()
  })

  it('names the missing tools and says what will break', async () => {
    setupMocks({
      tools: {
        ok: false,
        toolsDir: 'C:/tools',
        binaries: [
          { name: 'ffmpeg', present: false, valid: false, missingFiles: ['ffmpeg.exe'] },
          { name: 'yt-dlp', present: true, valid: true, missingFiles: [] },
        ],
      },
    })
    render(<HomePanel onNavigate={vi.fn()} />)
    expect(await screen.findByText('1 required tool is missing')).toBeInTheDocument()
    expect(
      screen.getByText('Scene detection and exports will fail until ffmpeg installs.')
    ).toBeInTheDocument()
  })

  it('sends the user to Settings from the readiness call to action', async () => {
    setupMocks({ config: { clip_extraction_mode: 'cpu' } })
    const onNavigate = vi.fn()
    render(<HomePanel onNavigate={onNavigate} />)
    fireEvent.click(await screen.findByText('Change this in Settings'))
    expect(onNavigate).toHaveBeenCalledWith('settings')
  })

  it('stays usable when every status call fails', async () => {
    mockInvoke('get_config', async () => { throw new Error('nope') })
    mockInvoke('video_gpu_status', async () => { throw new Error('nope') })
    mockInvoke('tools_status', async () => { throw new Error('nope') })
    mockInvoke('download_history', async () => { throw new Error('nope') })
    render(<HomePanel onNavigate={vi.fn()} />)
    expect(await screen.findByText('Hardware setting unknown')).toBeInTheDocument()
    expect(screen.getByText('Scene Splitter')).toBeInTheDocument()
  })

  // -- Pick up where you left off -----------------------------------------

  it('offers a way back into the last tool that was open', async () => {
    window.localStorage.setItem(
      'ui.home.lastTool',
      JSON.stringify({ id: 'clip-hunting', at: Date.now() - 2 * 60 * 60 * 1000 })
    )
    const { onNavigate } = await renderHome()
    expect(screen.getByText('2 hours ago')).toBeInTheDocument()
    fireEvent.click(screen.getByText('2 hours ago'))
    expect(onNavigate).toHaveBeenCalledWith('clip-hunting')
  })

  it('suggests a starting point when no tool has been opened yet', async () => {
    const { onNavigate } = await renderHome()
    fireEvent.click(screen.getByText('Open Scene Splitter'))
    expect(onNavigate).toHaveBeenCalledWith('clip-hunting')
  })

  // -- Recent downloads ---------------------------------------------------

  it('lists the newest downloads and opens one in File Explorer', async () => {
    setupMocks({
      history: [
        {
          id: 'a',
          createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
          kind: 'anime',
          title: 'Frieren',
          subtitle: 'Episode 12',
          qualityLabel: '1080p',
          url: 'https://example.test/a',
          outputPath: 'C:/downloads/frieren-12.mp4',
        },
      ],
    })
    render(<HomePanel onNavigate={vi.fn()} />)
    expect(await screen.findByText('Frieren')).toBeInTheDocument()
    expect(screen.getByText('Episode 12 · 1080p · 30 minutes ago')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Frieren'))
    await waitFor(() =>
      expect(mockInvokeFn).toHaveBeenCalledWith('reveal_in_folder', {
        path: 'C:/downloads/frieren-12.mp4',
      })
    )
  })

  it('invites a first download when the history is empty', async () => {
    const onNavigate = vi.fn()
    render(<HomePanel onNavigate={onNavigate} />)
    fireEvent.click(await screen.findByText('Open Downloader'))
    expect(onNavigate).toHaveBeenCalledWith('downloader')
  })
})
