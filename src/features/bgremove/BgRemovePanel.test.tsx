import React from "react";
import { render, screen } from "@testing-library/react";
import { BgRemovePanel } from "./BgRemovePanel";
import "../../../tests/setup/tauri";

describe("BgRemovePanel", () => {
  it("renders panel header and instructions", () => {
    render(<BgRemovePanel />);
    expect(screen.getByText("One-Click Video Background Removal")).toBeInTheDocument();
    expect(screen.getByText(/Isolate characters from video files/)).toBeInTheDocument();
  });

  it("renders options dropdowns", () => {
    render(<BgRemovePanel />);
    expect(screen.getByLabelText("AI Segmentation Model")).toBeInTheDocument();
    expect(screen.getByLabelText("Export Format")).toBeInTheDocument();
  });

  it("renders dropzone when no file selected", () => {
    render(<BgRemovePanel />);
    expect(screen.getByText("Drag & Drop video file here")).toBeInTheDocument();
  });

  it("action button is disabled initially", () => {
    render(<BgRemovePanel />);
    const btn = screen.getByRole("button", { name: "Remove Background" });
    expect(btn).toBeDisabled();
  });
});
