/**
 * src/features/audio/MediaToAudioPanel.test.tsx
 *
 * Tests for MediaToAudioPanel — format toggle, file selection, conversion
 * invoke, progress events, batch error handling.
 */

import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockInvoke, mockInvokeFn, dispatchTauriEvent } from '../../../tests/setup/tauri'
import { mockDialogOpen } from '../../../tests/setup/dialog'

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: vi.fn(() => Promise.resolve(() => {})),
  }),
}))

import { MediaToAudioPanel } from './MediaToAudioPanel'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConversionDonePayload(output: string): string {
  return JSON.stringify({ output })
}

function setupConversionMocks() {
  mockInvoke('media_to_audio', ({ inputPath, outputFormat }: { inputPath: string; outputFormat: string }) => {
    const base = inputPath.replace(/\.[^.]+$/, '')
    return makeConversionDonePayload(`${base}.${outputFormat}`)
  })
  mockInvoke('discord_set_state', () => null)
  mockInvoke('discord_clear', () => null)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MediaToAudioPanel', () => {
  beforeEach(() => {
    setupConversionMocks()
  })

  it('renders WAV and MP3 format toggle buttons', () => {
    render(<MediaToAudioPanel />)
    expect(screen.getByRole('button', { name: 'WAV' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'MP3' })).toBeInTheDocument()
  })

  it('WAV is selected by default', () => {
    render(<MediaToAudioPanel />)
    expect(screen.getByRole('button', { name: 'WAV' })).toHaveClass('is-active')
    expect(screen.getByRole('button', { name: 'MP3' })).not.toHaveClass('is-active')
  })

  it('switches to MP3 when MP3 button is clicked', async () => {
    render(<MediaToAudioPanel />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'MP3' }))
    expect(screen.getByRole('button', { name: 'MP3' })).toHaveClass('is-active')
    expect(screen.getByRole('button', { name: 'WAV' })).not.toHaveClass('is-active')
  })

  it('shows "Select files" button when no files are selected', () => {
    render(<MediaToAudioPanel />)
    expect(screen.getByRole('button', { name: /select files/i })).toBeInTheDocument()
  })

  it('opens file dialog and accepts selected file', async () => {
    mockDialogOpen.mockResolvedValueOnce(['/media/song.mp4'])
    render(<MediaToAudioPanel />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /select files/i }))
    // After selection, the panel updates (no crash)
    await waitFor(() => {
      expect(mockDialogOpen).toHaveBeenCalledOnce()
    })
  })

  it('invokes media_to_audio with inputPath and outputFormat=wav', async () => {
    mockDialogOpen.mockResolvedValueOnce(['/media/clip.mkv'])
    render(<MediaToAudioPanel />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /select files/i }))

    // Wait for file to be selected, then start conversion
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /change files/i })).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: /start/i }))

    await waitFor(() => {
      expect(mockInvokeFn).toHaveBeenCalledWith(
        'media_to_audio',
        expect.objectContaining({ inputPath: '/media/clip.mkv', outputFormat: 'wav' }),
      )
    })
  })

  it('invokes media_to_audio with outputFormat=mp3 when MP3 is selected', async () => {
    mockDialogOpen.mockResolvedValueOnce(['/media/clip.mkv'])
    render(<MediaToAudioPanel />)
    const user = userEvent.setup()

    // Switch to MP3 first
    await user.click(screen.getByRole('button', { name: 'MP3' }))
    await user.click(screen.getByRole('button', { name: /select files/i }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /change files/i })).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: /start/i }))

    await waitFor(() => {
      expect(mockInvokeFn).toHaveBeenCalledWith(
        'media_to_audio',
        expect.objectContaining({ outputFormat: 'mp3' }),
      )
    })
  })

  it('shows conversion progress from conversion-progress event', async () => {
    let resolveConversion!: (v: string) => void
    mockInvoke('media_to_audio', () =>
      new Promise<string>((res) => {
        resolveConversion = res
      }),
    )

    mockDialogOpen.mockResolvedValueOnce(['/media/song.mp4'])
    render(<MediaToAudioPanel />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /select files/i }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /change files/i })).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: /start/i }))

    // Dispatch a conversion progress event
    act(() => {
      dispatchTauriEvent('conversion-progress', {
        stage: 'converting',
        percent: 42,
        message: 'Encoding audio stream...',
      })
    })

    await waitFor(() => {
      expect(screen.getByText('Encoding audio stream...')).toBeInTheDocument()
    })

    act(() => { resolveConversion(makeConversionDonePayload('/media/song.wav')) })
  })

  it('shows success output path after conversion completes', async () => {
    mockDialogOpen.mockResolvedValueOnce(['/media/song.mp4'])
    render(<MediaToAudioPanel />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /select files/i }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /change files/i })).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: /start/i }))

    await waitFor(() => {
      expect(screen.getByText(/song\.wav/i)).toBeInTheDocument()
    }, { timeout: 3000 })
  })
})
