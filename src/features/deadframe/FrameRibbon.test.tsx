import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FrameRibbon, RIBBON_COLUMNS, ribbonColumns } from "./FrameRibbon";
import { keptFrameCount, keptFrameFlags } from "./DeadFramePanel";

const SCORES = [1, 0.0005, 0.2, 0.0005, 0.012, 0.2];

function ticks(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".deadframe-ribbon-tick"));
}

function droppedTicks(container: HTMLElement): HTMLElement[] {
  return ticks(container).filter((tick) => tick.dataset.drop === "1");
}

describe("ribbonColumns", () => {
  it("gives one solid-or-empty column per frame while the clip is short", () => {
    expect(ribbonColumns([true, false, true, false], 240)).toEqual([0, 1, 0, 1]);
  });

  it("never emits more columns than the cap", () => {
    const flags = new Array(9_137).fill(true);
    expect(ribbonColumns(flags, 240)).toHaveLength(240);
  });

  it("reads a bucket as the share of its own frames that were dropped", () => {
    // Four frames into two columns: the first pair is half dropped, the second
    // pair is entirely dropped.
    expect(ribbonColumns([true, false, false, false], 2)).toEqual([0.5, 1]);
  });

  it("counts every frame exactly once across the buckets", () => {
    const flags = Array.from({ length: 1_003 }, (_, index) => index % 3 !== 0);
    const dropped = flags.filter((kept) => !kept).length;
    const columns = ribbonColumns(flags, 240);
    // Bucket sizes differ by at most one frame, so weighting each column by its
    // own frame count has to land back on the real dropped total.
    const weighted = columns.reduce((sum, fraction, index) => {
      const start = Math.floor((index * flags.length) / 240);
      const end = Math.floor(((index + 1) * flags.length) / 240);
      return sum + fraction * (Math.max(end, start + 1) - start);
    }, 0);
    expect(Math.round(weighted)).toBe(dropped);
  });

  it("has nothing to draw for an empty score list", () => {
    expect(ribbonColumns([], 240)).toEqual([]);
  });
});

describe("FrameRibbon", () => {
  it("drops exactly as many ticks as the kept-frame count says are gone", () => {
    for (const sensitivity of [0, 18, 44, 60, 100]) {
      const flags = keptFrameFlags(SCORES, sensitivity);
      const removed = SCORES.length - keptFrameCount(SCORES, sensitivity);
      const { container, unmount } = render(<FrameRibbon flags={flags} />);
      expect(ticks(container)).toHaveLength(SCORES.length);
      expect(droppedTicks(container)).toHaveLength(removed);
      unmount();
    }
  });

  it("prints the same numbers the ticks are drawn from", () => {
    render(<FrameRibbon flags={keptFrameFlags(SCORES, 60)} />);
    expect(screen.getByText("3 kept")).toBeInTheDocument();
    expect(screen.getByText("3 removed")).toBeInTheDocument();
  });

  it("buckets a long clip instead of drawing one node per frame", () => {
    const flags = Array.from({ length: 12_400 }, (_, index) => index % 2 === 0);
    const { container } = render(<FrameRibbon flags={flags} />);
    expect(ticks(container).length).toBeLessThanOrEqual(RIBBON_COLUMNS);
    expect(ticks(container)).toHaveLength(RIBBON_COLUMNS);
    // The count beside it is still the real per-frame total, not the column
    // count, so the picture summarises without the numbers lying.
    expect(screen.getByText("6200 kept")).toBeInTheDocument();
    expect(screen.getByText("6200 removed")).toBeInTheDocument();
  });

  it("shows a flat baseline and no numbers when nothing is measured", () => {
    const { container } = render(<FrameRibbon flags={null} />);
    expect(ticks(container)).toHaveLength(0);
    expect(container.querySelector(".deadframe-ribbon-baseline")).not.toBeNull();
    expect(screen.queryByText(/kept/)).not.toBeInTheDocument();
    expect(screen.queryByText(/removed/)).not.toBeInTheDocument();
  });

  it("keeps the strip out of the accessibility tree, since the numbers say it too", () => {
    const { container } = render(<FrameRibbon flags={keptFrameFlags(SCORES, 18)} />);
    expect(container.querySelector(".deadframe-ribbon-strip")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });
});
