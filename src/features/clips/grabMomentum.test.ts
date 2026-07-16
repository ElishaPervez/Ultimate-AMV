import { describe, expect, it } from "vitest";
import {
  GRID_GRAB_MOMENTUM_MAX_PX_PER_MS,
  GRID_GRAB_MOMENTUM_MAX_STEP_MS,
  sampleGrabVelocity,
  stepGrabMomentum,
} from "./grabMomentum";

describe("grabMomentum", () => {
  it("measures scroll speed and caps extreme pointer samples", () => {
    expect(sampleGrabVelocity(0, 20, 10)).toBeCloseTo(1.3);
    expect(sampleGrabVelocity(0, 1000, 1)).toBeCloseTo(GRID_GRAB_MOMENTUM_MAX_PX_PER_MS * 0.65);
    expect(sampleGrabVelocity(0, -1000, 1)).toBeCloseTo(-GRID_GRAB_MOMENTUM_MAX_PX_PER_MS * 0.65);
  });

  it("keeps direction while reducing speed each frame", () => {
    const downward = stepGrabMomentum(1, 1000 / 60);
    const upward = stepGrabMomentum(-1, 1000 / 60);

    expect(downward.distance).toBeGreaterThan(0);
    expect(downward.velocity).toBeGreaterThan(0);
    expect(downward.velocity).toBeLessThan(1);
    expect(upward.distance).toBeLessThan(0);
    expect(upward.velocity).toBeLessThan(0);
    expect(Math.abs(upward.velocity)).toBeLessThan(1);
  });

  it("produces nearly the same travel across different frame rates", () => {
    const oneFrame = stepGrabMomentum(1.5, 16);
    const halfFrameA = stepGrabMomentum(1.5, 8);
    const halfFrameB = stepGrabMomentum(halfFrameA.velocity, 8);

    expect(halfFrameA.distance + halfFrameB.distance).toBeCloseTo(oneFrame.distance, 5);
    expect(halfFrameB.velocity).toBeCloseTo(oneFrame.velocity, 5);
  });

  it("caps delayed frames so returning from a stall cannot jump the grid", () => {
    const delayed = stepGrabMomentum(2, 500);
    const capped = stepGrabMomentum(2, GRID_GRAB_MOMENTUM_MAX_STEP_MS);

    expect(delayed.distance).toBeCloseTo(capped.distance, 5);
    expect(delayed.velocity).toBeCloseTo(capped.velocity, 5);
  });

  it("stops once the remaining speed is visually negligible", () => {
    expect(stepGrabMomentum(0.01, 16).velocity).toBe(0);
  });
});
