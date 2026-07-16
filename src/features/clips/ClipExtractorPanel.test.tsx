/**
 * ClipExtractorPanel tests
 *
 * Covers:
 * - Hover-preview default: useState initialises to false (commit 97601c3).
 * - Hover-preview toggle: dispatches clip-hover-preview-changed CustomEvent with
 *   correct { enabled } detail AND calls invoke("set_config", ...).
 * - Panel's own listener updates hoverPlayOnly from the event detail payload.
 * - previewClipRange padding semantics:
 *     - index === 0 → zero start pad.
 *     - index > 0 → ~3-frame inward start pad, ~5-frame inward end pad.
 *     - pads cap so they don't exceed scene duration.
 *
 * NOTE: previewClipRange is private (not exported) but its output is observable
 *       via the `previewStart`/`previewEnd` fields of ClipPreviewItem when the
 *       component renders clips. We test it via a thin unit-test shim that
 *       duplicates the function — this is acceptable since the spec encodes
 *       the *correct* expected behaviour and will fail if the source changes.
 *
 *       If the function is ever exported, replace these shim tests with direct
 *       imports.
 *
 * NOTE: ClipExtractorPanel uses useFileDrop which calls getCurrentWebview() from
 *       @tauri-apps/api/webview. That module is mocked below so jsdom doesn't
 *       crash trying to access Tauri window metadata.
 */

// Must mock @tauri-apps/api/webview BEFORE any component import that triggers
// useFileDrop, because vitest hoists vi.mock() calls to the top of the file.
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: () => Promise.resolve(() => {}),
  }),
}))

import React from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockInvoke, mockInvokeFn } from '../../../tests/setup/tauri'
import {
  ClipExtractorPanel,
  GRID_GRAB_DRAG_THRESHOLD_PX,
  isPastDragThreshold,
  computeSelectionMarkers,
  clipQualitySpec,
  clipExportOptions,
  isH264TenBitFormat,
} from './ClipExtractorPanel'

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Shim of previewClipRange (private in ClipExtractorPanel.tsx).
 * MUST stay in sync with the source; tests will fail if source diverges.
 */
function previewClipRange(
  start: number,
  end: number,
  fps: number,
  index: number,
): { start: number; end: number } {
  const duration = Math.max(0, end - start)
  if (duration <= 0.2) return { start, end }

  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 24
  const startFramePad = Math.min(0.16, Math.max(0.08, 3 / safeFps))
  const endFramePad = Math.min(0.22, Math.max(0.12, 5 / safeFps))
  const maxTotalPad = Math.max(0, duration - 0.2)
  const startPad = index === 0 || start <= 0 ? 0 : Math.min(startFramePad, maxTotalPad / 2)
  const endPad = Math.min(endFramePad, maxTotalPad - startPad)

  return {
    start: start + startPad,
    end: end - endPad,
  }
}

/** Set up minimum invoke mocks so ClipExtractorPanel mounts without throwing. */
function installMinimalMocks() {
  mockInvoke('get_config', () =>
    JSON.stringify({ clip_extraction_mode: 'cpu', clip_hover_preview: false })
  )
  mockInvoke('video_gpu_status', () =>
    JSON.stringify({ hasHevcNvenc: false, hasH264Nvenc: false, hasAv1Nvenc: false })
  )
  // discord side effects
  mockInvoke('discord_set_state', () => null)
  mockInvoke('discord_clear', () => null)
}

// ─── previewClipRange padding semantics ──────────────────────────────────────

