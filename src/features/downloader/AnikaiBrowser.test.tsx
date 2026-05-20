/**
 * Tests for AnikaiBrowser component.
 *
 * NOTE: AnikaiBrowser uses Tauri's Webview API heavily (Webview class,
 * getCurrentWindow, LogicalPosition, LogicalSize). These are native Tauri
 * primitives that cannot run in jsdom — they depend on the Tauri IPC bridge
 * to create and position native OS webview windows.
 *
 * Strategy:
 * - Mock all Tauri Webview / window APIs so the component can mount.
 * - Test only the pure-React portions: toolbar rendering, address bar,
 *   provider select, stream-capture bar UI, EpisodeLabelModal integration,
 *   and event-driven state (via dispatchTauriEvent).
 * - Document which pieces are NOT testable in jsdom.
 */

import React from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { mockInvoke, dispatchTauriEvent, mockListenFn } from '../../../tests/setup/tauri'

// ---------------------------------------------------------------------------
// Mock Tauri Webview APIs — they are native-only and crash in jsdom.
// vi.mock factories are hoisted ABOVE all imports, so we cannot reference
// local variables declared here. Use vi.hoisted() to safely share state.
// ---------------------------------------------------------------------------

const { mockWebviewOnce, MockWebviewCtor } = vi.hoisted(() => {
  const mockWebviewOnce = vi.fn((_event: string, handler: () => void) => {
    if (_event === 'tauri://created') {
      Promise.resolve().then(handler)
    }
  })

  const mockInstance = {
    once: mockWebviewOnce,
    hide: vi.fn(async () => undefined),
    show: vi.fn(async () => undefined),
    setPosition: vi.fn(async () => undefined),
    setSize: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    label: 'anikai-provider-1',
  }

  const MockWebviewCtor = vi.fn().mockImplementation(() => mockInstance)
  // Static method — needed for Webview.getAll() call inside createProviderView
  ;(MockWebviewCtor as unknown as { getAll: () => Promise<unknown[]> }).getAll = vi.fn(async () => [])

  return { mockWebviewOnce, MockWebviewCtor }
})

vi.mock('@tauri-apps/api/webview', () => ({
  Webview: MockWebviewCtor,
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => ({ label: 'main' })),
}))

vi.mock('@tauri-apps/api/dpi', () => ({
  LogicalPosition: vi.fn().mockImplementation((x: number, y: number) => ({ x, y })),
  LogicalSize: vi.fn().mockImplementation((w: number, h: number) => ({ w, h })),
}))

// ---------------------------------------------------------------------------
// Import component AFTER mocks are set up
// ---------------------------------------------------------------------------

import { AnikaiBrowser } from './AnikaiBrowser'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupDefaultMocks() {
  mockInvoke('get_config', async () =>
    JSON.stringify({
      download_path: '/downloads',
      provider_url: 'https://anikai.to',
      clip_extraction_mode: 'gpu',
    })
  )
  mockInvoke('set_config', async () => undefined)
  mockInvoke('install_media_sniffer', async () => undefined)
  mockInvoke('inspect_stream', async () => [])
  mockInvoke('cancel_download', async () => undefined)
  mockInvoke('list_anime_folders', async () => [])
  mockInvoke('discord_set_state', async () => undefined)
}

const defaultProps = {
  active: true,
  sidebarExpanded: false,
  enqueueDownload: vi.fn(() => 'job-id-1'),
}

/**
 * Render AnikaiBrowser and wait for all startup async chains to settle:
 *  1. listen() hooks registered
 *  2. get_config invoke resolves and sets loadedUrl
 *  3. loadedUrl effect fires resetCaptureState then creates Webview
 *  4. Webview.once('tauri://created') fires (mocked as next microtask)
 *  5. install_media_sniffer invoked
 * A short setTimeout(30ms) inside act() drains all of this.
 */
