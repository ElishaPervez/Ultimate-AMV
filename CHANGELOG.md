# Changelog

All notable changes to Ultimate AMV are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.4.0]: https://github.com/ElishaPervez/Ultimate-AMV/releases/tag/v0.4.0
[0.3.0]: https://github.com/ElishaPervez/Ultimate-AMV/releases/tag/v0.3.0
[0.2.0]: https://github.com/ElishaPervez/Ultimate-AMV/releases/tag/v0.2.0
[0.1.0]: https://github.com/ElishaPervez/Ultimate-AMV/releases/tag/v0.1.0
