import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockInvoke, mockInvokeFn } from "../../../tests/setup/tauri";
import { mockDialogOpen } from "../../../tests/setup/dialog";
import {
  acceptsDroppedPath,
  DeadFramePanel,
  isSupportedVideoPath,
  keptFrameCount,
} from "./DeadFramePanel";
import { resetPlayableSourceCache } from "./playableSource";

const mockOpenPath = vi.fn(async (_path: string) => undefined);
vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: (path: string) => mockOpenPath(path),
  openUrl: vi.fn(),
}));

const CLIP = String.raw`C:\clips\scene.mp4`;
const OTHER_CLIP = String.raw`C:\clips\other.mp4`;
const PREVIEW_OUTPUT = String.raw`C:\appdata\deadframe_previews\preview-1.mp4`;
const PROXY = String.raw`C:\appdata\proxies\scene-proxy.mp4`;

// The playable-file answers are cached at module scope so re-selecting a clip
// costs nothing; that cache has to be emptied between tests or one test's
// answer decides the next test's player.
beforeEach(() => {
  resetPlayableSourceCache();
  mockOpenPath.mockClear();
});

// Frame 0 is never removable. Index 1 and 3 are held duplicates, index 4 is one
// frame of drift from a slow pan: it survives the default dial and is only
// caught once the dial is pushed up.
const SCORES = [1, 0.0005, 0.2, 0.0005, 0.012, 0.2];

function statusPayload() {
  return JSON.stringify({
    type: "status",
    hardware: { hasCuda: true, device: "RTX Test" },
    models: {},
  });
}

function analysisPayload(args: unknown) {
  const input = (args as { input: string }).input;
  return JSON.stringify({
    type: "analysis",
    input,
    frameCount: SCORES.length,
    fps: 24,
    width: 1920,
    height: 1080,
    duration: SCORES.length / 24,
    scores: SCORES,
  });
}

function previewPayload() {
  return JSON.stringify({
    type: "done",
    output: PREVIEW_OUTPUT,
    sourceFrames: SCORES.length,
    keptFrames: 4,
    elapsedSeconds: 1,
  });
}

function exportPayload() {
  return JSON.stringify({
    type: "done",
    outcomes: [{ ok: true, input: CLIP, output: String.raw`C:\clips\scene_nodead.mp4` }],
    succeeded: 1,
    failed: 0,
    removedFrames: 2,
    elapsedSeconds: 3,
  });
}

function registerDefaults() {
  mockInvoke("interpolate_status", () => statusPayload());
  mockInvoke("deadframe_clear_previews", () => undefined);
  mockInvoke("deadframe_analyze", (args) => analysisPayload(args));
  mockInvoke("deadframe_preview", () => previewPayload());
  mockInvoke("deadframe_export", () => exportPayload());
  // Both players ask whether the embedded browser can decode the file before
  // pointing at it. The default answer is "yes, play it as-is".
  mockInvoke("clip_playback_plan", () => directPlan());
  mockInvoke("build_source_proxy", () => PROXY);
}

function directPlan() {
  return { mode: "direct", reasons: [] };
}

function proxyPlan() {
  return { mode: "proxy", reasons: ["video codec prores not WebView2-friendly"] };
}

function sourceVideo(): HTMLVideoElement {
  return screen.getByLabelText("the source clip") as HTMLVideoElement;
}

async function addClips(user: ReturnType<typeof userEvent.setup>, paths: string[]) {
  mockDialogOpen.mockResolvedValueOnce(paths);
  await user.click(screen.getByRole("button", { name: "Add clips" }));
  // The queue row swaps "Measuring…" for the count once the scores land.
  await screen.findAllByText(`${SCORES.length} → 4`);
}

function analyzeCallCount(): number {
  return mockInvokeFn.mock.calls.filter(([command]) => command === "deadframe_analyze").length;
}

function exportButton(): HTMLElement {
  return screen.getByRole("button", { name: "Export queue" });
}

// The four format cards are gone; the container is picked from a dropdown, and
// each format's one-line hint now lives inside the menu.
function formatTrigger(): HTMLElement {
  return screen.getByRole("button", { name: /^(H\.264|HEVC|ProRes) · /u });
}

