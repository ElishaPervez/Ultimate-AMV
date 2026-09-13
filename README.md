<p align="center">
  <img src="app-logo.webp" alt="Ultimate AMV" width="100%">
</p>

# Ultimate AMV

Windows desktop app for the whole AMV pre-edit workflow: browse and download footage, find and export cuts, clean up the footage, separate audio, and hand off to your editor.

<p align="center">
  <a href="https://discord.gg/kXqYrERSP">
    <img src="https://img.shields.io/badge/Join%20our%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white&labelColor=4752C4" alt="Join our Discord" height="50">
  </a>
</p>

## Features

Screens are grouped by the four stages of an edit, plus the system screens.

| Stage | Screen | What it does |
| --- | --- | --- |
| Get footage | Downloader | Built-in browser with automatic episode and series detection on anime streaming sites and YouTube; live queue, per-download save folder, cancel support. |
| Get footage | Tsukyio Vault | Browse, preview, and pull editing assets into the project; account sign-in or a manual API key. |
| Find your cuts | Scene Splitter | Automatic scene detection, frame-accurate trimming, clip merging, and export via ffmpeg with GPU-accelerated decoding; Quality, VBR, and CBR rate control on every encode preset that supports it. |
| Find your cuts | Smart cut (export preset) | Exports without re-encoding, so cuts are near-instant and bit-for-bit identical to the source while still landing on the exact frame you chose; MP4 sources stay MP4 for drag-and-drop import into Premiere, After Effects, and DaVinci. |
| Find your cuts | Dead Frame Remover | Detects and drops the duplicate frames anime is full of; sensitivity dial, filmstrip preview of what is about to be cut, and optional re-timing of the survivors to a frame rate you pick. |
| Clean up the footage | BG Remover | Cuts the subject out of video or images with ML matting and a clean transparent edge. |
| Clean up the footage | Frame Interpolation | Generates in-between frames to raise a clip's frame rate (2x, 3x, 4x, or a target fps), or slow motion up to 64x; batch queueing and one-click hand-off from the clip grid. |
| Prep for your editor | Vocal Separation | Splits any track into vocals and instrumental with ML models; CPU and NVIDIA GPU (CUDA) support. |
| Prep for your editor | Video Conversion | Re-encodes exports into the formats your editor wants, such as ProRes. |
| Prep for your editor | Audio Conversion | Converts audio between formats, such as WAV and MP3. |
| System | Home | Four-stage overview: install and readiness status, whether fast export encoding is available, the last tool you used, and recent downloads you can reveal on disk. |
| System | Logs | Searchable, filterable event log with Info, Warn, and Error counts, a category filter, collapsible detail, and export to a .txt file. |
| System | Settings | Themes and custom colours, background image or live wallpaper, per-feature options, engine setup and repair, app updates, and Discord. |

Also: self-contained first-run setup (the wizard installs PyTorch, audio-separator, and ONNX Runtime into a bundled Python, with no manual setup), preset and full-hex colour schemes, silent signed auto-updates, and Discord Rich Presence.

## Requirements

- Windows 10 or later, 64-bit.
- Around 4 GB of free disk space for the app and base dependencies.
- GPU mode requires an NVIDIA GPU with CUDA 12.x drivers installed.

## Installation

1. Download the latest installer from the [Releases](../../releases) page and run it. No admin rights required: it installs per-user by default.
2. On first launch the app downloads its media tools (ffmpeg, ffprobe, yt-dlp, uv) into a per-user cache, then runs the setup wizard automatically to install the audio and clip processing backends. The wizard handles everything and can be re-run later from Settings.

## Development

Prerequisites: Node.js 20+, Rust (stable), and the [Tauri v2 prerequisites](https://tauri.app/start/prerequisites/).

```bash
git clone https://github.com/ElishaPervez/Ultimate-AMV.git && cd Ultimate-AMV && npm install
```

Runtime dependencies (required once per checkout): place a [Windows embeddable Python 3.13](https://www.python.org/downloads/windows/) distribution in `python/`, then run:

```powershell
./bundle-deps.ps1
```

| Task | Command |
| --- | --- |
| Run in dev mode | `npm run desktop` |
| Build installer | `npm run tauri build` |

The NSIS installer is written to `src-tauri/target/release/bundle/nsis/`.

## Release builds

Pushing a version tag builds and publishes through GitHub Actions. The workflow downloads the bundled Python runtime, builds the Tauri app, and attaches the installer to the GitHub Release; ffmpeg, ffprobe, yt-dlp, and uv are fetched on first launch instead of being bundled.

```bash
git tag v1.0.0
git push origin v1.0.0
```

## Stack

| Layer | Technology |
| --- | --- |
| Desktop shell | Tauri v2 (Rust) |
| Frontend | React 19, TypeScript, Vite |
| Audio ML | audio-separator, PyTorch, ONNX Runtime |
| Video processing | ffmpeg, ffprobe |
| Download | yt-dlp |
| Bundled runtime | Python 3.13 (embeddable) |