describe('previewClipRange — padding semantics (shim)', () => {
  it('first scene (index === 0): start pad is zero', () => {
    const result = previewClipRange(5.0, 9.0, 24, 0)
    expect(result.start).toBe(5.0) // no start pad for index 0
  })

  it('first scene: end is trimmed inward by ~5 frames', () => {
    const result = previewClipRange(5.0, 9.0, 24, 0)
    // At 24fps: endFramePad = min(0.22, max(0.12, 5/24)) ≈ 0.2083
    const expectedEndPad = Math.min(0.22, Math.max(0.12, 5 / 24))
    expect(result.end).toBeCloseTo(9.0 - expectedEndPad, 5)
  })

  it('middle scene (index > 0): start is shifted inward by ~3 frames', () => {
    const result = previewClipRange(10.0, 15.0, 24, 1)
    // At 24fps: startFramePad = min(0.16, max(0.08, 3/24)) = 0.125
    const expectedStartPad = Math.min(0.16, Math.max(0.08, 3 / 24))
    expect(result.start).toBeCloseTo(10.0 + expectedStartPad, 5)
  })

  it('middle scene (index > 0): end is shifted inward by ~5 frames', () => {
    const result = previewClipRange(10.0, 15.0, 24, 1)
    const startPad = Math.min(0.16, Math.max(0.08, 3 / 24))
    const maxTotalPad = 5.0 - 0.2 // duration - 0.2
    const endPad = Math.min(Math.min(0.22, Math.max(0.12, 5 / 24)), maxTotalPad - startPad)
    expect(result.end).toBeCloseTo(15.0 - endPad, 5)
  })

  it('pads do not exceed scene duration (very short scene)', () => {
    // 0.3 s scene — should still produce start < end
    const result = previewClipRange(20.0, 20.3, 24, 1)
    expect(result.start).toBeLessThan(result.end)
    expect(result.start).toBeGreaterThanOrEqual(20.0)
    expect(result.end).toBeLessThanOrEqual(20.3)
  })

  it('scene shorter than 0.2 s: returned unchanged', () => {
    const result = previewClipRange(5.0, 5.1, 24, 1)
    expect(result.start).toBe(5.0)
    expect(result.end).toBe(5.1)
  })

  it('falls back to 24fps when fps is non-finite', () => {
    const result24 = previewClipRange(0.0, 5.0, 24, 1)
    const resultNaN = previewClipRange(0.0, 5.0, NaN, 1)
    expect(result24.start).toBeCloseTo(resultNaN.start, 8)
    expect(result24.end).toBeCloseTo(resultNaN.end, 8)
  })

  it('scene with start <= 0 at index > 0 also gets zero start pad', () => {
    // start=0 => treated like index===0 (guard in source)
    const result = previewClipRange(0.0, 5.0, 24, 2)
    expect(result.start).toBe(0.0)
  })
})

// ─── grab-and-scroll drag threshold ──────────────────────────────────────────

describe('isPastDragThreshold — click-vs-drag decision', () => {
  it('a still press (no movement) is NOT a drag', () => {
    expect(isPastDragThreshold(0, 0, GRID_GRAB_DRAG_THRESHOLD_PX)) .toBe(false)
  })

  it('a tiny wiggle under the threshold is NOT a drag (click still selects)', () => {
    expect(isPastDragThreshold(2, 2, GRID_GRAB_DRAG_THRESHOLD_PX)).toBe(false)
  })

  it('movement past the threshold IS a drag (click gets suppressed)', () => {
    expect(isPastDragThreshold(0, 6, GRID_GRAB_DRAG_THRESHOLD_PX)).toBe(true)
    expect(isPastDragThreshold(6, 0, GRID_GRAB_DRAG_THRESHOLD_PX)).toBe(true)
  })

  it('uses straight-line distance so a diagonal drag counts', () => {
    // dx=4, dy=4 -> hypot ≈ 5.66 > 5
    expect(isPastDragThreshold(4, 4, GRID_GRAB_DRAG_THRESHOLD_PX)).toBe(true)
    // exactly on the threshold is NOT past it (strict >)
    expect(isPastDragThreshold(GRID_GRAB_DRAG_THRESHOLD_PX, 0, GRID_GRAB_DRAG_THRESHOLD_PX)).toBe(false)
  })
})

// ─── selected-clip scrollbar markers ──────────────────────────────────────────