async function chooseFormat(user: ReturnType<typeof userEvent.setup>, label: RegExp) {
  await user.click(formatTrigger());
  await user.click(await screen.findByRole("option", { name: label }));
}

function ribbonTicks(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".deadframe-ribbon-tick"));
}

async function previewSelectedClip(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Preview" }));
  await waitFor(() => expect(exportButton()).toBeEnabled());
}

describe("DeadFramePanel export gate", () => {
  it("keeps export locked while the queue is empty", async () => {
    registerDefaults();
    render(<DeadFramePanel active />);
    expect(exportButton()).toBeDisabled();
    expect(await screen.findByText("no preview yet")).toBeInTheDocument();
  });

  it("keeps export locked after clips are added but before any preview", async () => {
    registerDefaults();
    const user = userEvent.setup();
    render(<DeadFramePanel active />);
    await addClips(user, [CLIP]);
    expect(exportButton()).toBeDisabled();
    expect(screen.getByText("no preview yet")).toBeInTheDocument();
  });

  it("unlocks export once a preview lands", async () => {
    registerDefaults();
    const user = userEvent.setup();
    render(<DeadFramePanel active />);
    await addClips(user, [CLIP]);
    await previewSelectedClip(user);
    expect(
      screen.getByText("preview matches the dial - ready to export 1 clip"),
    ).toBeInTheDocument();
  });

  it("re-locks export when the sensitivity dial moves", async () => {
    registerDefaults();
    const user = userEvent.setup();
    render(<DeadFramePanel active />);
    await addClips(user, [CLIP]);
    await previewSelectedClip(user);
    fireEvent.change(screen.getByRole("slider", { name: "Sensitivity" }), {
      target: { value: "60" },
    });
    expect(exportButton()).toBeDisabled();
    expect(screen.getByText("dial moved - preview again")).toBeInTheDocument();
  });

  it("re-locks export when a different queue clip is selected", async () => {
    registerDefaults();
    const user = userEvent.setup();
    render(<DeadFramePanel active />);
    await addClips(user, [CLIP, OTHER_CLIP]);
    await previewSelectedClip(user);
    // The row's own button, not its Remove button.
    await user.click(screen.getByRole("button", { name: /^other\.mp4/ }));
    expect(exportButton()).toBeDisabled();
    expect(screen.getByText("no preview yet")).toBeInTheDocument();
  });

  it("leaves export unlocked when the output format changes", async () => {
    registerDefaults();
    const user = userEvent.setup();
    render(<DeadFramePanel active />);
    await addClips(user, [CLIP]);
    await previewSelectedClip(user);
    await chooseFormat(user, /H\.264 · MKV/);
    expect(exportButton()).toBeEnabled();
    expect(
      screen.getByText("preview matches the dial - ready to export 1 clip"),
    ).toBeInTheDocument();
  });
});

describe("DeadFramePanel detection dial", () => {
  it("recomputes the live count from the cached scores without measuring again", async () => {
    registerDefaults();
    const user = userEvent.setup();
    render(<DeadFramePanel active />);
    await addClips(user, [CLIP]);
    expect(analyzeCallCount()).toBe(1);
    expect(screen.getByText("4 kept")).toBeInTheDocument();
    expect(screen.getByText("2 removed")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("slider", { name: "Sensitivity" }), {
      target: { value: "60" },
    });
    expect(await screen.findByText("3 kept")).toBeInTheDocument();
    expect(screen.getByText("3 removed")).toBeInTheDocument();
    expect(screen.getByText("6 → 3")).toBeInTheDocument();
    expect(analyzeCallCount()).toBe(1);
  });

  it("draws one ribbon tick per frame and drops exactly the ones the count lost", async () => {
    registerDefaults();
    const user = userEvent.setup();
    render(<DeadFramePanel active />);
    await addClips(user, [CLIP]);

    const dropped = () => ribbonTicks().filter((tick) => tick.dataset.drop === "1").length;
    expect(ribbonTicks()).toHaveLength(SCORES.length);
    expect(dropped()).toBe(SCORES.length - keptFrameCount(SCORES, 18));

    fireEvent.change(screen.getByRole("slider", { name: "Sensitivity" }), {
      target: { value: "60" },
    });
    await screen.findByText("3 kept");
    expect(dropped()).toBe(SCORES.length - keptFrameCount(SCORES, 60));
  });

  it("shows an empty ribbon with no numbers before any clip is selected", async () => {
    registerDefaults();
    render(<DeadFramePanel active />);
    await screen.findByText("no preview yet");
    expect(ribbonTicks()).toHaveLength(0);
    expect(document.querySelector(".deadframe-ribbon-baseline")).not.toBeNull();
    expect(screen.queryByText(/\d+ kept/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\d+ removed/)).not.toBeInTheDocument();
  });

  it("counts a score sitting exactly on the threshold as kept", () => {
    // 0.001 is the threshold at dial 0, so it must survive there and only fall
    // once the dial pushes the threshold past it.
    expect(keptFrameCount([1, 0.001], 0)).toBe(2);
    expect(keptFrameCount([1, 0.001], 100)).toBe(1);
  });
});

