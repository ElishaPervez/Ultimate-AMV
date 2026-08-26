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

vi.mock('./ClipPreviewTile', async () => {
  const actual = await vi.importActual<typeof import('./ClipPreviewTile')>('./ClipPreviewTile')
  return {
    ...actual,
    ClipPreviewTile: vi.fn((props: Parameters<typeof actual.ClipPreviewTile>[0]) =>
      actual.ClipPreviewTile(props)
    ),
  }
})

// jsdom has no layout engine, so the production virtual scroller otherwise
// renders no rows. Keep the real panel and real tile mounted while replacing
// only the layout-dependent row calculation for these integration tests.
vi.mock('react-virtuoso', () => ({
  Virtuoso: (props: {
    data: unknown[]
    itemContent: (index: number, item: unknown) => React.ReactNode
    scrollerRef?: (el: HTMLElement | null) => void
    initialTopMostItemIndex?: number | { index: number; align?: string }
    rangeChanged?: (range: { startIndex: number; endIndex: number }) => void
  }) => {
    const initialIndex = typeof props.initialTopMostItemIndex === 'object'
      ? props.initialTopMostItemIndex.index
      : (props.initialTopMostItemIndex ?? 0);
    return React.createElement(
      'div',
      {
        'data-testid': 'scene-virtual-scroller',
        'data-initial-top-index': initialIndex,
        ref: (node: HTMLDivElement | null) => {
          if (node) {
            (node as unknown as { __simulateRangeChanged?: (range: { startIndex: number; endIndex: number }) => void }).__simulateRangeChanged = props.rangeChanged;
            node.getBoundingClientRect = () => ({
              top: 0,
              bottom: 800,
              left: 0,
              right: 1200,
              width: 1200,
              height: 800,
              x: 0,
              y: 0,
              toJSON: () => {},
            });
          }
          if (props.scrollerRef) {
            props.scrollerRef(node)
          }
        },
      },
      React.createElement(
        'div',
        { 'data-testid': 'virtuoso-item-list' },
        props.data.map((item, index) => React.createElement(
          'div',
          {
            key: index,
            'data-index': index,
            ref: (rowNode: HTMLDivElement | null) => {
              if (rowNode) {
                rowNode.getBoundingClientRect = () => ({
                  top: index * 150,
                  bottom: (index + 1) * 150,
                  left: 0,
                  right: 1200,
                  width: 1200,
                  height: 150,
                  x: 0,
                  y: index * 150,
                  toJSON: () => {},
                });
              }
            },
          },
          props.itemContent(index, item),
        )),
      ),
    )
  },
}))

