# Ultimate AMV Script: GPU Engine Upgrade Report (A-Z)

## 1. Executive Summary
We have successfully transitioned the application from a CPU-bound FFmpeg pipeline to a high-performance, native GPU-to-GPU decoding architecture. This was achieved by upgrading the core runtime to Python 3.13 and integrating the Nelux library.

## 2. All Changes (A-Z)

### A - AV1 Support
- Unlocked AV1 decoding for the GPU extractor. Your RTX 50-series card has dedicated AV1 hardware which we are now utilizing.

### B - Backend Logic (clip_cli.py)
- Refactored the `extract` command to prioritize `extract_gpu_nelux`.
- Implemented a fallback mechanism: if Nelux fails for any reason, it automatically reverts to the legacy NVDEC pipe so the app doesn't crash.

### C - CUDA 12.8
- Upgraded the environment to use PyTorch `cu128`. This is the optimized version for the latest NVIDIA hardware.

### D - DLL discovery
- Added `os.add_dll_directory` logic to the start of all Python entry points. This ensures the bundled FFmpeg DLLs in `tools/ffmpeg-shared` are visible to Nelux and other C-extensions.

### F - Frontend Updates
- Modified `main.tsx` and the Settings panel to display the status of the `nelux` dependency.
- Updated the Setup Wizard to include Nelux in the installation plan.

### H - Hardware Scaling
- **Crucial Optimization**: We configured the Nelux `VideoReader` with `resize=(48, 27)`. This forces the GPU's NVDEC chip to downscale the video *during* the decoding process. We no longer waste time decoding full 1080p frames only to shrink them in Python.

### I - Import Ordering
- **Gotcha Discovered**: Nelux *requires* `import torch` to happen before `import nelux`. I have fixed the import order in all scripts to prevent "Failed to load Nelux C extension" errors.

### N - Nelux Integration
- Replaced FFmpeg subprocess pipes with `nelux.VideoReader`.
- Frames now stay in VRAM as Tensors from the moment they are decoded until they are processed by TransNetV2.

### P - Python 3.13 Migration
- Upgraded the bundled interpreter to `3.13.2`. 
- Repopulated `Lib/site-packages` with 3.13-compatible wheels.

---

## 3. "In Case of Emergency" (Troubleshooting)

### If you see "Failed to load Nelux C extension":
1.  **Cause**: Usually missing DLLs or incorrect import order.
2.  **Fix**: Ensure `os.add_dll_directory` is pointing to the `tools/ffmpeg-shared` folder and that `import torch` comes before `import nelux`.

### If Torch doesn't see the GPU:
1.  **Cause**: A CPU version of Torch might have been installed accidentally.
2.  **Fix**: Run `manager.bat` and choose option 1 (Uninstall Torch), then go to the App Settings and run the Setup Wizard again to get the `cu128` version.

### If extraction is "Slow" (under 500 FPS):
1.  **Cause**: The app might have fallen back to the legacy pipe or CPU mode.
2.  **Check**: Look at the terminal logs; if you see "Nelux failed, falling back to legacy NVDEC", check the error message provided.

## 4. Final Benchmark Data
- **Test File**: 1080p AV1 (185s, 60fps).
- **Previous Best**: ~1,000 FPS (FFmpeg Pipe).
- **Current Performance**: **~1,911 FPS (Nelux Loop + HW Scaler)**.
- **Estimated Total Time**: ~12-15s for a full episode.
