import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ClipRateControl } from "./ClipRateControl";

describe("ClipRateControl", () => {
  it("offers quality, VBR, and CBR as separate modes", () => {
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

    expect(screen.getByRole("button", { name: "Quality" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "VBR" }));
    fireEvent.click(screen.getByRole("button", { name: "CBR" }));
    expect(onModeChange).toHaveBeenNthCalledWith(1, "vbr");
    expect(onModeChange).toHaveBeenNthCalledWith(2, "cbr");
  });

  it("accepts an unrestricted decimal VBR target", () => {
    const onBitrateChange = vi.fn();
    render(
      <ClipRateControl
        mode="vbr"
        bitrateMbps={20}
        disabled={false}
        onModeChange={() => undefined}
        onBitrateChange={onBitrateChange}
      />,
    );

    expect(screen.getByText("Aims for this average bitrate; busy scenes may go over.")).toBeVisible();
    const input = screen.getByRole("spinbutton", { name: "Average bitrate" });
    fireEvent.change(input, { target: { value: "350.5" } });
    fireEvent.blur(input);
    expect(onBitrateChange).toHaveBeenCalledWith(350.5);
    expect(input).not.toHaveAttribute("max");
  });

  it("rejects zero instead of starting an invalid export", () => {
    const onBitrateChange = vi.fn();
    render(
      <ClipRateControl
        mode="cbr"
        bitrateMbps={20}
        disabled={false}
        onModeChange={() => undefined}
        onBitrateChange={onBitrateChange}
      />,
    );

    expect(screen.getByText("Holds this bitrate throughout. Predictable file size, safe for streaming.")).toBeVisible();
    const input = screen.getByRole("spinbutton", { name: "Constant bitrate" });
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.blur(input);
    expect(onBitrateChange).not.toHaveBeenCalled();
    expect(input).toHaveValue(20);
  });
});
