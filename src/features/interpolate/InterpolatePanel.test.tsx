import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { dispatchTauriEvent, mockInvoke, mockInvokeFn } from "../../../tests/setup/tauri";
import { mockDialogOpen } from "../../../tests/setup/dialog";
import { acceptsDroppedPath, InterpolatePanel, isSupportedVideoPath } from "./InterpolatePanel";

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

  it("uses the source frame rate for explicit slow motion", async () => {
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
    await user.click(screen.getByRole("button", { name: "Slow motion" }));
    await user.click(screen.getByRole("button", { name: "64x" }));
    await user.click(screen.getByRole("button", { name: "Add clips" }));
    expect(await screen.findByText("scene_64x-slowmo.mp4")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add _64x-slowmo" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Interpolate 1 clip/ }));
    await waitFor(() => {
      expect(mockInvokeFn).toHaveBeenCalledWith("interpolate_run", expect.objectContaining({
        factor: 64,
        slowMotion: true,
        targetFps: null,
      }));
    });
  });

  it("returns to the normal 4x ceiling when leaving slow motion", async () => {
    mockInvoke("interpolate_status", () => statusPayload());
    const user = userEvent.setup();
    render(<InterpolatePanel active />);
    await screen.findByText(/RTX Test/);
    await user.click(screen.getByRole("button", { name: "Slow motion" }));
    await user.click(screen.getByRole("button", { name: "64x" }));
    await user.click(screen.getByRole("button", { name: "Multiplier" }));
    expect(screen.getByRole("button", { name: "4x" })).toHaveClass("is-active");
    expect(screen.queryByRole("button", { name: "64x" })).not.toBeInTheDocument();
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

  it("picking a format renames the output and reaches the backend", async () => {
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
    await user.click(screen.getByRole("button", { name: "Add clips" }));
    expect(await screen.findByText("scene_2x.mp4")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /H.264 · MKV/ }));
    expect(await screen.findByText("scene_2x.mkv")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Interpolate 1 clip/ }));
    await waitFor(() => {
      expect(mockInvokeFn).toHaveBeenCalledWith("interpolate_run", expect.objectContaining({
        outputFormat: "h264-mkv",
      }));
    });
  });

  it("hides the quality dial for the format that has none", async () => {
    mockInvoke("interpolate_status", () => statusPayload());
    const user = userEvent.setup();
    render(<InterpolatePanel active />);
    await screen.findByText(/RTX Test/);
    expect(screen.getByRole("button", { name: "Quality" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /ProRes · MOV/ }));
    expect(screen.queryByRole("button", { name: "Quality" })).not.toBeInTheDocument();
    expect(screen.getByText(/nothing to tune/)).toBeInTheDocument();
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

describe("interpolation drop targets", () => {
  it("accepts supported clips and rejects other files", () => {
    expect(isSupportedVideoPath(String.raw`C:\clips\scene.MP4`)).toBe(true);
    expect(isSupportedVideoPath(String.raw`C:\clips\scene.m4v`)).toBe(true);
    expect(isSupportedVideoPath(String.raw`C:\clips\notes.txt`)).toBe(false);
    expect(isSupportedVideoPath(String.raw`C:\clips\track.flac`)).toBe(false);
  });

  it("treats an extensionless drop as a folder to expand", () => {
    expect(acceptsDroppedPath(String.raw`C:\clips\batch-01`)).toBe(true);
    expect(acceptsDroppedPath("/home/pc/clips")).toBe(true);
    expect(acceptsDroppedPath(String.raw`C:\clips\notes.txt`)).toBe(false);
  });

  it("does not mistake a dotted folder name for a file extension", () => {
    // Only a dot AFTER the last separator can be an extension.
    expect(acceptsDroppedPath(String.raw`C:\my.clips\batch`)).toBe(true);
    expect(isSupportedVideoPath(String.raw`C:\my.mp4\batch`)).toBe(false);
  });
});
