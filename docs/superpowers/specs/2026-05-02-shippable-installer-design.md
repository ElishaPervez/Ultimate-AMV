# Shippable Windows Installer — Design Spec

## Overview

Transform the current dev-only Tauri app into a properly packaged Windows
installer that bundles a self-contained Python runtime, ffmpeg/ffprobe/yt-dlp,
and the backend scripts. Heavy dependencies (pip packages, AI models) are
downloaded on first run via a guided setup wizard.

## Installer Layout

```
C:\Program Files\Ultimate AMV\
├── ultimate-amv-script.exe      # Tauri Rust binary (frontend baked in)
├── backend/
│   ├── audio_cli.py
│   ├── clip_cli.py
│   ├── amv_audio/
│   │   ├── __init__.py
│   │   ├── config.py
│   │   ├── hardware.py
│   │   ├── gpu.py
│   │   ├── models.py
│   │   ├── separator.py
│   │   ├── setup.py
│   │   └── logs.py
│   ├── requirements.txt
│   └── models/                  # Empty at install (populated by wizard)
├── python/                      # Embedded Python 3.12
│   └── python.exe + stdlib
└── tools/
    ├── ffmpeg.exe
    ├── ffprobe.exe
    └── yt-dlp.exe
```

### Bundled in installer (~60MB)
| Item | Size | Notes |
|------|------|-------|
| Rust binary + frontend assets | ~15MB | Normal Tauri release build |
| Python 3.12 embed (x64) | ~10MB | python-3.12.x-embed-amd64.zip extracted |
| ffmpeg.exe (full, CUVID+NVENC) | ~80MB | Shared build with ffprobe. This is the bulk. |
| ffprobe.exe | ~5MB | Part of ffmpeg build |
| yt-dlp.exe | ~10MB | Static binary |
| Backend Python scripts | ~50KB | All .py files under backend/ |

### Downloaded at first run (variable, ~3GB for GPU path)
| Item | Size | Why not bundled |
|------|------|----------------|
| PyTorch + CUDA 12.8 wheels | ~2.5GB | Version-specific, updates frequently |
| audio-separator + deps | ~50MB | Python packages |
| transnetv2-pytorch | ~5MB | Python package |
| scenedetect[opencv] | ~30MB | Python package |
| onnxruntime-gpu | ~100MB | Python package |
| Kim_Vocal_2.onnx | ~25MB | AI model file |
| BS-RoFormer checkpoint | ~200MB | AI model file (GPU only) |

## First-Run Setup Wizard

Full-screen wizard that blocks the app until setup completes.

### State tracking
`backend/config.json` gains `setup_complete: bool` (default false).

### Step 1 — Hardware Detection
- Runs `nvidia-smi --query-gpu=name --format=csv,noheader` via subprocess
- Attempts `import torch; torch.cuda.is_available()` via embedded Python
- Displays detected GPU name or "No NVIDIA GPU detected"
- Reports VRAM, driver version

### Step 2 — PyTorch Recommendation
- **GPU detected**: radio group with "GPU mode (CUDA 12.8)" pre-selected and "CPU mode" as alternative
- **No GPU**: "CPU mode" shown as only option (disabled GPU radio with explanation)
- User confirms selection

### Step 3 — Dependency Installation
Sequential sub-steps with real-time progress events:
1. Bootstrap pip into embedded Python (`get-pip.py` download + run)
2. Install PyTorch (cu128 or cpu index URL)
3. Install audio-separator + pydub
4. Install onnxruntime(-gpu)
5. Install transnetv2-pytorch + numpy
6. Install scenedetect[opencv]
7. Download AI models (Kim_Vocal_2, BS-RoFormer if GPU)

Each step emits `setup-progress` events with:
```json
{ "stage": "installing_pytorch", "message": "Downloading PyTorch (2.1 GB)...", "percent": 45 }
```

### Step 4 — Complete
- "Start Using Ultimate AMV" button
- Sets `setup_complete: true`
- App transitions to main workspace

### UI Implementation
- New file: `src/SetupWizard.tsx` (not crammed into main.tsx)
- Uses same design language (cyan/green/rose accents, dark theme)
- Step indicator at top, content area, back/next/install buttons at bottom

## Runtime Fixes

### `project_root()` → `app_root()`
Replace `std::env::current_dir()` with `std::env::current_exe()`:
```rust
fn app_root() -> Result<PathBuf, String> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .ok_or_else(|| "Cannot determine app location".to_string())
}
```
All downstream path constructions use `app_root()` as base.

