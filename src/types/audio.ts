export type AudioTab = "extract";

export type AudioStatus = {
  type: "status";
  hardware: {
    device: string;
    device_short: string;
    gpu_type: string;
    fp16_capable: boolean;
    provider: string;
    vram?: string | null;
  };
  dependencies: {
    audio_separator: boolean;
    pydub: boolean;
    typing_extensions: boolean;
    torch: boolean;
    torch_version?: string | null;
    onnxruntime: boolean;
    onnxruntime_version?: string | null;
    runtime_ready: boolean;
    ready: boolean;
  };
  model_name: string;
};

export type AudioProgress = {
  type: "progress";
  stage: string;
  percent: number;
  message: string;
};

export type AudioSetupProgress = {
  type: "setup-progress";
  step: number;
  total: number;
  state: "running" | "done" | "error";
  message: string;
  phase?: "install" | "verify";
};

export type AudioSetupPlan = {
  type: "setup-plan";
  mode: "cpu" | "gpu";
  rows: Array<{
    component: string;
    status: string;
  }>;
  issues: string[];
  installs: string[][];
  success_mode: "cpu" | "gpu" | null;
  gpu_name?: string | null;
};

export type AudioSetupResult = {
  type: "setup-done";
  ok: true;
  mode: "cpu" | "gpu";
  plan: Omit<AudioSetupPlan, "type">;
  status: AudioStatus;
};

export type AudioOutputFormat = "wav" | "mp3";

export type BatchItemStatus = {
  input: string;
  output?: string;
  outputs?: string[];
  status: "done" | "error";
  message?: string;
};