describe("DeadFramePanel output controls", () => {
  it("unmounts the whole rate row for ProRes and brings it back for the others", async () => {
    registerDefaults();
    const user = userEvent.setup();
    render(<DeadFramePanel active />);
    expect(screen.getByRole("button", { name: "Quality" })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Constant quality" })).toBeInTheDocument();

    await chooseFormat(user, /ProRes · MOV/);
    expect(screen.queryByRole("button", { name: "Quality" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "CBR" })).not.toBeInTheDocument();
    expect(screen.queryByRole("slider", { name: "Constant quality" })).not.toBeInTheDocument();
    expect(screen.getByText(/nothing to tune/)).toBeInTheDocument();

    await chooseFormat(user, /H\.264 · MP4/);
    expect(screen.getByRole("button", { name: "Quality" })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Constant quality" })).toBeInTheDocument();
  });

  it("swaps the value control and its value when the rate mode changes", async () => {
    registerDefaults();
    const user = userEvent.setup();
    render(<DeadFramePanel active />);
    expect(screen.getByRole("spinbutton", { name: "Constant quality" })).toHaveValue(18);

    await user.click(screen.getByRole("button", { name: "CBR" }));
    expect(screen.queryByRole("spinbutton", { name: "Constant quality" })).not.toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "Constant bitrate" })).toHaveValue(20);
    expect(screen.getByText("The encoder holds this bitrate throughout the clip.")).toBeInTheDocument();
  });

  it("hands the backend the format, rate mode, and value it was shown", async () => {
    registerDefaults();
    const user = userEvent.setup();
    render(<DeadFramePanel active />);
    await addClips(user, [CLIP]);
    await previewSelectedClip(user);

    await chooseFormat(user, /H\.264 · MKV/);
    await user.click(screen.getByRole("button", { name: "CBR" }));
    fireEvent.change(screen.getByRole("slider", { name: "Constant bitrate" }), {
      target: { value: "40" },
    });
    await user.click(screen.getByRole("button", { name: "Keep" }));

    expect(exportButton()).toBeEnabled();
    await user.click(exportButton());
    await waitFor(() => {
      expect(mockInvokeFn).toHaveBeenCalledWith("deadframe_export", {
        inputs: [CLIP],
        sensitivity: 18,
        suffix: "_nodead",
        outputFormat: "h264-mkv",
        rateMode: "cbr",
        quality: 18,
        bitrateMbps: 40,
        keepAudio: true,
        fps: null,
        gpu: true,
      });
    });
  });

  it("sends no frame rate by default and the chosen one after the dropdown is used", async () => {
    registerDefaults();
    const user = userEvent.setup();
    render(<DeadFramePanel active />);
    await addClips(user, [CLIP]);
    await previewSelectedClip(user);

    // Picking a rate is an encoder setting, so the gate stays open like it
    // does for the format and rate-mode controls.
    await user.click(screen.getByRole("button", { name: "Source fps" }));
    await user.click(await screen.findByRole("option", { name: "60 fps" }));
    expect(exportButton()).toBeEnabled();

    await user.click(exportButton());
    await waitFor(() => {
      expect(mockInvokeFn).toHaveBeenCalledWith(
        "deadframe_export",
        expect.objectContaining({ fps: 60 }),
      );
    });
  });
});

