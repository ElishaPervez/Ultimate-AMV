# Benchmark kit: Scene Splitter detection and grid previews

Measures the two things the 2026-10-30 optimization run targets: how long
first-time scene detection takes (CPU mode and GPU mode, one episode and a
batch), and what the scene grid's previews cost (building them, showing a new
tile, and frame times while scrolling). Results are appended as JSON lines to
`C:\projects (code)\13. Ultimate AMV script\docs\optimize-2026-10-30\bench-results.jsonl`.

It runs the worktree's own `backend\clip_cli.py` the same way the Rust shell
does (one-shot process per episode for CPU mode, the persistent `--server`
process for GPU mode, with the same JSON payload), and copies the exact ffmpeg
argument lists for previews from `src-tauri\src\clips.rs` and `preview.rs`. If
those Rust argument lists change, update `proxy_args` / `webp_args` in
`bench.py` to match.

## One-time setup (scratch, outside the repo)

Everything heavy lives in `C:\tmp\amv-optimize-bench` (override with
`AMV_BENCH_ROOT`). Nothing touches the installed app or its settings.

1. `runtime\python\` : embeddable Python 3.13.2 (same build the release
   workflow bundles), `python313._pth` with `import site` enabled, and the
   app's pinned clip stack installed with uv:
   `uv pip install --python <python.exe> --index-url https://download.pytorch.org/whl/cu128 torch==2.11.0 torchvision==0.26.0 torchaudio==2.11.0`
   then `numpy==2.4.4 "scenedetect>=0.6.7,<0.8" opencv-python transnetv2-pytorch nelux==0.11.0 typing_extensions`
   (with a constraints file pinning torch and numpy).
2. `runtime\tools\` : `ffmpeg.exe`, `ffprobe.exe` from
   `ffmpeg-8.1.1-full_build.zip` and `ffmpeg-shared\*.dll` from
   `ffmpeg-8.1.1-full_build-shared.zip` (both from `tools.json`, sha256
   checked). `ULTIMATE_AMV_TOOLS_DIR` is honoured first if set.
3. `runtime\benchlib\` : Playwright for the grid scroll test only
   (`uv pip install --target runtime\benchlib playwright`). It drives the
   installed Microsoft Edge, so no browser download.
4. Test media: `python -X utf8 scripts\bench\make_media.py` builds three
   23.7-minute synthetic episodes in `media\` (see its docstring: there were
   no complete real episodes on the benchmark PC, so they are made from real
   anime clips cut into 4 s shuffled pieces). Never commit media.

## Running

Use the scratch Python for everything (`P=C:\tmp\amv-optimize-bench\runtime\python\python.exe`):

    %P% -X utf8 scripts\bench\bench.py --tag baseline --mode quick
    %P% -X utf8 scripts\bench\bench.py --tag my-change --mode full
    %P% -X utf8 scripts\bench\bench.py --tag ab-on --only detect --repeats 3
    %P% -X utf8 scripts\bench\grid_bench.py --tag baseline --repeats 3
    %P% -X utf8 scripts\bench\diff_boundaries.py <boundaries run dir A> <run dir B>

- `--mode quick` (about 6-8 min): one-shot detection on the 1080p H.264
  episode in GPU and CPU mode, GPU one-shot on the 10-bit HEVC episode, a
  3-episode GPU server batch, the decode floor, and previews for one episode.
- `--mode full` (about 30-40 min): all three episodes, 3 repeats, a 12-episode
  GPU server batch and a 3-episode CPU batch (CPU batches are strictly
  sequential one-shot runs, so 12 episodes = 12 x one episode plus process
  start-up each time; measure 3 and confirm it is linear).
- `--only detect|batch|decode|preview` (repeatable) runs single sections, for
  same-minute A/B runs: switch the change on and off between calls and use
  different `--tag`s.
- The kit refuses to time while `C:\Users\PC\amv-optimize-machine-busy.txt`
  exists (`--allow-busy` overrides) and logs any other ffmpeg/python/cargo
  process running at the start in the `meta.other_heavy_processes_at_start`
  line. Every timed subprocess has a timeout (20 min detection, 10 min preview).

## What the metrics mean

Each JSON line: `ts, tag, run, commit (with -dirty if the tree has edits),
mode, metric, media, unit, n, median, p10, p90, min, max, values, extra`.

Detection (`detect.*`), split from the arrival times of clip_cli's progress
events:
- `oneshot.wall` : process start to exit, what a CPU-mode user waits per episode.
- `startup` : process start to first event (Python start, imports, dependency
  check, ffprobe; in GPU one-shot also torch import and TransNetV2 load).
- `pre_decode` : first event to first decode event (GPU: model load lands here).
- `decode` : decode events (full-res decode + resize to 48x27 frames).
- `analyze` : TransNetV2 inference (GPU) or PySceneDetect (CPU).
- `finish` : building the scene list and emitting the result.
- `gpu.server.warmup` : starting the GPU server (the app does this when the
  Scene Splitter opens, so users usually do not wait for it).
- `gpu.batchN.per_episode` / `total_after_warm` : the app's real GPU batch
  path, episodes sent one after another to the warm server.
- `decode_floor.*` : ffmpeg alone producing the 48x27 frames and discarding
  them (CPU software decode, and NVDEC + GPU resize). The lower bound for the
  decode stage with today's decode approach.

Boundaries: every detection run writes `cuts` to
`docs\optimize-2026-10-30\boundaries\<tag>\<run>\<media>.<mode>.<label>.json`.
`diff_boundaries.py` exits 1 and lists moved cuts if anything differs.

Previews (`preview.*`):
- `proxy_build.nvenc|x264` : the whole-episode 240p proxy the default grid
  needs before a 1080p episode's tiles can play (GPU machines use NVENC, CPU
  machines libx264). This is the "previews appear" wait for a new episode.
- `first_frame_seek.proxy240|source` : ffmpeg seek + decode of one frame, a
  floor for how quickly a newly mounted tile can show a picture.
- `webp_tile`, `webp_screenful12`, `webp_tile_size` : the legacy animated-WebP
  grid (used when "featherweight previews" is switched off).

Grid scroll (`grid.*`, from grid_bench.py in real Edge):
- `wheel.*` : a wheel notch (100 px) every 120 ms through the grid.
- `fling.*` : a steady 3000 px/s scroll (new mounts held back, like the app).
- `frame_p90/p99/max`, `frames_over_50ms` : animation-frame intervals while
  scrolling; the run target is no frame over 50 ms.
- `tile_first_frame` / `initial_screen_first_frame` : mount to first painted
  video frame per tile.

## Limits (read before trusting a number)

- The grid harness is a stand-in for the React grid (no React renders, app
  CSS, Tauri asset protocol or DEV tooling). It measures the browser and video
  side; React/state churn in `ClipExtractorPanel.tsx` is NOT covered. To
  measure the real grid, run the app from this worktree (`npm run tauri dev`)
  with WebView2 remote debugging
  (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`),
  attach Playwright with `chromium.connect_over_cdp`, load episodes, scroll
  `.clip-grid`'s scroller with the same wheel/fling scripts and record a
  performance trace (`tracing.start(screenshots=False)`) plus rAF intervals.
- Synthetic media: NVENC-encoded, made from 89 s of real anime footage looped
  with a hue drift. Decode cost per frame is close to real x264/x265 rips but
  scene statistics repeat every 89 s.
- Media sits on the NVMe drive. Users often keep episodes on hard disks; a
  one-time read of a 1 GB episode from a ~150 MB/s HDD adds ~7 s that this
  kit does not include.
