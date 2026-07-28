/**
 * SettingsPanel integration tests
 * Tests tab switching, initial state, and confirm modal wiring.
 */

import React from 'react'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { dispatchTauriEvent, mockInvoke, mockInvokeFn } from '../../../tests/setup/tauri'
import { SettingsPanel } from './SettingsPanel'

// Minimal valid config JSON (parseBridgePayload uses JSON.parse on last line)
function configJson(overrides: Record<string, unknown> = {}): string {
  const config = {
    type: 'config',
    force_cpu: false,
    setup_type: 'cpu',
    clip_extraction_mode: 'cpu',
    setup_complete: true,
    download_path: '/tmp/downloads',
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
    audio_output_format: 'wav',
    clip_hover_preview: false,
    scene_preview_height: 240,
    clip_preview_speed: 1,
    tsukyio_api_key: '',
    ...overrides,
  }
  return JSON.stringify(config)
}

function statusJson(overrides: Record<string, unknown> = {}): string {
  const status = {
    type: 'status',
    hardware: { device: 'cpu', device_short: 'cpu', gpu_type: 'none', fp16_capable: false, provider: 'CPUExecutionProvider' },
    dependencies: {
      audio_separator: true,
      pydub: true,
      typing_extensions: true,
      torch: true,
      torch_version: '2.1.0+cpu',
      onnxruntime: true,
      onnxruntime_version: '1.17.0',
      runtime_ready: true,
      ready: true,
    },
    model_name: 'UVR_MDXNET_Main',
    ...overrides,
  }
  return JSON.stringify(status)
}

function setupResultJson(mode: 'cpu' | 'gpu', statusOverrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'setup-done',
    ok: true,
    mode,
    plan: {
      mode,
      rows: [],
      issues: [],
      installs: [],
      success_mode: mode,
      gpu_name: mode === 'gpu' ? 'Test GPU' : null,
    },
    status: JSON.parse(statusJson(statusOverrides)),
  })
}

function setupDefaultMocks() {
  mockInvoke('get_config', () => configJson())
  mockInvoke('audio_status', () => statusJson())
}

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn(async () => '0.10.0'),
}))

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: vi.fn(async () => null),
}))

// Suppress log invokes
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: vi.fn(() => ({ onDragDropEvent: vi.fn(async () => () => {}) })),
}))