describe("DeadFramePanel preview", () => {
  it("keeps Preview and Export reachable, and gated as before, after the rebuild", async () => {
    registerDefaults();
    const user = userEvent.setup();
    render(<DeadFramePanel active />);
    // Preview now sits in the sensitivity card, Export alone in the bottom bar.
    // Both stay shut until there is a measured clip / a matching preview.
    expect(screen.getByRole("button", { name: "Preview" })).toBeDisabled();
    expect(exportButton()).toBeDisabled();

    await addClips(user, [CLIP]);
    expect(screen.getByRole("button", { name: "Preview" })).toBeEnabled();
    expect(exportButton()).toBeDisabled();

    await previewSelectedClip(user);
    expect(exportButton()).toBeEnabled();
  });

  it("asks the backend for the selected clip at the dial the user can see", async () => {
    registerDefaults();
    const user = userEvent.setup();
    render(<DeadFramePanel active />);
    await addClips(user, [CLIP]);
    fireEvent.change(screen.getByRole("slider", { name: "Sensitivity" }), {
      target: { value: "44" },
    });
    await previewSelectedClip(user);
    expect(mockInvokeFn).toHaveBeenCalledWith("deadframe_preview", {
      input: CLIP,
      sensitivity: 44,
    });
  });

  it("sweeps up a preview a crash left behind, without saying anything about it", async () => {
    registerDefaults();
    render(<DeadFramePanel active />);
    await waitFor(() => expect(mockInvokeFn).toHaveBeenCalledWith("deadframe_clear_previews"));
    expect(screen.queryByText(/leftover/i)).not.toBeInTheDocument();
  });

  it("calls a cancelled preview cancelled instead of showing the killed job's error", async () => {
    registerDefaults();
    let failPreview: (() => void) | undefined;
    mockInvoke("deadframe_preview", () => new Promise((_resolve, reject) => {
      // The killed sidecar's failure lands after the cancel call has returned,
      // which is the ordering that would otherwise replace the cancel message.
      failPreview = () => setTimeout(
        () => reject(new Error("Dead frame removal stopped without a result (exit code 1).")),
        0,
      );
    }));
    mockInvoke("cancel_deadframe", () => failPreview?.());
    const user = userEvent.setup();
    render(<DeadFramePanel active />);
    await addClips(user, [CLIP]);
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    await screen.findByText("Cancelled. Files that had already finished were kept.");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(screen.queryByText(/exit code 1/)).not.toBeInTheDocument();
    expect(exportButton()).toBeDisabled();
  });

  it("leaves the gate locked and reports the reason when a preview fails", async () => {
    registerDefaults();
    mockInvoke("deadframe_preview", () => {
      throw new Error("Could not read this file.");
    });
    const user = userEvent.setup();
    render(<DeadFramePanel active />);
    await addClips(user, [CLIP]);
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByText("Could not read this file.")).toBeInTheDocument();
    expect(exportButton()).toBeDisabled();
    expect(screen.getByText("no preview yet")).toBeInTheDocument();
  });
});

