import React from "react";
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClipRunStatus } from "./ClipRunStatus";
import {
  beginClipRunProgress,
  publishDetectionProgress,
  resetClipRunProgress,
} from "./clipRunProgressStore";

describe("ClipRunStatus render boundary", () => {
  beforeEach(() => resetClipRunProgress());

  it("updates progress without rendering its parent or grid sibling", () => {
    const gridRender = vi.fn();
    const parentRender = vi.fn();
    function GridProbe() {
      gridRender();
      return <div>scene grid</div>;
    }
    function Harness() {
      parentRender();
      return (
        <>
          <ClipRunStatus
            error={null}
            sceneCount={12}
            displayedClipCount={12}
            hasResult
            isExtracting
            featherweightActive
            resolvedProxySources={[]}
            gridPreview
            readyPreviewCount={0}
            settledPreviewCount={0}
          />
          <GridProbe />
        </>
      );
    }

    render(<Harness />);
    act(() => {
      const generation = beginClipRunProgress();
      publishDetectionProgress(generation, {
        type: "progress",
        stage: "detecting",
        percent: 48,
        message: "Episode 2/3",
      });
    });

    expect(screen.getByText("48%")) .toBeInTheDocument();
    expect(parentRender).toHaveBeenCalledTimes(1);
    expect(gridRender).toHaveBeenCalledTimes(1);
  });
});
