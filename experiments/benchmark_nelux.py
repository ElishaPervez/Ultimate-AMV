import os
import sys
import time
from pathlib import Path
import torch

# Setup DLL path for Nelux
ffmpeg_shared = Path(r"c:\Projects (code)\27. Ultimate AMV script\tools\ffmpeg-shared")
if ffmpeg_shared.exists():
    os.add_dll_directory(str(ffmpeg_shared.resolve()))

from nelux import VideoReader

INPUT_VIDEO = r"c:\Projects (code)\28. Fastest decode\test footage.mp4"
FRAME_W = 48
FRAME_H = 27

def benchmark_nelux_constructor_resize():
    print("--- Benchmarking Nelux (Resize in Constructor) ---")
    try:
        # User says this disables get_batch or makes it slow
        reader = VideoReader(INPUT_VIDEO, decode_accelerator="nvdec", resize=(FRAME_W, FRAME_H))
        frame_count = len(reader)
        
        start_time = time.perf_counter()
        
        # If get_batch is disabled or slow, we might have to use a loop or it might just be slow
        # Let's try get_batch first to see if it even works
        batch_size = 100
        for i in range(0, frame_count, batch_size):
            indices = range(i, min(i + batch_size, frame_count))
            batch = reader.get_batch(indices)
            
        end_time = time.perf_counter()
        duration = end_time - start_time
        fps = frame_count / duration
        print(f"Frames: {frame_count}")
        print(f"Time: {duration:.2f}s")
        print(f"FPS: {fps:.2f}")
        return fps
    except Exception as e:
        print(f"Nelux Constructor Resize failed/errored: {e}")
        return 0

def benchmark_nelux_batch_interpolate():
    print("--- Benchmarking Nelux (Full Res Batch + Torch Interpolate) ---")
    try:
        reader = VideoReader(INPUT_VIDEO, decode_accelerator="nvdec")
        frame_count = len(reader)
        
        start_time = time.perf_counter()
        
        batch_size = 100
        for i in range(0, frame_count, batch_size):
            indices = range(i, min(i + batch_size, frame_count))
            # 1. Decode at full res
            batch = reader.get_batch(indices) # [B, H, W, 3]
            
            # 2. GPU Resize
            batch = batch.permute(0, 3, 1, 2).float()
            batch = torch.nn.functional.interpolate(batch, size=(FRAME_H, FRAME_W), mode='bilinear')
            # Keeping it on GPU for now as "GPU-to-GPU" approach
            
        end_time = time.perf_counter()
        duration = end_time - start_time
        fps = frame_count / duration
        print(f"Frames: {frame_count}")
        print(f"Time: {duration:.2f}s")
        print(f"FPS: {fps:.2f}")
        return fps
    except Exception as e:
        print(f"Nelux Batch Interpolate failed: {e}")
        return 0

if __name__ == "__main__":
    benchmark_nelux_constructor_resize()
    benchmark_nelux_batch_interpolate()
