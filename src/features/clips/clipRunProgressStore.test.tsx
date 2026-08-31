import { beforeEach, describe, expect, it } from "vitest";
import {
  beginClipRunProgress,
  getClipRunProgressSnapshot,
  publishCompatibilityProgress,
  publishDetectionProgress,
  publishProxyProgress,
  resetClipRunProgress,
} from "./clipRunProgressStore";

describe("clip run progress channels", () => {
  beforeEach(() => resetClipRunProgress());

  it("keeps detection unchanged when a proxy reports progress", () => {
    const generation = beginClipRunProgress();
    publishDetectionProgress(generation, {
      type: "progress",
      stage: "detecting",
      percent: 37,
      message: "Episode 1/3",
    });
    publishProxyProgress("C:\\episode-1.mkv", 62);
    publishCompatibilityProgress({
      stage: "processing",
      percent: 14,
      message: "Converting episode 3",
    });

    expect(getClipRunProgressSnapshot()).toMatchObject({
      detection: { percent: 37, message: "Episode 1/3" },
      proxyBySource: { "C:\\episode-1.mkv": 62 },
      compatibility: { percent: 14, message: "Converting episode 3" },
    });
  });

  it("clears every transient channel for a new source set", () => {
    const generation = beginClipRunProgress();
    publishDetectionProgress(generation, {
      type: "progress",
      stage: "detecting",
      percent: 45,
      message: "Old run",
    });
    publishProxyProgress("C:\\old.mkv", 20);
    publishCompatibilityProgress({
      stage: "processing",
      percent: 10,
      message: "Old conversion",
    });

    resetClipRunProgress();

    expect(getClipRunProgressSnapshot()).toMatchObject({
      detection: null,
      proxyBySource: {},
      compatibility: null,
    });
  });

  it("ignores detection updates from the previous generation", () => {
    const oldGeneration = beginClipRunProgress();
    const currentGeneration = beginClipRunProgress();
    publishDetectionProgress(oldGeneration, {
      type: "progress",
      stage: "detecting",
      percent: 99,
      message: "Late old event",
    });

    expect(currentGeneration).not.toBe(oldGeneration);
    expect(getClipRunProgressSnapshot().detection).toBeNull();
  });
});