### `python_exe()` — embedded first
```rust
fn python_exe(root: &Path) -> PathBuf {
    let embedded = root.join("python").join("python.exe");
    if embedded.exists() { return embedded; }
    PathBuf::from("python") // fallback for dev
}
```

### `find_tool()` — bundled first, then PATH
```rust
fn find_tool(root: &Path, name: &str) -> PathBuf {
    let bundled = root.join("tools").join(format!("{name}.exe"));
    if bundled.exists() { return bundled; }
    PathBuf::from(name)
}
```
Replaces all direct `Command::new("ffmpeg")` / `Command::new("yt-dlp")` calls.

### `ensure_tool()` — updated
Checks that the tool is executable regardless of how it was located.

### `ytdlp_command()` — bundled first
Checks `root/tools/yt-dlp.exe` before falling back to PATH search or `python -m yt_dlp`.

## Security Fixes

### CSP (tauri.conf.json)
```json
"csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' asset: https: data:; media-src 'self' asset: https:; connect-src 'self' asset: https://anikai.to https://api.jikan.moe"
```

### Asset protocol scope
The app needs to serve local video files for clip previews via `asset://` URLs.
The scope must cover the default download directory and common video locations:
```json
"assetProtocol": {
    "enable": true,
    "scope": ["$APPDATA/**", "$RESOURCE/**", "$HOME/**"]
}
```
The `$HOME/**` scope is broad but necessary because users can set the download
directory to any arbitrary path. This is still narrower than `["**"]` since it
restricts to the user's home directory.

### Per-WebView CSP
The main app window gets a strict CSP; the AniKai WebView gets a permissive one
since it loads arbitrary site content. In Rust, when creating the AniKai WebView,
set `csp: None` on its builder attributes. The main window's CSP stays strict:
```json
"csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' asset: https: data:; media-src 'self' asset: https:; connect-src 'self' asset:"
```

### DevTools
Remove `devtools: true` from AniKai WebView creation in production builds (use `#[cfg(debug_assertions)]` equivalent on JS side or check `__TAURI__`).

## NSIS Installer Configuration

```json
"nsis": {
    "install_mode": "currentUser",
    "install_path": "C:\\Program Files\\Ultimate AMV",
    "create_desktop_shortcut": true,
    "shortcuts": ["Desktop", "StartMenu"],
    "license": null
}
```

## Download Path Setting

### Config
`backend/config.json` adds `download_path: str`:
```json
{
    "download_path": "%USERPROFILE%\\Videos\\Ultimate AMV\\anime downloads\\",
    ...
}
```

### Rust
- New Tauri command `set_download_path(path: String)` updates config
- `get_config` returns `download_path` to frontend
- Download logic reads from config instead of hardcoded path
- Directory created if missing before each download

### React UI
Settings panel gets a "Downloads" group:
- Current path displayed in a read-only input
- "Browse" button opens Tauri directory picker dialog
- New path saved to config on selection

## Files to Create / Modify

### New files
| File | Purpose |
|------|---------|
| `src/SetupWizard.tsx` | First-run setup wizard React component |
| `src-tauri/icons/icon.png` | Placeholder app icon (256x256) |
| `src-tauri/icons/icon.ico` | Placeholder app icon (converted) |
| `src-tauri/icons/32x32.png` | Placeholder icon variant |
| `src-tauri/icons/128x128.png` | Placeholder icon variant |
| `src-tauri/icons/128x128@2x.png` | Placeholder icon variant |

### Modified files
| File | Changes |
|------|---------|
| `src-tauri/src/lib.rs` | `app_root()` replacement, bundled tool discovery, setup commands, download path config |
| `src-tauri/tauri.conf.json` | CSP, asset scope, NSIS config, icons, bundle.resources |
| `src/main.tsx` | Import/route SetupWizard, add download path UI to Settings |
| `backend/amv_audio/config.py` | Add `download_path` to DEFAULT_CONFIG, load/save |
| `backend/audio_cli.py` | Add `set-download-path` subcommand |
| `src/styles.css` | Any styles for SetupWizard |
| `backend/config.json` | Add `setup_complete`, `download_path` defaults |

## Order of Implementation

1. Fix `app_root()`, `python_exe()`, `find_tool()`, `ytdlp_command()` in lib.rs
2. Update `tauri.conf.json` (CSP, bundle.resources, NSIS, icons)
3. Generate placeholder icons
4. Add download path config + Rust commands + Settings UI
5. Build SetupWizard component + Rust setup commands
6. Wire setup progress events
7. Test full flow in dev mode
8. `cargo tauri build` for NSIS installer