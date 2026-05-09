import os
import sys
import time
from pathlib import Path
import torch
import threading
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

def reader_thread(reader, start_idx, num_frames, progress_bar, results, thread_id):
    if hasattr(reader, 'set_range'):
        reader.set_range(start_idx, start_idx + num_frames)
    
    count = 0
    batch_size = 10
    for i in range(0, num_frames, batch_size):
        current_batch = min(batch_size, num_frames - i)
        for _ in range(current_batch):
            f = reader.read_frame()
            if f is None: break
            count += 1
        progress_bar.update(current_batch)
    results[thread_id] = count

def benchmark_nelux_multi(num_readers=4):
    print(f"--- Benchmarking Nelux Multi-Readers ({num_readers}) ---")
    try:
        readers = [VideoReader(INPUT_VIDEO, decode_accelerator="nvdec", resize=(FRAME_W, FRAME_H)) for _ in range(num_readers)]
        
        frame_count = min(len(readers[0]), MAX_FRAMES)
        chunk_size = frame_count // num_readers
        
        results = [0] * num_readers
        threads = []
        
        with tqdm(total=frame_count, desc=f"Nelux x{num_readers}") as pbar:
            start_time = time.perf_counter()
            
            for i in range(num_readers):
                start_idx = i * chunk_size
                count = chunk_size if i < num_readers - 1 else frame_count - start_idx
                t = threading.Thread(target=reader_thread, args=(readers[i], start_idx, count, pbar, results, i))
                threads.append(t)
                t.start()
                
            for t in threads:
                t.join()
            
            end_time = time.perf_counter()
        
        total_frames = sum(results)
        duration = end_time - start_time
        fps = total_frames / duration
        print(f"Frames: {total_frames}")
        print(f"Time: {duration:.2f}s")
        print(f"FPS: {fps:.2f}")
        return fps
    except Exception as e:
        print(f"Nelux Multi failed: {e}")
        return 0

if __name__ == "__main__":
    benchmark_nelux_multi(4)
    benchmark_nelux_multi(8)
