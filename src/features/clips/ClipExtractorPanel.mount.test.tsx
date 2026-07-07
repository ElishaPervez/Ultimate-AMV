/**
 * Central geometry-driven mount-set cap tests.
 *
 * These exercise `computeGeometryMountVideoIds` — the SOLE authority for which
 * grid tiles may mount a live offset <video> (it REPLACED the retired per-tile
 * IntersectionObserver mount decision). The white-screen crash this guards
 * against is a WebView2 renderer/GPU death from exceeding Chromium's ~75
 * concurrent video-decoder limit, so the load-bearing invariant is:
 *
 *   ACROSS A FAST FLING (every transient scroll position), the size of the
 *   granted mount set NEVER exceeds the hard cap.
 *
 * Plus the no-dead-zone invariant: once the fling settles, every VISIBLE row's
 * tiles are in the granted set.
 *
 * The function is pure (no React / no Virtuoso geometry), so we drive it
 * directly with deterministic geometry — jsdom has no real scroll layout.
 */

import { computeGeometryMountVideoIds } from './ClipExtractorPanel'
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

describe('computeGeometryMountVideoIds — hard cap across a fast fling', () => {
  const clipRows = makeClipRows()
  const maxScrollTop = ROW_COUNT * ROW_HEIGHT_PX - VIEWPORT_HEIGHT_PX

  it('never exceeds the ceiling at ANY transient scroll position during a fling', () => {
    const cap = MAX_GRID_VIDEO_PLAYERS_CEILING
    // Script a fast fling: many scroll positions sweeping the whole list,
    // including fractional / mid-row offsets a rAF sample would land on.
    let maxObserved = 0
    for (let scrollTopPx = 0; scrollTopPx <= maxScrollTop; scrollTopPx += 137) {
      const ids = computeGeometryMountVideoIds({
        clipRows,
        cap,
        rowHeightPx: ROW_HEIGHT_PX,
        viewportHeightPx: VIEWPORT_HEIGHT_PX,
        scrollTopPx,
        rowsInView: Math.ceil(VIEWPORT_HEIGHT_PX / ROW_HEIGHT_PX),
        marginPx: PREVIEW_PLAY_AREA_MARGIN_PX,
      })
      expect(ids.size).toBeLessThanOrEqual(cap)
      if (ids.size > maxObserved) maxObserved = ids.size
    }
    // Sanity: this dense grid actually pushes the set up to the cap (otherwise
    // the test wouldn't be exercising the truncation path at all).
    expect(maxObserved).toBe(cap)
  })

  it('respects a LOWER live knob (repurposed Max-grid-players) as the PRE-WARM bound', () => {
    // The DEV panel dials tunables.maxGridVideoPlayers; the caller clamps it to
    // the hard ceiling. A conservative DEV value (e.g. 16) bounds the GRANTED set
    // — but the effective cap is floored at the visible-tile count so every
    // visible tile mounts, so the granted size is bounded by
    // max(knob, visibleTileCount) clamped to the ceiling, never just the knob.
    const cap = 16
    for (let scrollTopPx = 0; scrollTopPx <= maxScrollTop; scrollTopPx += 211) {
      const ids = computeGeometryMountVideoIds({
        clipRows,
        cap,
        rowHeightPx: ROW_HEIGHT_PX,
        viewportHeightPx: VIEWPORT_HEIGHT_PX,
        scrollTopPx,
        rowsInView: Math.ceil(VIEWPORT_HEIGHT_PX / ROW_HEIGHT_PX),
        marginPx: PREVIEW_PLAY_AREA_MARGIN_PX,
      })
      const firstVisibleRow = Math.floor(scrollTopPx / ROW_HEIGHT_PX)
      const lastVisibleRow = Math.ceil((scrollTopPx + VIEWPORT_HEIGHT_PX) / ROW_HEIGHT_PX) - 1
      const visibleTileCount =
        (Math.min(lastVisibleRow, ROW_COUNT - 1) - firstVisibleRow + 1) * GRID_COLS
      const effectiveCap = Math.min(
        MAX_GRID_VIDEO_PLAYERS_CEILING,
        Math.max(cap, visibleTileCount),
      )
      expect(ids.size).toBeLessThanOrEqual(effectiveCap)
      expect(ids.size).toBeLessThanOrEqual(MAX_GRID_VIDEO_PLAYERS_CEILING)
    }
  })

  it('after the fling settles, every VISIBLE row is in the granted set (no dead-zone)', () => {
    const cap = MAX_GRID_VIDEO_PLAYERS_CEILING
    // A resting position partway down the list (the fling has stopped here).
    const scrollTopPx = 137 * 137
    const ids = computeGeometryMountVideoIds({
      clipRows,
      cap,
      rowHeightPx: ROW_HEIGHT_PX,
      viewportHeightPx: VIEWPORT_HEIGHT_PX,
      scrollTopPx,
      rowsInView: Math.ceil(VIEWPORT_HEIGHT_PX / ROW_HEIGHT_PX),
      marginPx: PREVIEW_PLAY_AREA_MARGIN_PX,
    })
    expect(ids.size).toBeLessThanOrEqual(cap)

    const firstVisibleRow = Math.floor(scrollTopPx / ROW_HEIGHT_PX)
    const lastVisibleRow = Math.ceil((scrollTopPx + VIEWPORT_HEIGHT_PX) / ROW_HEIGHT_PX) - 1
    // The visible band (rows that fill the viewport) is well under the cap, so
    // every visible tile must be granted — otherwise a fling leaves dead tiles.
    for (let r = firstVisibleRow; r <= lastVisibleRow; r += 1) {
      for (const clip of clipRows[r]) {
        expect(ids.has(clip.id)).toBe(true)
      }
    }
  })

  // DEFECT A regression: when the knob cap is BELOW the number of tiles actually
  // visible (a tall/dense 4-col viewport shows ~32 tiles, prod cap is 12), the
  // nearest-12-to-center used to be granted and the farther-but-still-VISIBLE
  // tiles sat dark. The effective cap must be FLOORED at the visible-tile count
  // so EVERY visible-row tile mounts.
  it.each([
    ['prod knob cap', 12],
    ['dev knob cap', 16],
  ])('no cap-below-visible dead-zone with the %s (every visible tile mounts)', (_label, cap) => {
    const scrollTopPx = 137 * 137 // a resting position partway down the list
    const firstVisibleRow = Math.floor(scrollTopPx / ROW_HEIGHT_PX)
    const lastVisibleRow = Math.ceil((scrollTopPx + VIEWPORT_HEIGHT_PX) / ROW_HEIGHT_PX) - 1
    const visibleTileCount = (lastVisibleRow - firstVisibleRow + 1) * GRID_COLS

    // Precondition: the visible band genuinely EXCEEDS the knob cap (otherwise
    // the floor wouldn't be exercised) yet stays within the hard ceiling (so we
    // expect a TRUE no-dead-zone, not the pathological ceiling-truncation case).
    expect(visibleTileCount).toBeGreaterThan(cap)
    expect(visibleTileCount).toBeLessThanOrEqual(MAX_GRID_VIDEO_PLAYERS_CEILING)

    const ids = computeGeometryMountVideoIds({
      clipRows,
      cap,
      rowHeightPx: ROW_HEIGHT_PX,
      viewportHeightPx: VIEWPORT_HEIGHT_PX,
      scrollTopPx,
      rowsInView: Math.ceil(VIEWPORT_HEIGHT_PX / ROW_HEIGHT_PX),
      marginPx: PREVIEW_PLAY_AREA_MARGIN_PX,
    })

    // Every tile in every visible row is granted — no dark-but-visible tile.
    for (let r = firstVisibleRow; r <= lastVisibleRow; r += 1) {
      for (const clip of clipRows[r]) {
        expect(ids.has(clip.id)).toBe(true)
      }
    }
    // The floor raised the cap to AT LEAST the visible-tile count...
    expect(ids.size).toBeGreaterThanOrEqual(visibleTileCount)
    // ...but never past the hard ceiling.
    expect(ids.size).toBeLessThanOrEqual(MAX_GRID_VIDEO_PLAYERS_CEILING)
  })

  // DEFECT B regression: the effective cap (and thus the granted set) can never
  // exceed MAX_GRID_VIDEO_PLAYERS_CEILING, AND the ceiling is low enough that the
  // DEV StrictMode double-mount transient (each <video> mounted twice) stays
  // under Chromium's concurrent-decoder limit.
  it('effectiveCap never exceeds the ceiling, even with the knob dialed above it', () => {
    // Dial the knob WAY past the ceiling and sweep the whole list. The granted
    // set size must stay <= the ceiling at every position.
    const cap = MAX_GRID_VIDEO_PLAYERS_CEILING * 10
    for (let scrollTopPx = 0; scrollTopPx <= maxScrollTop; scrollTopPx += 173) {
      const ids = computeGeometryMountVideoIds({
        clipRows,
        cap,
        rowHeightPx: ROW_HEIGHT_PX,
        viewportHeightPx: VIEWPORT_HEIGHT_PX,
        scrollTopPx,
        rowsInView: Math.ceil(VIEWPORT_HEIGHT_PX / ROW_HEIGHT_PX),
        marginPx: PREVIEW_PLAY_AREA_MARGIN_PX,
      })
      expect(ids.size).toBeLessThanOrEqual(MAX_GRID_VIDEO_PLAYERS_CEILING)
    }
  })

  // PATHOLOGICAL CASE regression: when the VISIBLE band ALONE shows more tiles
  // than the ceiling (only reachable at a tiny row height / huge viewport), the
  // visible-tile floor would raise the effective cap above the ceiling — but the
  // ceiling clamp must still win, granting exactly the ceiling's worth of tiles
  // and accepting a dead-zone rather than blowing past the decoder safety limit.
  // Previously guarded by analysis only; lock it with a test.
  it('clamps to the ceiling when the VISIBLE band alone exceeds it (visibleTileCount >> ceiling)', () => {
    const tinyRowHeightPx = 10
    const hugeViewportHeightPx = 5000
    // visibleTileCount ≈ (5000 / 10) rows × 4 cols = ~2000 tiles, far above 35.
    const visibleRowSpan = Math.ceil(hugeViewportHeightPx / tinyRowHeightPx)
    const visibleTileCount = visibleRowSpan * GRID_COLS
    expect(visibleTileCount).toBeGreaterThan(MAX_GRID_VIDEO_PLAYERS_CEILING)

    const ids = computeGeometryMountVideoIds({
      clipRows,
      cap: MAX_GRID_VIDEO_PLAYERS_CEILING,
      rowHeightPx: tinyRowHeightPx,
      viewportHeightPx: hugeViewportHeightPx,
      scrollTopPx: 0,
      rowsInView: visibleRowSpan,
      marginPx: PREVIEW_PLAY_AREA_MARGIN_PX,
    })

    // The visible-tile floor cannot escape the ceiling: granted set is clamped
    // EXACTLY to the ceiling, never more.
    expect(ids.size).toBe(MAX_GRID_VIDEO_PLAYERS_CEILING)
  })

  it('the ceiling survives the StrictMode 2x transient including the hover +1 ((ceiling + 1) × 2 < decoder safety limit)', () => {
    // The per-tile play-area gate is `(mayMountVideo || isHovered) && ...`, so
    // ONE hovered tile outside the capped set can mount an extra decoder: the
    // true peak is ceiling + 1, NOT ceiling. The StrictMode dev double-mount
    // then doubles that. Lock the HONEST hover-inclusive bound.
    expect((MAX_GRID_VIDEO_PLAYERS_CEILING + 1) * 2).toBeLessThan(DECODER_SAFETY_LIMIT)
  })

  it('pre-warms a slow scroll: tiles just outside the viewport (within the 250px margin) are granted', () => {
    const cap = MAX_GRID_VIDEO_PLAYERS_CEILING
    const scrollTopPx = 50 * ROW_HEIGHT_PX
    const ids = computeGeometryMountVideoIds({
      clipRows,
      cap,
      rowHeightPx: ROW_HEIGHT_PX,
      viewportHeightPx: VIEWPORT_HEIGHT_PX,
      scrollTopPx,
      rowsInView: Math.ceil(VIEWPORT_HEIGHT_PX / ROW_HEIGHT_PX),
      marginPx: PREVIEW_PLAY_AREA_MARGIN_PX,
    })
    const firstVisibleRow = Math.floor(scrollTopPx / ROW_HEIGHT_PX)
    const marginRows = Math.ceil(PREVIEW_PLAY_AREA_MARGIN_PX / ROW_HEIGHT_PX)
    // The row just above the viewport (still within the pre-play margin) is
    // granted so it is already decoding before it scrolls into view.
    const preWarmRow = firstVisibleRow - 1
    expect(marginRows).toBeGreaterThanOrEqual(1)
    expect(ids.has(clipRows[preWarmRow][0].id)).toBe(true)
  })

  it('returns an empty set for an empty grid', () => {
    const ids = computeGeometryMountVideoIds({
      clipRows: [],
      cap: MAX_GRID_VIDEO_PLAYERS_CEILING,
      rowHeightPx: ROW_HEIGHT_PX,
      viewportHeightPx: VIEWPORT_HEIGHT_PX,
      scrollTopPx: 0,
      rowsInView: 8,
      marginPx: PREVIEW_PLAY_AREA_MARGIN_PX,
    })
    expect(ids.size).toBe(0)
  })

  it('falls back to the top fill rows when geometry is not yet measured (rowHeight/viewport 0)', () => {
    const cap = MAX_GRID_VIDEO_PLAYERS_CEILING
    const rowsInView = 8
    const ids = computeGeometryMountVideoIds({
      clipRows,
      cap,
      rowHeightPx: 0,
      viewportHeightPx: 0,
      scrollTopPx: 0,
      rowsInView,
      marginPx: PREVIEW_PLAY_AREA_MARGIN_PX,
    })
    expect(ids.size).toBeLessThanOrEqual(cap)
    // Top-of-list rows are granted so the initial viewport isn't blank.
    expect(ids.has(clipRows[0][0].id)).toBe(true)
  })
})
