import os
import sys
import time
from pathlib import Path
import torch
from tqdm import tqdm

# Setup DLL path for Nelux
ffmpeg_shared = Path(r"c:\Projects (code)\27. Ultimate AMV script\tools\ffmpeg-shared")
if ffmpeg_shared.exists():
    os.add_dll_directory(str(ffmpeg_shared.resolve()))

from nelux import VideoReader

INPUT_VIDEO = r"c:\Projects (code)\28. Fastest decode\test footage.mp4"
FRAME_W = 48
FRAME_H = 27
MAX_FRAMES = 10000

def benchmark_nelux_optimized_single():
    print("--- Benchmarking Optimized Single Nelux (read_frame + HW Resize + Large Prefetch) ---")
    try:
        reader = VideoReader(INPUT_VIDEO, decode_accelerator="nvdec", resize=(FRAME_W, FRAME_H))
        frame_count = min(len(reader), MAX_FRAMES)
        
        # Start prefetching with a large buffer
        if hasattr(reader, 'start_prefetch'):
            reader.start_prefetch(buffer_size=512)
            
        start_time = time.perf_counter()
        
        for _ in tqdm(range(frame_count), desc="Optimized Nelux"):
            f = reader.read_frame()
            if f is None: break
            
        end_time = time.perf_counter()
        
        if hasattr(reader, 'stop_prefetch'):
            reader.stop_prefetch()
            
        duration = end_time - start_time
        fps = frame_count / duration
        print(f"Frames: {frame_count}")
        print(f"Time: {duration:.2f}s")
        print(f"FPS: {fps:.2f}")
        return fps
    except Exception as e:
        print(f"Optimized Nelux failed: {e}")
        return 0

if __name__ == "__main__":
    benchmark_nelux_optimized_single()
