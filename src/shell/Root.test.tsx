/**
 * Tests for Root component.
 * Root is a gating component that shows:
 *   1. ToolsGate until tools are ready
 *   2. Loading spinner until setup state is known
 *   3. SetupWizard if setup is not complete
 *   4. Repair gate if startup dependencies need repair
 *   5. App when everything is ready
 *
 * Depth from root: src/shell/ -> depth 2 -> ../../tests/setup/tauri
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockInvoke } from '../../tests/setup/tauri'

// Heavy panels — mock them out so Root tests stay fast
vi.mock('./App', () => ({
  App: () => <div data-testid="app-panel">App</div>,
}))
vi.mock('../features/setup/ToolsGate', () => ({
  ToolsGate: ({ onReady }: { onReady: () => void }) => (
    <div data-testid="tools-gate">
      <button type="button" onClick={onReady}>
        Ready
      </button>
    </div>
  ),
}))
vi.mock('../SetupWizard', () => ({
  SetupWizard: ({ onComplete }: { onComplete: () => void }) => (
    <div data-testid="setup-wizard">
      <button type="button" onClick={onComplete}>
        Complete
      </button>
    </div>
  ),
}))

import { Root } from './Root'

function makeConfig(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'config',
    setup_complete: true,
    setup_type: 'cpu',
    ...overrides,
  })
}

function makeSetupPlan(installs: string[][] = []) {
  return JSON.stringify({
    type: 'setup-plan',
    mode: 'cpu',
    rows: [],
    issues: [],
    installs,
    success_mode: 'cpu',
  })
}

describe('Root', () => {
  beforeEach(() => {
    mockInvoke('frontend_log', () => undefined)
    mockInvoke('discord_set_state', () => undefined)
  })

  it('shows ToolsGate first before tools are ready', () => {
    // tools_status never resolves — ToolsGate stays in checking phase
    // Our mock ToolsGate renders a "tools-gate" div
    mockInvoke('tools_status', () => new Promise(() => {}))
    render(<Root />)
    expect(screen.getByTestId('tools-gate')).toBeInTheDocument()
  })

  it('shows loading spinner after tools are ready while config loads', async () => {
    const user = userEvent.setup()
    // get_config never resolves — loading spinner persists
    mockInvoke('tools_status', () => new Promise(() => {}))
    mockInvoke('get_config', () => new Promise(() => {}))
    render(<Root />)

    // Simulate tools becoming ready
    await user.click(screen.getByRole('button', { name: 'Ready' }))

    await waitFor(() => {
      expect(screen.getByText('Loading setup state...')).toBeInTheDocument()
    })
  })

  it('shows SetupWizard when setup_complete is false', async () => {
    const user = userEvent.setup()
    mockInvoke('tools_status', () => new Promise(() => {}))
    mockInvoke('get_config', () => makeConfig({ setup_complete: false }))
    render(<Root />)

    await user.click(screen.getByRole('button', { name: 'Ready' }))

    await waitFor(() => {
      expect(screen.getByTestId('setup-wizard')).toBeInTheDocument()
    })
  })

  it('shows checking dependencies spinner when setup is complete', async () => {
    const user = userEvent.setup()
    mockInvoke('tools_status', () => new Promise(() => {}))
    // get_config resolves with setup complete; audio_setup_plan hangs
    mockInvoke('get_config', () => makeConfig())
    mockInvoke('audio_setup_plan', () => new Promise(() => {}))
    render(<Root />)

    await user.click(screen.getByRole('button', { name: 'Ready' }))

    await waitFor(() => {
      expect(screen.getByText(/Checking.*dependencies/i)).toBeInTheDocument()
    })
  })

  it('shows App when all dependencies are satisfied', async () => {
    const user = userEvent.setup()
    mockInvoke('tools_status', () => new Promise(() => {}))
    mockInvoke('get_config', () => makeConfig())
    mockInvoke('audio_setup_plan', () => makeSetupPlan([]))
    render(<Root />)

    await user.click(screen.getByRole('button', { name: 'Ready' }))

    await waitFor(() => {
      expect(screen.getByTestId('app-panel')).toBeInTheDocument()
    })
  })

  it('shows repair gate when dependencies need install', async () => {
    const user = userEvent.setup()
    mockInvoke('tools_status', () => new Promise(() => {}))
    mockInvoke('get_config', () => makeConfig())
    mockInvoke('audio_setup_plan', () =>
      makeSetupPlan([['pip', 'install', 'torch']]),
    )
    render(<Root />)

    await user.click(screen.getByRole('button', { name: 'Ready' }))

    await waitFor(() => {
      expect(screen.getByText(/CPU Engine Needs Setup/i)).toBeInTheDocument()
    })
  })

  it('shows GPU Engine label when setup_type is gpu', async () => {
    const user = userEvent.setup()
    mockInvoke('tools_status', () => new Promise(() => {}))
    mockInvoke('get_config', () => makeConfig({ setup_type: 'gpu' }))
    mockInvoke('audio_setup_plan', () =>
      makeSetupPlan([['pip', 'install', 'torch']]),
    )
    render(<Root />)

    await user.click(screen.getByRole('button', { name: 'Ready' }))

    await waitFor(() => {
      expect(screen.getByText(/GPU Engine Needs Setup/i)).toBeInTheDocument()
    })
  })

  it('"Continue Anyway" button on repair gate advances to App', async () => {
    const user = userEvent.setup()
    mockInvoke('tools_status', () => new Promise(() => {}))
    mockInvoke('get_config', () => makeConfig())
    mockInvoke('audio_setup_plan', () =>
      makeSetupPlan([['pip', 'install', 'torch']]),
    )
    render(<Root />)

    await user.click(screen.getByRole('button', { name: 'Ready' }))
    await waitFor(() => screen.getByText(/CPU Engine Needs Setup/i))

    await user.click(screen.getByRole('button', { name: /continue anyway/i }))

    await waitFor(() => {
      expect(screen.getByTestId('app-panel')).toBeInTheDocument()
    })
  })
})