describe("DeadFramePanel player sources", () => {
  it("plays the original file when the app can decode it", async () => {
    registerDefaults();
    const user = userEvent.setup();
    render(<DeadFramePanel active />);
    await addClips(user, [CLIP]);
    await waitFor(() => expect(sourceVideo()).toHaveAttribute("src", CLIP));
    expect(mockInvokeFn).toHaveBeenCalledWith("clip_playback_plan", { sourcePath: CLIP });
    expect(
      mockInvokeFn.mock.calls.some(([command]) => command === "build_source_proxy"),
    ).toBe(false);
  });

  it("plays the stand-in copy, never the original, for a file it cannot decode", async () => {
    registerDefaults();
    mockInvoke("clip_playback_plan", () => proxyPlan());
    const user = userEvent.setup();
    render(<DeadFramePanel active />);
    await addClips(user, [CLIP]);
    await waitFor(() => expect(sourceVideo()).toHaveAttribute("src", PROXY));
    expect(mockInvokeFn).toHaveBeenCalledWith("build_source_proxy", {
      sourcePath: CLIP,
      force: false,
    });
  });

  it("only builds one stand-in copy no matter how often the clip is re-selected", async () => {
    registerDefaults();
    mockInvoke("clip_playback_plan", () => proxyPlan());
    const user = userEvent.setup();
    render(<DeadFramePanel active />);
    await addClips(user, [CLIP, OTHER_CLIP]);
    await waitFor(() => expect(sourceVideo()).toHaveAttribute("src", PROXY));
    await user.click(screen.getByRole("button", { name: /^other\.mp4/ }));
    await user.click(screen.getByRole("button", { name: /^scene\.mp4/ }));
    await waitFor(() => expect(sourceVideo()).toHaveAttribute("src", PROXY));
    const builds = mockInvokeFn.mock.calls.filter(
      ([command, args]) =>
        command === "build_source_proxy" && (args as { sourcePath: string }).sourcePath === CLIP,
    );
    expect(builds).toHaveLength(1);
  });

  it("explains itself instead of going black when the stand-in copy cannot be made", async () => {
    registerDefaults();
    mockInvoke("clip_playback_plan", () => proxyPlan());
    mockInvoke("build_source_proxy", () => {
      throw new Error("ffmpeg exited with code 1");
    });
    const user = userEvent.setup();
    render(<DeadFramePanel active />);
    await addClips(user, [CLIP]);
    expect(
      await screen.findByText(/format the app can't show on screen/i),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("the source clip")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Open in your video player/ }));
    expect(mockOpenPath).toHaveBeenCalledWith(CLIP);
  });

  it("keeps the dial and the Preview button usable while a copy is being made", async () => {
    registerDefaults();
    mockInvoke("clip_playback_plan", () => proxyPlan());
    mockInvoke("build_source_proxy", () => new Promise<string>(() => undefined));
    const user = userEvent.setup();
    render(<DeadFramePanel active />);
    await addClips(user, [CLIP]);
    expect(await screen.findByText("Preparing preview…")).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Sensitivity" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Preview" })).toBeEnabled();
  });

  it("checks the rendered result too, so a preview never lands in a black box", async () => {
    registerDefaults();
    const user = userEvent.setup();
    render(<DeadFramePanel active />);
    await addClips(user, [CLIP]);
    await previewSelectedClip(user);
    await waitFor(() =>
      expect(screen.getByLabelText("the de-duplicated clip")).toHaveAttribute(
        "src",
        PREVIEW_OUTPUT,
      ),
    );
    expect(mockInvokeFn).toHaveBeenCalledWith("clip_playback_plan", {
      sourcePath: PREVIEW_OUTPUT,
    });
  });
});

describe("DeadFramePanel queue", () => {
  it("marks a clip that could not be measured and keeps the rest usable", async () => {
    registerDefaults();
    mockInvoke("deadframe_analyze", (args) => {
      const input = (args as { input: string }).input;
      if (input === OTHER_CLIP) throw new Error("Could not read this file.");
      return analysisPayload(args);
    });
    const user = userEvent.setup();
    render(<DeadFramePanel active />);
    mockDialogOpen.mockResolvedValueOnce([CLIP, OTHER_CLIP]);
    await user.click(screen.getByRole("button", { name: "Add clips" }));
    expect(await screen.findByText("Could not read this file.")).toBeInTheDocument();
    await previewSelectedClip(user);
    // The unreadable clip is skipped by the export, so the count is 1 of 2.
    expect(
      screen.getByText("preview matches the dial - ready to export 1 clip"),
    ).toBeInTheDocument();
  });

  it("removes a queued clip", async () => {
    registerDefaults();
    const user = userEvent.setup();
    render(<DeadFramePanel active />);
    await addClips(user, [CLIP, OTHER_CLIP]);
    expect(screen.getByText("2 clips")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove other.mp4" }));
    expect(screen.getByText("1 clip")).toBeInTheDocument();
  });
});

describe("dead frame drop targets", () => {
  it("accepts supported clips and rejects other files", () => {
    expect(isSupportedVideoPath(String.raw`C:\clips\scene.MP4`)).toBe(true);
    expect(isSupportedVideoPath(String.raw`C:\clips\notes.txt`)).toBe(false);
  });

  it("treats an extensionless drop as a folder to expand", () => {
    expect(acceptsDroppedPath(String.raw`C:\clips\batch-01`)).toBe(true);
    expect(acceptsDroppedPath(String.raw`C:\clips\notes.txt`)).toBe(false);
  });
});
