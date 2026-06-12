import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { vi } from "vitest";
import { BgRemovePanel } from "./BgRemovePanel";
import { mockInvoke, dispatchTauriEvent } from "../../../tests/setup/tauri";

const { openMock, saveMock } = vi.hoisted(() => ({ openMock: vi.fn(), saveMock: vi.fn() }));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: openMock,
  save: saveMock,
}));

function mockStatus(hasCuda = true) {
  mockInvoke("bgremove_status", () =>
    JSON.stringify({ type: "status", hardware: { hasCuda } }),
  );
}

describe("BgRemovePanel", () => {
  beforeEach(() => {
    openMock.mockReset();
    saveMock.mockReset();
  });

  describe("Video Isolate Tab", () => {
    it("renders video panel header and instructions", () => {
      render(<BgRemovePanel mode="video" />);
      expect(screen.getByText("Video Background Removal")).toBeInTheDocument();
      expect(screen.getByText(/Isolate foreground characters and subjects from video files/)).toBeInTheDocument();
    });

    it("renders options dropdowns in video mode", () => {
      render(<BgRemovePanel mode="video" />);
      // The custom Dropdown isn't programmatically associated with its label
      // (htmlFor points at no control id), so assert the visible label text.
      expect(screen.getByText("AI Segmentation Model")).toBeInTheDocument();
      expect(screen.getByText("Export Format")).toBeInTheDocument();
    });

    it("renders video source dropzone when no file selected", () => {
      render(<BgRemovePanel mode="video" />);
      expect(screen.getByText("No file selected")).toBeInTheDocument();
    });

    it("video action button is disabled initially", () => {
      render(<BgRemovePanel mode="video" />);
      const btn = screen.getByRole("button", { name: "Remove Background" });
      expect(btn).toBeDisabled();
    });
  });

  describe("Image Isolate Tab", () => {
    it("renders image panel header and instructions", () => {
      render(<BgRemovePanel mode="image" />);
      expect(screen.getByText("Image Background Removal")).toBeInTheDocument();
      expect(screen.getByText(/Isolate foreground characters and subjects from static images/)).toBeInTheDocument();
    });

    it("renders dropzone instructions and select button", () => {
      render(<BgRemovePanel mode="image" />);
      expect(screen.getByText("Drop video or image to remove background")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Select file" })).toBeInTheDocument();
    });
  });

  describe("Tab instances", () => {
    it("hides the panel when inactive but keeps it mounted", () => {
      const { container } = render(<BgRemovePanel mode="video" active={false} />);
      const section = container.querySelector("section");
      expect(section).not.toBeNull();
      expect(section).toHaveStyle({ display: "none" });
    });

    it("routes a picked video file from the image tab to the video tab", async () => {
      mockStatus();
      openMock.mockResolvedValue("C:\\clips\\drift.mp4");
      const onRequestTab = vi.fn();
      render(
        <>
          <BgRemovePanel mode="video" active={false} onRequestTab={onRequestTab} />
          <BgRemovePanel mode="image" active onRequestTab={onRequestTab} />
        </>,
      );

      // Only the visible (image) instance exposes its picker to the a11y tree.
      fireEvent.click(screen.getByRole("button", { name: "Select file" }));

      await waitFor(() => expect(onRequestTab).toHaveBeenCalledWith("video"));
      // The hidden video instance received the file.
      expect(await screen.findByText("drift.mp4")).toBeInTheDocument();
    });

    it("keeps an image file picked on the image tab in place", async () => {
      mockStatus();
      // Auto-preview fires for images; let it resolve with a preview payload.
      mockInvoke("bgremove_preview", () =>
        JSON.stringify({
          type: "preview_done",
          original: "C:\\cache\\image\\orig.png",
          isolated: "C:\\cache\\image\\isolated.png",
          frame: 0,
          elapsedSeconds: 1.5,
        }),
      );
      openMock.mockResolvedValue("C:\\art\\sticker.png");
      const onRequestTab = vi.fn();
      render(<BgRemovePanel mode="image" active onRequestTab={onRequestTab} />);

      fireEvent.click(screen.getByRole("button", { name: "Select file" }));

      expect(await screen.findByText("sticker.png")).toBeInTheDocument();
      expect(onRequestTab).not.toHaveBeenCalled();
    });
  });

  describe("Unsupported files", () => {
    it("warns instead of loading when the picked file is neither video nor image", async () => {
      mockStatus();
      openMock.mockResolvedValue("C:\\downloads\\notes.txt");
      const onRequestTab = vi.fn();
      render(<BgRemovePanel mode="video" active onRequestTab={onRequestTab} />);

      fireEvent.click(screen.getByRole("button", { name: "Select file" }));

      expect(await screen.findByText("Unsupported file type")).toBeInTheDocument();
      expect(screen.getByText(/notes\.txt/)).toBeInTheDocument();
      expect(screen.getByText("No file selected")).toBeInTheDocument();
      expect(onRequestTab).not.toHaveBeenCalled();
    });

    it("clears the warning once a supported file is picked", async () => {
      mockStatus();
      openMock
        .mockResolvedValueOnce("C:\\downloads\\notes.txt")
        .mockResolvedValueOnce("C:\\clips\\drift.mp4");
      render(<BgRemovePanel mode="video" active />);

      fireEvent.click(screen.getByRole("button", { name: "Select file" }));
      expect(await screen.findByText("Unsupported file type")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Select file" }));
      expect(await screen.findByText("drift.mp4")).toBeInTheDocument();
      expect(screen.queryByText("Unsupported file type")).not.toBeInTheDocument();
    });
  });

  describe("Processing UI", () => {
    it("keeps the panel visible and shows inline progress while processing", async () => {
      mockStatus();
      openMock.mockResolvedValue("C:\\clips\\drift.mp4");
      saveMock.mockResolvedValue("C:\\out\\drift_transparent.webm");
      mockInvoke("bgremove_process", () => new Promise(() => {}));
      render(<BgRemovePanel mode="video" active />);

      fireEvent.click(screen.getByRole("button", { name: "Select file" }));
      expect(await screen.findByText("drift.mp4")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Remove Background" }));

      // The action buttons swap for an inline progress block; the rest of the
      // panel (header, source card) stays mounted and visible.
      expect(await screen.findByRole("progressbar")).toBeInTheDocument();
      expect(screen.getByText("Video Background Removal")).toBeInTheDocument();
      expect(screen.getByText("drift.mp4")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Remove Background" })).not.toBeInTheDocument();

      // Progress events update the inline bar.
      act(() => {
        dispatchTauriEvent("bgremove-progress", {
          type: "progress",
          stage: "processing",
          percent: 42,
          message: "Frame 100/240",
        });
      });
      expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42");
      expect(screen.getByText("Frame 100/240")).toBeInTheDocument();
    });

    it("shows a dismissible inline result banner after completion", async () => {
      mockStatus();
      openMock.mockResolvedValue("C:\\clips\\drift.mp4");
      saveMock.mockResolvedValue("C:\\out\\drift_transparent.webm");
      mockInvoke("bgremove_process", () =>
        JSON.stringify({
          type: "done",
          output: "C:\\out\\drift_transparent.webm",
          frames: 281,
          elapsedSeconds: 56.7,
        }),
      );
      render(<BgRemovePanel mode="video" active />);

      fireEvent.click(screen.getByRole("button", { name: "Select file" }));
      expect(await screen.findByText("drift.mp4")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Remove Background" }));

      // The result renders as an inline banner; the panel, file, and action
      // buttons all stay in place for the next run.
      expect(await screen.findByText("Background isolation complete")).toBeInTheDocument();
      expect(screen.getByText("Background removal complete. Processed 281 frames in 56.7s.")).toBeInTheDocument();
      expect(screen.getByText("Video Background Removal")).toBeInTheDocument();
      expect(screen.getByText("drift.mp4")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Remove Background" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Open folder" })).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      expect(screen.queryByText("Background isolation complete")).not.toBeInTheDocument();
    });

    it("shows the synced result comparison player when the backend provides a showcase", async () => {
      mockStatus();
      openMock.mockResolvedValue("C:\\clips\\drift.mp4");
      saveMock.mockResolvedValue("C:\\out\\drift_transparent.mov");
      mockInvoke("bgremove_process", () =>
        JSON.stringify({
          type: "done",
          output: "C:\\out\\drift_transparent.mov",
          frames: 185,
          fps: 23.98,
          showcase: "C:\\appdata\\bgremove_previews\\showcase\\showcase.webm",
          elapsedSeconds: 38.2,
        }),
      );
      render(<BgRemovePanel mode="video" active />);

      fireEvent.click(screen.getByRole("button", { name: "Select file" }));
      expect(await screen.findByText("drift.mp4")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Remove Background" }));

      expect(await screen.findByText("Result Comparison")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Next frame" })).toBeInTheDocument();
      expect(screen.getByRole("slider", { name: "Seek" })).toBeInTheDocument();
    });
  });

  describe("Image tab preview", () => {
    it("has no manual preview button and retries a failed auto-preview from the error banner", async () => {
      mockStatus();
      openMock.mockResolvedValue("C:\\art\\sticker.png");
      let previewAttempts = 0;
      mockInvoke("bgremove_preview", () => {
        previewAttempts += 1;
        if (previewAttempts === 1) {
          throw new Error("Model download interrupted");
        }
        return JSON.stringify({
          type: "preview_done",
          original: "C:\\cache\\image\\orig.png",
          isolated: "C:\\cache\\image\\isolated.png",
          frame: 0,
          totalFrames: 1,
          elapsedSeconds: 1.5,
        });
      });
      render(<BgRemovePanel mode="image" active />);

      fireEvent.click(screen.getByRole("button", { name: "Select file" }));

      // Auto-preview fails; the banner owns the retry. No standalone preview button.
      expect(await screen.findByText("Failed to isolate image")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Generate Isolated Preview/ })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Try again" }));

      expect(await screen.findByText("AI Isolation Preview")).toBeInTheDocument();
      expect(previewAttempts).toBe(2);
    });
  });

  describe("Video preview frame scrubber", () => {
    it("re-runs the preview at the frame the user scrubs to", async () => {
      mockStatus();
      openMock.mockResolvedValue("C:\\clips\\drift.mp4");
      const previewCalls: Array<{ frame?: number }> = [];
      mockInvoke("bgremove_preview", (args) => {
        previewCalls.push(args as { frame?: number });
        return JSON.stringify({
          type: "preview_done",
          original: "C:\\cache\\video\\orig.png",
          isolated: "C:\\cache\\video\\isolated.png",
          frame: previewCalls.length === 1 ? 100 : 200,
          totalFrames: 300,
          elapsedSeconds: 2.1,
        });
      });
      render(<BgRemovePanel mode="video" active />);

      fireEvent.click(screen.getByRole("button", { name: "Select file" }));
      expect(await screen.findByText("drift.mp4")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Generate AI Preview" }));
      const slider = await screen.findByLabelText("Preview frame");
      expect(previewCalls[0]).toMatchObject({ frame: -1 });
      expect(screen.getByText("100 / 299")).toBeInTheDocument();

      fireEvent.change(slider, { target: { value: "200" } });
      fireEvent.pointerUp(slider);

      expect(await screen.findByText("200 / 299")).toBeInTheDocument();
      expect(previewCalls).toHaveLength(2);
      expect(previewCalls[1]).toMatchObject({ frame: 200 });
    });
  });
});