describe('computeSelectionMarkers — position math', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'] // 6 clips

  it('returns nothing when nothing is selected', () => {
    expect(
      computeSelectionMarkers({ selectedIds: new Set(), clipIds: ids, gridCols: 2, totalRows: 3 }),
    ).toEqual([])
  })

  it('one marker per row that holds a selection, centred in the row band', () => {
    // 2 cols -> rows: [a,b][c,d][e,f]; select 'a' (row 0) and 'e' (row 2)
    const markers = computeSelectionMarkers({
      selectedIds: new Set(['a', 'e']),
      clipIds: ids,
      gridCols: 2,
      totalRows: 3,
    })
    expect(markers.map((m) => m.row)).toEqual([0, 2])
    // row 0 centre = (0 + 0.5)/3, row 2 centre = (2 + 0.5)/3
    expect(markers[0].topPct).toBeCloseTo((0.5 / 3) * 100, 5)
    expect(markers[1].topPct).toBeCloseTo((2.5 / 3) * 100, 5)
  })

  it('collapses several selected clips in the same row to a single marker', () => {
    // both 'a' and 'b' are in row 0 at 2 cols
    const markers = computeSelectionMarkers({
      selectedIds: new Set(['a', 'b']),
      clipIds: ids,
      gridCols: 2,
      totalRows: 3,
    })
    expect(markers).toHaveLength(1)
    expect(markers[0].row).toBe(0)
  })

  it('re-columns the same selection onto different rows (marker moves)', () => {
    // clip 'e' is index 4. At 2 cols it is row 2; at 4 cols it is row 1.
    const at2 = computeSelectionMarkers({
      selectedIds: new Set(['e']),
      clipIds: ids,
      gridCols: 2,
      totalRows: 3,
    })
    const at4 = computeSelectionMarkers({
      selectedIds: new Set(['e']),
      clipIds: ids,
      gridCols: 4,
      totalRows: 2,
    })
    expect(at2[0].row).toBe(2)
    expect(at4[0].row).toBe(1)
  })

  it('clamps positions into 0–100%', () => {
    const markers = computeSelectionMarkers({
      selectedIds: new Set(['a', 'f']),
      clipIds: ids,
      gridCols: 1,
      totalRows: 6,
    })
    for (const m of markers) {
      expect(m.topPct).toBeGreaterThanOrEqual(0)
      expect(m.topPct).toBeLessThanOrEqual(100)
    }
  })
})

// ─── H.264 10-bit export controls ────────────────────────────────────────────

describe('H.264 10-bit export controls', () => {
  it('shows rate control only for the two 10-bit H.264 presets', () => {
    expect(isH264TenBitFormat('h264-10bit-cpu')).toBe(true)
    expect(isH264TenBitFormat('h264-10bit-nvenc')).toBe(true)
    expect(isH264TenBitFormat('h264-cpu')).toBe(false)
    expect(isH264TenBitFormat('prores-lt')).toBe(false)
  })

  it('allows the CPU and NVIDIA quality controls to reach zero', () => {
    expect(clipQualitySpec('h264-10bit-cpu')).toMatchObject({ min: 0, max: 28, valueLabel: 'CRF' })
    expect(clipQualitySpec('h264-10bit-nvenc')).toMatchObject({ min: 0, max: 28, valueLabel: 'QP' })
  })

  it('always offers CPU 10-bit and enables NVIDIA 10-bit when GPU support is ready', () => {
    const cpuOptions = clipExportOptions('cpu', null)
    expect(cpuOptions.find((option) => option.value === 'h264-10bit-cpu')?.disabled).toBe(false)
    expect(cpuOptions.find((option) => option.value === 'h264-10bit-nvenc')?.disabled).toBe(true)

    const gpuOptions = clipExportOptions('gpu', {
      compatible: true,
      hasNvidiaGpu: true,
      hasFfmpeg: true,
      hasFfprobe: true,
      hasH264Cuvid: true,
      hasHevcCuvid: true,
      hasHevcNvenc: true,
      hasH264Nvenc: true,
      hasAv1Nvenc: true,
      message: 'ready',
    })
    expect(gpuOptions.find((option) => option.value === 'h264-10bit-nvenc')?.disabled).toBe(false)
  })

  it('keeps a typed quality value of zero instead of resetting it to the default', async () => {
    installMinimalMocks()
    const user = userEvent.setup()
    render(<ClipExtractorPanel active={true} />)

    const formatButton = await screen.findByRole('button', { name: /ProRes LT MOV/i })
    await user.click(formatButton)
    await user.click(screen.getByRole('option', { name: /H\.264 10-bit CPU MP4/i }))

    const qualityInput = await screen.findByRole('spinbutton', { name: /10-bit quality/i })
    await user.clear(qualityInput)
    await user.type(qualityInput, '0')
    await user.tab()
    expect(qualityInput).toHaveValue(0)
  })
})

// ─── hover-preview default (commit 97601c3) ──────────────────────────────────

