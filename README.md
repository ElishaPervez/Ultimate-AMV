<p align="center">
  <img src="app-logo.webp" alt="Ultimate AMV" width="100%">
</p>

# Ultimate AMV

A Windows desktop app for building anime music video edits. It handles the full workflow in one place : browsing and downloading source footage, separating audio, extracting clips, and exporting the final cut.

<p align="center">
  <a href="https://discord.gg/kXqYrERSP">
    <img src="https://img.shields.io/badge/Join%20our%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white&labelColor=4752C4" alt="Join our Discord" height="50">
  </a>
</p>

---

## Features

**Get footage**

- **Built-in browser** with automatic episode and series detection on anime streaming sites
- **Download manager** : grab footage directly from streaming sites via a bundled yt-dlp integration
- **Tsukyio Vault** : browse, preview, and pull editing assets straight into your project

**Find your cuts**

- **Scene Splitter** : automatic scene detection with frame-accurate trimming and export via ffmpeg, GPU-accelerated decoding where available, and Quality / VBR / CBR rate control on every encode preset
- **Smart cut** : export clips without re-encoding, so cuts are near-instant and bit-for-bit identical to the source while still landing on the exact frame you chose ; MP4 sources stay MP4 for drag-and-drop import into Premiere, After Effects, and DaVinci
- **Dead Frame Remover** : detects and drops the duplicate frames anime is full of, with a sensitivity dial, a filmstrip preview of what's about to be cut, and optional re-timing of the survivors to a frame rate you pick

**Clean up the footage**

- **Frame Interpolation** : generate in-between frames to raise a clip's frame rate (2x/3x/4x or a target fps), or slow-motion mode up to 64x, with batch queueing and one-click hand-off from the clip grid
- **Background removal** : cut the subject out of footage using ML matting

**Prep for your editor**

- **Audio separation** : split any track into vocals and instrumentals using ML models, with CPU and NVIDIA GPU (CUDA) support
- **Video and audio conversion** : convert exports into the formats your editor wants

**Everywhere**

- **Self-contained setup** : a first-run wizard installs all ML dependencies (PyTorch, audio-separator, ONNX Runtime) into a bundled Python environment, no manual setup required
- **Custom themes** : preset colour schemes plus full hex colour customisation

---

## Requirements

- Windows 10 or later, 64-bit
- Around 4 GB of free disk space for the app and base dependencies
- GPU mode requires an NVIDIA GPU with CUDA 12.x drivers installed

---

## Installation

Download the latest installer from the [Releases](../../releases) page and run it. No admin rights required : it installs per-user by default.

On first launch, open **Settings** and run the setup wizard to install the audio and clip processing backends. The wizard handles everything automatically.

---

## Development

**Prerequisites:** Node.js 20+, Rust (stable), the [Tauri v2 prerequisites](https://tauri.app/start/prerequisites/)

**Clone and install:**

```bash
git clone https://github.com/ElishaPervez/Ultimate-AMV.git
cd Ultimate-AMV
npm install
```

**Bundled runtime dependencies** (required before running or building):

Place a [Windows embeddable Python 3.11](https://www.python.org/downloads/windows/) distribution in `python/`, then run:

```powershell
./bundle-deps.ps1
```

Also place `yt-dlp.exe`, `ffmpeg.exe`, and `ffprobe.exe` in `tools/`.

**Run in dev mode:**

```bash
npm run desktop
```

**Build installer:**

```bash
npm run tauri build
```

The NSIS installer will be output to `src-tauri/target/release/bundle/nsis/`.

---

## Release builds

Releases are built automatically by GitHub Actions when a version tag is pushed. The workflow downloads all runtime dependencies (Python, ffmpeg, yt-dlp), builds the Tauri app, and attaches the installer to the GitHub Release.

```bash
git tag v1.0.0
git push origin v1.0.0
```

---

## Stack

| Layer | Technology |
|---|---|
| Desktop shell | Tauri v2 (Rust) |
| Frontend | React 19, TypeScript, Vite |
| Audio ML | audio-separator, PyTorch, ONNX Runtime |
| Video processing | ffmpeg, ffprobe |
| Download | yt-dlp |
| Bundled runtime | Python 3.11 (embeddable) |

---

🤖 **App development was powered by AI** ✨
