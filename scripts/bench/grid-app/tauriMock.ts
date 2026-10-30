/* Bench-only stand-in for the Tauri backend, so the REAL Scene Splitter panel
 * (ClipExtractorPanel and its grid) runs in plain Edge without the Rust shell.
 * Only the calls the grid needs return data; everything else resolves to null.
 *
 * URL parameters (all optional):
 *   eps=N        number of episodes in the batch (default 1). Every episode
 *                reuses the same real scene list and the same real 240p
 *                preview file, under a different source path and URL.
 *   proxyMs=N    delay before build_source_proxy answers (default 50 ms; the
 *                preview file already exists, like a cache hit).
 * The scene list and preview file are served by serve.mjs at /media/. */

type Handler = (args: Record<string, unknown> | undefined) => unknown;

const params = new URLSearchParams(window.location.search);
const episodeCount = Math.max(1, Number(params.get("eps") ?? "1"));
const proxyDelayMs = Math.max(0, Number(params.get("proxyMs") ?? "50"));

const episodePaths = Array.from(
  { length: episodeCount },
  (_, i) => `C:\\bench\\episodes\\Episode ${String(i + 1).padStart(2, "0")}.mkv`,
);

let scenesPromise: Promise<{ cuts: number[]; fps: number; duration: number }> | null = null;
function loadScenes() {
  scenesPromise ??= fetch("/media/scenes.json").then((r) => r.json());
  return scenesPromise;
}

async function extractionResult(inputPath: string) {
  const { cuts, fps, duration } = await loadScenes();
  const edges = [0, ...cuts.filter((c) => c > 0 && c < duration), duration];
  const scenes = [];
  for (let i = 0; i + 1 < edges.length; i += 1) {
    scenes.push({ source: inputPath, start: edges[i], end: edges[i + 1], index: i, label: `Scene ${i + 1}` });
  }
  return JSON.stringify({
    type: "done",
    mode: "cpu",
    input: inputPath,
    scenes,
    cuts: scenes.map((s) => s.start),
    sceneCount: scenes.length,
    fps,
    duration,
    totalSeconds: 1,
  });
}

const config = {
  type: "config",
  force_cpu: true,
  setup_type: "cpu",
  clip_extraction_mode: "cpu",
  clip_hover_preview: false,
  enable_project_sync: false,
  featherweight_previews: true,
  scene_preview_height: 240,
  clip_preview_speed: 1,
};

const handlers: Record<string, Handler> = {
  get_config: () => JSON.stringify(config),
  video_gpu_status: () =>
    JSON.stringify({ compatible: false, hasNvidiaGpu: false, hasFfmpeg: true, hasFfprobe: true }),
  "plugin:dialog|open": () => episodePaths,
  clip_extract: (args) => extractionResult(String(args?.inputPath ?? "")),
  clip_playback_plan: () => ({
    mode: "proxy",
    videoCodec: "h264",
    audioCodec: "aac",
    width: 1920,
    height: 1080,
    pixFmt: "yuv420p",
    container: "mp4",
    inScope: true,
    reasons: ["height above preview cap"],
  }),
  build_source_proxy: (args) =>
    new Promise((resolve) =>
      window.setTimeout(
        () => resolve(`C:\\bench\\proxies\\${encodeURIComponent(String(args?.sourcePath ?? ""))}.mp4`),
        proxyDelayMs,
      ),
    ),
  video_source_codec: () => JSON.stringify({ codec: "h264" }),
  "plugin:event|listen": () => Math.floor(Math.random() * 1e9),
  // Only needed by the rest of the desktop shell (?shell=1).
  download_history: () => [],
  list_anime_folders: () => [],
  tsukyio_get_auth_state: () => ({ isAuthenticated: false }),};

let nextCallbackId = 1;
const callbacks = new Map<number, unknown>();

const internals = {
  invoke(cmd: string, args?: Record<string, unknown>) {
    const handler = handlers[cmd];
    try {
      return Promise.resolve(handler ? handler(args) : null);
    } catch (error) {
      return Promise.reject(error);
    }
  },
  transformCallback(callback: unknown) {
    const id = nextCallbackId++;
    callbacks.set(id, callback);
    return id;
  },
  unregisterCallback(id: number) {
    callbacks.delete(id);
  },
  convertFileSrc(filePath: string) {
    // Every preview file maps to the one real 240p preview file; the query
    // keeps each episode a separate resource, as separate files are in the app.
    return `/media/proxy.mp4?p=${encodeURIComponent(filePath)}`;
  },
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
};

const w = window as unknown as Record<string, unknown>;
w.__TAURI_INTERNALS__ = internals;
w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
w.__AMV_GRID_BENCH__ = { episodeCount };
