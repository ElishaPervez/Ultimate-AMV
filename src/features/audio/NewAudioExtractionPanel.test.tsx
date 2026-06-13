/**
 * src/features/audio/NewAudioExtractionPanel.test.tsx
 *
 * Tests for NewAudioExtractionPanel — dependency gating / setup flow, happy-path
 * extraction, all-failed batches (error card, not the stem mixer), partial
 * failures, cancel flow (both branches), and progress events.
 *
 * Module-level status cache:
 * NewAudioExtractionPanel.tsx caches `audio_status` in module scope
 * (`cachedAudioStatus` / `pendingAudioStatus`), so a status fetched by one test
 * would leak into the next render. Every test therefore gets a fresh module via
 * vi.resetModules() + dynamic import in beforeEach — no ordering constraints,
 * no soft-skips.
 *
 * Behaviors that changed since the legacy AudioExtractionPanel suite:
 * - When EVERY file in a batch fails, the ERROR ResultCard renders instead of
 *   the StemMixerCard fallback ("stems are saved but preview is unavailable").
 * - The resultMessage ("X/Y files extracted...", "Extraction cancelled. N
 *   file(s) saved before cancel.") is now rendered in the "Extraction
 *   Complete" side card; the legacy panel kept it as internal state only.
 */

import { render, screen, waitFor, within, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockInvoke, mockInvokeFn, dispatchTauriEvent } from '../../../tests/setup/tauri'
import { mockDialogOpen } from '../../../tests/setup/dialog'

// Mock webview so useFileDrop doesn't fail
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: vi.fn(() => Promise.resolve(() => {})),
  }),
}))

// Fresh component per test so the module-level audio_status cache never leaks.
let NewAudioExtractionPanel: (typeof import('./NewAudioExtractionPanel'))['NewAudioExtractionPanel']

beforeEach(async () => {
  vi.resetModules()
  ;({ NewAudioExtractionPanel } = await import('./NewAudioExtractionPanel'))
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStatusPayload(gpuType = 'none', ready = true): string {
  return JSON.stringify({
    type: 'status',
    hardware: {
      device: gpuType === 'nvidia' ? 'NVIDIA RTX 3080' : 'CPU',
      device_short: gpuType === 'nvidia' ? 'RTX 3080' : 'CPU',
      gpu_type: gpuType,
      fp16_capable: gpuType === 'nvidia',
      provider: gpuType === 'nvidia' ? 'CUDAExecutionProvider' : 'CPUExecutionProvider',
    },
    dependencies: {
      audio_separator: ready,
      pydub: ready,
      typing_extensions: true,
      torch: ready,
      onnxruntime: ready,
      runtime_ready: ready,
      ready,
    },
    model_name: 'MDX23C-8KFFT',
  })
}

function makeExtractPayload(inputPath: string): string {
  // Use [Vocals] and [Instrumental] so classifyStems finds both stems
  const stem = inputPath.replace(/\.[^.]+$/, '')
  return JSON.stringify({
    type: 'done',
    outputs: [`${stem}_[Vocals].wav`, `${stem}_[Instrumental].wav`],
  })
}

function setupReadySystem() {
  mockInvoke('audio_status', () => makeStatusPayload('none', true))
  mockInvoke('discord_set_state', () => null)
  mockInvoke('discord_clear', () => null)
  mockInvoke('cancel_audio', () => null)
  mockInvoke('open_path', () => null)
}

/** Render the panel with deps ready and wait for the file picker stage. */
async function renderReadyPanel() {
  render(<NewAudioExtractionPanel />)
  await waitFor(() => {
    expect(screen.getByText('Select files')).toBeInTheDocument()
  })
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe('NewAudioExtractionPanel — initial state', () => {
  beforeEach(() => {
    setupReadySystem()
  })

  it('shows the SelectFileButton (file picker) once audio_status resolves ready', async () => {
    await renderReadyPanel()
    expect(screen.getByRole('button', { name: /select files/i })).toBeInTheDocument()
  })

  it('shows the hero status list with model name and "Ready" dependencies', async () => {
    await renderReadyPanel()
    expect(screen.getByText('MDX23C-8KFFT')).toBeInTheDocument()
    expect(screen.getByText('Ready')).toBeInTheDocument()
  })

  it('renders the drop-zone root and enables the hero CTA when deps are ready', async () => {
    const { container } = render(<NewAudioExtractionPanel />)
    expect(container.querySelector('.new-audio-panel.drop-zone')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /choose files/i })).not.toBeDisabled()
    })
  })
})

