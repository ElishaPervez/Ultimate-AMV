import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { extractEpisodeNumber } from "../../lib/episode";
import { logFrontend, safeLogValue } from "../../lib/log";
import { parseBridgePayload } from "../../utils/bridge";
import type { AppConfig } from "../../types/app";
import type {
  DownloadHistoryItem,
  DownloadProgress,
  DownloadQueueItem,
  DownloaderTab,
} from "../../types/download";
import { AnikaiBrowser } from "./AnikaiBrowser";
import { DownloadQueuePanel } from "./DownloadQueuePanel";
import { YoutubeDownloaderPanel } from "./YoutubeDownloaderPanel";

export function DownloaderPanel({
  active,
  activeTab,
  sidebarExpanded,
}: {
  active: boolean;
  activeTab: DownloaderTab;
  sidebarExpanded: boolean;
}) {
  const [queue, setQueue] = React.useState<DownloadQueueItem[]>([]);
  const [history, setHistory] = React.useState<DownloadHistoryItem[]>([]);
  const activeJobIdRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    void refreshDownloadHistory();
  }, []);

  React.useEffect(() => {
    const unlisteners: Array<() => void> = [];
    void listen<DownloadProgress>("download-progress", (event) => {
      const jobId = event.payload.jobId ?? activeJobIdRef.current;
      if (!jobId) return;
      setQueue((current) => current.map((job) => (
        job.id === jobId
          ? {
            ...job,
            progress: event.payload,
            warning: event.payload.warning ?? job.warning ?? null,
          }
          : job
      )));
    }).then((unlisten) => unlisteners.push(unlisten));
    return () => unlisteners.forEach((unlisten) => unlisten());
  }, []);

  React.useEffect(() => {
    if (!activeJobIdRef.current) {
      const next = queue.find((job) => job.status === "queued");
      if (next) {
        void startQueuedDownload(next);
      }
    }
  }, [queue]);

  async function refreshDownloadHistory() {
    try {
      const payload = await invoke<DownloadHistoryItem[]>("download_history");
      setHistory(payload);
    } catch (error) {
      logFrontend("warn", "frontend.download.history.error", "Could not load download history", {
        error: safeLogValue(error),
      });
    }
  }

  function enqueueDownload(item: Omit<DownloadQueueItem, "id" | "status" | "createdAt">) {
    const id = `dl-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setQueue((current) => [
      ...current,
      {
        ...item,
        id,
        status: "queued",
        createdAt: Date.now(),
        progress: { jobId: id, stage: "queued", percent: null, message: "Waiting for current download..." },
      },
    ]);
    return id;
  }

  async function startQueuedDownload(job: DownloadQueueItem) {
    activeJobIdRef.current = job.id;
    setQueue((current) => current.map((item) => (
      item.id === job.id
        ? { ...item, status: "downloading", progress: { jobId: job.id, stage: "starting", percent: 0, message: "Starting download..." } }
        : item
    )));

    try {
      const configRaw = await invoke<string>("get_config");
      const config = parseBridgePayload<AppConfig>(configRaw);
      const savedPath = job.kind === "anime"
        ? await invoke<string>("download_stream", {
          jobId: job.id,
          url: job.url,
          referer: job.referer || job.sourcePage || "",
          animeTitle: job.title,
          episodeNumber: extractEpisodeNumber(job.subtitle ?? ""),
          episodeLabel: job.subtitle,
          qualityLabel: job.qualityLabel,
          sourcePage: job.sourcePage || job.referer || job.url,
          downloadDir: config.download_path || undefined,
          customOutputDir: job.customOutputDir || undefined,
        })
        : await invoke<string>("download_media", {
          jobId: job.id,
          url: job.url,
          referer: job.referer || undefined,
          formatId: job.formatId || undefined,
          title: job.title,
          subtitle: job.subtitle || undefined,
          qualityLabel: job.qualityLabel || undefined,
          sourcePage: job.sourcePage || job.url,
          downloadDir: config.download_path || undefined,
          kind: job.kind,
          folderName: job.folderName || undefined,
          clipStartSeconds: job.clip?.startSeconds ?? undefined,
          clipEndSeconds: job.clip?.endSeconds ?? undefined,
          forceKeyframesAtCuts: job.clip ? job.clip.forceKeyframes : undefined,
        });

      setQueue((current) => current.map((item) => (
        item.id === job.id
          ? {
            ...item,
            status: "done",
            outputPath: savedPath,
            progress: { jobId: job.id, stage: "done", percent: 100, message: savedPath },
          }
          : item
      )));
      if (job.kind === "anime" && config.clip_extraction_mode !== "cpu") {
        void invoke("warmup_clip_server").catch(() => {});
      }
      void refreshDownloadHistory();
    } catch (error) {
      const message = String(error);
      setQueue((current) => current.map((item) => (
        item.id === job.id
          ? {
            ...item,
            status: message.toLowerCase().includes("cancel") ? "cancelled" : "error",
            error: message,
            progress: { jobId: job.id, stage: "error", percent: null, message },
          }
          : item
      )));
    } finally {
      activeJobIdRef.current = null;
    }
  }

  function cancelQueuedDownload(job: DownloadQueueItem) {
    if (job.status === "downloading") {
      void invoke("cancel_download");
      setQueue((current) => current.map((item) => (
        item.id === job.id
          ? { ...item, progress: { jobId: job.id, stage: "cancelling", percent: item.progress?.percent ?? null, message: "Cancelling..." } }
          : item
      )));
      return;
    }
    setQueue((current) => current.map((item) => (
      item.id === job.id
        ? { ...item, status: "cancelled", progress: { jobId: job.id, stage: "cancelled", percent: null, message: "Removed from queue." } }
        : item
    )));
  }

  function redownload(item: DownloadHistoryItem) {
    enqueueDownload({
      kind: item.kind === "anime" ? "anime" : "youtube",
      title: item.title,
      subtitle: item.subtitle,
      qualityLabel: item.qualityLabel,
      url: item.url,
      referer: item.referer,
      sourcePage: item.sourcePage,
      formatId: item.formatId,
      folderName: item.kind === "anime" ? null : "youtube downloads",
      progress: null,
      outputPath: null,
      error: null,
    });
  }

  const visibleQueue = queue.filter((job) => job.status !== "cancelled" || job.progress?.stage === "cancelled");

  return (
    <section className="downloader-workspace">
      <div className={`downloader-panel ${activeTab === "anime" ? "is-active" : "is-hidden"}`}>
        <AnikaiBrowser active={active && activeTab === "anime"} sidebarExpanded={sidebarExpanded} enqueueDownload={enqueueDownload} />
      </div>
      <div className={`downloader-panel ${activeTab === "youtube" ? "is-active" : "is-hidden"}`}>
        <YoutubeDownloaderPanel enqueueDownload={enqueueDownload} history={history} onRedownload={redownload} />
      </div>
      <DownloadQueuePanel queue={visibleQueue} onCancel={cancelQueuedDownload} />
    </section>
  );
}
