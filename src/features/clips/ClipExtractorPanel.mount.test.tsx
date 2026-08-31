/**
 * Central measured-geometry mount-set cap tests.
 *
 * These exercise `selectClipPlaybackWindow` — the pure selection algorithm
 * governing which grid tiles are granted live playback. The white-screen crash
 * this guards against is a WebView2 renderer/GPU death from exceeding Chromium's
 * ~75 concurrent video-decoder limit, so the load-bearing invariant is:
 *
 *   ACROSS A FAST FLING (every transient scroll position), the size of the
 *   granted mount set NEVER exceeds the hard cap.
 *
 * Plus the no-dead-zone invariant: once the fling settles, every VISIBLE row's
 * tiles are in the granted set.
 */

import { describe, it, expect } from 'vitest'
import { selectClipPlaybackWindow, type MeasuredClipRow } from './clipPlaybackWindow'
import {
  DECODER_SAFETY_LIMIT,
  MAX_GRID_VIDEO_PLAYERS_CEILING,
  PREVIEW_PLAY_AREA_MARGIN_PX,
} from '../../lib/constants'

// Build a tall, dense grid of rows so the eligible band routinely EXCEEDS the
// cap and the outward-walk truncation actually bites (the whole point of the
// cap). 4 columns × 400 rows = 1600 tiles.
const GRID_COLS = 4
const ROW_COUNT = 400
const ROW_HEIGHT_PX = 120
const VIEWPORT_HEIGHT_PX = 900

function makeClipRows(rows = ROW_COUNT, cols = GRID_COLS): { id: string }[][] {
  const out: { id: string }[][] = []
  for (let r = 0; r < rows; r += 1) {
    const row: { id: string }[] = []
    for (let c = 0; c < cols; c += 1) row.push({ id: `clip-${r}-${c}` })
    out.push(row)
  }
  return out
}

function makeMeasuredRows(clipRows: { id: string }[][], rowHeight = ROW_HEIGHT_PX): MeasuredClipRow[] {
  const out: MeasuredClipRow[] = []
  for (let r = 0; r < clipRows.length; r += 1) {
    out.push({
      rowIndex: r,
      top: r * rowHeight,
      bottom: (r + 1) * rowHeight,
      clipIds: clipRows[r].map((c) => c.id),
    })
  }
  return out
}

