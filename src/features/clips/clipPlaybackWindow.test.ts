import { describe, expect, it } from 'vitest';
import {
  type MeasuredClipRow,
  selectClipPlaybackWindow,
} from './clipPlaybackWindow';

describe('selectClipPlaybackWindow', () => {
  it('1. grants every row physically intersecting the viewport before any prewarm row', () => {
    const rows: MeasuredClipRow[] = [
      { rowIndex: 0, top: -100, bottom: -10, clipIds: ['c0_1', 'c0_2'] },
      { rowIndex: 1, top: 0, bottom: 90, clipIds: ['c1_1', 'c1_2'] },
      { rowIndex: 2, top: 100, bottom: 190, clipIds: ['c2_1', 'c2_2'] },
      { rowIndex: 3, top: 200, bottom: 290, clipIds: ['c3_1', 'c3_2'] },
      { rowIndex: 4, top: 310, bottom: 400, clipIds: ['c4_1', 'c4_2'] },
    ];

    // Viewport is [0, 300], margin is 150
    // Rows 1, 2, 3 are visible. Row 0 (top -100, bottom -10) and Row 4 (top 310, bottom 400) are prewarm.
    const result = selectClipPlaybackWindow({
      rows,
      viewportTop: 0,
      viewportBottom: 300,
      marginPx: 150,
      requestedCap: 8,
      hardCap: 35,
    });

    expect(result.visibleIds).toEqual(new Set(['c1_1', 'c1_2', 'c2_1', 'c2_2', 'c3_1', 'c3_2']));
    expect(result.firstVisibleRow).toBe(1);
    expect(result.lastVisibleRow).toBe(3);
    expect(result.visibleCountExceededHardCap).toBe(false);

    // Visible tiles (6) + 2 prewarm tiles to reach requestedCap (8)
    // Viewport center = 150.
    // Row 0 center = -55, distance to 150 = 205.
    // Row 4 center = 355, distance to 150 = 205.
    // Row 0 has smaller rowIndex so Row 0 tiles are picked to fill cap 8.
    expect(result.grantedIds).toEqual(
      new Set(['c1_1', 'c1_2', 'c2_1', 'c2_2', 'c3_1', 'c3_2', 'c0_1', 'c0_2']),
    );
  });

  it('2. considers partially visible rows at top and bottom as visible', () => {
    const rows: MeasuredClipRow[] = [
      { rowIndex: 0, top: -50, bottom: 50, clipIds: ['top_clip'] },
      { rowIndex: 1, top: 50, bottom: 150, clipIds: ['mid_clip'] },
      { rowIndex: 2, top: 150, bottom: 250, clipIds: ['bot_clip'] },
    ];

    // Viewport is [0, 200]
    // Row 0 crosses 0 (top -50, bottom 50) -> visible
    // Row 1 is [50, 150] -> visible
    // Row 2 crosses 200 (top 150, bottom 250) -> visible
    const result = selectClipPlaybackWindow({
      rows,
      viewportTop: 0,
      viewportBottom: 200,
      marginPx: 100,
      requestedCap: 12,
      hardCap: 35,
    });

    expect(result.visibleIds).toEqual(new Set(['top_clip', 'mid_clip', 'bot_clip']));
    expect(result.grantedIds).toEqual(new Set(['top_clip', 'mid_clip', 'bot_clip']));
    expect(result.firstVisibleRow).toBe(0);
    expect(result.lastVisibleRow).toBe(2);
  });

  it('3. does not consider a row touching an edge without occupying pixels as visible', () => {
    const rows: MeasuredClipRow[] = [
      { rowIndex: 0, top: -100, bottom: 0, clipIds: ['touch_top'] }, // bottom == viewportTop
      { rowIndex: 1, top: 0, bottom: 100, clipIds: ['inside_1'] },
      { rowIndex: 2, top: 100, bottom: 200, clipIds: ['inside_2'] },
      { rowIndex: 3, top: 200, bottom: 300, clipIds: ['touch_bottom'] }, // top == viewportBottom
    ];

    // Viewport is [0, 200]
    const result = selectClipPlaybackWindow({
      rows,
      viewportTop: 0,
      viewportBottom: 200,
      marginPx: 150,
      requestedCap: 2, // only visible count
      hardCap: 35,
    });

    expect(result.visibleIds).toEqual(new Set(['inside_1', 'inside_2']));
    expect(result.firstVisibleRow).toBe(1);
    expect(result.lastVisibleRow).toBe(2);
  });

  it('4. selects prewarm rows nearest the viewport center until capacity is exhausted', () => {
    // Viewport [100, 300], center = 200. Margin = 300 (band [-200, 600])
    // Visible: Row 2 ([150, 250], center 200) -> 1 tile
    // Prewarm candidates:
    // Row 1: [50, 90], center 70, dist to 200 = 130
    // Row 3: [310, 350], center 330, dist to 200 = 130 (tied with row 1, tie-break rowIndex 1)
    // Row 0: [-50, -10], center -30, dist to 200 = 230
    // Row 4: [450, 500], center 475, dist to 200 = 275
    const rows: MeasuredClipRow[] = [
      { rowIndex: 0, top: -50, bottom: -10, clipIds: ['c0'] },
      { rowIndex: 1, top: 50, bottom: 90, clipIds: ['c1'] },
      { rowIndex: 2, top: 150, bottom: 250, clipIds: ['c2'] },
      { rowIndex: 3, top: 310, bottom: 350, clipIds: ['c3'] },
      { rowIndex: 4, top: 450, bottom: 500, clipIds: ['c4'] },
    ];

    const result = selectClipPlaybackWindow({
      rows,
      viewportTop: 100,
      viewportBottom: 300,
      marginPx: 300,
      requestedCap: 3,
      hardCap: 35,
    });

    expect(result.visibleIds).toEqual(new Set(['c2']));
    // Capacity 3: c2 (visible) + c1 (nearest prewarm dist 130) + c3 (next nearest prewarm dist 130)
    expect(result.grantedIds).toEqual(new Set(['c2', 'c1', 'c3']));
  });

  it('5. expands requested cap below visible count to the visible count', () => {
    const rows: MeasuredClipRow[] = [
      { rowIndex: 0, top: 0, bottom: 50, clipIds: ['c1', 'c2', 'c3', 'c4'] },
      { rowIndex: 1, top: 50, bottom: 100, clipIds: ['c5', 'c6', 'c7', 'c8'] },
      { rowIndex: 2, top: 100, bottom: 150, clipIds: ['c9', 'c10', 'c11', 'c12'] },
    ];

    // All 12 tiles are visible, but requestedCap is only 4
    const result = selectClipPlaybackWindow({
      rows,
      viewportTop: 0,
      viewportBottom: 200,
      marginPx: 100,
      requestedCap: 4,
      hardCap: 35,
    });

    expect(result.visibleIds.size).toBe(12);
    expect(result.grantedIds.size).toBe(12);
    expect(result.visibleCountExceededHardCap).toBe(false);
  });

  it('6. never exceeds hard cap', () => {
    const rows: MeasuredClipRow[] = [
      { rowIndex: 0, top: 0, bottom: 100, clipIds: ['c1', 'c2'] },
      { rowIndex: 1, top: 100, bottom: 200, clipIds: ['c3', 'c4'] },
      { rowIndex: 2, top: 200, bottom: 300, clipIds: ['c5', 'c6'] },
    ];

    const result = selectClipPlaybackWindow({
      rows,
      viewportTop: 0,
      viewportBottom: 300,
      marginPx: 100,
      requestedCap: 50,
      hardCap: 4,
    });

    expect(result.grantedIds.size).toBe(4);
  });

  it('7. grants visible tiles nearest viewport center and sets overflow flag when visible tiles exceed hard cap', () => {
    // 5 rows visible in viewport [0, 500], center = 250
    // Row 0: [0, 100], center 50, dist 200, clips ['c0_1', 'c0_2']
    // Row 1: [100, 200], center 150, dist 100, clips ['c1_1', 'c1_2']
    // Row 2: [200, 300], center 250, dist 0, clips ['c2_1', 'c2_2']
    // Row 3: [300, 400], center 350, dist 100, clips ['c3_1', 'c3_2']
    // Row 4: [400, 500], center 450, dist 200, clips ['c4_1', 'c4_2']
    const rows: MeasuredClipRow[] = [
      { rowIndex: 0, top: 0, bottom: 100, clipIds: ['c0_1', 'c0_2'] },
      { rowIndex: 1, top: 100, bottom: 200, clipIds: ['c1_1', 'c1_2'] },
      { rowIndex: 2, top: 200, bottom: 300, clipIds: ['c2_1', 'c2_2'] },
      { rowIndex: 3, top: 300, bottom: 400, clipIds: ['c3_1', 'c3_2'] },
      { rowIndex: 4, top: 400, bottom: 500, clipIds: ['c4_1', 'c4_2'] },
    ];

    // Hard cap is 5 tiles
    const result = selectClipPlaybackWindow({
      rows,
      viewportTop: 0,
      viewportBottom: 500,
      marginPx: 0,
      requestedCap: 12,
      hardCap: 5,
    });

    expect(result.visibleIds.size).toBe(10);
    expect(result.visibleCountExceededHardCap).toBe(true);
    expect(result.grantedIds.size).toBe(5);

    // Nearest rows to 250:
    // Row 2 (dist 0) -> c2_1, c2_2 (2 tiles)
    // Row 1 (dist 100, rowIndex 1) -> c1_1, c1_2 (2 tiles)
    // Row 3 (dist 100, rowIndex 3) -> c3_1 (1 tile to fill cap 5)
    expect(result.grantedIds).toEqual(new Set(['c2_1', 'c2_2', 'c1_1', 'c1_2', 'c3_1']));
  });

  it('8. ignores invalid and zero-height rectangles', () => {
    const rows: MeasuredClipRow[] = [
      { rowIndex: 0, top: NaN, bottom: 100, clipIds: ['inv1'] },
      { rowIndex: 1, top: 50, bottom: 50, clipIds: ['zero_h'] }, // height 0
      { rowIndex: 2, top: 100, bottom: 80, clipIds: ['neg_h'] }, // inverted
      { rowIndex: 3, top: 0, bottom: 100, clipIds: ['valid'] },
    ];

    const result = selectClipPlaybackWindow({
      rows,
      viewportTop: 0,
      viewportBottom: 200,
      marginPx: 0,
      requestedCap: 10,
      hardCap: 35,
    });

    expect(result.visibleIds).toEqual(new Set(['valid']));
    expect(result.firstVisibleRow).toBe(3);
    expect(result.lastVisibleRow).toBe(3);
  });

  it('9. handles sparse rendered row indices and variable row heights', () => {
    const rows: MeasuredClipRow[] = [
      { rowIndex: 12, top: 20, bottom: 180, clipIds: ['r12_1', 'r12_2'] },
      { rowIndex: 45, top: 190, bottom: 280, clipIds: ['r45_1'] },
    ];

    const result = selectClipPlaybackWindow({
      rows,
      viewportTop: 0,
      viewportBottom: 300,
      marginPx: 50,
      requestedCap: 10,
      hardCap: 35,
    });

    expect(result.visibleIds).toEqual(new Set(['r12_1', 'r12_2', 'r45_1']));
    expect(result.firstVisibleRow).toBe(12);
    expect(result.lastVisibleRow).toBe(45);
  });

  it('10. produces deterministic IDs and ordering on identical inputs', () => {
    const rows: MeasuredClipRow[] = [
      { rowIndex: 0, top: -20, bottom: 80, clipIds: ['a', 'b'] },
      { rowIndex: 1, top: 80, bottom: 180, clipIds: ['c', 'd'] },
      { rowIndex: 2, top: 180, bottom: 280, clipIds: ['e', 'f'] },
    ];

    const input = {
      rows,
      viewportTop: 0,
      viewportBottom: 200,
      marginPx: 100,
      requestedCap: 10,
      hardCap: 35,
    };

    const run1 = selectClipPlaybackWindow(input);
    const run2 = selectClipPlaybackWindow(input);

    expect([...run1.grantedIds]).toEqual([...run2.grantedIds]);
    expect([...run1.visibleIds]).toEqual([...run2.visibleIds]);
    expect(run1.firstVisibleRow).toBe(run2.firstVisibleRow);
    expect(run1.lastVisibleRow).toBe(run2.lastVisibleRow);
    expect(run1.visibleCountExceededHardCap).toBe(run2.visibleCountExceededHardCap);
  });
});
