import { describe, expect, it } from "vitest";
import {
  DESIGN_HEIGHT,
  DESIGN_WIDTH,
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STEP,
  computeUiZoom,
} from "./uiScale";

/** The CSS space the layout gets to work in at a given window size. */
function layoutSpace(w: number, h: number) {
  const zoom = computeUiZoom(w, h);
  return { zoom, width: w / zoom, height: h / zoom };
}

describe("computeUiZoom", () => {
  it("leaves the design size untouched", () => {
    expect(computeUiZoom(DESIGN_WIDTH, DESIGN_HEIGHT)).toBe(1);
  });

  it("shrinks by the tighter axis", () => {
    // Width is fine, height is the constraint: 720/900 = 0.8.
    expect(computeUiZoom(1920, 720)).toBe(0.8);
    // Height is fine, width is the constraint: 1152/1440 = 0.8.
    expect(computeUiZoom(1152, 1200)).toBe(0.8);
  });

  it("snaps downwards to the step so it never overshoots", () => {
    // 1270/1440 = 0.8819 -> 0.85, not 0.90.
    expect(computeUiZoom(1270, 1600)).toBe(0.85);
    expect(computeUiZoom(1439, 1600)).toBe(0.95);
  });

  it("only ever returns whole steps", () => {
    for (let w = 1080; w <= 3000; w += 7) {
      const zoom = computeUiZoom(w, 2000);
      const steps = zoom / ZOOM_STEP;
      expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-6);
    }
  });

  it("holds the floor and the ceiling", () => {
    expect(computeUiZoom(200, 200)).toBe(MIN_ZOOM);
    expect(computeUiZoom(7680, 4320)).toBe(MAX_ZOOM);
  });

  it("falls back to 1 on nonsense input", () => {
    expect(computeUiZoom(0, 900)).toBe(1);
    expect(computeUiZoom(1440, -1)).toBe(1);
    expect(computeUiZoom(Number.NaN, 900)).toBe(1);
  });

  /**
   * The invariant the deleted media queries depended on: from the window
   * minimum (DESIGN * MIN_ZOOM, set in tauri.conf.json) upwards, the layout
   * always gets at least the full design size to lay itself out in — so no
   * scrollbar can be caused purely by the window being smaller.
   */
  it("never hands the layout less than the design size", () => {
    const minW = DESIGN_WIDTH * MIN_ZOOM;
    const minH = DESIGN_HEIGHT * MIN_ZOOM;
    for (let w = minW; w <= 4000; w += 13) {
      for (const h of [minH, 700, 900, 1100, 1440, 2160]) {
        if (h < minH) continue;
        const space = layoutSpace(w, h);
        expect(space.width).toBeGreaterThanOrEqual(DESIGN_WIDTH - 0.5);
        expect(space.height).toBeGreaterThanOrEqual(DESIGN_HEIGHT - 0.5);
      }
    }
  });

  it("fits exactly at the window minimum", () => {
    const space = layoutSpace(DESIGN_WIDTH * MIN_ZOOM, DESIGN_HEIGHT * MIN_ZOOM);
    expect(space.zoom).toBe(MIN_ZOOM);
    expect(Math.round(space.width)).toBe(DESIGN_WIDTH);
    expect(Math.round(space.height)).toBe(DESIGN_HEIGHT);
  });
});
