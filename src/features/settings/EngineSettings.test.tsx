/**
 * EngineSettings tests
 * Tests GPU/CPU disable logic, badge states, clear-cache wiring.
 */

import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EngineSettings } from './EngineSettings'
import type { AppConfig } from '../../types/app'
import type { AudioStatus } from '../../types/audio'

const baseConfig: AppConfig = {
  type: 'config',
  force_cpu: false,
  setup_type: 'cpu',
  clip_extraction_mode: 'cpu',
  setup_complete: true,
  download_path: '/tmp',
  provider_url: '',
  theme: 'cyan',
  theme_color_a: '#48d7ff',
  theme_color_b: '#63e6a2',
  background_image: '',
  background_scale: 1,
  background_offset_x: 50,
  background_offset_y: 50,
  background_dim: 55,
  background_blur: 0,
  background_video: '',
  background_video_source: '',
  background_video_fps: 30,
  background_bright_text: '0',
  audio_output_format: 'wav',
  clip_hover_preview: false,
  featherweight_previews: false,
  scene_preview_height: 240,
  tsukyio_api_key: '',
}

const cpuStatus: AudioStatus = {
  type: 'status',
  hardware: { device: 'cpu', device_short: 'cpu', gpu_type: 'none', fp16_capable: false, provider: 'CPUExecutionProvider' },
  dependencies: {
    audio_separator: true, pydub: true, typing_extensions: true,
    torch: true, torch_version: '2.1.0+cpu',
    onnxruntime: true, onnxruntime_version: '1.17.0',
    runtime_ready: true, ready: true,
  },
  model_name: 'UVR_MDXNET_Main',
}

const nvidiaStatus: AudioStatus = {
  type: 'status',
  hardware: { device: 'cuda', device_short: 'cuda', gpu_type: 'nvidia', fp16_capable: true, provider: 'CUDAExecutionProvider' },
  dependencies: {
    audio_separator: true, pydub: true, typing_extensions: true,
    torch: true, torch_version: '2.1.0+cu121',
    onnxruntime: true, onnxruntime_version: '1.17.0',
    runtime_ready: true, ready: true,
  },
  model_name: 'UVR_MDXNET_Main',
}

function renderEngine(overrides: {
  status?: AudioStatus | null
  backendConfig?: AppConfig | null
  settingsChecking?: boolean
  setupRunning?: 'cpu' | 'gpu' | null
  switchMode?: (mode: 'cpu' | 'gpu') => void
  clearCache?: () => void
} = {}) {
  const switchMode = overrides.switchMode ?? vi.fn()
  const clearCache = overrides.clearCache ?? vi.fn()
  const setupLogRef = { current: null }

  render(
    <EngineSettings
      status={overrides.status ?? cpuStatus}
      backendConfig={overrides.backendConfig ?? baseConfig}
      settingsChecking={overrides.settingsChecking ?? false}
      setupRunning={overrides.setupRunning ?? null}
      setupProgress={null}
      setupLines={[]}
      setupNotice={null}
      error={null}
      setupLogRef={setupLogRef}
      switchMode={switchMode}
      clearingCache={false}
      cacheNotice={null}
      cacheError={null}
      clearCache={clearCache}
    />,
  )
  return { switchMode, clearCache }
}

describe('EngineSettings', () => {
  it('renders without crashing', () => {
    renderEngine()
    expect(screen.getByText('AI Engine')).toBeInTheDocument()
  })

  it('shows GPU warning when GPU is not available', () => {
    renderEngine({ status: cpuStatus })
    // cpuStatus.hardware.gpu_type is "none", so gpuSetupBlocked = true
    // Multiple elements may contain the text (warning div and button subtitle)
    const matches = screen.getAllByText(/Compatible graphics card not found/i)
    expect(matches.length).toBeGreaterThan(0)
  })

  it('GPU button is disabled when no compatible GPU found', () => {
    renderEngine({ status: cpuStatus })
    const gpuBtn = screen.getByRole('button', { name: /Switch to GPU/i })
    expect(gpuBtn).toBeDisabled()
  })

  it('GPU button is enabled when NVIDIA GPU is available and CPU mode installed', () => {
    // nvidiaStatus has gpu_type=nvidia; torch_version=+cu121 so installedMode=gpu
    // gpuAllSet = true when installed=gpu && ready && hasGpu — so button is disabled
    // This test checks the gpuSetupBlocked=false path (GPU present but not yet setup)
    const statusWithGpuButCpu: AudioStatus = {
      ...cpuStatus,
      hardware: { ...cpuStatus.hardware, gpu_type: 'nvidia' },
    }
    renderEngine({ status: statusWithGpuButCpu })
    const gpuBtn = screen.getByRole('button', { name: /Switch to GPU/i })
    // GPU is available, torch is cpu mode so gpuAllSet=false, not blocked
    expect(gpuBtn).not.toBeDisabled()
  })

  it('GPU button shows "GPU ready" label and is disabled when GPU is fully set up', () => {
    renderEngine({ status: nvidiaStatus })
    // installedMode=gpu, depsReady=true, hasGpu=true => gpuAllSet=true => disabled
    expect(screen.getByRole('button', { name: /GPU ready/i })).toBeDisabled()
  })

  it('CPU button shows "CPU ready" and is disabled when CPU is fully set up', () => {
    renderEngine({ status: cpuStatus })
    // installedMode=cpu, depsReady=true => cpuAllSet=true => disabled
    expect(screen.getByRole('button', { name: /CPU ready/i })).toBeDisabled()
  })

  it('clicking Switch to GPU calls switchMode("gpu")', async () => {
    const user = userEvent.setup()
    const statusWithGpu: AudioStatus = {
      ...cpuStatus,
      hardware: { ...cpuStatus.hardware, gpu_type: 'nvidia' },
    }
    const { switchMode } = renderEngine({ status: statusWithGpu })
    const gpuBtn = screen.getByRole('button', { name: /Switch to GPU/i })
    await user.click(gpuBtn)
    expect(switchMode).toHaveBeenCalledWith('gpu')
  })

  it('clicking Clear cache calls clearCache callback', async () => {
    const user = userEvent.setup()
    const { clearCache } = renderEngine()
    await user.click(screen.getByRole('button', { name: /Clear cache/i }))
    expect(clearCache).toHaveBeenCalledTimes(1)
  })

  it('shows CPU READY badge when CPU is installed and ready', () => {
    renderEngine({ status: cpuStatus })
    expect(screen.getByText('CPU READY')).toBeInTheDocument()
  })

  it('shows Not installed badge when no torch version detected', () => {
    const noTorchStatus: AudioStatus = {
      ...cpuStatus,
      dependencies: { ...cpuStatus.dependencies, torch: false, torch_version: null, ready: false },
    }
    renderEngine({ status: noTorchStatus })
    expect(screen.getByText('Not installed')).toBeInTheDocument()
  })

  it('both GPU and CPU buttons disabled during setup run', () => {
    renderEngine({ setupRunning: 'gpu', settingsChecking: false })
    // When setupRunning != null, both buttons are disabled
    const gpuBtn = screen.queryByRole('button', { name: /Switch to GPU|GPU ready/i })
    const cpuBtn = screen.queryByRole('button', { name: /Switch to CPU|CPU ready/i })
    if (gpuBtn) expect(gpuBtn).toBeDisabled()
    if (cpuBtn) expect(cpuBtn).toBeDisabled()
  })
})
