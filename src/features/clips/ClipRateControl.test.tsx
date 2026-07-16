import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ClipRateControl } from "./ClipRateControl";

describe("ClipRateControl", () => {
  it("switches between quality and target bitrate", () => {
    const onModeChange = vi.fn();
    render(
      <ClipRateControl
        mode="quality"
        bitrateMbps={20}
        disabled={false}
        onModeChange={onModeChange}
        onBitrateChange={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Target bitrate" }));
    expect(onModeChange).toHaveBeenCalledWith("bitrate");
  });

  it("accepts an unrestricted decimal bitrate", () => {
    const onBitrateChange = vi.fn();
    render(
      <ClipRateControl
        mode="bitrate"
        bitrateMbps={20}
        disabled={false}
        onModeChange={() => undefined}
        onBitrateChange={onBitrateChange}
      />,
    );

    const input = screen.getByRole("spinbutton", { name: "Target bitrate" });
    fireEvent.change(input, { target: { value: "350.5" } });
    fireEvent.blur(input);
    expect(onBitrateChange).toHaveBeenCalledWith(350.5);
    expect(input).not.toHaveAttribute("max");
  });

  it("rejects zero instead of starting an invalid export", () => {
    const onBitrateChange = vi.fn();
    render(
      <ClipRateControl
        mode="bitrate"
        bitrateMbps={20}
        disabled={false}
        onModeChange={() => undefined}
        onBitrateChange={onBitrateChange}
      />,
    );

    const input = screen.getByRole("spinbutton", { name: "Target bitrate" });
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.blur(input);
    expect(onBitrateChange).not.toHaveBeenCalled();
    expect(input).toHaveValue(20);
  });
});
