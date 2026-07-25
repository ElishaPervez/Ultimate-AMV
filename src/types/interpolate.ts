export type InterpolateModelKey = "rife4.25" | "rife4.6";
export type InterpolateFactor = 2 | 3 | 4;
export type InterpolateNamingMode = "suffix" | "source-name";
export type InterpolateQueueStatus = "queued" | "running" | "done" | "failed";

export type InterpolateStatus = {
  type: "status";
  hardware: {
    device?: string;
    hasCuda: boolean;
  };
  models: Record<
    InterpolateModelKey,
    {
      key: InterpolateModelKey;
      label: string;
      description: string;
      installed: boolean;
      path: string;
    }
  >;
};

export type InterpolateProgress = {
  type: string;
  stage?: string;
  percent?: number;
  message?: string;
  elapsedSeconds?: number;
  clipIndex?: number;
  clipCount?: number;
  clipName?: string;
  binary?: string;
  downloadedBytes?: number;
  totalBytes?: number;
};

export type InterpolateOutcome = {
  ok: boolean;
  input: string;
  output: string;
  error?: string;
  sourceFrames?: number;
  outputFrames?: number;
  sourceFps?: number;
  outputFps?: number;
  sceneHolds?: number;
};

export type InterpolateDone = {
  type: "done";
  outcomes: InterpolateOutcome[];
  succeeded: number;
  failed: number;
  sceneHolds: number;
  elapsedSeconds: number;
};

export type InterpolateQueueItem = {
  input: string;
  output: string;
  status: InterpolateQueueStatus;
  message?: string;
};