// ---------------------------------------------------------------------------
// Dependency gating / setup flow
// ---------------------------------------------------------------------------

describe('NewAudioExtractionPanel — dependency gating', () => {
  beforeEach(() => {
    mockInvoke('discord_set_state', () => null)
    mockInvoke('discord_clear', () => null)
  })

  it('renders DepInstallCard (not the picker) when dependencies are not ready', async () => {
    mockInvoke('audio_status', () => makeStatusPayload('none', false))
    render(<NewAudioExtractionPanel />)

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /one-time engine setup/i })).toBeInTheDocument()
    })
    expect(screen.queryByText('Select files')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /choose files/i })).toBeDisabled()
  })

  it('invokes audio_setup with mode=cpu and shows SetupRunningCard while running', async () => {
    mockInvoke('audio_status', () => makeStatusPayload('none', false))
    let resolveSetup!: (v: string) => void
    mockInvoke('audio_setup', () => new Promise<string>((res) => { resolveSetup = res }))

    render(<NewAudioExtractionPanel />)
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /one-time engine setup/i })).toBeInTheDocument()
    })

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /install cpu only/i }))

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /installing cpu engine/i })).toBeInTheDocument()
    })
    expect(mockInvokeFn).toHaveBeenCalledWith('audio_setup', { mode: 'cpu' })

    act(() => { resolveSetup(JSON.stringify({ type: 'setup-complete' })) })
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /installing cpu engine/i })).not.toBeInTheDocument()
    })
  })

  it('invokes audio_setup with mode=gpu when the GPU install button is clicked', async () => {
    mockInvoke('audio_status', () => makeStatusPayload('nvidia', false))
    let resolveSetup!: (v: string) => void
    mockInvoke('audio_setup', () => new Promise<string>((res) => { resolveSetup = res }))

    render(<NewAudioExtractionPanel />)
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /one-time engine setup/i })).toBeInTheDocument()
    })

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /install gpu mode/i }))

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /installing gpu engine/i })).toBeInTheDocument()
    })
    expect(mockInvokeFn).toHaveBeenCalledWith('audio_setup', { mode: 'gpu' })

    act(() => { resolveSetup(JSON.stringify({ type: 'setup-complete' })) })
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /installing gpu engine/i })).not.toBeInTheDocument()
    })
  })

  it('propagates audio-setup-progress events to SetupRunningCard', async () => {
    mockInvoke('audio_status', () => makeStatusPayload('none', false))
    let resolveSetup!: (v: string) => void
    mockInvoke('audio_setup', () => new Promise<string>((res) => { resolveSetup = res }))

    render(<NewAudioExtractionPanel />)
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /one-time engine setup/i })).toBeInTheDocument()
    })

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /install cpu only/i }))
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /installing cpu engine/i })).toBeInTheDocument()
    })

    act(() => {
      dispatchTauriEvent('audio-setup-progress', {
        type: 'setup-progress',
        step: 3,
        total: 5,
        state: 'running',
        message: 'Installing PyTorch...',
      })
    })

    await waitFor(() => {
      expect(screen.getByText('Step 3 of 5')).toBeInTheDocument()
    })
    expect(screen.getByText('Installing PyTorch...')).toBeInTheDocument()

    act(() => { resolveSetup(JSON.stringify({ type: 'setup-complete' })) })
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /installing cpu engine/i })).not.toBeInTheDocument()
    })
  })

  it('shows the setup notice and the picker after setup completes and status flips ready', async () => {
    let ready = false
    mockInvoke('audio_status', () => makeStatusPayload('none', ready))
    mockInvoke('audio_setup', () => {
      ready = true
      return JSON.stringify({ type: 'setup-complete' })
    })

    render(<NewAudioExtractionPanel />)
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /one-time engine setup/i })).toBeInTheDocument()
    })

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /install cpu only/i }))

    // audio_setup resolves → refreshStatus(true) re-fetches the now-ready status
    await waitFor(() => {
      expect(screen.getByText('Select files')).toBeInTheDocument()
    })
    expect(screen.getByText('CPU engine ready. Pick a file to extract.')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('NewAudioExtractionPanel — happy path', () => {
  beforeEach(() => {
    setupReadySystem()
  })

  it('invokes audio_extract for the picked file and renders the StemMixerCard', async () => {
    mockInvoke('audio_extract', ({ inputPath }: { inputPath: string }) =>
      makeExtractPayload(inputPath),
    )
    mockDialogOpen.mockResolvedValueOnce(['/music/track1.mp3'])
    await renderReadyPanel()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /select files/i }))

    await waitFor(() => {
      expect(screen.getByRole('region', { name: /stem mixer/i })).toBeInTheDocument()
    })
    expect(mockInvokeFn).toHaveBeenCalledWith('audio_extract', { inputPath: '/music/track1.mp3' })
    expect(screen.getByRole('button', { name: /extract another file/i })).toBeInTheDocument()
    expect(screen.getByText('1/1 files extracted. 2 stems saved.')).toBeInTheDocument()
  })

  it('extracts a batch in order and shows a "Done" batch row per file', async () => {
    const files = ['/music/track1.mp3', '/music/track2.mp3']
    const extractCalls: string[] = []
    mockInvoke('audio_extract', ({ inputPath }: { inputPath: string }) => {
      extractCalls.push(inputPath)
      return makeExtractPayload(inputPath)
    })
    mockDialogOpen.mockResolvedValueOnce(files)
    await renderReadyPanel()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /select files/i }))

    await waitFor(() => {
      expect(screen.getByRole('region', { name: /stem mixer/i })).toBeInTheDocument()
    })
    expect(extractCalls).toEqual(files)
    expect(screen.getAllByText('Done')).toHaveLength(2)
    expect(screen.getByText('2/2 files extracted. 4 stems saved.')).toBeInTheDocument()
  })

  it('stays on the picker and never invokes audio_extract when the dialog is cancelled', async () => {
    const extractCalls: string[] = []
    mockInvoke('audio_extract', ({ inputPath }: { inputPath: string }) => {
      extractCalls.push(inputPath)
      return makeExtractPayload(inputPath)
    })
    // mockDialogOpen resolves null by default (user cancelled)
    await renderReadyPanel()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /select files/i }))

    await waitFor(() => {
      expect(mockDialogOpen).toHaveBeenCalledOnce()
    })
    expect(extractCalls).toHaveLength(0)
    expect(screen.getByText('Select files')).toBeInTheDocument()
  })

  it('force-refreshes audio_status after the batch completes', async () => {
    let statusCalls = 0
    mockInvoke('audio_status', () => {
      statusCalls += 1
      return makeStatusPayload('none', true)
    })
    mockInvoke('audio_extract', ({ inputPath }: { inputPath: string }) =>
      makeExtractPayload(inputPath),
    )
    mockDialogOpen.mockResolvedValueOnce(['/music/track1.mp3'])
    await renderReadyPanel()
    expect(statusCalls).toBe(1)

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /select files/i }))

    await waitFor(() => {
      expect(screen.getByRole('region', { name: /stem mixer/i })).toBeInTheDocument()
    })
    expect(statusCalls).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// All files failed → ERROR ResultCard, not the stem mixer
