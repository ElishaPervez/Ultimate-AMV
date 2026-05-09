import subprocess
import time
import os
from pathlib import Path

FFMPEG = r"c:\Projects (code)\27. Ultimate AMV script\tools\ffmpeg.exe"
INPUT_VIDEO = r"c:\Projects (code)\28. Fastest decode\test footage.mp4"
FRAME_W = 48
FRAME_H = 27
FRAME_BYTES = FRAME_W * FRAME_H * 3

def benchmark_ffmpeg_pure_gpu_scale():
    print("--- Benchmarking FFmpeg Pure GPU Scale/Format ---")
    command = [
        FFMPEG,
        "-hwaccel", "cuda",
        "-hwaccel_output_format", "cuda",
        "-c:v", "h264_cuvid",
        "-i", INPUT_VIDEO,
        "-vf", f"scale_cuda={FRAME_W}:{FRAME_H}:format=rgb24,hwdownload",
        "-f", "image2pipe",
        "-pix_fmt", "rgb24",
        "-vcodec", "rawvideo",
        "pipe:1"
    ]
    
    start_time = time.perf_counter()
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    
    frame_count = 0
    while True:
        chunk = process.stdout.read(FRAME_BYTES * 1000)
        if not chunk:
            break
        frame_count += len(chunk) // FRAME_BYTES
    
    process.wait()
    end_time = time.perf_counter()
    
    duration = end_time - start_time
    fps = frame_count / duration
    print(f"Frames: {frame_count}")
    print(f"Time: {duration:.2f}s")
    print(f"FPS: {fps:.2f}")
    return fps

if __name__ == "__main__":
    benchmark_ffmpeg_pure_gpu_scale()
