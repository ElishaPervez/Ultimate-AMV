/**
 * Tests for LogsPanel component.
 * Depth from root: src/features/logs/ -> depth 3 -> ../../../tests/setup/tauri
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockInvoke } from '../../../tests/setup/tauri'
import { LogsPanel } from './LogsPanel'

// Helper to build the JSON bridge response for app_logs
function makeLogsPayload(lines: string[]): string {
  return JSON.stringify({ type: 'logs', lines })
}

describe('LogsPanel', () => {
  beforeEach(() => {
    // frontend_log is called via logFrontend — silence it
    mockInvoke('frontend_log', () => undefined)
  })

  it('shows "No logs yet" empty state when lines are empty', async () => {
    mockInvoke('app_logs', () => makeLogsPayload([]))
    render(<LogsPanel />)
    await waitFor(() => {
      expect(screen.getByText('No logs yet')).toBeInTheDocument()
    })
  })

  it('renders log lines in the pre element', async () => {
    mockInvoke('app_logs', () => makeLogsPayload(['line one', 'line two']))
    render(<LogsPanel />)
    await waitFor(() => {
      const pre = screen.getByLabelText('Application logs')
      expect(pre).toHaveTextContent('line one')
      expect(pre).toHaveTextContent('line two')
    })
  })

  it('shows count of log lines', async () => {
    mockInvoke('app_logs', () => makeLogsPayload(['a', 'b', 'c']))
    render(<LogsPanel />)
    await waitFor(() => {
      expect(screen.getByText(/Showing 3 of 3 log lines/i)).toBeInTheDocument()
    })
  })

  it('clear button is disabled when no lines', async () => {
    mockInvoke('app_logs', () => makeLogsPayload([]))
    render(<LogsPanel />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^clear$/i })).toBeDisabled()
    })
  })

  it('copy button is disabled when no lines', async () => {
    mockInvoke('app_logs', () => makeLogsPayload([]))
    render(<LogsPanel />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^copy$/i })).toBeDisabled()
    })
  })

  it('clear button is enabled when there are lines', async () => {
    mockInvoke('app_logs', () => makeLogsPayload(['a line']))
    render(<LogsPanel />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^clear$/i })).toBeEnabled()
    })
  })

  it('clear button clears lines and invokes clear_app_logs', async () => {
    const user = userEvent.setup()
    mockInvoke('app_logs', () => makeLogsPayload(['line 1']))
    mockInvoke('clear_app_logs', () => undefined)
    render(<LogsPanel />)

    // Wait for lines to appear
    await waitFor(() => expect(screen.getByLabelText('Application logs')).toBeInTheDocument())

    // Re-mock app_logs to return empty after clear
    mockInvoke('app_logs', () => makeLogsPayload([]))

    await user.click(screen.getByRole('button', { name: /^clear$/i }))
    await waitFor(() => {
      expect(screen.getByText('No logs yet')).toBeInTheDocument()
    })
  })

  it('shows error message when app_logs invoke fails', async () => {
    mockInvoke('app_logs', () => { throw new Error('Fetch failed') })
    render(<LogsPanel />)
    await waitFor(() => {
      expect(screen.getByText(/fetch failed/i)).toBeInTheDocument()
    })
  })

  it('copy button is enabled when there are lines', async () => {
    mockInvoke('app_logs', () => makeLogsPayload(['a line']))
    render(<LogsPanel />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^copy$/i })).toBeEnabled()
    })
  })
})