describe('SettingsPanel', () => {
  it('renders without crashing when config resolves', async () => {
    setupDefaultMocks()
    render(<SettingsPanel themeColors={{ primary: '#48d7ff', secondary: '#63e6a2' }} />)
    await waitFor(() => {
      expect(screen.getByText('AI Engine & System')).toBeInTheDocument()
    })
  })

  it('initial active tab is "engine" (System & Engine button)', async () => {
    setupDefaultMocks()
    render(<SettingsPanel themeColors={{ primary: '#48d7ff', secondary: '#63e6a2' }} />)
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: /AI Engine & System/i })
      expect(btn).toHaveClass('is-active')
    })
  })

  it('clicking Feature Preferences tab switches content', async () => {
    const user = userEvent.setup()
    setupDefaultMocks()
    render(<SettingsPanel themeColors={{ primary: '#48d7ff', secondary: '#63e6a2' }} />)
    await waitFor(() => screen.getByRole('button', { name: /App Settings/i }))
    await user.click(screen.getByRole('button', { name: /App Settings/i }))
    // Feature tab shows download folder setting
    expect(screen.getByText('Download folder')).toBeInTheDocument()
  })

  it('clicking Theme & Social tab switches content', async () => {
    const user = userEvent.setup()
    setupDefaultMocks()
    render(<SettingsPanel themeColors={{ primary: '#48d7ff', secondary: '#63e6a2' }} />)
    await waitFor(() => screen.getByRole('button', { name: /Theme & Status/i }))
    await user.click(screen.getByRole('button', { name: /Theme & Status/i }))
    expect(screen.getByText('Theme colors')).toBeInTheDocument()
  })

  it('loads clip_hover_preview=false by default when config returns false', async () => {
    setupDefaultMocks()
    render(<SettingsPanel themeColors={{ primary: '#48d7ff', secondary: '#63e6a2' }} />)
    // Navigate to Features tab
    await waitFor(() => screen.getByRole('button', { name: /App Settings/i }))
    await act(async () => {
      screen.getByRole('button', { name: /App Settings/i }).click()
    })
    await waitFor(() => {
      const toggle = screen.getByRole('switch', { name: /Hover-to-Play previews/i })
      expect(toggle).toHaveAttribute('aria-checked', 'false')
    })
  })

  it('loads clip_hover_preview=true when config returns true', async () => {
    mockInvoke('get_config', () => configJson({ clip_hover_preview: true }))
    mockInvoke('audio_status', () => statusJson())
    render(<SettingsPanel themeColors={{ primary: '#48d7ff', secondary: '#63e6a2' }} />)
    await act(async () => {
      screen.getByRole('button', { name: /App Settings/i }).click()
    })
    await waitFor(() => {
      const toggle = screen.getByRole('switch', { name: /Hover-to-Play previews/i })
      expect(toggle).toHaveAttribute('aria-checked', 'true')
    })
  })

  it('clear cache button opens the confirm modal', async () => {
    const user = userEvent.setup()
    setupDefaultMocks()
    render(<SettingsPanel themeColors={{ primary: '#48d7ff', secondary: '#63e6a2' }} />)
    // Engine tab is active; find clear cache button
    await waitFor(() => screen.getByRole('button', { name: /Clear cache/i }))
    await user.click(screen.getByRole('button', { name: /Clear cache/i }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText(/Clear saved previews/i)).toBeInTheDocument()
  })

  it('confirming clear cache modal calls clear_app_cache invoke', async () => {
    const user = userEvent.setup()
    mockInvoke('get_config', () => configJson())
    mockInvoke('audio_status', () => statusJson())
    mockInvoke('clear_app_cache', () => ({ files_removed: 3, bytes_freed: 1024 }))
    render(<SettingsPanel themeColors={{ primary: '#48d7ff', secondary: '#63e6a2' }} />)
    // Click the engine tab "Clear cache" pill button (not in dialog)
    await waitFor(() => screen.getAllByRole('button', { name: /Clear cache/i }))
    const clearBtns = screen.getAllByRole('button', { name: /Clear cache/i })
    // The first one should be the non-dialog pill button
    await user.click(clearBtns[0])
    // Modal is now open; click the confirm button inside the dialog
    const dialog = screen.getByRole('dialog')
    const dialogConfirmBtn = dialog.querySelector('.episode-label-confirm') as HTMLButtonElement
    await user.click(dialogConfirmBtn)
    await waitFor(() => {
      const calls = mockInvokeFn.mock.calls
      const clearCacheCall = calls.find((call) => call[0] === 'clear_app_cache')
      expect(clearCacheCall).toBeDefined()
    })
  })

  it('cancelling clear cache modal does NOT call clear_app_cache', async () => {
    const user = userEvent.setup()
    setupDefaultMocks()
    render(<SettingsPanel themeColors={{ primary: '#48d7ff', secondary: '#63e6a2' }} />)
    await waitFor(() => screen.getByRole('button', { name: /Clear cache/i }))
    await user.click(screen.getByRole('button', { name: /Clear cache/i }))
    await user.click(screen.getByRole('button', { name: /^Cancel$/i }))
    const calls = mockInvokeFn.mock.calls
    const clearCacheCall = calls.find((call) => call[0] === 'clear_app_cache')
    expect(clearCacheCall).toBeUndefined()
  })

  it('GPU/CPU switch button opens the confirm modal', async () => {
    const user = userEvent.setup()
    // Provide status with no GPU so GPU button is not disabled due to gpuAllSet
    mockInvoke('get_config', () => configJson({ setup_type: 'cpu' }))
    mockInvoke('audio_status', () => statusJson({
      hardware: { device: 'cpu', device_short: 'cpu', gpu_type: 'nvidia', fp16_capable: false, provider: 'CUDA' },
      dependencies: {
        audio_separator: true, pydub: true, typing_extensions: true,
        torch: true, torch_version: '2.1.0+cpu',
        onnxruntime: true, onnxruntime_version: '1.17.0',
        runtime_ready: true, ready: true,
      },
    }))
    render(<SettingsPanel themeColors={{ primary: '#48d7ff', secondary: '#63e6a2' }} />)
    await waitFor(() => screen.getByRole('button', { name: /Switch to GPU/i }))
    await user.click(screen.getByRole('button', { name: /Switch to GPU/i }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('uses the verified setup result without launching status or mode-setting processes again', async () => {
    const user = userEvent.setup()
    mockInvoke('get_config', () => configJson({ setup_type: 'cpu', force_cpu: true, clip_extraction_mode: 'cpu' }))
    mockInvoke('audio_status', () => statusJson({
      hardware: { device: 'Test GPU', device_short: 'CPU', gpu_type: 'nvidia', fp16_capable: false, provider: 'CPU fallback' },
      dependencies: {
        audio_separator: true, pydub: true, typing_extensions: true,
        torch: true, torch_version: '2.11.0+cpu',
        onnxruntime: true, onnxruntime_version: '1.17.0',
        runtime_ready: true, ready: true,
      },
    }))
    mockInvoke('audio_setup', () => setupResultJson('gpu', {
      hardware: { device: 'Test GPU', device_short: 'CUDA', gpu_type: 'nvidia', fp16_capable: true, provider: 'CUDAExecutionProvider' },
      dependencies: {
        audio_separator: true, pydub: true, typing_extensions: true,
        torch: true, torch_version: '2.11.0+cu128',
        onnxruntime: true, onnxruntime_version: '1.17.0',
        runtime_ready: true, ready: true,
      },
      model_name: 'BS-Roformer (Best Quality)',
    }))

    render(<SettingsPanel themeColors={{ primary: '#48d7ff', secondary: '#63e6a2' }} />)
    await user.click(await screen.findByRole('button', { name: /Switch to GPU/i }))
    await user.click(screen.getByRole('dialog').querySelector('.episode-label-confirm') as HTMLButtonElement)

    await waitFor(() => expect(screen.getByText('GPU engine ready.')).toBeInTheDocument())
    expect(screen.getByText('GPU READY')).toBeInTheDocument()
    expect(mockInvokeFn.mock.calls.filter((call) => call[0] === 'audio_status')).toHaveLength(1)
    expect(mockInvokeFn.mock.calls.filter((call) => call[0] === 'get_config')).toHaveLength(1)
    expect(mockInvokeFn.mock.calls.filter((call) => call[0] === 'set_config')).toHaveLength(0)
    expect(mockInvokeFn.mock.calls.filter((call) => call[0] === 'audio_setup')).toHaveLength(1)
  })

  it('shows verification instead of claiming installation is still running', async () => {
    const user = userEvent.setup()
    let finishSetup!: (value: string) => void
    mockInvoke('get_config', () => configJson({ setup_type: 'cpu' }))
    mockInvoke('audio_status', () => statusJson({
      hardware: { device: 'Test GPU', device_short: 'CPU', gpu_type: 'nvidia', fp16_capable: false, provider: 'CPU fallback' },
      dependencies: {
        audio_separator: true, pydub: true, typing_extensions: true,
        torch: true, torch_version: '2.11.0+cpu',
        onnxruntime: true, onnxruntime_version: '1.17.0',
        runtime_ready: true, ready: true,
      },
    }))
    mockInvoke('audio_setup', () => new Promise<string>((resolve) => {
      finishSetup = resolve
    }))

    render(<SettingsPanel themeColors={{ primary: '#48d7ff', secondary: '#63e6a2' }} />)
    await user.click(await screen.findByRole('button', { name: /Switch to GPU/i }))
    await user.click(screen.getByRole('dialog').querySelector('.episode-label-confirm') as HTMLButtonElement)

    act(() => {
      dispatchTauriEvent('audio-setup-progress', {
        type: 'setup-progress',
        step: 2,
        total: 2,
        state: 'running',
        message: 'Verifying GPU/CPU engine and cleaning package cache...',
        phase: 'verify',
      })
    })

    expect(await screen.findByText('Verifying GPU/CPU engine...')).toBeInTheDocument()
    expect(screen.queryByText(/Installing GPU engine/)).not.toBeInTheDocument()

    await act(async () => {
      finishSetup(setupResultJson('gpu', {
        hardware: { device: 'Test GPU', device_short: 'CUDA', gpu_type: 'nvidia', fp16_capable: true, provider: 'CUDAExecutionProvider' },
        dependencies: {
          audio_separator: true, pydub: true, typing_extensions: true,
          torch: true, torch_version: '2.11.0+cu128',
          onnxruntime: true, onnxruntime_version: '1.17.0',
          runtime_ready: true, ready: true,
        },
      }))
    })
  })
})
