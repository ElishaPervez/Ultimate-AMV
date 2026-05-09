import os
import sys
import time
from pathlib import Path
import torch
import threading

# Setup DLL path for Nelux
ffmpeg_shared = Path(r"c:\Projects (code)\27. Ultimate AMV script\tools\ffmpeg-shared")
if ffmpeg_shared.exists():
    os.add_dll_directory(str(ffmpeg_shared.resolve()))

from nelux import VideoReader

INPUT_VIDEO = r"c:\Projects (code)\28. Fastest decode\test footage.mp4"
FRAME_W = 48
FRAME_H = 27
MAX_FRAMES = 10000

def reader_thread(reader, start_idx, num_frames, results, thread_id):
    # Skip to start_idx
    # Since we are using read_frame, we need to seek or skip
    # For now, let's assume we can create readers with start points if supported
    # Nelux has set_range or similar?
    if hasattr(reader, 'set_range'):
        reader.set_range(start_idx, start_idx + num_frames)
    
    frames_collected = []
    for _ in range(num_frames):
        f = reader.read_frame()
        if f is None: break
        frames_collected.append(f)
    results[thread_id] = frames_collected

def benchmark_nelux_dual():
    print("--- Benchmarking Nelux Dual Readers (Parallel Decode) ---")
    try:
        # Create two readers
        r1 = VideoReader(INPUT_VIDEO, decode_accelerator="nvdec", resize=(FRAME_W, FRAME_H))
        r2 = VideoReader(INPUT_VIDEO, decode_accelerator="nvdec", resize=(FRAME_W, FRAME_H))
        
        frame_count = min(len(r1), MAX_FRAMES)
        mid = frame_count // 2
        
        results = [None, None]
        
        start_time = time.perf_counter()
        
        t1 = threading.Thread(target=reader_thread, args=(r1, 0, mid, results, 0))
        t2 = threading.Thread(target=reader_thread, args=(r2, mid, frame_count - mid, results, 1))
        
        t1.start()
        t2.start()
        t1.join()
        t2.join()
        
        end_time = time.perf_counter()
        
        total_frames = len(results[0]) + len(results[1])
        duration = end_time - start_time
        fps = total_frames / duration
        print(f"Frames: {total_frames}")
        print(f"Time: {duration:.2f}s")
        print(f"FPS: {fps:.2f}")
        return fps
    except Exception as e:
        print(f"Nelux Dual failed: {e}")
        import traceback
        traceback.print_exc()
        return 0

if __name__ == "__main__":
    benchmark_nelux_dual()
