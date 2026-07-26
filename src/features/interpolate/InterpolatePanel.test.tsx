import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { dispatchTauriEvent, mockInvoke, mockInvokeFn } from "../../../tests/setup/tauri";
import { mockDialogOpen } from "../../../tests/setup/dialog";
import { InterpolatePanel } from "./InterpolatePanel";

function statusPayload() {
  return JSON.stringify({
    type: "status",
    hardware: { hasCuda: true, device: "RTX Test" },
    models: {},
  });
}

describe("InterpolatePanel", () => {
  it("renders and updates factor and model controls", async () => {
    mockInvoke("interpolate_status", () => statusPayload());
    const user = userEvent.setup();
    render(<InterpolatePanel active />);
    await screen.findByText(/RTX Test/);
    await user.click(screen.getByRole("button", { name: "3x" }));
    expect(screen.getByRole("button", { name: "3x" })).toHaveClass("is-active");
    await user.click(screen.getByRole("button", { name: /RIFE 4.6 Lower memory/ }));
    expect(screen.getByRole("button", { name: /RIFE 4.6 Lower memory/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("uses a target frame rate in the output name and backend request", async () => {
    mockInvoke("interpolate_status", () => statusPayload());
    mockInvoke("interpolate_run", () => JSON.stringify({
      type: "done",
      outcomes: [],
      succeeded: 1,
      failed: 0,
      elapsedSeconds: 1,
    }));
    mockDialogOpen.mockResolvedValueOnce(["C:\\clips\\scene.mp4"]);
    const user = userEvent.setup();
    render(<InterpolatePanel active />);
    await screen.findByText(/RTX Test/);
    await user.click(screen.getByRole("button", { name: "Target FPS" }));
    await user.click(screen.getByRole("button", { name: "120" }));
    await user.click(screen.getByRole("button", { name: "Add clips" }));
    expect(await screen.findByText("scene_120fps.mp4")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Interpolate 1 clip/ }));
    await waitFor(() => {
      expect(mockInvokeFn).toHaveBeenCalledWith("interpolate_run", expect.objectContaining({
        targetFps: 120,
        factor: 2,
        rateMode: "quality",
        quality: 18,
      }));
    });
  });

  it("progress events update both the queue and progress card", async () => {
    mockInvoke("interpolate_status", () => statusPayload());
    mockInvoke("interpolate_run", () => new Promise(() => {}));
    mockDialogOpen.mockResolvedValueOnce(["C:\\clips\\scene.mp4"]);
    const user = userEvent.setup();
    render(<InterpolatePanel active />);
    await screen.findByText(/RTX Test/);
    await user.click(screen.getByRole("button", { name: "Add clips" }));
    await user.click(screen.getByRole("button", { name: /Interpolate 1 clip/ }));
    act(() => {
      dispatchTauriEvent("interpolate-progress", {
        type: "progress",
        stage: "interpolate",
        percent: 42,
        message: "Interpolated 84 source frames",
        clipIndex: 1,
        clipCount: 1,
        clipName: "scene.mp4",
      });
    });
    expect(await screen.findByText("42%")).toBeInTheDocument();
    expect(screen.getByText("Interpolated 84 source frames")).toBeInTheDocument();
    expect(screen.getByText("scene.mp4", { selector: ".interpolate-progress-heading strong" })).toBeInTheDocument();
  });

  it("cancel invokes the backend and resets the running state", async () => {
    mockInvoke("interpolate_status", () => statusPayload());
    mockInvoke("interpolate_run", () => new Promise(() => {}));
    mockInvoke("cancel_interpolate", () => undefined);
    mockDialogOpen.mockResolvedValueOnce(["C:\\clips\\scene.mp4"]);
    const user = userEvent.setup();
    render(<InterpolatePanel active />);
    await screen.findByText(/RTX Test/);
    await user.click(screen.getByRole("button", { name: "Add clips" }));
    await user.click(screen.getByRole("button", { name: /Interpolate 1 clip/ }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(mockInvokeFn).toHaveBeenCalledWith("cancel_interpolate");
    });
    expect(await screen.findByText(/Interpolation cancelled/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Interpolate 1 clip/ })).toBeEnabled();
  });

  it("removes an individual queued clip", async () => {
    mockInvoke("interpolate_status", () => statusPayload());
    mockDialogOpen.mockResolvedValueOnce(["C:\\clips\\one.mp4", "C:\\clips\\two.mp4"]);
    render(<InterpolatePanel active />);
    await screen.findByText(/RTX Test/);
    fireEvent.click(screen.getByRole("button", { name: "Add clips" }));
    expect(await screen.findByText("2 clips")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove one.mp4" }));
    expect(screen.getByText("1 clip")).toBeInTheDocument();
  });
});
