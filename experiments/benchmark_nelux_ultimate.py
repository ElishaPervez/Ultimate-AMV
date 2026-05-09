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

def benchmark_nelux_ultimate():
    print("--- Benchmarking Nelux (Serial + Prefetch + HW Resize) ---")
    try:
        # Use constructor resize to activate hardware scaler
        reader = VideoReader(INPUT_VIDEO, decode_accelerator="nvdec", resize=(FRAME_W, FRAME_H))
        frame_count = len(reader)
        
        # Start prefetching if available
        if hasattr(reader, 'start_prefetch'):
            reader.start_prefetch(buffer_size=128)
            
        start_time = time.perf_counter()
        
        batch_size = 100
        total_frames_processed = 0
        
        for i in range(0, frame_count, batch_size):
            frames = []
            for _ in range(batch_size):
                f = reader.read_frame()
                if f is None:
                    break
                frames.append(f)
            
            if not frames:
                break
                
            # Simulate preparation for TransNetV2
            batch = torch.stack(frames) # [B, 27, 48, 3]
            batch = batch.unsqueeze(0)  # [1, B, 27, 48, 3]
            total_frames_processed += batch.shape[1]
            
        end_time = time.perf_counter()
        
        if hasattr(reader, 'stop_prefetch'):
            reader.stop_prefetch()
            
        duration = end_time - start_time
        fps = total_frames_processed / duration
        print(f"Frames: {total_frames_processed}")
        print(f"Time: {duration:.2f}s")
        print(f"FPS: {fps:.2f}")
        return fps
    except Exception as e:
        print(f"Nelux Ultimate failed: {e}")
        import traceback
        traceback.print_exc()
        return 0

if __name__ == "__main__":
    benchmark_nelux_ultimate()
