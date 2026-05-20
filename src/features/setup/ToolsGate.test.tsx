/**
 * Tests for ToolsGate component.
 * Depth from root: src/features/setup/ -> depth 3 -> ../../../tests/setup/tauri
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockInvoke, dispatchTauriEvent, mockInvokeFn } from '../../../tests/setup/tauri'
import { ToolsGate } from './ToolsGate'

function makeToolsStatus(ok: boolean, binaries?: Array<{ name: string; present: boolean; valid: boolean; missingFiles: string[] }>) {
  return {
    ok,
    toolsDir: 'C:\\Users\\test\\AppData\\Local\\com.elishapervez.ultimateamv\\tools',
    binaries: binaries ?? [
      { name: 'ffmpeg', present: ok, valid: ok, missingFiles: ok ? [] : ['ffmpeg.exe'] },
      { name: 'yt-dlp', present: ok, valid: ok, missingFiles: ok ? [] : ['yt-dlp.exe'] },
    ],
  }
}

describe('ToolsGate', () => {
  beforeEach(() => {
    mockInvoke('frontend_log', () => undefined)
  })

  it('shows checking spinner while loading', () => {
    // Never resolves — component stays in checking phase
    mockInvoke('tools_status', () => new Promise(() => {}))
    render(<ToolsGate onReady={vi.fn()} />)
    expect(screen.getByText('Checking media tools...')).toBeInTheDocument()
  })

  it('calls onReady when tools are already ok', async () => {
    const onReady = vi.fn()
    mockInvoke('tools_status', () => makeToolsStatus(true))
    render(<ToolsGate onReady={onReady} />)
    await waitFor(() => {
      expect(onReady).toHaveBeenCalledTimes(1)
    })
  })

  it('shows missing-tools UI when tools are not ok', async () => {
    mockInvoke('tools_status', () => makeToolsStatus(false))
    render(<ToolsGate onReady={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('First-launch tools download')).toBeInTheDocument()
    })
  })

  it('shows the tools directory path in footnote', async () => {
    mockInvoke('tools_status', () => makeToolsStatus(false))
    render(<ToolsGate onReady={vi.fn()} />)
    await waitFor(() => {
      expect(
        screen.getByText(/com\.elishapervez\.ultimateamv/),
      ).toBeInTheDocument()
    })
  })

  it('shows each binary name in the list', async () => {
    mockInvoke('tools_status', () => makeToolsStatus(false))
    render(<ToolsGate onReady={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('ffmpeg')).toBeInTheDocument()
      expect(screen.getByText('yt-dlp')).toBeInTheDocument()
    })
  })

  it('Download tools button calls tools_install', async () => {
    const user = userEvent.setup()
    mockInvoke('tools_status', () => makeToolsStatus(false))
    // tools_install hangs so we can inspect the call
    mockInvoke('tools_install', () => new Promise(() => {}))
    render(<ToolsGate onReady={vi.fn()} />)

    await waitFor(() => screen.getByText('Download tools'))
    await user.click(screen.getByRole('button', { name: /download tools/i }))

    await waitFor(() => {
      const installCalls = mockInvokeFn.mock.calls.filter(([cmd]) => cmd === 'tools_install')
      expect(installCalls.length).toBeGreaterThan(0)
    })
  })

  it('shows installing UI after clicking Download tools', async () => {
    const user = userEvent.setup()
    mockInvoke('tools_status', () => makeToolsStatus(false))
    mockInvoke('tools_install', () => new Promise(() => {}))
    render(<ToolsGate onReady={vi.fn()} />)

    await waitFor(() => screen.getByText('Download tools'))
    await user.click(screen.getByRole('button', { name: /download tools/i }))

    await waitFor(() => {
      expect(screen.getByText('Setting up media tools')).toBeInTheDocument()
    })
  })

  it('shows Cancel button during install', async () => {
    const user = userEvent.setup()
    mockInvoke('tools_status', () => makeToolsStatus(false))
    mockInvoke('tools_install', () => new Promise(() => {}))
    render(<ToolsGate onReady={vi.fn()} />)

    await waitFor(() => screen.getByText('Download tools'))
    await user.click(screen.getByRole('button', { name: /download tools/i }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument()
    })
  })

  it('Cancel button calls tools_cancel', async () => {
    const user = userEvent.setup()
    mockInvoke('tools_status', () => makeToolsStatus(false))
    mockInvoke('tools_install', () => new Promise(() => {}))
    mockInvoke('tools_cancel', () => undefined)
    render(<ToolsGate onReady={vi.fn()} />)

    await waitFor(() => screen.getByText('Download tools'))
    await user.click(screen.getByRole('button', { name: /download tools/i }))
    await waitFor(() => screen.getByRole('button', { name: /cancel/i }))
    await user.click(screen.getByRole('button', { name: /cancel/i }))

    await waitFor(() => {
      const cancelCalls = mockInvokeFn.mock.calls.filter(([cmd]) => cmd === 'tools_cancel')
      expect(cancelCalls.length).toBeGreaterThan(0)
    })
  })

  it('shows progress update from tools-progress event', async () => {
    const user = userEvent.setup()
    mockInvoke('tools_status', () => makeToolsStatus(false))
    mockInvoke('tools_install', () => new Promise(() => {}))
    render(<ToolsGate onReady={vi.fn()} />)

    await waitFor(() => screen.getByText('Download tools'))
    await user.click(screen.getByRole('button', { name: /download tools/i }))

    // Wait for install phase
    await waitFor(() => screen.getByText('Setting up media tools'))

    // Dispatch a download-progress event
    dispatchTauriEvent('tools-progress', {
      type: 'download-progress',
      binary: 'ffmpeg',
      downloadedBytes: 1024 * 1024 * 50,
      totalBytes: 1024 * 1024 * 100,
    })

    await waitFor(() => {
      // ffmpeg row should be in downloading state
      expect(screen.getByText('Downloading')).toBeInTheDocument()
    })
  })

  it('shows error state when tools_status rejects', async () => {
    // BUG: when tools_status throws, ToolsGate sets phase="error" but status
    // remains null.  The guard at line 244 (`if (phase === "checking" || !status)`)
    // causes the checking-spinner to stay visible even though phase is "error".
    // The correct behaviour is: if the initial status check fails, show an error
    // to the user rather than spinning indefinitely.
    // Leave this test failing until the component is fixed.
    mockInvoke('tools_status', () => { throw new Error('Network error') })
    render(<ToolsGate onReady={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText(/tools install failed/i)).toBeInTheDocument()
    })
  })

  it('calls onReady after successful install and re-check shows ok', async () => {
    const user = userEvent.setup()
    const onReady = vi.fn()
    let statusCallCount = 0
    mockInvoke('tools_status', () => {
      statusCallCount += 1
      // First call: not ok; second call (after install): ok
      return makeToolsStatus(statusCallCount > 1)
    })
    mockInvoke('tools_install', async () => undefined)
    render(<ToolsGate onReady={onReady} />)

    await waitFor(() => screen.getByText('Download tools'))
    await user.click(screen.getByRole('button', { name: /download tools/i }))

    await waitFor(() => {
      expect(onReady).toHaveBeenCalledTimes(1)
    })
  })
})
