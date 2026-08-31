import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { logFrontend, safeLogValue } from "../../lib/log";
import { parseBridgePayload } from "../../utils/bridge";
import type { AppConfig } from "../../types/app";
import type { VideoGpuStatus } from "../../types/conversion";
import type { DownloadHistoryItem } from "../../types/download";

type ToolsStatus = {
  ok: boolean;
  toolsDir: string;
  binaries: Array<{ name: string; present: boolean; valid: boolean; missingFiles: string[] }>;
};

/** How a readiness line reads at a glance: green / amber / red dot. */
export type ReadinessTone = "ok" | "warn" | "bad";

export type ReadinessLine = {
  key: string;
  tone: ReadinessTone;
  /** Short headline, e.g. "Running on your graphics card". */
  label: string;
  /** One sentence saying what that means for the user's exports. */
  detail: string;
};

export type HomeStatus = {
  loading: boolean;
  lines: ReadinessLine[];
  /** True when at least one line is warn/bad, which surfaces the fix button. */
  needsAttention: boolean;
  downloads: DownloadHistoryItem[];
  downloadsLoaded: boolean;
  refresh: () => void;
};

/* Everything here is read-only and cheap: two file-system checks and one
 * ffmpeg capability probe, all of which other panels already run on mount.
 * Nothing here starts a job or touches the user's files. */
export function useHomeStatus(active: boolean): HomeStatus {
  const [loading, setLoading] = React.useState(true);
  const [lines, setLines] = React.useState<ReadinessLine[]>([]);
  const [downloads, setDownloads] = React.useState<DownloadHistoryItem[]>([]);
  const [downloadsLoaded, setDownloadsLoaded] = React.useState(false);
  const [nonce, setNonce] = React.useState(0);

  const refresh = React.useCallback(() => setNonce((n) => n + 1), []);

  React.useEffect(() => {
    if (!active) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      const [config, gpu, tools] = await Promise.all([
        invoke<string>("get_config")
          .then((raw) => parseBridgePayload<AppConfig>(raw))
          .catch((error) => {
            logFrontend("warn", "frontend.home.config.error", "Could not read app config for Home", {
              error: safeLogValue(error),
            });
            return null;
          }),
        invoke<string>("video_gpu_status")
          .then((raw) => parseBridgePayload<VideoGpuStatus>(raw))
          .catch((error) => {
            logFrontend("warn", "frontend.home.gpu.error", "Could not read GPU status for Home", {
              error: safeLogValue(error),
            });
            return null;
          }),
        invoke<ToolsStatus>("tools_status").catch((error) => {
          logFrontend("warn", "frontend.home.tools.error", "Could not read tool status for Home", {
            error: safeLogValue(error),
          });
          return null;
        }),
      ]);
      if (cancelled) return;
      setLines(buildReadinessLines(config, gpu, tools));
      setLoading(false);
    }

    async function loadDownloads() {
      try {
        const payload = await invoke<DownloadHistoryItem[]>("download_history");
        if (!cancelled) setDownloads(payload.slice(0, 4));
      } catch (error) {
        logFrontend("warn", "frontend.home.downloads.error", "Could not read download history for Home", {
          error: safeLogValue(error),
        });
      } finally {
        if (!cancelled) setDownloadsLoaded(true);
      }
    }

    void load();
    void loadDownloads();
    return () => {
      cancelled = true;
    };
  }, [active, nonce]);

  return {
    loading,
    lines,
    needsAttention: lines.some((line) => line.tone !== "ok"),
    downloads,
    downloadsLoaded,
    refresh,
  };
}

function buildReadinessLines(
  config: AppConfig | null,
  gpu: VideoGpuStatus | null,
  tools: ToolsStatus | null,
): ReadinessLine[] {
  const lines: ReadinessLine[] = [];

  /* Line 1 — what will actually do the work. The config setting alone is not
   * the answer: the app can be set to GPU on a machine where no usable GPU
   * was found, and then every job quietly runs on the processor instead. */
  const wantsGpu = config ? config.clip_extraction_mode !== "cpu" && !config.force_cpu : true;
  const gpuUsable = gpu?.compatible === true;
  if (config === null) {
    lines.push({
      key: "hardware",
      tone: "warn",
      label: "Hardware setting unknown",
      detail: "The app could not read its own settings file. Open Settings to check it.",
    });
  } else if (wantsGpu && gpuUsable) {
    lines.push({
      key: "hardware",
      tone: "ok",
      label: "Running on your graphics card",
      detail: gpu?.gpuName ? `${gpu.gpuName} is doing the heavy work.` : "Scene detection and exports use the GPU.",
    });
  } else if (wantsGpu && !gpuUsable) {
    lines.push({
      key: "hardware",
      tone: "warn",
      label: "Set to graphics card, but none was found",
      detail: "Jobs will fall back to your processor and take noticeably longer.",
    });
  } else {
    lines.push({
      key: "hardware",
      tone: "warn",
      label: "Running on your processor",
      detail: gpuUsable
        ? "A usable graphics card was found — switching to it in Settings would be faster."
        : "Slower than a graphics card, but it works on any machine.",
    });
  }

  /* Line 2 — whether exports get hardware encoding. Separate from line 1
   * because a card can decode fine and still lack the encoder. */
  const hasNvenc = gpu?.hasH264Nvenc === true || gpu?.hasHevcNvenc === true;
  lines.push(
    hasNvenc
      ? {
        key: "encoding",
        tone: "ok",
        label: "Fast export encoding available",
        detail: "Re-encoded exports finish in a fraction of the time.",
      }
      : {
        key: "encoding",
        tone: "warn",
        label: "Exports encode on the processor",
        detail: "They still finish correctly, they just take longer.",
      },
  );

  /* Line 3 — the pieces that make everything else possible. Missing ones
   * cause failures that look like broken files rather than a missing tool. */
  if (tools === null) {
    lines.push({
      key: "tools",
      tone: "warn",
      label: "Tool check did not answer",
      detail: "Restart the app if scene detection or exports start failing.",
    });
  } else if (tools.ok) {
    lines.push({
      key: "tools",
      tone: "ok",
      label: "All required tools installed",
      detail: "Nothing is missing — every tool can run.",
    });
  } else {
    const missing = tools.binaries.filter((binary) => !binary.present);
    lines.push({
      key: "tools",
      tone: "bad",
      label: missing.length === 1 ? "1 required tool is missing" : `${missing.length} required tools are missing`,
      detail: `Scene detection and exports will fail until ${missing.map((b) => b.name).join(", ")} installs.`,
    });
  }

  return lines;
}