// ---------------------------------------------------------------------------

describe('NewAudioExtractionPanel — all files failed', () => {
  beforeEach(() => {
    setupReadySystem()
  })

  it('shows the error ResultCard with the raw bridge error when the single file fails', async () => {
    mockInvoke('audio_extract', () => {
      throw new Error('Processing failed: OOM')
    })
    mockDialogOpen.mockResolvedValueOnce(['/music/track1.mp3'])
    await renderReadyPanel()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /select files/i }))

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /extraction failed/i })).toBeInTheDocument()
    })
    const card = screen.getByRole('heading', { name: /extraction failed/i }).closest('section')!
    expect(within(card).getByText('Processing failed: OOM')).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: /try again/i })).toBeInTheDocument()
    // The stem mixer (full or fallback) must NOT render
    expect(screen.queryByRole('region', { name: /stem mixer/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/stems are saved but preview is unavailable/i)).not.toBeInTheDocument()
  })

  it('shows the "All N files failed" summary with the first error when every file fails', async () => {
    mockInvoke('audio_extract', ({ inputPath }: { inputPath: string }) => {
      throw new Error(inputPath.includes('track1') ? 'boom one' : 'boom two')
    })
    mockDialogOpen.mockResolvedValueOnce(['/music/track1.mp3', '/music/track2.mp3'])
    await renderReadyPanel()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /select files/i }))

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /extraction failed/i })).toBeInTheDocument()
    })
    expect(
      screen.getAllByText('All 2 files failed to extract. First error: boom one').length,
    ).toBeGreaterThan(0)
    expect(document.querySelectorAll('.batch-status-row.is-error')).toHaveLength(2)
    expect(screen.queryByRole('region', { name: /stem mixer/i })).not.toBeInTheDocument()
  })

  it('re-runs the same files from "Try again" and reaches the stem mixer on success', async () => {
    let attempt = 0
    mockInvoke('audio_extract', ({ inputPath }: { inputPath: string }) => {
      attempt += 1
      if (attempt === 1) throw new Error('transient GPU error')
      return makeExtractPayload(inputPath)
    })
    mockDialogOpen.mockResolvedValueOnce(['/music/track1.mp3'])
    await renderReadyPanel()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /select files/i }))

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /extraction failed/i })).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: /try again/i }))

    await waitFor(() => {
      expect(screen.getByRole('region', { name: /stem mixer/i })).toBeInTheDocument()
    })
    expect(attempt).toBe(2)
    expect(mockDialogOpen).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// Partial failure
