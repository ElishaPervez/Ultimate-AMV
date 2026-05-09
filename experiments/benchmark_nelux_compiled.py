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

@torch.compile
def resize_batch(batch):
    # Interpolate expects [B, C, H, W]
    # batch is [B, H, W, C]
    batch = batch.permute(0, 3, 1, 2).float()
    batch = torch.nn.functional.interpolate(batch, size=(FRAME_H, FRAME_W), mode='bilinear')
    return batch

def benchmark_nelux_compiled_resize():
    print("--- Benchmarking Nelux (Full Res Batch + Compiled Interpolate) ---")
    try:
        reader = VideoReader(INPUT_VIDEO, decode_accelerator="nvdec")
        frame_count = len(reader)
        
        # Warmup compile
        dummy_batch = torch.zeros((100, 360, 640, 3), device="cuda", dtype=torch.uint8)
        for _ in range(3):
            resize_batch(dummy_batch)
            
        start_time = time.perf_counter()
        
        batch_size = 100
        for i in range(0, frame_count, batch_size):
            indices = range(i, min(i + batch_size, frame_count))
            batch = reader.get_batch(indices) 
            resized = resize_batch(batch)
            
        end_time = time.perf_counter()
        duration = end_time - start_time
        fps = frame_count / duration
        print(f"Frames: {frame_count}")
        print(f"Time: {duration:.2f}s")
        print(f"FPS: {fps:.2f}")
        return fps
    except Exception as e:
        print(f"Nelux Compiled Resize failed: {e}")
        import traceback
        traceback.print_exc()
        return 0

if __name__ == "__main__":
    benchmark_nelux_compiled_resize()