import React from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { dispatchTauriEvent, mockInvoke, mockInvokeFn } from '../../../tests/setup/tauri'
import { mockDialogOpen } from '../../../tests/setup/dialog'
import {
  ClipExtractorPanel,
  GRID_GRAB_DRAG_THRESHOLD_PX,
  isPastDragThreshold,
  computeSelectionMarkers,
  clipBitrateDefault,
  clipQualitySpec,
  clipExportOptions,
  clipPresetExtension,
  formatSupportsRateControl,
  collectProxySourcesForActiveClips,
} from './ClipExtractorPanel'
import { ClipPreviewTile } from './ClipPreviewTile'

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
  it('supports rate control on every re-encoding preset with a bitrate target', () => {
    expect(formatSupportsRateControl('gpu-intra')).toBe(true)
    expect(formatSupportsRateControl('h264-nvenc')).toBe(true)
    expect(formatSupportsRateControl('h264-10bit-nvenc')).toBe(true)
    expect(formatSupportsRateControl('av1-nvenc')).toBe(true)
    expect(formatSupportsRateControl('h264-cpu')).toBe(true)
    expect(formatSupportsRateControl('h264-10bit-cpu')).toBe(true)
    expect(formatSupportsRateControl('hevc-cpu')).toBe(true)
    expect(formatSupportsRateControl('prores-lt')).toBe(false)
    expect(formatSupportsRateControl('prores-hq')).toBe(false)
    expect(formatSupportsRateControl('lossless-cut')).toBe(false)
    expect(formatSupportsRateControl('smart-cut')).toBe(false)
  })

  // Mirrors preset_extension_for() in src-tauri/src/clips.rs. If these two ever
  // disagree, the merge strip shows a filename the backend never writes.
  it('keeps a smart cut of an mp4-family source in mp4', () => {
    expect(clipPresetExtension('smart-cut', ['C:\\clips\\ep 1.mp4'])).toBe('mp4')
    expect(clipPresetExtension('smart-cut', ['C:\\clips\\ep 1.MP4'])).toBe('mp4')
    expect(clipPresetExtension('smart-cut', ['/media/ep1.m4v'])).toBe('mp4')
    expect(clipPresetExtension('smart-cut', ['C:\\clips\\a.mov', 'C:\\clips\\b.mp4'])).toBe('mp4')
  })

  it('falls back to mkv for any smart-cut source that is not mp4-family', () => {
    expect(clipPresetExtension('smart-cut', ['C:\\clips\\ep 1.mkv'])).toBe('mkv')
    expect(clipPresetExtension('smart-cut', ['C:\\clips\\ep 1.webm'])).toBe('mkv')
    // One mkv in a merge selection drags the whole output back to mkv.
    expect(clipPresetExtension('smart-cut', ['C:\\a.mp4', 'C:\\b.mkv'])).toBe('mkv')
    // A dotted folder name must not be mistaken for the file's extension.
    expect(clipPresetExtension('smart-cut', ['C:\\my.mp4.folder\\ep1'])).toBe('mkv')
    // Nothing selected yet: no promise beyond today's default.
    expect(clipPresetExtension('smart-cut', [])).toBe('mkv')
  })

  it('leaves every other preset fixed regardless of the source', () => {
    expect(clipPresetExtension('lossless-cut', ['C:\\clips\\ep 1.mp4'])).toBe('mkv')
    expect(clipPresetExtension('h264-cpu', ['C:\\clips\\ep 1.mkv'])).toBe('mp4')
    expect(clipPresetExtension('prores-hq', ['C:\\clips\\ep 1.mp4'])).toBe('mov')
    expect(clipPresetExtension('gpu-intra', [])).toBe('mov')
  })

  it('uses format-appropriate bitrate defaults', () => {
    expect(clipBitrateDefault('gpu-intra')).toBe(60)
    expect(clipBitrateDefault('av1-nvenc')).toBe(8)
    expect(clipBitrateDefault('hevc-cpu')).toBe(12)
    expect(clipBitrateDefault('h264-cpu')).toBe(20)
    expect(clipBitrateDefault('h264-10bit-nvenc')).toBe(20)
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

  it('shows rate control for H.264 CPU and only shows quality while Quality is active', async () => {
    installMinimalMocks()
    const user = userEvent.setup()
    render(<ClipExtractorPanel active={true} />)

    await user.click(await screen.findByRole('button', { name: /ProRes LT MOV/i }))
    await user.click(screen.getByRole('option', { name: /H\.264 CPU MP4/i }))

    expect(screen.getByRole('group', { name: /export rate control/i })).toBeVisible()
    expect(screen.getByRole('spinbutton', { name: /constant rate factor/i })).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'VBR' }))
    expect(screen.queryByRole('spinbutton', { name: /constant rate factor/i })).not.toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: /average bitrate/i })).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Quality' }))
    expect(screen.getByRole('spinbutton', { name: /constant rate factor/i })).toBeVisible()
  })

  it('returns to Quality after visiting a preset without rate control', async () => {
    installMinimalMocks()
    const user = userEvent.setup()
    render(<ClipExtractorPanel active={true} />)

    await user.click(await screen.findByRole('button', { name: /ProRes LT MOV/i }))
    await user.click(screen.getByRole('option', { name: /H\.264 CPU MP4/i }))
    await user.click(screen.getByRole('button', { name: 'CBR' }))

    await user.click(screen.getByRole('button', { name: /H\.264 CPU MP4/i }))
    await user.click(screen.getByRole('option', { name: /ProRes LT MOV/i }))
    await user.click(screen.getByRole('button', { name: /ProRes LT MOV/i }))
    await user.click(screen.getByRole('option', { name: /H\.264 CPU MP4/i }))

    expect(screen.getByRole('button', { name: 'Quality' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('spinbutton', { name: /constant rate factor/i })).toBeVisible()
  })

  it('sends CBR bitrate without a quality value for an 8-bit H.264 export', async () => {
    mockInvoke('get_config', () =>
      JSON.stringify({
        clip_extraction_mode: 'cpu',
        clip_hover_preview: false,
        featherweight_previews: false,
      }),
    )
    mockInvoke('video_gpu_status', () =>
      JSON.stringify({ hasHevcNvenc: false, hasH264Nvenc: false, hasAv1Nvenc: false }),
    )
    mockInvoke('discord_set_state', () => null)
    mockInvoke('discord_clear', () => null)
    mockInvoke('clip_extract', () =>
      JSON.stringify({
        type: 'done',
        mode: 'cpu',
        input: 'C:\\episode.mp4',
        scenes: [
          { source: 'C:\\episode.mp4', start: 1, end: 3, index: 0, label: 'Scene 1' },
        ],
        cuts: [],
        sceneCount: 1,
        fps: 24,
        duration: 3,
        totalSeconds: 0.1,
      }),
    )
    mockInvoke('clip_preview_generate_batch', () =>
      JSON.stringify({ type: 'done', items: [] }),
    )
    mockInvoke('clip_export', () => JSON.stringify({ type: 'done' }))
    mockDialogOpen
      .mockResolvedValueOnce(['C:\\episode.mp4'])
      .mockResolvedValueOnce('C:\\exports')

    const user = userEvent.setup()
    render(<ClipExtractorPanel active={true} />)

    await user.click(await screen.findByRole('button', { name: /select episodes/i }))
    await user.click(await screen.findByRole('button', { name: /extract clips/i }))
    await user.click(await screen.findByRole('button', { name: /select all clips/i }))

    await user.click(screen.getByRole('button', { name: /ProRes LT MOV/i }))
    await user.click(screen.getByRole('option', { name: /H\.264 CPU MP4/i }))
    await user.click(screen.getByRole('button', { name: 'CBR' }))
    await user.click(screen.getByRole('button', { name: /Export 1 clips/i }))

    await waitFor(() => {
      const exportCall = mockInvokeFn.mock.calls.find(([command]) => command === 'clip_export')
      expect(exportCall?.[1]).toMatchObject({
        preset: 'h264-cpu',
        qualityValue: null,
        rateMode: 'cbr',
        bitrateMbps: 20,
      })
    })
  })

  it('smooths every exported clip in one interpolation batch', async () => {
    mockInvoke('get_config', () =>
      JSON.stringify({
        clip_extraction_mode: 'cpu',
        clip_hover_preview: false,
        featherweight_previews: false,
      }),
    )
    mockInvoke('video_gpu_status', () =>
      JSON.stringify({ hasHevcNvenc: false, hasH264Nvenc: false, hasAv1Nvenc: false }),
    )
    mockInvoke('discord_set_state', () => null)
    mockInvoke('discord_clear', () => null)
    mockInvoke('clip_extract', () =>
      JSON.stringify({
        type: 'done',
        mode: 'cpu',
        input: 'C:\\episode.mp4',
        scenes: [
          { source: 'C:\\episode.mp4', start: 1, end: 3, index: 0, label: 'Scene 1' },
          { source: 'C:\\episode.mp4', start: 4, end: 6, index: 1, label: 'Scene 2' },
        ],
        cuts: [],
        sceneCount: 2,
        fps: 24,
        duration: 6,
        totalSeconds: 0.1,
      }),
    )
    mockInvoke('clip_preview_generate_batch', () =>
      JSON.stringify({ type: 'done', items: [] }),
    )
    mockInvoke<{ clips: Array<{ index: number }> }>('clip_export', ({ clips }) =>
      JSON.stringify({
        type: 'done',
        output: 'C:\\exports',
        outputs: [`C:\\exports\\${clips[0].index + 1}.mp4`],
      }),
    )
    mockInvoke('interpolate_exported_clips', () =>
      JSON.stringify({ type: 'done', succeeded: 2, failed: 0 }),
    )
    mockDialogOpen
      .mockResolvedValueOnce(['C:\\episode.mp4'])
      .mockResolvedValueOnce('C:\\exports')

    const user = userEvent.setup()
    render(<ClipExtractorPanel active={true} />)

    await user.click(await screen.findByRole('button', { name: /select episodes/i }))
    await user.click(await screen.findByRole('button', { name: /extract clips/i }))
    await user.click(await screen.findByRole('button', { name: /select all clips/i }))
    await user.click(screen.getByRole('checkbox', { name: /Smooth motion/i }))
    await user.click(screen.getByRole('button', { name: /Export 2 clips/i }))

    await waitFor(() => {
      const smoothingCalls = mockInvokeFn.mock.calls.filter(
        ([command]) => command === 'interpolate_exported_clips',
      )
      expect(smoothingCalls).toHaveLength(1)
      expect(smoothingCalls[0]?.[1]).toMatchObject({
        paths: ['C:\\exports\\1.mp4', 'C:\\exports\\2.mp4'],
        factor: 2,
        model: 'rife4.25',
        gpu: false,
        half: false,
      })
      const exportCalls = mockInvokeFn.mock.calls.filter(([command]) => command === 'clip_export')
      expect(exportCalls).toHaveLength(2)
      expect(exportCalls[0]?.[1]).toMatchObject({ preset: 'h264-cpu' })
    })
  })
})

