export type DownloaderTab = "anime" | "youtube";

export type MediaCandidate = {
  url: string;
  kind: string;
  /**
   * Referer URL the sniffer chose for this candidate based on the most
   * recently observed embed/player iframe origin. `undefined` means
   * "fall back to the current page URL" — see how `AnikaiBrowser`
   * passes `candidate.referer ?? currentPageUrl` to `inspect_stream`.
   */
  referer?: string;
};

export type MediaRequestDebug = {
  url: string;
  count: number;
  interesting: boolean;
};

export type ProviderNavigation = {
  url: string;
};

export type ProviderPageIdentity = {
  animeTitle?: string | null;
  episodeNumber?: string | null;
  episodeLabel?: string | null;
  sourcePage?: string | null;
};

export type DownloadProgress = {
  jobId?: string | null;
  stage: string;
  percent?: number | null;
  message: string;
  warning?: string | null;
};

export type DownloadIdentity = {
  animeTitle?: string | null;
  episodeNumber?: string | null;
  episodeLabel?: string | null;
  qualityLabel?: string | null;
  sourcePage: string;
};

export type StreamQuality = {
  id: string;
  label: string;
  url: string;
  width?: number | null;
  height?: number | null;
  bitrate?: number | null;
  codec?: string | null;
  /**
   * Referer that was used (and worked) for this quality during inspection.
   * Echoed back from the Rust `inspect_stream` command so the eventual
   * download can use the same referer header.
   */
  referer?: string;
};

export type CaptureState = "armed" | "inspecting" | "detected" | "downloading" | "consumed";

export type DownloadFormat = {
  id: string;
  label: string;
  ext?: string | null;
  resolution?: string | null;
  width?: number | null;
  height?: number | null;
  bitrate?: number | null;
  filesize?: number | null;
  vcodec?: string | null;
  acodec?: string | null;
  audioOnly: boolean;
};

export type DownloadFormatInspection = {
  durationSeconds?: number | null;
  isLive: boolean;
  videoId?: string | null;
  previewUrl?: string | null;
  formats: DownloadFormat[];
};

export type ClipRange = {
  startSeconds: number;
  endSeconds: number;
  forceKeyframes: boolean;
};

export type DownloadHistoryItem = {
  id: string;
  createdAt: string;
  kind: string;
  title: string;
  subtitle?: string | null;
  qualityLabel?: string | null;
  url: string;
  referer?: string | null;
  formatId?: string | null;
  outputPath: string;
  sourcePage?: string | null;
};

export type DownloadQueueItem = {
  id: string;
  kind: "anime" | "youtube";
  title: string;
  subtitle?: string | null;
  qualityLabel?: string | null;
  url: string;
  referer?: string | null;
  sourcePage?: string | null;
  formatId?: string | null;
  folderName?: string | null;
  customOutputDir?: string | null;
  clip?: ClipRange | null;
  status: "queued" | "downloading" | "done" | "error" | "cancelled";
  progress?: DownloadProgress | null;
  outputPath?: string | null;
  error?: string | null;
  warning?: string | null;
  createdAt: number;
};
