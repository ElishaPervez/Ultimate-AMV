# Changelog

All notable changes to Ultimate AMV are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.1] — 2026-05-16

### Added
- monkey

[0.7.1]: https://github.com/ElishaPervez/Ultimate-AMV/releases/tag/v0.7.1

## [0.7.0] — 2026-05-16

### Added
- **Silent in-app auto-updater.** Settings now has an "App Updates" card
  at the top showing the current version and a "Check for updates"
  button that polls the GitHub release feed. When a newer version is
  found, the release notes are previewed inline and a single click
  downloads the new installer in the background — keep the app open and
  use it normally while it downloads. When ready, the button changes to
  "Restart to apply update": clicking it quits the app, runs the new
  installer silently (no wizard, no prompts), and relaunches the new
  version. The whole sequence takes 3–6 seconds of visible downtime
  with no user-installed packages disturbed (your GPU/CPU torch wheel,
  audio-separator, nelux, etc. all survive the additive overlay
  install). Releases are cryptographically signed with a minisign
  keypair; the updater verifies the signature before installing, so a
  tampered or substituted installer is rejected. The CI workflow is
  the only thing with the private key.
- **First-launch tools-download gate.** Replaces the old approach of
  bundling FFmpeg / ffprobe / yt-dlp / the shared FFmpeg DLLs nelux
  needs inside the installer. On first launch a "Setting up media
  tools" gate downloads them (about 200 MB total) into a per-user
  cache at `%LOCALAPPDATA%\com.elishapervez.ultimateamv\tools\` and
  verifies every binary against a pinned SHA256 from `tools.json`.
  This is a one-time cost — subsequent auto-updates only ship the app
  code and apply in seconds. The cache lives outside the install
  directory, so reinstalls and uninstalls don't disturb it.
- **`tools_status`, `tools_install`, `tools_cancel` Tauri commands**
  for the new gate. `tools-progress` events stream per-binary
  download + verify + install state with byte-level granularity.
- **`ULTIMATE_AMV_TOOLS_DIR` environment variable** is set on every
  Python sidecar spawn (audio bridge, clip bridge, clip server, and
  the nelux importability probe in `_nelux_importable()`).
  `clip_cli.py` and `audio_cli.py` consult it to locate
  ffmpeg/ffprobe/yt-dlp and to register the ffmpeg-shared DLL
  directory with `os.add_dll_directory` for nelux's C extension.
- **`prepare_for_update` Tauri command** runs before the updater's
  `install()` to kill Python sidecars synchronously (so they don't
  hold `_bz2.pyd` / `python.exe` open during the file replace) and
  to clear `KILL_ON_JOB_CLOSE` from the Windows Job Object (so the
  installer survives our exit instead of being killed alongside the
  main process).

### Changed
- **Installer is now ~30 MB instead of ~185 MB.** FFmpeg, ffprobe,
  yt-dlp, and the shared FFmpeg DLLs no longer ship inside the NSIS
  installer — see the tools-download gate above.
- **Tool versions are pinned in `tools.json` at the repo root.**
  Bumping a binary is a manifest change + matching SHA256 update.
  Current pins: yt-dlp 2026.03.17, FFmpeg static
  `autobuild-2026-05-15-13-34` (master, GPL), FFmpeg shared DLLs
  `autobuild-2026-05-15-13-34` (n8.1 branch — the avcodec-62 ABI
  nelux is built against).
- **CI no longer downloads FFmpeg / yt-dlp** during the release
  build. `.github/workflows/release.yml` drops three binary-fetch
  steps and ships `tools.json` as a Tauri resource, so the installer
  artifact is purely app code + Python runtime.
- **`core:app:default` capability granted** so the frontend can read
  the bundled app version at runtime.

[0.7.0]: https://github.com/ElishaPervez/Ultimate-AMV/releases/tag/v0.7.0

## [0.6.0] — 2026-05-16

### Added
- **Custom URL provider for anime downloads.** The provider dropdown in
  the Anime Download panel now has a third option, "Custom URL", that
  unlocks the address bar so you can point the built-in browser at any
  anime site — not just AniKai or AniWaves. Enter a URL and press Enter
  (or click Go) to load it. Host-restricted navigation is disabled in
  custom mode, so the page can navigate freely within whatever site
  you pointed it at. The stream sniffer still works the same — open an
  episode, hit play, and the captured stream lands in the queue.
- **Provider selection persists across sessions.** The selected
  provider (preset or custom URL) is saved to config and restored on
  next launch, so you don't have to reselect every time you open the
  app.

### Fixed
- **"Confirm episode" modal no longer hides behind the video player.**
  When the sniffer couldn't auto-detect the anime title or episode
  number (which is the default case on custom URLs and miruro-style
  sites), clicking Download would open a labeling modal that was
  completely invisible because the native child WebView rendered on
  top of the HTML overlay. The WebView now temporarily moves off-screen
  while the modal is open and snaps back in place when it closes.
- **Browser page no longer disappears after confirming the modal.** A
  follow-on regression where the WebView would stay parked off-screen
  after the modal dismissed — Tauri's child WebView needs a multi-attempt
  position/size sync plus a one-pixel resize nudge to reliably redraw
  after being moved. The lifecycle effect now fires that exact sequence
  on modal close, so the page restores the moment you confirm the
  episode.

## [0.5.0] — 2026-05-14

### Added
- **Unsupported-codec auto-convert for the GPU clip extractor.** Dropping a
  video that uses a codec the GPU path can't decode (most commonly
  ProRes / DNxHR / DNxHD inside `.mov`, or VP9 in unusual containers) now
  surfaces a friendly modal instead of silently freezing. One click on
  "Convert to compatible format" transcodes the source to H.264 mp4
  (CRF 20, AAC audio) into a per-app cache directory, then re-runs the
  extraction on the converted copy automatically. The original file is
  never touched. A small "Using converted copy of <name>" badge appears
  on the source card so the substitution is visible, and the cached copy
  is keyed by source path + size + mtime so re-extracting the same file
  is instant on subsequent runs.
- **"Stuck? Convert to compatible format" escape hatch** under the
  Cancel button during extraction, for the rare case a hang slips past
  the preflight check. Kills the running job and opens the convert
  modal pre-loaded with the active file.

### Fixed
- **GPU clip extraction no longer hangs forever on unsupported codecs.**
  The clip extractor's GPU path calls `nelux.VideoReader(...,
  decode_accelerator="nvdec")`, which only supports H.264 / HEVC / AV1
  in hardware. On anything else (ProRes, DNxHR, VP9, exotic MKV
  builds), nelux would hang inside native C++ code without ever raising
  a Python exception or emitting an error event — leaving the UI stuck
  at "Decoding at 8000+ FPS with Nelux Ultimate..." at 1% with no way
  to recover short of killing the app. The frontend now runs a
  ~50 ms ffprobe codec check before dispatching to the GPU path; if
  the codec isn't in the supported whitelist (sourced from
  `cuvid_decoder()` in `backend/clip_cli.py`), the convert modal opens
  immediately with the codec named in plain language. CPU mode skips
  this check entirely — PySceneDetect pipes through ffmpeg directly
  and handles every codec ffmpeg knows.
- **Cancel actually cancels GPU clip extractions now.** The previous
  `cancel_clip` only killed the one-shot child process; the persistent
  clip server (which runs nelux's native code) was a separate
  AsyncChild that the cancel never touched, so a hung server would
  stay hung and the next extraction would dispatch to the same wedged
  stdin. Cancel now stops both — the one-shot PID and the persistent
  `CLIP_SERVER` AsyncChild — and emits a synthetic `stopped` event so
  the warmup automatically respawns a fresh server for the next run.
  The Cancel button on the frontend also breaks out of the awaited
  `clip-server-event` listener via an abort ref, which previously
  waited indefinitely for a `done`/`error` event that never came after
  a cancel.

## [0.4.1] — 2026-05-14

### Fixed
- **Updates no longer fail with "Error opening file for writing" when
  the app is running.** Installing an update on top of a running copy
  used to leave orphaned Python sidecars (clip server, audio worker)
  holding `_bz2.pyd` / FFmpeg DLLs open, blocking the file copy. The
  main process now pins itself to a Windows Job Object with
  `KILL_ON_JOB_CLOSE` so sidecars die automatically the moment the
  main exe exits — for any reason, including the installer's hard
  terminate. A new NSIS pre-install hook also runs
  `taskkill /F /T` on the whole tree as a belt-and-suspenders pass.
  Result: closing the app first is no longer required to update.
- **"GPU Engine Needs Setup" modal no longer fires on every launch of
  a healthy install.** Three bugs combined to trip the repair gate
  even on working installs: the bundler was flattening
  `tools/ffmpeg-shared/` (where nelux's FFmpeg DLLs live) into
  `tools/`; the planner's nelux-importability probe spawned a fresh
  subprocess that did not re-add the FFmpeg directory to Windows' DLL
  search path; and the same probe did not `import torch` before
  `import nelux` (nelux 0.10+ raises `ImportError: PyTorch must be
  imported before Nelux.` otherwise). Reverted the bundler form to
  preserve directory structure, and the probe now mirrors the
  runtime's `os.add_dll_directory` + torch pre-import before the
  nelux import. The modal previously claimed "Missing DLLs
  (reinstall)" even though the DLLs were correct and Repair could
  never fix the underlying issue.
- **Clip extractor warmup no longer fails with the nelux FFmpeg DLL
  load error.** Same root cause as above — with the bundler fix in
  place, `tools/ffmpeg-shared/*.dll` end up at the path nelux expects.
- **Engine Repair never leaves the install worse than it found it on
  network failure.** Torch is now swapped via a single
  `pip install --upgrade --force-reinstall` which downloads the
  replacement wheel before removing the existing one. Previously a
  failed download mid-Repair would leave the user with no torch at
  all and Settings reporting packages as "missing".
- **Clip extractor no longer breaks audio extraction on first launch in
  CPU mode.** The clip server's warmup used to run its own dependency
  reinstall in the background; if it raced with another tool's pip
  call (or got killed mid-uninstall by a setup flow), the install
  ended up with mismatched torch/torchvision wheels and a cryptic
  `operator torchvision::nms does not exist` error from the next
  separation. The auto-repair on warmup is gone — dependencies are
  installed once during the setup wizard / Repair, and the clip
  server now trusts that they're correct.
- **Clip preview progress bar no longer drifts out of sync with the
  looping clip.** The bar's CSS animation duration is now sourced from
  the actual sum of per-frame delays encoded into the WebP (parsed
  from its ANMF chunks), rather than the requested clip duration.
  ffmpeg truncates per-frame delays to integer milliseconds (e.g.
  83 ms instead of 83.33 ms at fps=12), which caused the bar to drift
  ~5–10 ms per loop and visibly lap the WebP after a minute.
- **Clip preview bar and WebP no longer desync after switching tabs and
  coming back.** Returning to the Clip Hunting tab re-mounts every
  visible tile so both the progress bar and the WebP restart from frame
  0 in lockstep. The bar (a fresh DOM element) already restarted
  cleanly, but Chromium was serving the WebP from its decoded image
  cache and the animation continued mid-cycle — bar at 0%, WebP at
  frame ~50. The img src now cache-busts on each activation so the
  browser re-decodes from scratch.

### Changed
- **PyTorch CPU/GPU mode is detected from the wheel's local tag
  (`+cu128` / `+cpu`) rather than a subprocess `torch.cuda.is_available()`
  probe at startup.** The probe was flaky on cold boots — driver not
  fully resident yet, first-import past the 10s timeout — and would
  silently demote a working `+cu` install to "cpu", which itself
  tripped the repair gate. `nvidia-smi` still gates whether GPU setup
  is offered, so a `+cu` wheel on a CPU-only host is caught by the
  right signal.

## [0.4.0] — 2026-05-11

### Added
- **Drag-and-drop files anywhere they're accepted.** Drop video or
  audio onto Vocal Extraction, Any To Audio, Clip Hunting, or Video To
  Video and they'll load just like the picker. Drop an image onto the
  background cropper in Settings to set or replace it. Hovering with
  files shows a clear drop target so you know it'll catch.
- **Custom save folder per AniKai download.** When the sniffer catches
  a stream we couldn't auto-name, a labeling prompt asks for the anime
  title and episode number — with autocomplete over folders you've
  already used — and lets you optionally save into any folder on disk
  instead of the default `<downloads>/<anime>` layout.

### Changed
- **Frontend refactored from a 6,616-line `main.tsx` to a 30-line
  entry mount.** Every panel, card, helper, and type now lives in a
  feature folder (`src/shell/`, `src/features/{audio,clips,downloader,
  logs,settings,video}/`, `src/lib/`, `src/types/`). One component per
  file, no barrel files, shared helpers consolidated into `src/lib/`.
  Behavior is identical — this is purely a maintainability upgrade
  that makes future features cheaper to add and easier to review.
- **Background cropper can be opened by clicking it.** The empty frame
  is now a click-or-Enter target in addition to the "Pick an image"
  button — matches the new drop behavior.

### Removed
- **Dead `AnimeBrowser` panel** and the 5 unused helpers + 2 unused
  types + 6 stale lucide imports that came with it. Nothing was
  rendering it; confirmed dead before deleting.

## [0.3.0] — 2026-05-10

### Added
- **Setup wizard now picks a download folder.** A new "Folder" step sits
  between Engine and Install (Hardware → Engine → **Folder** → Install →
  Done). The choice is persisted via `set_config(download_path)` so future
  downloads land where you told them to instead of the default
  `Videos\Ultimate AMV\anime downloads`. You can change it later from
  Settings.
- **Animated logo banner** at the top of the README (10 fps, palette-
  optimized GIF).

### Removed
- **"Use player" buttons in the YouTube trim editor.** The timecode inputs
  plus seek buttons already cover the same flow, so the extra buttons were
  just noise.

## [0.2.0] — 2026-05-09

### Added
- **Custom background image** with a built-in cropper — drag to position,
  scroll to zoom, dim and blur sliders. The image bleeds through every
  workspace area without hurting text legibility.
- **Custom theme colors.** Two-color accent gradient with five presets
  (cyan, mint, violet, rose, amber) plus full hex pickers for both stops.
- **YouTube trim editor.** Pick a start/end range before downloading
  instead of grabbing the full video; format inspection and source preview
  included.
- **Discord community button** in the README.

### Fixed
- **Engine setup integrity.** `setup_type` is now only persisted after
  `audio_setup` actually succeeds, so a crash mid-install no longer leaves
  config claiming GPU while CPU PyTorch is on disk.
- **Engine status reflects reality.** Settings derives the Active mode and
  READY badge from the installed PyTorch build (`+cu` / `+cpu`) rather
  than config alone, surfacing any mismatch with a one-click Switch to
  reconcile.

## [0.1.0] — 2026-05-09

### Added
- Initial release.
- Built-in browser with automatic episode and series detection on anime
  streaming sites.
- Audio separation (vocals / instrumentals) using ML models, with CPU and
  NVIDIA GPU (CUDA) support.
- Frame-accurate clip extraction and export via ffmpeg, with GPU-
  accelerated decoding where available.
- Download manager backed by a bundled yt-dlp.
- Self-contained first-run setup wizard that installs PyTorch, audio-
  separator, and ONNX Runtime into a bundled Python environment.

[0.6.2]: https://github.com/ElishaPervez/Ultimate-AMV/releases/tag/v0.6.2
[0.6.1]: https://github.com/ElishaPervez/Ultimate-AMV/releases/tag/v0.6.1
[0.6.0]: https://github.com/ElishaPervez/Ultimate-AMV/releases/tag/v0.6.0
[0.5.0]: https://github.com/ElishaPervez/Ultimate-AMV/releases/tag/v0.5.0
[0.4.1]: https://github.com/ElishaPervez/Ultimate-AMV/releases/tag/v0.4.1
[0.4.0]: https://github.com/ElishaPervez/Ultimate-AMV/releases/tag/v0.4.0
[0.3.0]: https://github.com/ElishaPervez/Ultimate-AMV/releases/tag/v0.3.0
[0.2.0]: https://github.com/ElishaPervez/Ultimate-AMV/releases/tag/v0.2.0
[0.1.0]: https://github.com/ElishaPervez/Ultimate-AMV/releases/tag/v0.1.0
