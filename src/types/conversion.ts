export type ConversionProgress = {
  stage: string;
  percent?: number | null;
  message: string;
  fps?: string | null;
  speed?: string | null;
};

export type ConversionDone = {
  type: "done";
  input: string;
  output: string;
  archivedOriginal?: string | null;
  preset: string;
};

export type VideoTranscodePreset = "gpu-intra" | "prores-lt" | "prores-hq";

export type VideoControlSpec = {
  label: string;
  valueLabel: string;
  help: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  suffix: string;
};

export type VideoGpuStatus = {
  compatible: boolean;
  gpuName?: string | null;
  hasNvidiaGpu: boolean;
  hasFfmpeg: boolean;
  hasFfprobe: boolean;
  hasH264Cuvid: boolean;
  hasHevcCuvid: boolean;
  hasHevcNvenc: boolean;
  hasH264Nvenc: boolean;
  hasAv1Nvenc: boolean;
  message: string;
};
