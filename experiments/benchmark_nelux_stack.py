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

def benchmark_nelux_serial_stack():
    print("--- Benchmarking Nelux (Serial Loop + Stacking) ---")
    try:
        reader = VideoReader(INPUT_VIDEO, decode_accelerator="nvdec", resize=(FRAME_W, FRAME_H))
        frame_count = len(reader)
        
        start_time = time.perf_counter()
        
        batch_size = 100
        for i in range(0, frame_count, batch_size):
            frames = []
            for _ in range(batch_size):
                f = reader.read_frame()
                if f is None:
                    break
                frames.append(f)
            
            if frames:
                batch = torch.stack(frames)
                # Now batch is [B, 27, 48, 3] on CUDA
            
        end_time = time.perf_counter()
        duration = end_time - start_time
        fps = frame_count / duration
        print(f"Frames: {frame_count}")
        print(f"Time: {duration:.2f}s")
        print(f"FPS: {fps:.2f}")
        return fps
    except Exception as e:
        print(f"Nelux Serial Stack failed: {e}")
        return 0

if __name__ == "__main__":
    benchmark_nelux_serial_stack()
