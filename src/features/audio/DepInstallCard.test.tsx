/**
 * src/features/audio/DepInstallCard.test.tsx
 *
 * Tests for DepInstallCard — GPU/CPU install buttons, hardware detection display,
 * disabled state when no compatible GPU.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DepInstallCard } from './DepInstallCard'
import type { AudioStatus } from '../../types/audio'
import '../../../tests/setup/tauri'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStatus(overrides: Partial<AudioStatus> = {}): AudioStatus {
  return {
    type: 'status',
    hardware: {
      device: 'NVIDIA RTX 3080',
      device_short: 'RTX 3080',
      gpu_type: 'nvidia',
      fp16_capable: true,
      provider: 'CUDAExecutionProvider',
      vram: '10 GB',
    },
    dependencies: {
      audio_separator: false,
      pydub: false,
      typing_extensions: true,
      torch: false,
      onnxruntime: false,
      runtime_ready: false,
      ready: false,
    },
    model_name: 'MDX23C-8KFFT',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DepInstallCard', () => {
  it('renders the one-time setup heading', () => {
    const status = makeStatus()
    render(
      <DepInstallCard
        status={status}
        hasGpu={true}
        gpuSetupBlocked={false}
        onChoose={() => {}}
      />,
    )
    expect(screen.getByRole('heading', { name: /one-time engine setup/i })).toBeInTheDocument()
  })

  it('displays detected hardware from status', () => {
    const status = makeStatus()
    render(
      <DepInstallCard
        status={status}
        hasGpu={true}
        gpuSetupBlocked={false}
        onChoose={() => {}}
      />,
    )
    expect(screen.getByText('NVIDIA RTX 3080')).toBeInTheDocument()
  })

  it('displays active model name', () => {
    const status = makeStatus()
    render(
      <DepInstallCard
        status={status}
        hasGpu={true}
        gpuSetupBlocked={false}
        onChoose={() => {}}
      />,
    )
    expect(screen.getByText('MDX23C-8KFFT')).toBeInTheDocument()
  })

  it('GPU button is enabled when hasGpu=true and gpuSetupBlocked=false', () => {
    const status = makeStatus()
    render(
      <DepInstallCard
        status={status}
        hasGpu={true}
        gpuSetupBlocked={false}
        onChoose={() => {}}
      />,
    )
    const gpuBtn = screen.getByRole('button', { name: /install gpu mode/i })
    expect(gpuBtn).not.toBeDisabled()
  })

  it('GPU button is disabled when gpuSetupBlocked=true', () => {
    const status = makeStatus({
      hardware: {
        device: 'CPU only',
        device_short: 'CPU',
        gpu_type: 'none',
        fp16_capable: false,
        provider: 'CPUExecutionProvider',
      },
    })
    render(
      <DepInstallCard
        status={status}
        hasGpu={false}
        gpuSetupBlocked={true}
        onChoose={() => {}}
      />,
    )
    const gpuBtn = screen.getByRole('button', { name: /install gpu mode/i })
    expect(gpuBtn).toBeDisabled()
  })

  it('shows "Compatible graphics card not found" warning li when gpuSetupBlocked=true', () => {
    const status = makeStatus()
    render(
      <DepInstallCard
        status={status}
        hasGpu={false}
        gpuSetupBlocked={true}
        onChoose={() => {}}
      />,
    )
    // The text appears multiple times (warning li + button small text),
    // so we target the warning li specifically via the install-warning class.
    const warningEl = document.querySelector('.install-warning')
    expect(warningEl).toBeInTheDocument()
    expect(warningEl?.textContent).toContain('Compatible graphics card not found')
  })

  it('does not show "Compatible graphics card not found" warning when gpuSetupBlocked=false', () => {
    const status = makeStatus()
    render(
      <DepInstallCard
        status={status}
        hasGpu={true}
        gpuSetupBlocked={false}
        onChoose={() => {}}
      />,
    )
    // The warning list item should not be present
    const warningItems = screen.queryAllByText(/compatible graphics card not found/i)
    // If it appears it's in button title/label — just check the warning li is not present
    const installWarnings = document.querySelectorAll('.install-warning')
    expect(installWarnings).toHaveLength(0)
  })

  it('calls onChoose("gpu") when GPU button is clicked', async () => {
    const onChoose = vi.fn()
    const status = makeStatus()
    render(
      <DepInstallCard
        status={status}
        hasGpu={true}
        gpuSetupBlocked={false}
        onChoose={onChoose}
      />,
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /install gpu mode/i }))
    expect(onChoose).toHaveBeenCalledWith('gpu')
  })

  it('calls onChoose("cpu") when CPU button is clicked', async () => {
    const onChoose = vi.fn()
    const status = makeStatus()
    render(
      <DepInstallCard
        status={status}
        hasGpu={true}
        gpuSetupBlocked={false}
        onChoose={onChoose}
      />,
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /install cpu only/i }))
    expect(onChoose).toHaveBeenCalledWith('cpu')
  })

  it('CPU button is always enabled regardless of GPU state', () => {
    const status = makeStatus()
    render(
      <DepInstallCard
        status={status}
        hasGpu={false}
        gpuSetupBlocked={true}
        onChoose={() => {}}
      />,
    )
    const cpuBtn = screen.getByRole('button', { name: /install cpu only/i })
    expect(cpuBtn).not.toBeDisabled()
  })
})