async function renderAndSettle(props = defaultProps) {
  const result = render(<AnikaiBrowser {...props} />)
  // Wait for listen hooks to be registered (they are async .then chains)
  await waitFor(() => {
    const registered = mockListenFn.mock.calls.map(([name]) => name)
    expect(registered).toContain('media-candidate')
  })
  // Drain remaining microtasks and timers
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 30))
  })
  return result
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnikaiBrowser', () => {
  beforeEach(() => {
    setupDefaultMocks()
    MockWebviewCtor.mockClear()
    mockWebviewOnce.mockImplementation((_event: string, handler: () => void) => {
      if (_event === 'tauri://created') {
        Promise.resolve().then(handler)
      }
    })
  })

  it('renders the provider toolbar', () => {
    render(<AnikaiBrowser {...defaultProps} />)
    expect(screen.getByRole('button', { name: /AniKai/i })).toBeInTheDocument()
  })

  it('renders AniKai as the default option in the provider select', () => {
    render(<AnikaiBrowser {...defaultProps} />)
    expect(screen.getByRole('button', { name: /AniKai/i })).toBeInTheDocument()
  })

  it('renders AniWaves as an option in the provider select', () => {
    render(<AnikaiBrowser {...defaultProps} />)
    const trigger = screen.getByRole('button', { name: /AniKai/i })
    fireEvent.click(trigger)
    const options = screen.getAllByRole('option')
    const labels = options.map((o) => o.textContent)
    expect(labels).toContain('AniWaves')
  })

  it('renders Custom URL as an option', () => {
    render(<AnikaiBrowser {...defaultProps} />)
    const trigger = screen.getByRole('button', { name: /AniKai/i })
    fireEvent.click(trigger)
    const options = screen.getAllByRole('option')
    const labels = options.map((o) => o.textContent)
    expect(labels).toContain('Custom URL')
  })

  it('renders the address bar input', () => {
    render(<AnikaiBrowser {...defaultProps} />)
    expect(screen.getByRole('textbox', { name: /Provider address/i })).toBeInTheDocument()
  })

  it('shows locked (readOnly) address bar in preset mode', () => {
    render(<AnikaiBrowser {...defaultProps} />)
    const input = screen.getByRole('textbox', { name: /Provider address/i }) as HTMLInputElement
    expect(input.readOnly).toBe(true)
  })

  it('switching to Custom URL makes the address bar editable', async () => {
    render(<AnikaiBrowser {...defaultProps} />)
    const trigger = screen.getByRole('button', { name: /AniKai/i })
    fireEvent.click(trigger)
    const customOption = screen.getByRole('option', { name: /Custom URL/i })
    fireEvent.click(customOption)
    await waitFor(() => {
      const input = screen.getByRole('textbox', { name: /Provider address/i }) as HTMLInputElement
      expect(input.readOnly).toBe(false)
    })
  })

  it('shows a Go button in custom URL mode', async () => {
    render(<AnikaiBrowser {...defaultProps} />)
    const trigger = screen.getByRole('button', { name: /AniKai/i })
    fireEvent.click(trigger)
    const customOption = screen.getByRole('option', { name: /Custom URL/i })
    fireEvent.click(customOption)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Go' })).toBeInTheDocument()
    })
  })

  it('renders the Reload button', () => {
    render(<AnikaiBrowser {...defaultProps} />)
    expect(screen.getByRole('button', { name: /Reload/ })).toBeInTheDocument()
  })

  it('renders the stream capture bar', () => {
    render(<AnikaiBrowser {...defaultProps} />)
    expect(screen.getByRole('region', { name: /Detected stream/i })).toBeInTheDocument()
  })

  it('Download button is disabled when no stream is detected', () => {
    render(<AnikaiBrowser {...defaultProps} />)
    const downloadBtn = screen.getByRole('button', { name: /^Download$/ })
    expect(downloadBtn).toBeDisabled()
  })

  it('shows "No stream yet" in the capture bar when armed', () => {
    render(<AnikaiBrowser {...defaultProps} />)
    expect(screen.getByText('No stream yet')).toBeInTheDocument()
  })

  it('Reset button is not disabled on initial render', () => {
    render(<AnikaiBrowser {...defaultProps} />)
    expect(screen.getByRole('button', { name: 'Reset' })).not.toBeDisabled()
  })

  it('shows episode input field in the capture bar', () => {
    render(<AnikaiBrowser {...defaultProps} />)
    const section = screen.getByRole('region', { name: /Detected stream/i })
    expect(section.querySelector('input')).toBeInTheDocument()
  })

  it('updates capture bar when media-candidate event is dispatched', async () => {
    await renderAndSettle()
    await act(async () => {
      dispatchTauriEvent('media-candidate', { url: 'https://example.com/stream.m3u8', kind: 'hls' })
    })
    await waitFor(() => {
      const section = screen.getByRole('region', { name: /Detected stream/i })
      // After a media-candidate event:
      // - captureState transitions to 'detected'
      // - bestCandidate is set, creating a synthetic selectedQuality
      // - selectedQuality.label is "HLS playback stream" (not snifferMessage)
      // - selectedQuality.url is the candidate URL
      // The section shows selectedQuality.label + URL when detected.
      expect(section.textContent).toMatch(/HLS playback stream/)
      expect(section.textContent).toContain('https://example.com/stream.m3u8')
    })
  })

  it('updates page identity from provider-page-identity event', async () => {
    await renderAndSettle()
    await act(async () => {
      dispatchTauriEvent('provider-page-identity', {
        animeTitle: 'Naruto',
        episodeNumber: '42',
        episodeLabel: 'Episode 42',
        sourcePage: 'https://anikai.to/watch/naruto/42',
      })
    })
    await waitFor(() => {
      expect(screen.getByDisplayValue('Episode 42')).toBeInTheDocument()
    })
  })

  it('shows sniffer error message from media-sniffer-error event', async () => {
    await renderAndSettle()
    await act(async () => {
      dispatchTauriEvent('media-sniffer-error', 'DRM protected stream cannot be sniffed')
    })
    await waitFor(() => {
      const section = screen.getByRole('region', { name: /Detected stream/i })
      expect(section.textContent).toMatch(/Stream detector error:/)
    })
  })

  it('enables Download button after a media-candidate is detected', async () => {
    // inspect_stream returns empty — falls back to bestCandidate as selectedQuality
    await renderAndSettle()
    await act(async () => {
      dispatchTauriEvent('media-candidate', { url: 'https://cdn.example.com/stream.m3u8', kind: 'hls' })
    })
    await waitFor(() => {
      const downloadBtn = screen.getByRole('button', { name: /^Download$/ })
      expect(downloadBtn).not.toBeDisabled()
    }, { timeout: 2000 })
  })

  it('opens EpisodeLabelModal when download triggered with no identity detected', async () => {
    // Return quality data so selectedQuality is non-null after inspect
    mockInvoke('inspect_stream', async () => [
      {
        id: 'q1',
        label: '1080p',
        url: 'https://cdn.example.com/1080.m3u8',
        height: 1080,
        width: 1920,
        bitrate: null,
        codec: null,
      },
    ])

    await renderAndSettle()

    // Dispatch candidate — no identity event, so animeTitle/episodeNumber remain null
    await act(async () => {
      dispatchTauriEvent('media-candidate', { url: 'https://cdn.example.com/stream.m3u8', kind: 'hls' })
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Download$/ })).not.toBeDisabled()
    }, { timeout: 2000 })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Download$/ }))
    })

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument()
    })
  })
})

// ---------------------------------------------------------------------------
// Not testable in jsdom (documented per task scope)
// ---------------------------------------------------------------------------

describe('AnikaiBrowser — NOT testable in jsdom', () => {
  it.skip('Webview creation and native iframe rendering (requires Tauri runtime + native WebView2)', () => {
    // The Webview constructor, setPosition, setSize, show/hide are native Tauri
    // primitives backed by the OS webview (WebView2 on Windows). They cannot
    // run or be meaningfully verified in a jsdom environment.
    // The media sniffer script injection (install_media_sniffer invoke) is
    // also part of native Webview lifecycle.
  })

  it.skip('provider-navigation block for disallowed hosts (requires active Webview IPC)', () => {
    // isHostAllowed filtering works on navigation events fired by the native
    // Webview. Testing requires a real Tauri webview that navigates pages.
  })
})