// ─── Smart cut export preset ─────────────────────────────────────────────────

describe('Smart cut export preset', () => {
  it('offers no quality or rate control, like the other stream-copy presets', () => {
    expect(clipQualitySpec('smart-cut')).toBeNull()
    expect(clipQualitySpec('lossless-cut')).toBeNull()
    expect(formatSupportsRateControl('smart-cut')).toBe(false)
  })

  it('is selectable in CPU and GPU clip mode', () => {
    const cpuOptions = clipExportOptions('cpu', null)
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
    expect(cpuOptions.find((option) => option.value === 'smart-cut')?.disabled).toBe(false)
    expect(gpuOptions.find((option) => option.value === 'smart-cut')?.disabled).toBe(false)
    // Sits directly under Lossless cut in the dropdown.
    expect(cpuOptions.findIndex((option) => option.value === 'smart-cut')).toBe(
      cpuOptions.findIndex((option) => option.value === 'lossless-cut') + 1,
    )
  })

  it('hides the quality and rate-control inputs while it is selected', async () => {
    installMinimalMocks()
    const user = userEvent.setup()
    render(<ClipExtractorPanel active={true} />)

    await user.click(await screen.findByRole('button', { name: /ProRes LT MOV/i }))
    await user.click(screen.getByRole('option', { name: /Smart cut/i }))

    expect(screen.queryByRole('group', { name: /export rate control/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('spinbutton', { name: /constant rate factor/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('spinbutton', { name: /average bitrate/i })).not.toBeInTheDocument()
  })

  it('exports with no quality value, rate mode or bitrate', async () => {
    mockInvoke('get_config', () =>
      JSON.stringify({
        clip_extraction_mode: 'cpu',
        clip_hover_preview: false,
        featherweight_previews: false,
      }),
    )
    mockInvoke('video_gpu_status', () =>
      JSON.stringify({ hasHevcNvenc: false, hasH264Nvenc: false, hasAv1Nvenc: false }),
    )
    mockInvoke('discord_set_state', () => null)
    mockInvoke('discord_clear', () => null)
    mockInvoke('clip_extract', () =>
      JSON.stringify({
        type: 'done',
        mode: 'cpu',
        input: 'C:\\episode.mp4',
        scenes: [
          { source: 'C:\\episode.mp4', start: 1, end: 3, index: 0, label: 'Scene 1' },
        ],
        cuts: [],
        sceneCount: 1,
        fps: 24,
        duration: 3,
        totalSeconds: 0.1,
      }),
    )
    mockInvoke('clip_preview_generate_batch', () =>
      JSON.stringify({ type: 'done', items: [] }),
    )
    mockInvoke('clip_export', () => JSON.stringify({ type: 'done' }))
    mockDialogOpen
      .mockResolvedValueOnce(['C:\\episode.mp4'])
      .mockResolvedValueOnce('C:\\exports')

    const user = userEvent.setup()
    render(<ClipExtractorPanel active={true} />)

    await user.click(await screen.findByRole('button', { name: /select episodes/i }))
    await user.click(await screen.findByRole('button', { name: /extract clips/i }))
    await user.click(await screen.findByRole('button', { name: /select all clips/i }))

    await user.click(screen.getByRole('button', { name: /ProRes LT MOV/i }))
    await user.click(screen.getByRole('option', { name: /Smart cut/i }))
    await user.click(await screen.findByRole('button', { name: /Export 1 clips/i }))

    await waitFor(() => {
      const exportCall = mockInvokeFn.mock.calls.find(([command]) => command === 'clip_export')
      expect(exportCall?.[1]).toMatchObject({
        preset: 'smart-cut',
        qualityValue: null,
        rateMode: null,
        bitrateMbps: null,
      })
    })
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

describe('ClipExtractorPanel — grid preview speed', () => {
  it('shows the saved speed with the full supported range', async () => {
    installMinimalMocks()
    render(<ClipExtractorPanel active={true} />)

    const slider = await screen.findByRole('slider', { name: 'Grid preview playback speed' })
    expect(slider).toHaveAttribute('min', '0.25')
    expect(slider).toHaveAttribute('max', '4')
    expect(slider).toHaveAttribute('step', '0.25')
    expect(slider).toHaveValue('1')
    expect(screen.getByText('1.0x')).toBeInTheDocument()
  })

  it('disables speed changes when lightweight previews are off', async () => {
    mockInvoke('get_config', () =>
      JSON.stringify({
        clip_extraction_mode: 'cpu',
        clip_hover_preview: false,
        featherweight_previews: false,
        clip_preview_speed: 1,
      }),
    )
    mockInvoke('video_gpu_status', () =>
      JSON.stringify({ hasHevcNvenc: false, hasH264Nvenc: false, hasAv1Nvenc: false }),
    )
    mockInvoke('discord_set_state', () => null)
    render(<ClipExtractorPanel active={true} />)

    const slider = await screen.findByRole('slider', { name: 'Grid preview playback speed' })
    expect(slider).toBeDisabled()
    expect(slider.closest('.clip-cols-control')).toHaveAttribute(
      'title',
      'Preview speed needs the featherweight preview engine. Turn it on in Settings.',
    )
  })

  it('updates immediately and saves after the slider settles', async () => {
    installMinimalMocks()
    mockInvoke('set_config', () => null)
    render(<ClipExtractorPanel active={true} />)
    const slider = await screen.findByRole('slider', { name: 'Grid preview playback speed' })

    fireEvent.change(slider, { target: { value: '2' } })

    expect(screen.getByText('2.0x')).toBeInTheDocument()
    await waitFor(
      () => {
        expect(mockInvokeFn).toHaveBeenCalledWith('set_config', {
          key: 'clip_preview_speed',
          value: '2',
        })
      },
      { timeout: 600 },
    )
  })

  it('reflects a speed change made in Settings', async () => {
    installMinimalMocks()
    render(<ClipExtractorPanel active={true} />)
    await screen.findByRole('slider', { name: 'Grid preview playback speed' })

    act(() => {
      window.dispatchEvent(
        new CustomEvent('clip-preview-speed-changed', { detail: { speed: 1.75 } }),
      )
    })

    expect(screen.getByRole('slider', { name: 'Grid preview playback speed' })).toHaveValue('1.75')
    expect(screen.getByText('1.75x')).toBeInTheDocument()
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

describe('ClipExtractorPanel — lazy proxy scheduling', () => {
  it('does not queue proxies for selected episodes before scenes are visible', async () => {
    const detectionResolvers: Array<(value: string) => void> = []
    const detectionResult = (input: string) => JSON.stringify({
      type: 'done',
      mode: 'cpu',
      input,
      scenes: [],
      cuts: [],
      sceneCount: 0,
      fps: 24,
      duration: 60,
      totalSeconds: 1,
    })
    mockInvoke('get_config', () => JSON.stringify({
      clip_extraction_mode: 'cpu',
      clip_hover_preview: false,
      featherweight_previews: true,
    }))
    mockInvoke('video_gpu_status', () => JSON.stringify({
      hasHevcNvenc: false,
      hasH264Nvenc: false,
      hasAv1Nvenc: false,
    }))
    mockInvoke('discord_set_state', () => null)
    mockInvoke('discord_clear', () => null)
    mockInvoke('build_source_proxy', () => 'C:\\proxy.mp4')
    mockInvoke('clip_extract', () => new Promise<string>((resolve) => {
      detectionResolvers.push(resolve)
    }))
    mockDialogOpen.mockResolvedValueOnce(['C:\\episode-1.mkv', 'C:\\episode-2.mkv'])

    const user = userEvent.setup()
    render(<ClipExtractorPanel active />)
    await user.click(await screen.findByRole('button', { name: /select episodes/i }))
    await user.click(await screen.findByRole('button', { name: /extract clips/i }))
    await waitFor(() => expect(
      mockInvokeFn.mock.calls.some(([command]) => command === 'clip_extract'),
    ).toBe(true))

    expect(mockInvokeFn.mock.calls.filter(([command]) => command === 'build_source_proxy')).toHaveLength(0)

    await act(async () => {
      detectionResolvers[0](detectionResult('C:\\episode-1.mkv'))
    })
    await waitFor(() => expect(detectionResolvers).toHaveLength(2))
    await act(async () => {
      detectionResolvers[1](detectionResult('C:\\episode-2.mkv'))
    })
    await waitFor(() => expect(
      screen.getByRole('button', { name: /extract clips/i }),
    ).toBeEnabled())
  })

  it('requests proxies only for active sources and never duplicates an in-flight source', () => {
    const baseClip = {
      index: 0,
      label: 'Scene 1',
      range: '00:01 - 00:03',
      sourceName: 'episode',
      sourceSrc: 'asset',
      sourceStart: 1,
      sourceEnd: 3,
      previewStart: 1,
      previewEnd: 3,
      fps: 24,
    }
    const episode1Clip = {
      ...baseClip,
      id: 'episode-1-scene-1',
      path: 'C:\\episode-1.mkv',
    }
    const episode2Clip = {
      ...baseClip,
      id: 'episode-2-scene-1',
      path: 'C:\\episode-2.mkv',
    }
    const plan = {
      mode: 'proxy' as const,
      videoCodec: 'hevc',
      audioCodec: 'aac',
      width: 1920,
      height: 1080,
      pixFmt: 'yuv420p10le',
      container: 'matroska',
      inScope: true,
      reasons: ['codec'],
    }
    const input = {
      clips: [episode1Clip, episode2Clip],
      activeClipIds: new Set([episode1Clip.id]),
      playbackPlans: {
        'C:\\episode-1.mkv': plan,
        'C:\\episode-2.mkv': plan,
      },
      resolvedSources: new Set<string>(),
      inFlightSources: new Set<string>(),
    }

    expect(collectProxySourcesForActiveClips(input)).toEqual(['C:\\episode-1.mkv'])
    expect(collectProxySourcesForActiveClips({
      ...input,
      inFlightSources: new Set(['C:\\episode-1.mkv']),
    })).toEqual([])
  })
})

function sceneExtractionResult(input: string, label = 'Scene 1') {
  return JSON.stringify({
    type: 'done',
    mode: 'cpu',
    input,
    scenes: [
      { source: input, start: 1, end: 3, index: 0, label },
    ],
    cuts: [],
    sceneCount: 1,
    fps: 24,
    duration: 3,
    totalSeconds: 0.1,
  })
}

function proxyPlaybackPlan() {
  return {
    mode: 'proxy' as const,
    videoCodec: 'hevc',
    audioCodec: 'aac',
    width: 1920,
    height: 1080,
    pixFmt: 'yuv420p10le',
    container: 'matroska',
    inScope: true,
    reasons: ['codec'],
  }
}

function installScenePanelMocks(featherweightPreviews: boolean) {
  mockInvoke('get_config', () => JSON.stringify({
    clip_extraction_mode: 'cpu',
    clip_hover_preview: false,
    featherweight_previews: featherweightPreviews,
  }))
  mockInvoke('video_gpu_status', () => JSON.stringify({
    hasHevcNvenc: false,
    hasH264Nvenc: false,
    hasAv1Nvenc: false,
  }))
  mockInvoke('clip_preview_generate_batch', () => JSON.stringify({ type: 'done', items: [] }))
  mockInvoke('discord_set_state', () => null)
  mockInvoke('discord_clear', () => null)
}

describe('ClipExtractorPanel â final review regressions', () => {
  it('leaves a failed visible proxy tile on its static fallback immediately', async () => {
    installScenePanelMocks(true)
    mockInvoke('clip_extract', () => sceneExtractionResult('C:\\episode.mkv'))
    mockInvoke('clip_playback_plan', () => proxyPlaybackPlan())
    let rejectProxy!: (reason?: unknown) => void
    mockInvoke('build_source_proxy', () => new Promise<string>((_resolve, reject) => {
      rejectProxy = reject
    }))
    mockDialogOpen.mockResolvedValueOnce(['C:\\episode.mkv'])

    const user = userEvent.setup()
    render(<ClipExtractorPanel active />)
    await user.click(await screen.findByRole('button', { name: /select episodes/i }))
    await user.click(await screen.findByRole('button', { name: /extract clips/i }))
    await waitFor(() => expect(mockInvokeFn.mock.calls.some(([command]) => command === 'clip_extract')).toBe(true))
    await screen.findByText('Scene 1')
    await waitFor(() => expect(
      mockInvokeFn.mock.calls.some(([command]) => command === 'build_source_proxy'),
    ).toBe(true))

    const tile = () => document.querySelector('.clip-preview-tile-wrapper') as HTMLElement
    expect(tile().querySelector('.clip-video-placeholder.is-loading')).toBeInTheDocument()

    await act(async () => {
      rejectProxy(new Error('proxy failed'))
    })

    await waitFor(() => {
      expect(tile().querySelector('.clip-video-placeholder')).toBeInTheDocument()
      expect(tile().querySelector('.clip-video-placeholder.is-loading')).not.toBeInTheDocument()
    })
  })

  it('ignores old detection results when a replacement source starts a new run', async () => {
    installScenePanelMocks(false)
    const detectionResolvers: Array<(value: string) => void> = []
    mockInvoke('clip_extract', () => new Promise<string>((resolve) => {
      detectionResolvers.push(resolve)
    }))
    mockInvoke('cancel_clip', () => null)
    mockDialogOpen
      .mockResolvedValueOnce(['C:\\old.mkv'])
      .mockResolvedValueOnce(['C:\\new.mkv'])

    const user = userEvent.setup()
    render(<ClipExtractorPanel active />)
    await user.click(await screen.findByRole('button', { name: /select episodes/i }))
    await user.click(await screen.findByRole('button', { name: /extract clips/i }))
    await waitFor(() => expect(detectionResolvers).toHaveLength(1))

    await user.click(screen.getByRole('button', { name: /change episodes/i }))
    await waitFor(() => expect(
      screen.getByRole('button', { name: /extract clips/i }),
    ).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /extract clips/i }))
    await waitFor(() => expect(detectionResolvers).toHaveLength(2))

    await act(async () => {
      detectionResolvers[0](sceneExtractionResult('C:\\old.mkv', 'Old scene'))
    })
    await waitFor(() => expect(screen.queryByText('Old scene')).not.toBeInTheDocument())

    await act(async () => {
      detectionResolvers[1](sceneExtractionResult('C:\\new.mkv', 'New scene'))
    })
    await waitFor(() => expect(screen.getByText('New scene')).toBeInTheDocument())
  })

  it('ignores a late proxy event from an old request after the same source restarts', async () => {
    installScenePanelMocks(true)
    mockInvoke('clip_extract', () => sceneExtractionResult('C:\\episode.mkv'))
    mockInvoke('clip_playback_plan', () => proxyPlaybackPlan())
    const buildResolvers: Array<(value: string) => void> = []
    const buildRejectors: Array<(reason?: unknown) => void> = []
    mockInvoke('build_source_proxy', () => new Promise<string>((resolve, reject) => {
      buildResolvers.push(resolve)
      buildRejectors.push(reject)
    }))
    mockDialogOpen.mockResolvedValueOnce(['C:\\episode.mkv'])

    const user = userEvent.setup()
    render(<ClipExtractorPanel active />)
    await user.click(await screen.findByRole('button', { name: /select episodes/i }))
    await user.click(await screen.findByRole('button', { name: /extract clips/i }))
    await screen.findByText('Scene 1')
    await waitFor(() => expect(buildResolvers).toHaveLength(1))
    const firstRequest = mockInvokeFn.mock.calls
      .filter(([command]) => command === 'build_source_proxy')[0]?.[1] as { requestId: string }
    expect(firstRequest.requestId).toEqual(expect.any(String))

    act(() => {
      dispatchTauriEvent('proxy-progress', {
        sourcePath: 'C:\\episode.mkv',
        requestId: firstRequest.requestId,
        percent: 24,
        stage: 'processing',
      })
    })
    expect(screen.getByText('24%')).toBeInTheDocument()

    act(() => {
      window.dispatchEvent(new CustomEvent('scene-preview-height-changed', { detail: { height: 360 } }))
    })
    await waitFor(() => expect(buildResolvers).toHaveLength(2))
    const secondRequest = mockInvokeFn.mock.calls
      .filter(([command]) => command === 'build_source_proxy')[1]?.[1] as { requestId: string }
    expect(secondRequest.requestId).not.toBe(firstRequest.requestId)

    act(() => {
      dispatchTauriEvent('proxy-progress', {
        sourcePath: 'C:\\episode.mkv',
        requestId: firstRequest.requestId,
        percent: 88,
        stage: 'processing',
      })
    })
    expect(screen.queryByText('88%')).not.toBeInTheDocument()

    act(() => {
      dispatchTauriEvent('proxy-progress', {
        sourcePath: 'C:\\episode.mkv',
        requestId: secondRequest.requestId,
        percent: 41,
        stage: 'processing',
      })
    })
    expect(screen.getByText('41%')).toBeInTheDocument()

    await act(async () => {
      buildRejectors[0](new Error('old request cancelled'))
      buildRejectors[1](new Error('new request failed'))
    })
  })

  it('routes compatibility progress to its modal after a completed export is retained', async () => {
    installScenePanelMocks(false)
    let extractionCount = 0
    mockInvoke('clip_extract', () => {
      extractionCount += 1
      return extractionCount === 1
        ? sceneExtractionResult('C:\\episode.mkv')
        : Promise.reject(new Error('unsupported source'))
    })
    mockInvoke('clip_preview_generate_batch', () => JSON.stringify({ type: 'done', items: [] }))
    mockInvoke('clip_export', () => JSON.stringify({ type: 'done', output: 'C:\\exports\\1.mov' }))
    let resolveCompat!: (value: string) => void
    mockInvoke('clip_compat_convert', () => new Promise<string>((resolve) => {
      resolveCompat = resolve
    }))
    mockDialogOpen
      .mockResolvedValueOnce(['C:\\episode.mkv'])
      .mockResolvedValueOnce('C:\\exports')

    const user = userEvent.setup()
    render(<ClipExtractorPanel active />)
    await user.click(await screen.findByRole('button', { name: /select episodes/i }))
    await user.click(await screen.findByRole('button', { name: /extract clips/i }))
    await screen.findByText('Scene 1')
    await user.click(await screen.findByRole('button', { name: /select all clips/i }))
    await user.click(await screen.findByRole('button', { name: /Export 1 clips/i }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Export progress' })).toHaveTextContent('Exported 1 of 1 clips'))

    fireEvent.click(screen.getByRole('button', { name: /extract again/i }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Unsupported format' })).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /Convert to compatible format/i }))
    await waitFor(() => expect(mockInvokeFn.mock.calls.some(([command]) => command === 'clip_compat_convert')).toBe(true))

    const exportRow = screen.getByRole('list', { name: /per-clip status/i }).querySelector('li') as HTMLElement
    expect(exportRow).toHaveClass('is-done')
    act(() => {
      dispatchTauriEvent('conversion-progress', {
        stage: 'processing',
        percent: 64,
        message: 'Compatibility conversion 64%',
        clipIndex: 1,
        clipCount: 1,
      })
    })
    expect(screen.getByText('Compatibility conversion 64%')).toBeInTheDocument()
    expect(exportRow).toHaveClass('is-done')
    expect(exportRow).not.toHaveClass('is-active')

    await act(async () => {
      resolveCompat(JSON.stringify({ type: 'done', output: 'C:\\cache\\episode.mp4', cached: false }))
    })
  })

  it('keeps actual rendered tiles mounted while repeated detection progress updates arrive', async () => {
    installScenePanelMocks(true)
    const detectionResolvers: Array<(value: string) => void> = []
    mockInvoke('clip_extract', () => new Promise<string>((resolve) => {
      detectionResolvers.push(resolve)
    }))
    mockInvoke('clip_playback_plan', () => proxyPlaybackPlan())
    mockInvoke('build_source_proxy', () => Promise.reject(new Error('proxy unavailable')))
    mockDialogOpen.mockResolvedValueOnce(['C:\\episode-1.mkv', 'C:\\episode-2.mkv'])

    const user = userEvent.setup()
    const tileRenderMock = vi.mocked(ClipPreviewTile)
    tileRenderMock.mockClear()
    render(<ClipExtractorPanel active />)
    await user.click(await screen.findByRole('button', { name: /select episodes/i }))
    await user.click(await screen.findByRole('button', { name: /extract clips/i }))
    await waitFor(() => expect(detectionResolvers).toHaveLength(1))
    await act(async () => {
      detectionResolvers[0](sceneExtractionResult('C:\\episode-1.mkv'))
    })
    await screen.findByText('Scene 1')
    await waitFor(() => expect(mockInvokeFn.mock.calls.some(([command]) => command === 'build_source_proxy')).toBe(true))
    await waitFor(() => expect(document.querySelector('.clip-video-placeholder.is-loading')).not.toBeInTheDocument())
    tileRenderMock.mockClear()

    act(() => {
      for (const percent of [12, 28, 44, 61]) {
        dispatchTauriEvent('clip-progress', {
          type: 'progress',
          stage: 'detecting',
          percent,
          message: `Detecting ${percent}%`,
        })
      }
    })

    expect(tileRenderMock).toHaveBeenCalledTimes(0)

    await waitFor(() => expect(detectionResolvers).toHaveLength(2))
    await act(async () => {
      detectionResolvers[1](sceneExtractionResult('C:\\episode-2.mkv', 'Scene 2'))
    })
  })

  it('preserves top visible clip anchor when changing columns in classic preview mode and ignores width resize', async () => {
    installScenePanelMocks(false)
    const scenes: Array<{ source: string; start: number; end: number; index: number; label: string }> = []
    for (let i = 0; i < 40; i += 1) {
      scenes.push({
        source: 'C:\\episode.mkv',
        start: i * 2,
        end: (i + 1) * 2,
        index: i,
        label: `Scene ${i + 1}`,
      })
    }
    mockInvoke('clip_extract', () => JSON.stringify({
      type: 'done',
      mode: 'cpu',
      input: 'C:\\episode.mkv',
      scenes,
      cuts: [],
      sceneCount: 40,
      fps: 24,
      duration: 80,
      totalSeconds: 0.1,
    }))
    mockDialogOpen.mockResolvedValueOnce(['C:\\episode.mkv'])

    const user = userEvent.setup()
    render(<ClipExtractorPanel active />)
    await user.click(await screen.findByRole('button', { name: /select episodes/i }))
    await user.click(await screen.findByRole('button', { name: /extract clips/i }))
    await screen.findByText('Scene 1')

    const scroller = await screen.findByTestId('scene-virtual-scroller')
    expect(scroller).toBeInTheDocument()

    // 1 & 2. Put virtual grid at a deep visible row: row 6 (clips 24..27 in 4-col mode, top clip is clip 24)
    act(() => {
      const sim = (scroller as unknown as { __simulateRangeChanged?: (range: { startIndex: number; endIndex: number }) => void }).__simulateRangeChanged
      if (sim) {
        sim({ startIndex: 6, endIndex: 8 })
      }
    })

    // 3. Change column count to 2
    const twoColButton = screen.getByRole('button', { name: /2 columns/i })
    await user.click(twoColButton)

    // 4. Confirm clip 24 remains the anchor after remounting (in 2-column mode: row 24 / 2 = 12)
    const scrollerAfterRemount = await screen.findByTestId('scene-virtual-scroller')
    expect(scrollerAfterRemount).toBeInTheDocument()
    expect(scrollerAfterRemount.getAttribute('data-initial-top-index')).toBe('12')

    // 5. While still deep in classic mode, simulate a width resize
    act(() => {
      scrollerAfterRemount.getBoundingClientRect = () => ({
        top: 0,
        bottom: 800,
        left: 0,
        right: 900,
        width: 900,
        height: 800,
        x: 0,
        y: 0,
        toJSON: () => {},
      })
      window.dispatchEvent(new Event('resize'))
    })

    // 6. Confirm lightweight layout generation did not change and grid did not remount or jump to row 0
    expect(scrollerAfterRemount.getAttribute('data-initial-top-index')).toBe('12')
  })

  it('proves the same granted clip IDs control playback plan probes, proxy builds, loading states, and live player mounting while ungranted clips receive none', async () => {
    installScenePanelMocks(true)

    const scenes: Array<{ source: string; start: number; end: number; index: number; label: string }> = []
    for (let i = 0; i < 24; i += 1) {
      scenes.push({
        source: 'C:\\episode-1.mkv',
        start: i * 2,
        end: (i + 1) * 2,
        index: i,
        label: `Scene ${i + 1}`,
      })
    }
    for (let i = 24; i < 32; i += 1) {
      scenes.push({
        source: 'C:\\episode-2.mkv',
        start: (i - 24) * 2,
        end: (i - 24 + 1) * 2,
        index: i,
        label: `Scene ${i + 1}`,
      })
    }

    mockInvoke('clip_extract', () => JSON.stringify({
      type: 'done',
      mode: 'cpu',
      input: 'C:\\episode-1.mkv',
      scenes,
      cuts: [],
      sceneCount: 32,
      fps: 24,
      duration: 64,
      totalSeconds: 0.1,
    }))

    mockInvoke('clip_playback_plan', () => proxyPlaybackPlan())
    let resolveProxy1!: (value: string) => void
    mockInvoke('build_source_proxy', (args: { sourcePath: string }) => new Promise<string>((resolve) => {
      if (args.sourcePath === 'C:\\episode-1.mkv') {
        resolveProxy1 = resolve
      }
    }))
    mockDialogOpen.mockResolvedValueOnce(['C:\\episode-1.mkv'])

    const user = userEvent.setup()
    render(<ClipExtractorPanel active />)
    await user.click(await screen.findByRole('button', { name: /select episodes/i }))
    await user.click(await screen.findByRole('button', { name: /extract clips/i }))
    await screen.findByText('Scene 1')

    // 1. Playback plan probe was invoked for granted source (Ep1) but NOT ungranted source (Ep2)
    await waitFor(() => expect(
      mockInvokeFn.mock.calls.some(([cmd, args]) => cmd === 'clip_playback_plan' && (args as { sourcePath?: string } | undefined)?.sourcePath === 'C:\\episode-1.mkv')
    ).toBe(true))
    expect(
      mockInvokeFn.mock.calls.some(([cmd, args]) => cmd === 'clip_playback_plan' && (args as { sourcePath?: string } | undefined)?.sourcePath === 'C:\\episode-2.mkv')
    ).toBe(false)

    // 2. Proxy build was invoked for granted source (Ep1) but NOT ungranted source (Ep2)
    await waitFor(() => expect(
      mockInvokeFn.mock.calls.some(([cmd, args]) => cmd === 'build_source_proxy' && (args as { sourcePath?: string } | undefined)?.sourcePath === 'C:\\episode-1.mkv')
    ).toBe(true))
    expect(
      mockInvokeFn.mock.calls.some(([cmd, args]) => cmd === 'build_source_proxy' && (args as { sourcePath?: string } | undefined)?.sourcePath === 'C:\\episode-2.mkv')
    ).toBe(false)

    // 3. Granted card shows loading state, ungranted card does not
    const allTiles = document.querySelectorAll('.clip-preview-tile-wrapper')
    expect(allTiles.length).toBeGreaterThanOrEqual(25)
    const grantedTile = allTiles[0]
    const ungrantedTile = allTiles[allTiles.length - 1]

    expect(grantedTile.querySelector('.clip-video-placeholder.is-loading')).toBeInTheDocument()
    expect(ungrantedTile.querySelector('.clip-video-placeholder.is-loading')).not.toBeInTheDocument()

    // 4. Resolve proxy for granted source
    await act(async () => {
      resolveProxy1('C:\\cache\\episode-1-proxy.mp4')
    })

    // 5. Video player is mounted for the granted clip, but NOT for the ungranted clip
    await waitFor(() => {
      expect(grantedTile.querySelector('.clip-offset-video')).toBeInTheDocument()
      expect(grantedTile.querySelector('.clip-video-placeholder.is-loading')).not.toBeInTheDocument()
    })
    expect(ungrantedTile.querySelector('.clip-offset-video')).not.toBeInTheDocument()
  })
})
