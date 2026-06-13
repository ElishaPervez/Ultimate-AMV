/**
 * TsukyioPlayer tests
 *
 * Covers the custom transport controls wrapped around the <video>/<audio>
 * engine:
 * - Play/pause: button writes to the element, element events drive the label.
 * - Autoplay prop: play() attempted on mount only when autoPlay is enabled.
 * - Time readout: m:ss formatting after duration/timeupdate; "--:--" fallback
 *   while the duration is unknown (and the scrubber stays inert).
 * - Scrubber: proportional mousedown seek, window-mousemove drag, timeupdate
 *   suppression mid-drag, resume-after-drag, keyboard seeking, ARIA contract.
 * - Mute + volume: element writes round-trip through the volumechange
 *   persistence listener into localStorage, and a fresh mount restores them.
 * - Errors: media error codes surface via mediaErrorLabel.
 * - Ended: resets the play control and snaps the readout to the end.
 * - Branch smoke: video overlay bar vs hidden-audio-engine control bar.
 *
 * jsdom does not implement HTMLMediaElement playback, so play/pause/load and
 * the paused/ended/duration/currentTime/volume/muted properties are stubbed on
 * the prototype (same approach as DirectStreamPlayer.test.tsx, extended with
 * per-element state so the component's "element is the source of truth" sync
 * effect has something real to read). volume/muted dispatch `volumechange`
 * synchronously, which is what the component's persistence listener needs.
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { vi } from "vitest";
import { TsukyioPlayer } from "./TsukyioPlayer";
import type { TsukyioItem } from "../../types/tsukyio";
import { mockInvoke } from "../../../tests/setup/tauri";

// ─── HTMLMediaElement stubs ──────────────────────────────────────────────────

type MediaStubState = {
  paused: boolean;
  ended: boolean;
  duration: number;
  currentTime: number;
  volume: number;
  muted: boolean;
};

const mediaState = new WeakMap<HTMLMediaElement, MediaStubState>();

function stateOf(el: HTMLMediaElement): MediaStubState {
  let state = mediaState.get(el);
  if (!state) {
    state = { paused: true, ended: false, duration: NaN, currentTime: 0, volume: 1, muted: false };
    mediaState.set(el, state);
  }
  return state;
}

const playMock = vi.fn(function (this: HTMLMediaElement) {
  const state = stateOf(this);
  if (state.paused) {
    state.paused = false;
    state.ended = false;
    this.dispatchEvent(new Event("play"));
  }
  return Promise.resolve();
});

const pauseMock = vi.fn(function (this: HTMLMediaElement) {
  const state = stateOf(this);
  if (!state.paused) {
    state.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
});

const loadMock = vi.fn();

beforeAll(() => {
  const proto = HTMLMediaElement.prototype;
  Object.defineProperty(proto, "play", { configurable: true, writable: true, value: playMock });
  Object.defineProperty(proto, "pause", { configurable: true, writable: true, value: pauseMock });
  Object.defineProperty(proto, "load", { configurable: true, writable: true, value: loadMock });
  Object.defineProperty(proto, "paused", {
    configurable: true,
    get(this: HTMLMediaElement) {
      return stateOf(this).paused;
    },
  });
  Object.defineProperty(proto, "ended", {
    configurable: true,
    get(this: HTMLMediaElement) {
      return stateOf(this).ended;
    },
  });
  Object.defineProperty(proto, "duration", {
    configurable: true,
    get(this: HTMLMediaElement) {
      return stateOf(this).duration;
    },
  });
  Object.defineProperty(proto, "currentTime", {
    configurable: true,
    get(this: HTMLMediaElement) {
      return stateOf(this).currentTime;
    },
    set(this: HTMLMediaElement, value: number) {
      stateOf(this).currentTime = value;
    },
  });
  Object.defineProperty(proto, "volume", {
    configurable: true,
    get(this: HTMLMediaElement) {
      return stateOf(this).volume;
    },
    set(this: HTMLMediaElement, value: number) {
      const state = stateOf(this);
      if (state.volume !== value) {
        state.volume = value;
        this.dispatchEvent(new Event("volumechange"));
      }
    },
  });
  Object.defineProperty(proto, "muted", {
    configurable: true,
    get(this: HTMLMediaElement) {
      return stateOf(this).muted;
    },
    set(this: HTMLMediaElement, value: boolean) {
      const state = stateOf(this);
      if (state.muted !== value) {
        state.muted = value;
        this.dispatchEvent(new Event("volumechange"));
      }
    },
  });
});

beforeEach(() => {
  playMock.mockClear();
  pauseMock.mockClear();
  loadMock.mockClear();
  // handleError logs through invoke("frontend_log"); register a no-op so the
  // error tests don't depend on the registry's missing-handler rejection.
  mockInvoke("frontend_log", () => null);
});

// ─── fixtures + helpers ──────────────────────────────────────────────────────

const PREFS_KEY = "tsukyio.preview.player";

const videoItem: TsukyioItem = { id: "vid-1", name: "Sakura Drift.mp4", type: "video" };
const audioItem: TsukyioItem = { id: "aud-1", name: "Night Drive.mp3", type: "audio" };

const VIDEO_SRC = "tsukyio://stream/vid-1";
const AUDIO_SRC = "tsukyio://stream/aud-1";

// autoPlay defaults to FALSE here (the component defaults to true) so tests
// start from a deterministic paused state; autoplay has its own test.
function renderVideoPlayer(props?: Partial<React.ComponentProps<typeof TsukyioPlayer>>) {
  return render(
    <TsukyioPlayer item={videoItem} streamSrc={VIDEO_SRC} autoPlay={false} {...props} />,
  );
}

function getVideo(container: HTMLElement): HTMLVideoElement {
  const video = container.querySelector("video");
  if (!video) throw new Error("expected a <video> element to be rendered");
  return video;
}

// Drive the element to the component's "ready" state (canplay -> handleReady),
// optionally announcing a duration first (durationchange -> sync effect).
function makeReady(media: HTMLMediaElement, duration?: number) {
  if (duration !== undefined) {
    stateOf(media).duration = duration;
    fireEvent.durationChange(media);
  }
  fireEvent.canPlay(media);
}

// jsdom layout is all zeros — give the scrub track a real box so the
// fraction = (clientX - left) / width math in seekFromPointer is exercised.
function mockTrackRect(track: Element, width = 200) {
  vi.spyOn(track as HTMLElement, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: width,
    bottom: 8,
    width,
    height: 8,
    toJSON: () => ({}),
  } as DOMRect);
}

function getSeekSlider() {
  return screen.getByRole("slider", { name: "Seek" });
}

function getVolumeSlider(): HTMLInputElement {
  return screen.getByRole("slider", { name: "Volume" }) as HTMLInputElement;
}

function storedPrefs() {
  const raw = localStorage.getItem(PREFS_KEY);
  return raw === null ? null : (JSON.parse(raw) as { volume: number; muted: boolean });
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe("TsukyioPlayer", () => {
  describe("play / pause", () => {
    it("clicking Play calls play() on the video and flips the control to Pause", () => {
      const { container } = renderVideoPlayer();
      const video = getVideo(container);
      makeReady(video, 120);

      fireEvent.click(screen.getByRole("button", { name: "Play" }));

      expect(playMock).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Play" })).not.toBeInTheDocument();
    });

    it("clicking Pause pauses the video and flips the control back to Play", () => {
      const { container } = renderVideoPlayer();
      const video = getVideo(container);
      makeReady(video, 120);

      fireEvent.click(screen.getByRole("button", { name: "Play" }));
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));

      expect(pauseMock).toHaveBeenCalledTimes(1);
      expect(video.paused).toBe(true);
      expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    });

    it("attempts autoplay on mount only when autoPlay is enabled", () => {
      const first = render(<TsukyioPlayer item={videoItem} streamSrc={VIDEO_SRC} autoPlay />);
      expect(playMock).toHaveBeenCalledTimes(1);
      first.unmount();

      playMock.mockClear();
      render(<TsukyioPlayer item={videoItem} streamSrc={VIDEO_SRC} autoPlay={false} />);
      expect(playMock).not.toHaveBeenCalled();
    });
  });

  describe("time display", () => {
    it("renders the --:-- fallback and an inert scrubber while the duration is unknown", () => {
      const { container } = renderVideoPlayer();
      const video = getVideo(container);
      makeReady(video); // ready, but no duration announced (still NaN)

      expect(screen.getByText("0:00 / --:--")).toBeInTheDocument();

      const scrub = getSeekSlider();
      expect(scrub).toHaveAttribute("aria-disabled", "true");
      expect(scrub).toHaveAttribute("tabindex", "-1");
      expect(scrub).toHaveAttribute("aria-valuemax", "0");
      expect(scrub).toHaveAttribute("aria-valuetext", "0:00 of unknown");

      // Seeking is inert without a duration: no mousedown handler is attached.
      mockTrackRect(scrub);
      fireEvent.mouseDown(scrub, { clientX: 100 });
      expect(video.currentTime).toBe(0);
      expect(scrub).toHaveAttribute("aria-valuenow", "0");
    });

    it("formats the readout as m:ss once duration and timeupdate arrive", () => {
      const { container } = renderVideoPlayer();
      const video = getVideo(container);
      makeReady(video, 125);

      expect(screen.getByText("0:00 / 2:05")).toBeInTheDocument();

      stateOf(video).currentTime = 65;
      fireEvent.timeUpdate(video);

      expect(screen.getByText("1:05 / 2:05")).toBeInTheDocument();
    });
  });

  describe("scrubber", () => {
    it("seeks proportionally on mousedown and keeps the ARIA contract consistent", () => {
      const { container } = renderVideoPlayer();
      const video = getVideo(container);
      makeReady(video, 120);

      const scrub = getSeekSlider();
      expect(scrub).toHaveAttribute("aria-valuemin", "0");
      expect(scrub).toHaveAttribute("aria-valuemax", "120");
      expect(scrub).toHaveAttribute("aria-valuenow", "0");
      expect(scrub).toHaveAttribute("aria-disabled", "false");

      mockTrackRect(scrub, 200);
      fireEvent.mouseDown(scrub, { clientX: 50 }); // 25% of the 200px track

      expect(video.currentTime).toBeCloseTo(30);
      expect(scrub).toHaveAttribute("aria-valuenow", "30");
      expect(scrub).toHaveAttribute("aria-valuetext", "0:30 of 2:00");
      expect(screen.getByText("0:30 / 2:00")).toBeInTheDocument();

      fireEvent.mouseUp(window);
    });

    it("drag-seeks via window mousemove, ignores timeupdate mid-drag, and resumes on mouseup", () => {
      const { container } = renderVideoPlayer();
      const video = getVideo(container);
      makeReady(video, 120);

      fireEvent.click(screen.getByRole("button", { name: "Play" }));
      playMock.mockClear();

      const scrub = getSeekSlider();
      mockTrackRect(scrub, 200);

      fireEvent.mouseDown(scrub, { clientX: 50 });
      expect(pauseMock).toHaveBeenCalledTimes(1); // playback held during the drag

      fireEvent.mouseMove(window, { clientX: 150 }); // 75%
      expect(video.currentTime).toBeCloseTo(90);
      expect(scrub).toHaveAttribute("aria-valuenow", "90");

      // The element's own timeupdate must not yank the thumb mid-drag.
      stateOf(video).currentTime = 10;
      fireEvent.timeUpdate(video);
      expect(scrub).toHaveAttribute("aria-valuenow", "90");

      fireEvent.mouseUp(window);
      expect(playMock).toHaveBeenCalledTimes(1); // resumed because it was playing
      expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    });

    it("keyboard-seeks with ArrowRight / End, clamped to the duration", () => {
      const { container } = renderVideoPlayer();
      const video = getVideo(container);
      makeReady(video, 120);

      const scrub = getSeekSlider();
      fireEvent.keyDown(scrub, { key: "ArrowRight" });
      expect(video.currentTime).toBe(5);
      expect(scrub).toHaveAttribute("aria-valuenow", "5");

      fireEvent.keyDown(scrub, { key: "End" });
      expect(video.currentTime).toBe(120);
      expect(scrub).toHaveAttribute("aria-valuenow", "120");
    });
  });

  describe("mute + volume persistence", () => {
    it("toggling mute flips video.muted and round-trips the pref through localStorage", () => {
      const { container } = renderVideoPlayer();
      const video = getVideo(container);
      makeReady(video, 120);

      // First-run default prefs: muted, so the control offers Unmute.
      expect(video.muted).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Unmute" }));

      expect(video.muted).toBe(false);
      expect(screen.getByRole("button", { name: "Mute" })).toBeInTheDocument();
      expect(storedPrefs()).toEqual({ volume: 1, muted: false });

      fireEvent.click(screen.getByRole("button", { name: "Mute" }));
      expect(video.muted).toBe(true);
      expect(storedPrefs()).toEqual({ volume: 1, muted: true });
      expect(getVolumeSlider().value).toBe("0"); // muted slider renders at zero
    });

    it("a fresh mount restores persisted volume and mute from localStorage", () => {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ volume: 0.5, muted: false }));

      const { container } = renderVideoPlayer();
      const video = getVideo(container);

      expect(video.volume).toBeCloseTo(0.5);
      expect(video.muted).toBe(false);

      makeReady(video, 120);
      expect(screen.getByRole("button", { name: "Mute" })).toBeInTheDocument();
      expect(getVolumeSlider().value).toBe("0.5");
    });

    it("changing the volume slider sets video.volume, unmutes, and persists", () => {
      const { container } = renderVideoPlayer();
      const video = getVideo(container);
      makeReady(video, 120);

      expect(video.muted).toBe(true); // default prefs start muted
      fireEvent.change(getVolumeSlider(), { target: { value: "0.3" } });

      expect(video.volume).toBeCloseTo(0.3);
      expect(video.muted).toBe(false); // dragging to an audible level unmutes
      expect(screen.getByRole("button", { name: "Mute" })).toBeInTheDocument();
      expect(storedPrefs()).toEqual({ volume: 0.3, muted: false });
    });
  });

  describe("errors", () => {
    it("surfaces a decode failure with the mediaErrorLabel text and the error message", () => {
      const { container } = renderVideoPlayer();
      const video = getVideo(container);
      Object.defineProperty(video, "error", {
        configurable: true,
        value: { code: 3, message: "demuxer choked" },
      });

      fireEvent.error(video);

      expect(screen.getByText(/Preview could not be played:/)).toBeInTheDocument();
      expect(
        screen.getByText(/MEDIA_ERR_DECODE \(the media could not be decoded\)/),
      ).toBeInTheDocument();
      expect(screen.getByText(/demuxer choked/)).toBeInTheDocument();
      // The loading spinner is replaced by the error overlay.
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });

    it("falls back to the unknown-error label for unrecognized codes", () => {
      const { container } = renderVideoPlayer();
      const video = getVideo(container);
      Object.defineProperty(video, "error", {
        configurable: true,
        value: { code: 42, message: "" },
      });

      fireEvent.error(video);

      expect(screen.getByText(/unknown media error/)).toBeInTheDocument();
    });
  });

  describe("ended", () => {
    it("resets the play control and snaps the readout to the end", () => {
      const { container } = renderVideoPlayer();
      const video = getVideo(container);
      makeReady(video, 90);

      fireEvent.click(screen.getByRole("button", { name: "Play" }));
      expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();

      stateOf(video).ended = true;
      fireEvent.ended(video);

      expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
      expect(screen.getByText("1:30 / 1:30")).toBeInTheDocument();
    });
  });

  describe("audio vs video branches", () => {
    it("video assets render the overlay control bar only once ready", () => {
      const { container } = renderVideoPlayer();

      expect(container.querySelector("video")).toBeInTheDocument();
      expect(container.querySelector("audio")).toBeNull();
      expect(container.querySelector(".tsukyio-video-controls")).toBeNull();
      expect(screen.getByRole("status")).toHaveTextContent(/Loading preview/);

      makeReady(getVideo(container), 60);

      expect(container.querySelector(".tsukyio-video-controls")).toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });

    it("audio assets render the hidden engine plus the audio control bar", () => {
      const { container } = render(
        <TsukyioPlayer item={audioItem} streamSrc={AUDIO_SRC} autoPlay={false} />,
      );

      const audio = container.querySelector("audio.tsukyio-audio-engine") as HTMLAudioElement;
      expect(audio).toBeInTheDocument();
      expect(container.querySelector("video")).toBeNull();

      const shell = container.querySelector(".tsukyio-audio-player");
      expect(shell).toHaveAttribute("aria-hidden", "true"); // inert until ready

      makeReady(audio, 30);

      expect(shell).toHaveAttribute("aria-hidden", "false");
      expect(screen.getByRole("button", { name: "Play" })).toBeEnabled();
      expect(getSeekSlider()).toHaveAttribute("aria-valuemax", "30");
      expect(getVolumeSlider()).toBeEnabled();

      // The hidden <audio> engine is what the controls drive.
      fireEvent.click(screen.getByRole("button", { name: "Play" }));
      expect(playMock).toHaveBeenCalledTimes(1);
      expect(audio.paused).toBe(false);
    });

    it("renders the no-stream notice when streamSrc is null", () => {
      render(<TsukyioPlayer item={videoItem} streamSrc={null} />);
      expect(screen.getByText("No stream available for this clip.")).toBeInTheDocument();
    });
  });
});
