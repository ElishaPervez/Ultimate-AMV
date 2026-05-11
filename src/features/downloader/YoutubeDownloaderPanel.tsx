import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { Download, History, Scissors, Youtube } from "lucide-react";
import { BEST_FORMAT_ENTRY, BEST_FORMAT_ID } from "../../lib/constants";
import { formatBytes } from "../../lib/format";
import { formatHms } from "../../lib/time";
import { normalizeUrl } from "../../lib/url";
import type {
  ClipRange,
  DownloadFormat,
  DownloadFormatInspection,
  DownloadHistoryItem,
  DownloadQueueItem,
} from "../../types/download";
import { YoutubeTrimEditor } from "./YoutubeTrimEditor";

function extractYoutubeVideoId(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    const host = parsed.hostname.replace(/^www\./, "");
    if (host === "youtu.be") {
      const id = parsed.pathname.split("/").filter(Boolean)[0];
      return id || null;
    }
    if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) {
      const v = parsed.searchParams.get("v");
      if (v) return v;
      const segments = parsed.pathname.split("/").filter(Boolean);
      if (segments[0] === "embed" || segments[0] === "shorts" || segments[0] === "live") {
        return segments[1] ?? null;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function inferDownloadTitleFromUrl(value: string): string {
  try {
    const url = new URL(normalizeUrl(value));
    const id = url.searchParams.get("v") || url.pathname.split("/").filter(Boolean).pop() || "YouTube video";
    return `YouTube ${id}`;
  } catch {
    return "YouTube video";
  }
}

function classifyDownloadFormat(format: DownloadFormat): "audio" | "video" | "combined" {
  if (format.audioOnly) return "audio";
  if (format.acodec && format.vcodec) return "combined";
  return "video";
}

function describeFormatKind(format: DownloadFormat): { text: string; tone: "best" | "combined" | "video" | "audio" } {
  if (format.id === BEST_FORMAT_ID) return { text: "Recommended - auto-merge", tone: "best" };
  switch (classifyDownloadFormat(format)) {
    case "audio":
      return { text: "Audio only", tone: "audio" };
    case "combined":
      return { text: "Video + Audio", tone: "combined" };
    case "video":
    default:
      return { text: "Video only - audio auto-merged", tone: "video" };
  }
}

function buildYoutubeFormatSpec(format: DownloadFormat): string {
  if (format.id === BEST_FORMAT_ID) return "bestvideo*+bestaudio/best";
  switch (classifyDownloadFormat(format)) {
    case "video":
      return `${format.id}+bestaudio/best`;
    case "audio":
    case "combined":
    default:
      return format.id;
  }
}

export function YoutubeDownloaderPanel({
  enqueueDownload,
  history,
  onRedownload,
}: {
  enqueueDownload: (item: Omit<DownloadQueueItem, "id" | "status" | "createdAt">) => string;
  history: DownloadHistoryItem[];
  onRedownload: (item: DownloadHistoryItem) => void;
}) {
  const [url, setUrl] = React.useState("");
  const [formats, setFormats] = React.useState<DownloadFormat[]>([]);
  const [selectedFormatId, setSelectedFormatId] = React.useState(BEST_FORMAT_ID);
  const [inspecting, setInspecting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState("Paste a YouTube URL, inspect formats, then queue the version you want.");
  const [videoId, setVideoId] = React.useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const [durationSeconds, setDurationSeconds] = React.useState<number | null>(null);
  const [isLive, setIsLive] = React.useState(false);
  const [trimEnabled, setTrimEnabled] = React.useState(false);
  const [clipStart, setClipStart] = React.useState(0);
  const [clipEnd, setClipEnd] = React.useState(0);
  const [forceKeyframes, setForceKeyframes] = React.useState(true);

  const displayFormats = React.useMemo<DownloadFormat[]>(() => [BEST_FORMAT_ENTRY, ...formats], [formats]);
  const selectedFormat = displayFormats.find((format) => format.id === selectedFormatId) ?? displayFormats[0] ?? null;
  const youtubeHistory = history.filter((item) => item.kind !== "anime").slice(0, 8);
  const trimAvailable = trimEnabled && !!videoId && !isLive && (durationSeconds ?? 0) > 0;
  const clipDuration = Math.max(0, clipEnd - clipStart);

  function resetTrimState() {
    setVideoId(null);
    setPreviewUrl(null);
    setDurationSeconds(null);
    setIsLive(false);
    setTrimEnabled(false);
    setClipStart(0);
    setClipEnd(0);
  }

  async function inspectFormats(event?: React.FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const targetUrl = url.trim();
    if (!targetUrl || inspecting) return;
    setInspecting(true);
    setError(null);
    setFormats([]);
    setSelectedFormatId(BEST_FORMAT_ID);
    resetTrimState();
    setMessage("Inspecting downloadable formats...");
    try {
      const payload = await invoke<DownloadFormatInspection>("inspect_download_formats", {
        url: targetUrl,
        referer: undefined,
      });
      setFormats(payload.formats);
      setSelectedFormatId(BEST_FORMAT_ID);
      const duration = payload.durationSeconds ?? null;
      setDurationSeconds(duration);
      setIsLive(payload.isLive);
      setVideoId(payload.videoId ?? extractYoutubeVideoId(targetUrl));
      setPreviewUrl(payload.previewUrl ?? null);
      if (duration && duration > 0) {
        setClipStart(0);
        setClipEnd(duration);
      }
      const formatLine = payload.formats.length > 0
        ? `${payload.formats.length} formats found.`
        : "Best (auto-merge) is ready.";
      const durationLine = duration ? ` Duration: ${formatHms(duration, false)}.` : "";
      const liveLine = payload.isLive ? " Live stream — clipping disabled." : "";
      setMessage(`${formatLine}${durationLine}${liveLine}`);
    } catch (formatError) {
      setError(String(formatError));
      setMessage("Format inspection failed.");
    } finally {
      setInspecting(false);
    }
  }

  function queueSelectedFormat() {
    const targetUrl = url.trim();
    if (!targetUrl || !selectedFormat) return;
    const formatSpec = buildYoutubeFormatSpec(selectedFormat);
    let clip: ClipRange | null = null;
    const coversWholeVideo = durationSeconds !== null
      && clipStart <= 0.5
      && clipEnd >= durationSeconds - 0.5;
    if (trimAvailable && clipDuration > 0.05 && !coversWholeVideo) {
      clip = {
        startSeconds: clipStart,
        endSeconds: clipEnd,
        forceKeyframes,
      };
    }
    enqueueDownload({
      kind: "youtube",
      title: inferDownloadTitleFromUrl(targetUrl),
      subtitle: clip
        ? `Clip ${formatHms(clip.startSeconds, false)} - ${formatHms(clip.endSeconds, false)}`
        : null,
      qualityLabel: selectedFormat.label,
      url: targetUrl,
      referer: null,
      sourcePage: targetUrl,
      formatId: formatSpec,
      folderName: "youtube downloads",
      clip,
      progress: null,
      outputPath: null,
      error: null,
    });
    setMessage(
      clip
        ? `Queued ${selectedFormat.label} (clip ${formatHms(clip.startSeconds, false)} - ${formatHms(clip.endSeconds, false)}).`
        : `${selectedFormat.label} added to the download queue.`,
    );
  }

  return (
    <section className="youtube-downloader">
      <form className="youtube-download-card" onSubmit={inspectFormats}>
        <div className="youtube-download-head">
          <span className="youtube-mark"><Youtube size={24} strokeWidth={2.1} /></span>
          <div>
            <strong>YouTube Download</strong>
            <small>{message}</small>
          </div>
        </div>
        <div className="youtube-url-row">
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://www.youtube.com/watch?v=..."
            aria-label="YouTube URL"
            spellCheck={false}
          />
          <button type="submit" disabled={!url.trim() || inspecting}>
            {inspecting ? "Inspecting" : "Inspect"}
          </button>
        </div>
        {error && <small className="stream-error">{error}</small>}
      </form>

      <div className="youtube-format-list" aria-label="Download formats">
        {displayFormats.map((format) => {
          const kind = describeFormatKind(format);
          return (
            <button
              key={format.id}
              type="button"
              className={`youtube-format-row is-${kind.tone}${selectedFormat?.id === format.id ? " is-selected" : ""}`}
              onClick={() => setSelectedFormatId(format.id)}
            >
              <span className="youtube-format-label">
                <strong>{format.label}</strong>
                <em className={`youtube-format-tag is-${kind.tone}`}>{kind.text}</em>
              </span>
              <small>
                {[
                  format.vcodec ? `v: ${format.vcodec}` : null,
                  format.acodec ? `a: ${format.acodec}` : null,
                  format.filesize ? formatBytes(format.filesize) : null,
                ].filter(Boolean).join(" - ") || "Auto-pick best video and audio streams"}
              </small>
            </button>
          );
        })}
      </div>

      {!isLive && (durationSeconds ?? 0) > 0 ? (
        <YoutubeTrimEditor
          previewUrl={previewUrl}
          durationSeconds={durationSeconds ?? 0}
          enabled={trimEnabled}
          onEnabledChange={setTrimEnabled}
          startSeconds={clipStart}
          endSeconds={clipEnd}
          onChange={(start, end) => {
            setClipStart(start);
            setClipEnd(end);
          }}
          forceKeyframes={forceKeyframes}
          onForceKeyframesChange={setForceKeyframes}
        />
      ) : isLive ? (
        <div className="youtube-trim-disabled">
          <Scissors size={14} strokeWidth={2.1} />
          <span>Live streams cannot be clipped — yt-dlp does not support sections on live URLs.</span>
        </div>
      ) : null}

      <div className="youtube-actions">
        <button type="button" disabled={!selectedFormat || !url.trim()} onClick={queueSelectedFormat}>
          <Download size={16} strokeWidth={2.2} />
          {trimAvailable && clipDuration > 0.05
            ? `Queue clip (${formatHms(clipDuration, false)})`
            : "Queue selected format"}
        </button>
      </div>

      <section className="download-history-panel">
        <div className="download-panel-head">
          <History size={17} strokeWidth={2.1} />
          <span>History</span>
        </div>
        {youtubeHistory.length === 0 ? (
          <small>No YouTube downloads yet.</small>
        ) : (
          youtubeHistory.map((item) => (
            <div key={item.id} className="download-history-row">
              <div>
                <strong>{item.title}</strong>
                <small>{item.qualityLabel ?? item.formatId ?? "Previous format"}</small>
              </div>
              <button type="button" onClick={() => onRedownload(item)}>
                Redownload
              </button>
            </div>
          ))
        )}
      </section>
    </section>
  );
}
