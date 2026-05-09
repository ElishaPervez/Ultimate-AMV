import os
import sys
import time
import subprocess
import numpy as np
from pathlib import Path

# Add project root to path for imports
sys.path.append(os.getcwd())
# Also add backend to path if needed
sys.path.append(os.path.join(os.getcwd(), "backend"))

ffmpeg_dll_path = r"c:\Projects (code)\27. Ultimate AMV script\tools\ffmpeg-shared"
if os.path.exists(ffmpeg_dll_path):
    os.add_dll_directory(ffmpeg_dll_path)

import torch
from nelux import VideoReader

VIDEO_PATH = r"c:\Projects (code)\28. Fastest decode\test footage.mp4"
FFMPEG_PATH = r"c:\Projects (code)\27. Ultimate AMV script\tools\ffmpeg.exe"
FRAME_W, FRAME_H = 48, 27
MAX_FRAMES = 10000 # Benchmark a good chunk

def benchmark_ffmpeg_legacy():
    print("\n--- [Method 1] Legacy FFmpeg Pipe (King) ---")
    args = [
        FFMPEG_PATH,
        "-hwaccel", "cuda",
        "-hwaccel_output_format", "cuda",
        "-c:v", "h264_cuvid",
        "-i", VIDEO_PATH,
        "-vf", f"scale_cuda={FRAME_W}:{FRAME_H},hwdownload,format=nv12,format=rgb24",
        "-f", "image2pipe",
        "-pix_fmt", "rgb24",
        "-vcodec", "rawvideo",
        "-frames:v", str(MAX_FRAMES),
        "-"
    ]
    
    start_time = time.perf_counter()
    process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    
    frame_size = FRAME_W * FRAME_H * 3
    count = 0
    while count < MAX_FRAMES:
        chunk = process.stdout.read(frame_size * 100)
        if not chunk:
            break
        count += len(chunk) // frame_size
    
    process.wait()
    end_time = time.perf_counter()
    duration = end_time - start_time
    fps = count / duration
    print(f"Decoded {count} frames in {duration:.2f}s ({fps:.2f} fps)")
    return fps

def benchmark_nelux_challenger():
    print("\n--- [Method 2] Nelux Challenger (Full Res Batch + GPU Resize) ---")
    reader = VideoReader(VIDEO_PATH, decode_accelerator="nvdec")
    total_frames = min(len(reader), MAX_FRAMES)
    
    start_time = time.perf_counter()
    count = 0
    batch_size = 100
    for i in range(0, total_frames, batch_size):
        indices = range(i, min(i + batch_size, total_frames))
        with torch.inference_mode():
            batch = reader.get_batch(indices) # [B, H, W, 3]
            # GPU Resize
            batch = batch.permute(0, 3, 1, 2).float()
            batch = torch.nn.functional.interpolate(batch, size=(FRAME_H, FRAME_W), mode='bilinear')
        count += len(indices)
            
    torch.cuda.synchronize()
    end_time = time.perf_counter()
    duration = end_time - start_time
    fps = count / duration
    print(f"Decoded {count} frames in {duration:.2f}s ({fps:.2f} fps)")
    return fps

def benchmark_nelux_serial_hw():
    print("\n--- [Method 3] Nelux Serial (read_frame + HW Resize) ---")
    # THE SECRET WEAPON: Using constructor resize activates HW scaler, read_frame is fast
    reader = VideoReader(VIDEO_PATH, decode_accelerator="nvdec", resize=(FRAME_W, FRAME_H))
    total_frames = min(len(reader), MAX_FRAMES)
    
    start_time = time.perf_counter()
    count = 0
    batch_size = 100
    for i in range(0, total_frames, batch_size):
        frames = []
        for _ in range(batch_size):
            f = reader.read_frame()
            if f is None: break
            frames.append(f)
        
        if not frames: break
        
        # Stack to batch for TransNetV2 compatibility
        batch = torch.stack(frames)
        count += batch.shape[0]
            
    torch.cuda.synchronize()
    end_time = time.perf_counter()
    duration = end_time - start_time
    fps = count / duration
    print(f"Decoded {count} frames in {duration:.2f}s ({fps:.2f} fps)")
    return fps

def benchmark_ffmpeg_decoder_resize():
    print("\n--- [Method 4] Optimized FFmpeg (Decoder-level Resize) ---")
    args = [
        FFMPEG_PATH,
        "-hwaccel", "cuda",
        "-c:v", "h264_cuvid",
        "-resize", f"{FRAME_W}x{FRAME_H}",
        "-i", VIDEO_PATH,
        "-f", "image2pipe",
        "-pix_fmt", "rgb24",
        "-vcodec", "rawvideo",
        "-frames:v", str(MAX_FRAMES),
        "-"
    ]
    
    start_time = time.perf_counter()
    process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    
    frame_size = FRAME_W * FRAME_H * 3
    count = 0
    while count < MAX_FRAMES:
        chunk = process.stdout.read(frame_size * 100)
        if not chunk:
            break
        count += len(chunk) // frame_size
    
    process.wait()
    end_time = time.perf_counter()
    duration = end_time - start_time
    fps = count / duration
    print(f"Decoded {count} frames in {duration:.2f}s ({fps:.2f} fps)")
    return fps

if __name__ == "__main__":
    results = {}
    results["Legacy FFmpeg"] = benchmark_ffmpeg_legacy()
    results["Nelux (Full Res Batch)"] = benchmark_nelux_challenger()
    results["Nelux (Serial HW Resize)"] = benchmark_nelux_serial_hw()
    results["FFmpeg (Decoder Resize)"] = benchmark_ffmpeg_decoder_resize()
    
    print("\n" + "="*40)
    print(f"{'Method':<25} | {'FPS':<10}")
    print("-" * 40)
    for method, fps in results.items():
        print(f"{method:<25} | {fps:<10.2f}")
    print("="*40)
