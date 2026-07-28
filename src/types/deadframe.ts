import type {
  InterpolateOutputFormat,
  InterpolateProgress,
  InterpolateRateMode,
} from "./interpolate";

// The export settings are the ones the user already met on the Frame
// Interpolation panel, so the unions are aliased rather than duplicated: a
// fourth rate mode or a fifth container has to be added in one place only.
export type DeadFrameOutputFormat = InterpolateOutputFormat;
export type DeadFrameRateMode = InterpolateRateMode;
export type DeadFrameProgress = InterpolateProgress;

// "measuring" is the pass that scores every frame as the clip joins the queue;
// "ready" means the scores are cached and the live count is trustworthy.
export type DeadFrameQueueStatus =
  | "queued"
  | "measuring"
  | "ready"
  | "running"
  | "done"
  | "failed";

export type DeadFrameAnalysis = {
  type: "analysis";
  input: string;
  frameCount: number;
  fps: number;
  width: number;
  height: number;
  duration: number;
  scores: number[];
};

export type DeadFramePreviewDone = {
  type: "done";
  output: string;
  sourceFrames: number;
  keptFrames: number;
  elapsedSeconds: number;
};

export type DeadFrameOutcome = {
  ok: boolean;
  input: string;
  output: string;
  error?: string;
  sourceFrames?: number;
  keptFrames?: number;
  removedFrames?: number;
  fps?: number;
  width?: number;
  height?: number;
  sourceDuration?: number;
  outputDuration?: number;
  hasAudio?: boolean;
};

export type DeadFrameDone = {
  type: "done";
  outcomes: DeadFrameOutcome[];
  succeeded: number;
  failed: number;
  removedFrames: number;
  elapsedSeconds: number;
};

// The score array is one number per frame, so it stays in state and the live
// kept-frame count is recomputed from it on every dial move. Re-measuring on a
// slider drag would decode the clip again for no new information.
export type DeadFrameQueueItem = {
  input: string;
  status: DeadFrameQueueStatus;
  message?: string;
  output?: string;
  frameCount?: number;
  fps?: number;
  scores?: number[];
};

// What the last successful preview attests to. The export gate compares this
// against the live dial and the selected clip; anything else the user changes
// leaves it standing, because the preview never depended on it.
export type DeadFramePreview = {
  input: string;
  sensitivity: number;
  output: string;
  sourceFrames: number;
  keptFrames: number;
};
