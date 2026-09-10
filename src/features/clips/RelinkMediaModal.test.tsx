import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { RelinkMediaModal } from "./RelinkMediaModal";
import type { ResolvedSourceMedia } from "../../types/project";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

describe("RelinkMediaModal", () => {
  const mockSources: ResolvedSourceMedia[] = [
    {
      source: {
        id: "src-1",
        path: "C:\\Anime\\ep01.mp4",
        filename: "ep01.mp4",
        duration: 1200,
        fps: 24,
      },
      currentPath: "C:\\Anime\\ep01.mp4",
      status: "missing",
    },
    {
      source: {
        id: "src-2",
        path: "C:\\Anime\\ep02.mp4",
        filename: "ep02.mp4",
        duration: 1200,
        fps: 24,
      },
      currentPath: "D:\\NewAnime\\ep02.mp4",
      status: "resolved",
    },
  ];

  it("renders when open is true", () => {
    render(
      <RelinkMediaModal
        open={true}
        sources={mockSources}
        onResolve={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(screen.getByText("Relink Source Media")).toBeInTheDocument();
    expect(screen.getByText("ep01.mp4")).toBeInTheDocument();
    expect(screen.getByText("ep02.mp4")).toBeInTheDocument();
  });

  it("does not render when open is false", () => {
    render(
      <RelinkMediaModal
        open={false}
        sources={mockSources}
        onResolve={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(screen.queryByText("Relink Source Media")).not.toBeInTheDocument();
  });

  it("calls onCancel when Cancel button is clicked", () => {
    const onCancel = vi.fn();
    render(
      <RelinkMediaModal
        open={true}
        sources={mockSources}
        onResolve={vi.fn()}
        onCancel={onCancel}
      />
    );

    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalled();
  });
});
