import type {
  ClipAudioSettings,
  ClipExportFormat,
  ClipExportRateMode,
  ClipPreviewItem,
} from "./clip";

export type ProjectSourceItem = {
  id: string;
  path: string;
  filename: string;
  duration: number;
  fps: number;
  width?: number;
  height?: number;
};

export type ProjectExportConfig = {
  format: ClipExportFormat;
  rateMode: ClipExportRateMode;
  audioSettings: ClipAudioSettings;
  targetBitrateKbps?: number;
  crf?: number;
  outputFolder?: string;
};

export type UMVProjectManifest = {
  schemaVersion: "1.0.0";
  appVersion?: string;
  createdAt: string;
  modifiedAt: string;
  name: string;
  sources: ProjectSourceItem[];
  clips: ClipPreviewItem[];
  mergeGroupMap?: Record<string, string[]>;
  selectedClipIds?: string[];
  exportConfig?: ProjectExportConfig;
  notes?: string;
};

export type UAMVProjectManifest = UMVProjectManifest;

export type MediaResolutionStatus = "resolved" | "missing";

export type ResolvedSourceMedia = {
  source: ProjectSourceItem;
  currentPath: string;
  status: MediaResolutionStatus;
};

export type ProjectLoadResult = {
  manifest: UAMVProjectManifest;
  projectFilePath: string;
  resolvedSources: ResolvedSourceMedia[];
  hasMissingMedia: boolean;
};