describe('selectClipPlaybackWindow — hard cap across a fast fling', () => {
  const clipRows = makeClipRows()
  const rows = makeMeasuredRows(clipRows)
  const maxScrollTop = ROW_COUNT * ROW_HEIGHT_PX - VIEWPORT_HEIGHT_PX

  it('never exceeds the ceiling at ANY transient scroll position during a fling', () => {
    const hardCap = MAX_GRID_VIDEO_PLAYERS_CEILING
    let maxObserved = 0
    for (let scrollTopPx = 0; scrollTopPx <= maxScrollTop; scrollTopPx += 137) {
      const result = selectClipPlaybackWindow({
        rows,
        viewportTop: scrollTopPx,
        viewportBottom: scrollTopPx + VIEWPORT_HEIGHT_PX,
        marginPx: PREVIEW_PLAY_AREA_MARGIN_PX,
        requestedCap: hardCap,
        hardCap,
      })
      expect(result.grantedIds.size).toBeLessThanOrEqual(hardCap)
      if (result.grantedIds.size > maxObserved) {
        maxObserved = result.grantedIds.size
      }
    }
    expect(maxObserved).toBe(hardCap)
  })

  it('respects a LOWER live knob as the PRE-WARM bound while ensuring visible tiles mount', () => {
    const requestedCap = 16
    for (let scrollTopPx = 0; scrollTopPx <= maxScrollTop; scrollTopPx += 211) {
      const result = selectClipPlaybackWindow({
        rows,
        viewportTop: scrollTopPx,
        viewportBottom: scrollTopPx + VIEWPORT_HEIGHT_PX,
        marginPx: PREVIEW_PLAY_AREA_MARGIN_PX,
        requestedCap,
        hardCap: MAX_GRID_VIDEO_PLAYERS_CEILING,
      })
      const firstVisibleRow = Math.floor(scrollTopPx / ROW_HEIGHT_PX)
      const lastVisibleRow = Math.ceil((scrollTopPx + VIEWPORT_HEIGHT_PX) / ROW_HEIGHT_PX) - 1
      const visibleTileCount =
        (Math.min(lastVisibleRow, ROW_COUNT - 1) - firstVisibleRow + 1) * GRID_COLS
      const effectiveCap = Math.min(
        MAX_GRID_VIDEO_PLAYERS_CEILING,
        Math.max(requestedCap, visibleTileCount),
      )
      expect(result.grantedIds.size).toBeLessThanOrEqual(effectiveCap)
      expect(result.grantedIds.size).toBeLessThanOrEqual(MAX_GRID_VIDEO_PLAYERS_CEILING)
    }
  })

  it('after the fling settles, every VISIBLE row is in the granted set (no dead-zone)', () => {
    const hardCap = MAX_GRID_VIDEO_PLAYERS_CEILING
    const scrollTopPx = 137 * 137
    const result = selectClipPlaybackWindow({
      rows,
      viewportTop: scrollTopPx,
      viewportBottom: scrollTopPx + VIEWPORT_HEIGHT_PX,
      marginPx: PREVIEW_PLAY_AREA_MARGIN_PX,
      requestedCap: hardCap,
      hardCap,
    })
    expect(result.grantedIds.size).toBeLessThanOrEqual(hardCap)

    const firstVisibleRow = Math.floor(scrollTopPx / ROW_HEIGHT_PX)
    const lastVisibleRow = Math.ceil((scrollTopPx + VIEWPORT_HEIGHT_PX) / ROW_HEIGHT_PX) - 1
    for (let r = firstVisibleRow; r <= lastVisibleRow; r += 1) {
      for (const clip of clipRows[r]) {
        expect(result.grantedIds.has(clip.id)).toBe(true)
      }
    }
  })

  it.each([
    ['prod knob cap', 12],
    ['dev knob cap', 16],
  ])('no cap-below-visible dead-zone with the %s (every visible tile mounts)', (_label, requestedCap) => {
    const scrollTopPx = 137 * 137
    const firstVisibleRow = Math.floor(scrollTopPx / ROW_HEIGHT_PX)
    const lastVisibleRow = Math.ceil((scrollTopPx + VIEWPORT_HEIGHT_PX) / ROW_HEIGHT_PX) - 1
    const visibleTileCount = (lastVisibleRow - firstVisibleRow + 1) * GRID_COLS

    expect(visibleTileCount).toBeGreaterThan(requestedCap)
    expect(visibleTileCount).toBeLessThanOrEqual(MAX_GRID_VIDEO_PLAYERS_CEILING)

    const result = selectClipPlaybackWindow({
      rows,
      viewportTop: scrollTopPx,
      viewportBottom: scrollTopPx + VIEWPORT_HEIGHT_PX,
      marginPx: PREVIEW_PLAY_AREA_MARGIN_PX,
      requestedCap,
      hardCap: MAX_GRID_VIDEO_PLAYERS_CEILING,
    })

    for (let r = firstVisibleRow; r <= lastVisibleRow; r += 1) {
      for (const clip of clipRows[r]) {
        expect(result.grantedIds.has(clip.id)).toBe(true)
      }
    }
    expect(result.grantedIds.size).toBeGreaterThanOrEqual(visibleTileCount)
    expect(result.grantedIds.size).toBeLessThanOrEqual(MAX_GRID_VIDEO_PLAYERS_CEILING)
  })

  it('effectiveCap never exceeds the ceiling, even with requestedCap dialed above it', () => {
    const requestedCap = MAX_GRID_VIDEO_PLAYERS_CEILING * 10
    for (let scrollTopPx = 0; scrollTopPx <= maxScrollTop; scrollTopPx += 173) {
      const result = selectClipPlaybackWindow({
        rows,
        viewportTop: scrollTopPx,
        viewportBottom: scrollTopPx + VIEWPORT_HEIGHT_PX,
        marginPx: PREVIEW_PLAY_AREA_MARGIN_PX,
        requestedCap,
        hardCap: MAX_GRID_VIDEO_PLAYERS_CEILING,
      })
      expect(result.grantedIds.size).toBeLessThanOrEqual(MAX_GRID_VIDEO_PLAYERS_CEILING)
    }
  })

  it('clamps to the ceiling when the VISIBLE band alone exceeds it (visibleTileCount >> ceiling)', () => {
    const tinyRowHeightPx = 10
    const hugeViewportHeightPx = 5000
    const tinyRows = makeMeasuredRows(clipRows, tinyRowHeightPx)
    const visibleRowSpan = Math.ceil(hugeViewportHeightPx / tinyRowHeightPx)
    const visibleTileCount = visibleRowSpan * GRID_COLS
    expect(visibleTileCount).toBeGreaterThan(MAX_GRID_VIDEO_PLAYERS_CEILING)

    const result = selectClipPlaybackWindow({
      rows: tinyRows,
      viewportTop: 0,
      viewportBottom: hugeViewportHeightPx,
      marginPx: PREVIEW_PLAY_AREA_MARGIN_PX,
      requestedCap: MAX_GRID_VIDEO_PLAYERS_CEILING,
      hardCap: MAX_GRID_VIDEO_PLAYERS_CEILING,
    })

    expect(result.grantedIds.size).toBe(MAX_GRID_VIDEO_PLAYERS_CEILING)
    expect(result.visibleCountExceededHardCap).toBe(true)
  })

  it('the ceiling survives the StrictMode 2x transient including the hover +1 ((ceiling + 1) × 2 < decoder safety limit)', () => {
    expect((MAX_GRID_VIDEO_PLAYERS_CEILING + 1) * 2).toBeLessThan(DECODER_SAFETY_LIMIT)
  })

  it('pre-warms a slow scroll: tiles just outside the viewport (within the 250px margin) are granted', () => {
    const hardCap = MAX_GRID_VIDEO_PLAYERS_CEILING
    const scrollTopPx = 50 * ROW_HEIGHT_PX
    const result = selectClipPlaybackWindow({
      rows,
      viewportTop: scrollTopPx,
      viewportBottom: scrollTopPx + VIEWPORT_HEIGHT_PX,
      marginPx: PREVIEW_PLAY_AREA_MARGIN_PX,
      requestedCap: hardCap,
      hardCap,
    })
    const firstVisibleRow = Math.floor(scrollTopPx / ROW_HEIGHT_PX)
    const preWarmRow = firstVisibleRow - 1
    expect(result.grantedIds.has(clipRows[preWarmRow][0].id)).toBe(true)
  })

  it('returns an empty set for an empty grid', () => {
    const result = selectClipPlaybackWindow({
      rows: [],
      viewportTop: 0,
      viewportBottom: VIEWPORT_HEIGHT_PX,
      marginPx: PREVIEW_PLAY_AREA_MARGIN_PX,
      requestedCap: MAX_GRID_VIDEO_PLAYERS_CEILING,
      hardCap: MAX_GRID_VIDEO_PLAYERS_CEILING,
    })
    expect(result.grantedIds.size).toBe(0)
  })
})
