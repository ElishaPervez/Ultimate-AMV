export type BgRemoveProgress = {
  type: string;
  stage: string;
  percent: number;
  message: string;
  elapsedSeconds?: number;
};

export type BgRemoveStatus = {
  type: string;
  hardware: {
    device: string;
    hasCuda: boolean;
  };
  dependencies: {
    rembg_installed: boolean;
    has_onnxruntime: boolean;
  };
  models: Record<
    string,
    {
      name: string;
      label: string;
      description: string;
      size_mb: number;
    }
  >;
};
