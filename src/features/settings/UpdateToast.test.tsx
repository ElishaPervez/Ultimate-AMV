/**
 * UpdateToast tests
 * Auto-check on mount, slide-in when update available, dismiss, prepare_for_update ordering.
 */

import React from 'react'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockInvoke } from '../../../tests/setup/tauri'
import { UpdateToast } from './UpdateToast'

type FakeHandle = {
  available: boolean
  version: string
  body: string
  download: (cb: (p: unknown) => void) => Promise<void>
  install: () => Promise<void>
}

const mockUpdaterCheck = vi.fn<() => Promise<FakeHandle | null>>(async () => null)

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: mockUpdaterCheck,
}))

describe('UpdateToast', () => {
  beforeEach(() => {
    mockUpdaterCheck.mockReset()
    mockUpdaterCheck.mockResolvedValue(null)
  })

  it('renders nothing when no update is available', async () => {
    mockUpdaterCheck.mockResolvedValue(null)
    render(<UpdateToast />)
    await waitFor(() => {
      expect(screen.queryByRole('status')).toBeNull()
    })
  })

  it('auto-checks for updates on mount (calls updater.check)', async () => {
    render(<UpdateToast />)
    await waitFor(() => {
      expect(mockUpdaterCheck).toHaveBeenCalledTimes(1)
    })
  })

  it('shows toast when update is available on mount', async () => {
    mockUpdaterCheck.mockResolvedValue({
      available: true,
      version: '0.11.0',
      body: '',
      download: vi.fn(async () => {}),
      install: vi.fn(async () => {}),
    })
    render(<UpdateToast />)
    await waitFor(() => {
      expect(screen.getByRole('status')).toBeInTheDocument()
      expect(screen.getByText(/Update available/i)).toBeInTheDocument()
    })
  })

  it('shows the update version in the toast', async () => {
    mockUpdaterCheck.mockResolvedValue({
      available: true,
      version: '0.11.0',
      body: '',
      download: vi.fn(async () => {}),
      install: vi.fn(async () => {}),
    })
    render(<UpdateToast />)
    await waitFor(() => {
      expect(screen.getByText(/v0\.11\.0/i)).toBeInTheDocument()
    })
  })

  it('toast is dismissable via Dismiss button', async () => {
    const user = userEvent.setup()
    mockUpdaterCheck.mockResolvedValue({
      available: true,
      version: '0.11.0',
      body: '',
      download: vi.fn(async () => {}),
      install: vi.fn(async () => {}),
    })
    render(<UpdateToast />)
    await waitFor(() => screen.getByRole('button', { name: /Dismiss/i }))
    await user.click(screen.getByRole('button', { name: /Dismiss/i }))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('shows "Download and install" button in available state', async () => {
    mockUpdaterCheck.mockResolvedValue({
      available: true,
      version: '0.11.0',
      body: '',
      download: vi.fn(async () => {}),
      install: vi.fn(async () => {}),
    })
    render(<UpdateToast />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Download and install/i })).toBeInTheDocument()
    })
  })

  it('calls prepare_for_update BEFORE handle.install in toast flow', async () => {
    const callOrder: string[] = []

    const mockInstall = vi.fn(async () => {
      callOrder.push('install')
    })
    const mockDownload = vi.fn(async (cb: (p: unknown) => void) => {
      cb({ event: 'Started', data: { contentLength: 500 } })
      cb({ event: 'Progress', data: { chunkLength: 500 } })
      cb({ event: 'Finished', data: {} })
    })

    mockUpdaterCheck.mockResolvedValue({
      available: true,
      version: '0.11.0',
      body: '',
      download: mockDownload,
      install: mockInstall,
    })

    mockInvoke('prepare_for_update', () => {
      callOrder.push('prepare_for_update')
      return undefined
    })

    const user = userEvent.setup()
    render(<UpdateToast />)
    await waitFor(() => screen.getByRole('button', { name: /Download and install/i }))
    await user.click(screen.getByRole('button', { name: /Download and install/i }))

    await waitFor(() => {
      expect(callOrder).toContain('prepare_for_update')
    })

    const prepareIdx = callOrder.indexOf('prepare_for_update')
    const installIdx = callOrder.indexOf('install')
    expect(prepareIdx).toBeLessThan(installIdx)
  })

  it('dismiss button is hidden while downloading', async () => {
    // During download, isWorking=true which hides the dismiss button
    let resolveDl: (() => void) | undefined
    const blockingDownload = vi.fn((cb: (p: unknown) => void) => {
      cb({ event: 'Started', data: { contentLength: 1000 } })
      return new Promise<void>((resolve) => { resolveDl = resolve })
    })

    mockUpdaterCheck.mockResolvedValue({
      available: true,
      version: '0.11.0',
      body: '',
      download: blockingDownload,
      install: vi.fn(async () => {}),
    })

    mockInvoke('prepare_for_update', () => undefined)

    const user = userEvent.setup()
    render(<UpdateToast />)
    await waitFor(() => screen.getByRole('button', { name: /Download and install/i }))

    // Start download but don't resolve yet
    act(() => { screen.getByRole('button', { name: /Download and install/i }).click() })

    await waitFor(() => {
      // While downloading, dismiss button should not be visible
      expect(screen.queryByRole('button', { name: /Dismiss/i })).toBeNull()
    })

    // Clean up: resolve the pending download
    resolveDl?.()
  })
})
