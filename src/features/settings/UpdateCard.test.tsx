/**
 * UpdateCard tests
 * Tests version display, check states, prepare_for_update ordering.
 */

import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockInvoke, mockInvokeFn } from '../../../tests/setup/tauri'
import { UpdateCard } from './UpdateCard'

// Mock @tauri-apps/api/app so getVersion is controllable
vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn(async () => '0.10.0'),
}))

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

describe('UpdateCard', () => {
  beforeEach(() => {
    mockUpdaterCheck.mockReset()
    mockUpdaterCheck.mockResolvedValue(null)
  })

  it('renders without crashing', async () => {
    render(<UpdateCard />)
    await waitFor(() => {
      expect(screen.getByText(/App Updates/i)).toBeInTheDocument()
    })
  })

  it('displays the current version from getVersion', async () => {
    render(<UpdateCard />)
    await waitFor(() => {
      // Multiple elements show the version; check at least one exists
      const matches = screen.getAllByText(/v0\.10\.0/i)
      expect(matches.length).toBeGreaterThan(0)
    })
  })

  it('shows "Check for updates" button in idle state', async () => {
    render(<UpdateCard />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Check for updates/i })).toBeInTheDocument()
    })
  })

  it('shows "up to date" state when check returns no update', async () => {
    mockUpdaterCheck.mockResolvedValue({ available: false, version: '', body: '', download: vi.fn(), install: vi.fn() })
    const user = userEvent.setup()
    render(<UpdateCard />)
    await waitFor(() => screen.getByRole('button', { name: /Check for updates/i }))
    await user.click(screen.getByRole('button', { name: /Check for updates/i }))
    await waitFor(() => {
      expect(screen.getByText(/UP TO DATE/i)).toBeInTheDocument()
    })
  })

  it('shows "UPDATE AVAILABLE" badge when update is available', async () => {
    mockUpdaterCheck.mockResolvedValue({
      available: true,
      version: '0.11.0',
      body: 'New features!',
      download: vi.fn(async (cb) => { cb({ event: 'Finished', data: {} }) }),
      install: vi.fn(async () => {}),
    })
    const user = userEvent.setup()
    render(<UpdateCard />)
    await waitFor(() => screen.getByRole('button', { name: /Check for updates/i }))
    await user.click(screen.getByRole('button', { name: /Check for updates/i }))
    await waitFor(() => {
      expect(screen.getByText('UPDATE AVAILABLE')).toBeInTheDocument()
    })
  })

  it('shows "Download and install update" button when update available', async () => {
    mockUpdaterCheck.mockResolvedValue({
      available: true,
      version: '0.11.0',
      body: '',
      download: vi.fn(async (cb) => { cb({ event: 'Finished', data: {} }) }),
      install: vi.fn(async () => {}),
    })
    const user = userEvent.setup()
    render(<UpdateCard />)
    await waitFor(() => screen.getByRole('button', { name: /Check for updates/i }))
    await user.click(screen.getByRole('button', { name: /Check for updates/i }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Download and install update/i })).toBeInTheDocument()
    })
  })

  it('calls prepare_for_update BEFORE handle.install during download-and-install', async () => {
    const callOrder: string[] = []

    const mockInstall = vi.fn(async () => {
      callOrder.push('install')
    })
    const mockDownload = vi.fn(async (cb: (p: unknown) => void) => {
      cb({ event: 'Started', data: { contentLength: 1000 } })
      cb({ event: 'Progress', data: { chunkLength: 1000 } })
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
    render(<UpdateCard />)
    await waitFor(() => screen.getByRole('button', { name: /Check for updates/i }))
    await user.click(screen.getByRole('button', { name: /Check for updates/i }))
    await waitFor(() => screen.getByRole('button', { name: /Download and install update/i }))
    await user.click(screen.getByRole('button', { name: /Download and install update/i }))

    await waitFor(() => {
      expect(callOrder).toContain('prepare_for_update')
    })

    const prepareIdx = callOrder.indexOf('prepare_for_update')
    const installIdx = callOrder.indexOf('install')
    // prepare_for_update must come before install
    expect(prepareIdx).toBeLessThan(installIdx)
  })

  it('shows error state when update check throws', async () => {
    mockUpdaterCheck.mockRejectedValue(new Error('Network error'))
    const user = userEvent.setup()
    render(<UpdateCard />)
    await waitFor(() => screen.getByRole('button', { name: /Check for updates/i }))
    await user.click(screen.getByRole('button', { name: /Check for updates/i }))
    await waitFor(() => {
      expect(screen.getByText(/Network error/i)).toBeInTheDocument()
    })
  })

  it('shows "Check again" button in up-to-date state', async () => {
    mockUpdaterCheck.mockResolvedValue({ available: false, version: '', body: '', download: vi.fn(), install: vi.fn() })
    const user = userEvent.setup()
    render(<UpdateCard />)
    await waitFor(() => screen.getByRole('button', { name: /Check for updates/i }))
    await user.click(screen.getByRole('button', { name: /Check for updates/i }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Check again/i })).toBeInTheDocument()
    })
  })
})