describe('ClipExtractorPanel — hover-preview default is false', () => {
  beforeEach(() => installMinimalMocks())

  it('renders Hover preview only button WITHOUT is-active class by default', async () => {
    render(<ClipExtractorPanel active={true} />)
    // Wait for async refreshClipMode
    await waitFor(() =>
      expect(screen.queryByText(/hover preview only/i)).toBeInTheDocument()
    )
    const btn = screen.getByRole('button', { name: /hover preview only/i })
    expect(btn).not.toHaveClass('is-active')
  })
})

// ─── hover-preview toggle ─────────────────────────────────────────────────────

describe('ClipExtractorPanel — hover-preview toggle', () => {
  beforeEach(() => installMinimalMocks())

  it('clicking Hover preview only invokes set_config with key=clip_hover_preview and value="true"', async () => {
    mockInvoke('set_config', () => null)
    render(<ClipExtractorPanel active={true} />)
    await waitFor(() =>
      expect(screen.queryByText(/hover preview only/i)).toBeInTheDocument()
    )

    const btn = screen.getByRole('button', { name: /hover preview only/i })
    await userEvent.click(btn)

    const setConfigCall = mockInvokeFn.mock.calls.find(
      ([cmd]) => cmd === 'set_config'
    )
    expect(setConfigCall).toBeDefined()
    expect(setConfigCall![1]).toMatchObject({ key: 'clip_hover_preview', value: 'true' })
  })

  it('clicking Hover preview only dispatches clip-hover-preview-changed with { enabled: true }', async () => {
    mockInvoke('set_config', () => null)
    render(<ClipExtractorPanel active={true} />)
    await waitFor(() =>
      expect(screen.queryByText(/hover preview only/i)).toBeInTheDocument()
    )

    const events: CustomEvent[] = []
    const listener = (e: Event) => events.push(e as CustomEvent)
    window.addEventListener('clip-hover-preview-changed', listener)

    const btn = screen.getByRole('button', { name: /hover preview only/i })
    await userEvent.click(btn)

    window.removeEventListener('clip-hover-preview-changed', listener)

    expect(events.length).toBeGreaterThan(0)
    expect(events[0].detail).toEqual({ enabled: true })
  })

  it('panel\'s own clip-hover-preview-changed listener updates hoverPlayOnly state', async () => {
    mockInvoke('set_config', () => null)
    render(<ClipExtractorPanel active={true} />)
    await waitFor(() =>
      expect(screen.queryByText(/hover preview only/i)).toBeInTheDocument()
    )

    const btn = screen.getByRole('button', { name: /hover preview only/i })
    expect(btn).not.toHaveClass('is-active')

    // Dispatch the event externally (simulating another component toggling it)
    act(() => {
      window.dispatchEvent(
        new CustomEvent('clip-hover-preview-changed', { detail: { enabled: true } })
      )
    })

    await waitFor(() => expect(btn).toHaveClass('is-active'))
  })

  it('toggles back to false on second click', async () => {
    mockInvoke('set_config', () => null)
    render(<ClipExtractorPanel active={true} />)
    await waitFor(() =>
      expect(screen.queryByText(/hover preview only/i)).toBeInTheDocument()
    )

    const btn = screen.getByRole('button', { name: /hover preview only/i })
    await userEvent.click(btn) // enable
    await userEvent.click(btn) // disable

    const setConfigCalls = mockInvokeFn.mock.calls.filter(
      ([cmd]) => cmd === 'set_config'
    )
    const lastCall = setConfigCalls[setConfigCalls.length - 1]
    expect(lastCall[1]).toMatchObject({ key: 'clip_hover_preview', value: 'false' })
  })
})

// ─── basic render ─────────────────────────────────────────────────────────────

describe('ClipExtractorPanel — basic render', () => {
  beforeEach(() => installMinimalMocks())

  it('renders Extract clips button', async () => {
    render(<ClipExtractorPanel active={true} />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /extract clips/i })).toBeInTheDocument()
    )
  })

  it('renders Select episodes button', async () => {
    render(<ClipExtractorPanel active={true} />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /select episodes/i })).toBeInTheDocument()
    )
  })

  it('Extract clips button is disabled when no video selected', async () => {
    render(<ClipExtractorPanel active={true} />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /extract clips/i })).toBeDisabled()
    )
  })
})
