/**
 * src/SetupWizard.test.tsx
 *
 * Tests for the first-run Setup Wizard's failure screen.
 *
 * The bug these lock down: when the Python installer died, the wizard printed
 * the machine payload it emitted ({"type":"setup-error","message":"..."}) as
 * the error text, and it swapped the whole install view out for that one line,
 * so the setup log the user had been watching vanished with it.
 *
 * Depth from root: src/ -> depth 1 -> ../tests/setup/tauri
 */
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockInvoke, mockInvokeFn, dispatchTauriEvent } from '../tests/setup/tauri'

import { SetupWizard } from './SetupWizard'

const RAW_SETUP_ERROR_PAYLOAD = JSON.stringify({
  type: 'setup-error',
  message: "argument of type 'NoneType' is not iterable",
})

function mockHardware(hasNvidiaGpu = false) {
  mockInvoke('video_gpu_status', () =>
    JSON.stringify({
      hasNvidiaGpu,
      gpuName: hasNvidiaGpu ? 'NVIDIA RTX 3080' : null,
      message: hasNvidiaGpu ? 'Graphics card ready' : 'No graphics card found',
    }),
  )
}

/** Walk the wizard from the hardware check to the install step. */
async function gotoInstallStep(user: ReturnType<typeof userEvent.setup>) {
  render(<SetupWizard onComplete={() => {}} />)
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument()
  })
  await user.click(screen.getByRole('button', { name: 'Continue' })) // hardware -> engine
  await user.click(screen.getByRole('button', { name: 'Continue' })) // engine -> folder
  await user.click(screen.getByRole('button', { name: 'Continue' })) // folder -> install
  await user.click(screen.getByRole('button', { name: 'Install' }))
  await waitFor(() => {
    expect(mockInvokeFn).toHaveBeenCalledWith('audio_setup', { mode: 'cpu' })
  })
}

function emitProgress(step: number, message: string, state = 'running') {
  act(() => {
    dispatchTauriEvent('audio-setup-progress', {
      type: 'setup-progress',
      step,
      total: 5,
      state,
      message,
    })
  })
}

describe('SetupWizard install failure', () => {
  beforeEach(() => {
    mockHardware(false)
  })

  it('shows the human sentence, not the raw payload, when audio_setup rejects with JSON', async () => {
    const user = userEvent.setup()
    let rejectSetup!: (reason: unknown) => void
    mockInvoke('audio_setup', () => new Promise<string>((_res, rej) => { rejectSetup = rej }))

    await gotoInstallStep(user)
    act(() => { rejectSetup(RAW_SETUP_ERROR_PAYLOAD) })

    const message = await screen.findByText("argument of type 'NoneType' is not iterable")
    expect(message).toBeInTheDocument()
    // Nothing on screen may contain the payload's braces or field names.
    expect(message.textContent).not.toContain('{')
    expect(screen.queryByText(/setup-error/)).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain('"message"')
  })

  it('keeps the setup log on screen after a failure', async () => {
    const user = userEvent.setup()
    let rejectSetup!: (reason: unknown) => void
    mockInvoke('audio_setup', () => new Promise<string>((_res, rej) => { rejectSetup = rej }))

    await gotoInstallStep(user)
    emitProgress(1, 'Checking installed packages...')
    emitProgress(2, 'Installing PyTorch...')
    await waitFor(() => {
      expect(document.querySelector('.setup-log')?.textContent).toContain('Installing PyTorch')
    })

    act(() => { rejectSetup(RAW_SETUP_ERROR_PAYLOAD) })
    await screen.findByText("argument of type 'NoneType' is not iterable")

    const log = document.querySelector('.setup-log')
    expect(log).not.toBeNull()
    expect(log!.textContent).toContain('[1/5] Checking installed packages...')
    expect(log!.textContent).toContain('[2/5] Installing PyTorch...')
  })

  it('keeps Back and Retry working after a failure', async () => {
    const user = userEvent.setup()
    let rejectSetup!: (reason: unknown) => void
    let setupCalls = 0
    mockInvoke('audio_setup', () => {
      setupCalls += 1
      return new Promise<string>((_res, rej) => { rejectSetup = rej })
    })

    await gotoInstallStep(user)
    emitProgress(1, 'Checking installed packages...')
    act(() => { rejectSetup(RAW_SETUP_ERROR_PAYLOAD) })
    await screen.findByText("argument of type 'NoneType' is not iterable")

    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => { expect(setupCalls).toBe(2) })
    // A retry clears the previous run's error and its log.
    expect(screen.queryByText("argument of type 'NoneType' is not iterable")).not.toBeInTheDocument()
    expect(document.querySelector('.setup-log')).toBeNull()
  })

  it('passes a plain text failure straight through', async () => {
    const user = userEvent.setup()
    let rejectSetup!: (reason: unknown) => void
    mockInvoke('audio_setup', () => new Promise<string>((_res, rej) => { rejectSetup = rej }))

    await gotoInstallStep(user)
    act(() => { rejectSetup('Python process exited with code 1') })

    expect(await screen.findByText('Python process exited with code 1')).toBeInTheDocument()
  })
})
