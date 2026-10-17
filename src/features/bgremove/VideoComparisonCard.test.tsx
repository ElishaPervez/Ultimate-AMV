import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { VideoComparisonCard } from "./VideoComparisonCard";

const NOTICE = /original video can't be decoded/;

function setPictureSize(video: HTMLVideoElement, width: number, height: number) {
  Object.defineProperty(video, "videoWidth", { configurable: true, get: () => width });
  Object.defineProperty(video, "videoHeight", { configurable: true, get: () => height });
}

function originalVideo(container: HTMLElement): HTMLVideoElement | null {
  return container.querySelector('video[src="orig.mov"]');
}

describe("VideoComparisonCard", () => {
  it("keeps playing an original that has a picture", () => {
    const { container } = render(<VideoComparisonCard original="orig.mov" isolated="iso.webm" fps={24} />);
    const video = originalVideo(container)!;
    setPictureSize(video, 1920, 1080);
    fireEvent(video, new Event("loadedmetadata"));
    fireEvent(video, new Event("loadeddata"));
    expect(originalVideo(container)).toBeInTheDocument();
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });

  it("treats an original that opens without a picture like a decode error", () => {
    // WebView2 plays a ProRes MOV with audio as sound only: no error, no size.
    const { container } = render(<VideoComparisonCard original="orig.mov" isolated="iso.webm" fps={24} />);
    const video = originalVideo(container)!;
    setPictureSize(video, 0, 0);
    fireEvent(video, new Event("loadedmetadata"));
    expect(screen.getByText(NOTICE)).toBeInTheDocument();
    expect(originalVideo(container)).not.toBeInTheDocument();
  });

  it("says so inside the empty original pane in side-by-side mode", () => {
    const { container } = render(<VideoComparisonCard original="orig.mov" isolated="iso.webm" fps={24} />);
    fireEvent.click(screen.getByRole("button", { name: /Side-by-Side/ }));
    const video = originalVideo(container)!;
    fireEvent.error(video);
    expect(screen.getByText(/No preview for this file's format/)).toBeInTheDocument();
  });
});