// ---------------------------------------------------------------------------

describe('NewAudioExtractionPanel — partial failure', () => {
  beforeEach(() => {
    setupReadySystem()
  })

  it('shows the X/Y result message, the stem mixer, and a per-file error row', async () => {
    mockInvoke('audio_extract', ({ inputPath }: { inputPath: string }) => {
      if (inputPath.includes('track1')) throw new Error('codec error')
      return makeExtractPayload(inputPath)
    })
    mockDialogOpen.mockResolvedValueOnce(['/music/track1.mp3', '/music/track2.mp3'])
    await renderReadyPanel()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /select files/i }))

    await waitFor(() => {
      expect(screen.getByRole('region', { name: /stem mixer/i })).toBeInTheDocument()
    })
    expect(screen.getByText('1/2 files extracted. 2 stems saved.')).toBeInTheDocument()
    // Mixed batch: one failed row (with its message) and one done row
    const errorRows = document.querySelectorAll('.batch-status-row.is-error')
    expect(errorRows).toHaveLength(1)
    expect(errorRows[0].textContent).toContain('codec error')
    expect(screen.getAllByText('Done')).toHaveLength(1)
    // A partial failure is NOT the all-failed error card
    expect(screen.queryByRole('heading', { name: /extraction failed/i })).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Cancel flow
// ---------------------------------------------------------------------------

describe('NewAudioExtractionPanel — cancel flow', () => {
  beforeEach(() => {
    setupReadySystem()
  })

  it('invokes cancel_audio and reverts to the picker when cancelled with 0 files done', async () => {
    let rejectExtract!: (e: Error) => void
    mockInvoke('audio_extract', () =>
      new Promise<string>((_, rej) => { rejectExtract = rej }),
    )
    mockDialogOpen.mockResolvedValueOnce(['/music/track1.mp3'])
    await renderReadyPanel()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /select files/i }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument()
    })

    // Click cancel → sets the cancelling ref and invokes the backend kill
    await user.click(screen.getByRole('button', { name: /cancel/i }))
    expect(mockInvokeFn).toHaveBeenCalledWith('cancel_audio')

    // Reject the in-flight promise so the batch loop's await settles
    act(() => { rejectExtract(new Error('cancelled')) })

    // 0 outputs → selection cleared → picker shown, no result card of any kind
    await waitFor(() => {
      expect(screen.getByText('Select files')).toBeInTheDocument()
    })
    expect(screen.queryByRole('button', { name: /extract another file/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/extraction cancelled/i)).not.toBeInTheDocument()
  })

  it('shows "Extraction cancelled. N file(s) saved before cancel." when cancelled mid-batch', async () => {
    let rejectSecond!: (e: Error) => void
    const extractCalls: string[] = []
    mockInvoke('audio_extract', ({ inputPath }: { inputPath: string }) => {
      extractCalls.push(inputPath)
      if (extractCalls.length === 1) {
        return Promise.resolve(makeExtractPayload(inputPath))
      }
      return new Promise<string>((_, rej) => { rejectSecond = rej })
    })
    mockDialogOpen.mockResolvedValueOnce(['/music/track1.mp3', '/music/track2.mp3'])
    await renderReadyPanel()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /select files/i }))

    // Wait until the second file is in flight, then cancel
    await waitFor(() => {
      expect(extractCalls).toHaveLength(2)
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument()
    })
    await user.click(screen.getByRole('button', { name: /cancel/i }))
    act(() => { rejectSecond(new Error('cancelled')) })

    // 1 file's outputs survived → cancel message + stem mixer, not the picker
    await waitFor(() => {
      expect(screen.getByText('Extraction cancelled. 1 file saved before cancel.')).toBeInTheDocument()
    })
    expect(screen.getByRole('region', { name: /stem mixer/i })).toBeInTheDocument()
    expect(screen.queryByText('Select files')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// audio-progress event forwarding
// ---------------------------------------------------------------------------

describe('NewAudioExtractionPanel — audio-progress events', () => {
  beforeEach(() => {
    setupReadySystem()
  })

  it('shows the per-file message and an indeterminate bar before any progress event', async () => {
    let resolveExtract!: (v: string) => void
    mockInvoke('audio_extract', () =>
      new Promise<string>((res) => { resolveExtract = res }),
    )
    mockDialogOpen.mockResolvedValueOnce(['/music/track1.mp3'])
    await renderReadyPanel()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /select files/i }))

    await waitFor(() => {
      expect(screen.getByText('File 1/1: track1.mp3')).toBeInTheDocument()
    })
    expect(screen.getByRole('progressbar')).toHaveClass('is-indeterminate')

    // Clean up the hanging promise
    act(() => { resolveExtract(makeExtractPayload('/music/track1.mp3')) })
    await waitFor(() => {
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    })
  })

  it('updates the ExtractionProgressCard heading, bar, and message from audio-progress', async () => {
    let resolveExtract!: (v: string) => void
    mockInvoke('audio_extract', () =>
      new Promise<string>((res) => { resolveExtract = res }),
    )
    mockDialogOpen.mockResolvedValueOnce(['/music/track1.mp3'])
    await renderReadyPanel()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /select files/i }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument()
    })

    act(() => {
      dispatchTauriEvent('audio-progress', {
        type: 'progress',
        stage: 'processing',
        percent: 65,
        message: 'Separating stems...',
      })
    })

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /extracting vocals : 65%/i })).toBeInTheDocument()
    })
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '65')
    expect(screen.getByText('Separating stems...')).toBeInTheDocument()

    act(() => { resolveExtract(makeExtractPayload('/music/track1.mp3')) })
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument()
    })
  })
})
