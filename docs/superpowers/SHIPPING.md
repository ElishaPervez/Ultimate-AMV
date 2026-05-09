# Shipping the Windows Installer

## One-time prep (do this before every release build)

### 1. Stage Python embeddable

From the project root:

```powershell
Invoke-WebRequest https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip -OutFile python-embed.zip
Expand-Archive python-embed.zip -DestinationPath python
Remove-Item python-embed.zip
```

Open `python/python312._pth` and change:
```
#import site   →   import site
```

### 2. Verify ffmpeg has CUDA support

```powershell
.\tools\ffmpeg.exe -hide_banner -encoders | Select-String "nvenc"
```

Must show `hevc_nvenc` and `h264_nvenc`. If not, download the **full** build from gyan.dev/ffmpeg/builds and replace `tools/ffmpeg.exe` and `tools/ffprobe.exe`.

### 3. Build

```powershell
npm run tauri build
```

Output: `src-tauri/target/release/bundle/nsis/Ultimate AMV_0.1.0_x64-setup.exe`

---

## What gets bundled in the installer

| Path | Size | Source |
|------|------|--------|
| `ultimate-amv-script.exe` | ~15 MB | Tauri release build |
| `python/` | ~10 MB | Embeddable Python 3.12 |
| `tools/ffmpeg.exe` + `ffprobe.exe` | ~85 MB | gyan.dev full build |
| `tools/yt-dlp.exe` | ~10 MB | GitHub releases |
| `backend/*.py` + `backend/amv_audio/` | ~50 KB | This repo |

## What gets downloaded at first run (SetupWizard)

| Item | Size |
|------|------|
| PyTorch CPU | ~200 MB |
| PyTorch CUDA 12.8 | ~2.5 GB |
| audio-separator + deps | ~80 MB |
| AI models | ~225–425 MB |

---

## Icon generation (if needed)

If the build fails on missing PNG icon variants:

```powershell
npm run tauri icon path\to\your-logo.png
```

Source image should be 1024×1024 PNG.
