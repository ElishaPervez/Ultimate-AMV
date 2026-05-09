import os
import sys
import time
import subprocess
import numpy as np
from pathlib import Path

# Add project root to path for imports
sys.path.append(os.getcwd())
ffmpeg_dll_path = os.path.abspath("tools/ffmpeg-shared")
if os.path.exists(ffmpeg_dll_path):
    os.add_dll_directory(ffmpeg_dll_path)

import torch
try:
    from torchcodec.decoders import VideoDecoder
    HAS_TORCHCODEC = True
except ImportError:
    HAS_TORCHCODEC = False

VIDEO_PATH = r"C:\Users\Elisha\Videos\NVIDIA\Desktop\Desktop 2026.04.02 - 03.05.07.02.mp4"
FRAME_W, FRAME_H = 48, 27
MAX_FRAMES = 5000

def benchmark_ffmpeg_pipe():
    print("\n--- Benchmarking FFmpeg Pipe (Current Method) ---")
    ff_path = os.path.abspath("tools/ffmpeg.exe")
    
    # Simple check for codec
    try:
        probe_args = [
            os.path.abspath("tools/ffprobe.exe"),
            "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=codec_name",
            "-of", "default=nokey=1:noprint_wrappers=1",
            VIDEO_PATH
        ]
        codec = subprocess.check_output(probe_args).decode().strip()
        if codec == "h264":
            decoder = "h264_cuvid"
        elif codec == "hevc":
            decoder = "hevc_cuvid"
        elif codec == "av1":
            decoder = "av1_cuvid"
        else:
            decoder = codec  # fallback
        print(f"Codec: {codec}, using decoder: {decoder}")
    except Exception as e:
        print(f"Probing failed: {e}")
        return 0

    args = [
        ff_path,
        "-hwaccel", "cuda",
        "-hwaccel_output_format", "cuda",
        "-c:v", decoder,
        "-i", VIDEO_PATH,
        "-vf", f"scale_cuda={FRAME_W}:{FRAME_H},hwdownload,format=nv12,format=rgb24",
        "-f", "image2pipe",
        "-pix_fmt", "rgb24",
        "-vcodec", "rawvideo",
        "-frames:v", str(MAX_FRAMES),
        "-"
    ]

    start_time = time.time()
    process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    
    frame_size = FRAME_W * FRAME_H * 3
    count = 0
    while count < MAX_FRAMES:
        in_bytes = process.stdout.read(frame_size)
        if not in_bytes:
            break
        count += 1
        if count % 100 == 0:
            print(f"  FFmpeg: {count}/{MAX_FRAMES} frames...")
    
    stdout, stderr = process.communicate()
    end_time = time.time()
    duration = end_time - start_time
    fps = count / duration if duration > 0 else 0
    print(f"Decoded {count} frames in {duration:.2f}s ({fps:.2f} fps)")
    if count == 0:
        print(f"FFmpeg Stderr: {stderr.decode()[:500]}")
    return fps

def benchmark_torchcodec():
    if not HAS_TORCHCODEC:
        print("\n--- torchcodec not available, skipping ---")
        return 0
    
    print("\n--- Benchmarking torchcodec ---")
    
    devices = ["cpu", "cuda", "cuda:0"]
    for dev in devices:
        print(f"\nTrying device: {dev}")
        start_time = time.time()
        try:
            decoder = VideoDecoder(VIDEO_PATH, device=dev)
            count = 0
            for frame in decoder:
                if count >= MAX_FRAMES:
                    break
                count += 1
                if count % 100 == 0:
                    print(f"  torchcodec {dev}: {count}/{MAX_FRAMES} frames...")
                
            end_time = time.time()
            duration = end_time - start_time
            fps = count / duration if duration > 0 else 0
            print(f"  SUCCESS! Decoded {count} frames in {duration:.2f}s ({fps:.2f} fps)")
            return fps
        except Exception as e:
            print(f"  FAILED for {dev}: {e}")
    
    return 0

def benchmark_nv12_pipe():
    print("\n--- Benchmarking FFmpeg NV12 Pipe (Experimental) ---")
    ff_path = os.path.abspath("tools/ffmpeg.exe")
    
    # Simple check for codec
    probe_args = [
        os.path.abspath("tools/ffprobe.exe"),
        "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=codec_name",
        "-of", "default=nokey=1:noprint_wrappers=1",
        VIDEO_PATH
    ]
    codec = subprocess.check_output(probe_args).decode().strip()
    decoder = "h264_cuvid" if codec == "h264" else "hevc_cuvid" if codec == "hevc" else "av1_cuvid" if codec == "av1" else codec

    # NV12 is 1.5 bytes per pixel (Y + UV interleaved)
    # For 48x27, it's 48*27 + 48*27/2 = 1296 + 648 = 1944 bytes
    nv12_size = int(FRAME_W * FRAME_H * 1.5)

    args = [
        ff_path,
        "-hwaccel", "cuda",
        "-hwaccel_output_format", "cuda",
        "-c:v", decoder,
        "-i", VIDEO_PATH,
        "-vf", f"scale_cuda={FRAME_W}:{FRAME_H},hwdownload,format=nv12",
        "-f", "image2pipe",
        "-pix_fmt", "nv12",
        "-vcodec", "rawvideo",
        "-frames:v", str(MAX_FRAMES),
        "-"
    ]

    start_time = time.time()
    process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    
    count = 0
    while count < MAX_FRAMES:
        in_bytes = process.stdout.read(nv12_size)
        if not in_bytes:
            break
        count += 1
        if count % 100 == 0:
            print(f"  NV12: {count}/{MAX_FRAMES} frames...")
    
    stdout, stderr = process.communicate()
    end_time = time.time()
    duration = end_time - start_time
    fps = count / duration if duration > 0 else 0
    print(f"Decoded {count} NV12 frames in {duration:.2f}s ({fps:.2f} fps)")
    return fps

def benchmark_nelux():
    print("\n--- Benchmarking Nelux (GPU-to-GPU) ---")
    import torch
    import nelux
    
    device = torch.device("cuda")
    reader = nelux.VideoReader(VIDEO_PATH, decode_accelerator="nvdec")
    
    start_time = time.time()
    count = 0
    total_frames = min(len(reader), MAX_FRAMES)
    
    # Nelux is fastest with batches
    batch_size = 100
    for i in range(0, total_frames, batch_size):
        indices = list(range(i, min(i + batch_size, total_frames)))
        with torch.inference_mode():
            batch = reader.get_batch(indices)
            # Just move to CPU to simulate full work or keep on GPU
            # _ = batch.cpu() 
        count += len(indices)
        if count % 500 == 0:
            print(f"  Nelux: {count}/{total_frames} frames...")
            
    torch.cuda.synchronize()
    end_time = time.time()
    duration = end_time - start_time
    fps = count / duration if duration > 0 else 0
    print(f"Nelux decoded {count} frames in {duration:.2f}s ({fps:.2f} fps)")
    return fps

def benchmark_inference_only():
    print("\n--- Benchmarking TransNetV2 Inference Only ---")
    import torch
    from transnetv2_pytorch import TransNetV2
    
    device = torch.device("cuda")
    model = TransNetV2(device=device)
    model.eval()
    
    # 50 frames batch
    batch_size = 50
    dummy_input = torch.randint(0, 255, (1, batch_size, FRAME_H, FRAME_W, 3), dtype=torch.uint8).to(device)
    
    # Warmup
    for _ in range(5):
        with torch.inference_mode():
            _ = model(dummy_input)
    
    start_time = time.time()
    iterations = MAX_FRAMES // batch_size
    for _ in range(iterations):
        with torch.inference_mode():
            _ = model(dummy_input)
    
    torch.cuda.synchronize()
    end_time = time.time()
    duration = end_time - start_time
    total_frames = iterations * batch_size
    fps = total_frames / duration
    
    print(f"Inference only: {total_frames} frames in {duration:.2f}s ({fps:.2f} fps)")
    return fps

def benchmark_decord():
    print("\n--- Benchmarking Decord (GPU) ---")
    try:
        import decord
        from decord import VideoReader, gpu
    except ImportError:
        print("  decord not installed")
        return 0
    
    try:
        # Try to initialize on GPU
        vr = VideoReader(VIDEO_PATH, ctx=gpu(0), width=FRAME_W, height=FRAME_H)
        count = 0
        start_time = time.time()
        
        # decord is fast because it can batch
        batch_size = 100
        total_frames = min(len(vr), MAX_FRAMES)
        
        for i in range(0, total_frames, batch_size):
            indices = list(range(i, min(i + batch_size, total_frames)))
            batch = vr.get_batch(indices)
            count += len(indices)
            if count % 500 == 0:
                print(f"  Decord: {count}/{total_frames} frames...")
                
        end_time = time.time()
        duration = end_time - start_time
        fps = count / duration if duration > 0 else 0
        print(f"Decoded {count} frames in {duration:.2f}s ({fps:.2f} fps)")
        return fps
    except Exception as e:
        print(f"  Decord GPU failed: {e}")
        print("  Trying Decord CPU...")
        try:
            vr = VideoReader(VIDEO_PATH, width=FRAME_W, height=FRAME_H)
            count = 0
            start_time = time.time()
            total_frames = min(len(vr), MAX_FRAMES)
            for i in range(0, total_frames, batch_size):
                indices = list(range(i, min(i + batch_size, total_frames)))
                batch = vr.get_batch(indices)
                count += len(indices)
            end_time = time.time()
            duration = end_time - start_time
            fps = count / duration if duration > 0 else 0
            print(f"  Decord CPU SUCCESS: Decoded {count} frames in {duration:.2f}s ({fps:.2f} fps)")
            return fps
        except Exception as e2:
            print(f"  Decord CPU failed: {e2}")
            return 0

def benchmark_parallel_pipes():
    print("\n--- Benchmarking Parallel FFmpeg Pipes ---")
    ff_path = os.path.abspath("tools/ffmpeg.exe")
    
    # 2 processes
    midpoint = MAX_FRAMES // 2
    
    args1 = [
        ff_path, "-hwaccel", "cuda", "-hwaccel_output_format", "cuda",
        "-c:v", "av1_cuvid", "-i", VIDEO_PATH,
        "-vf", f"scale_cuda={FRAME_W}:{FRAME_H},hwdownload,format=nv12,format=rgb24",
        "-f", "image2pipe", "-pix_fmt", "rgb24", "-vcodec", "rawvideo",
        "-frames:v", str(midpoint), "-"
    ]
    
    args2 = [
        ff_path, "-hwaccel", "cuda", "-hwaccel_output_format", "cuda",
        "-c:v", "av1_cuvid", "-ss", "00:01:00",  # Skip 1 min to simulate middle start
        "-i", VIDEO_PATH,
        "-vf", f"scale_cuda={FRAME_W}:{FRAME_H},hwdownload,format=nv12,format=rgb24",
        "-f", "image2pipe", "-pix_fmt", "rgb24", "-vcodec", "rawvideo",
        "-frames:v", str(midpoint), "-"
    ]

    start_time = time.time()
    p1 = subprocess.Popen(args1, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    p2 = subprocess.Popen(args2, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    
    frame_size = FRAME_W * FRAME_H * 3
    count = 0
    
    # Read both in parallel
    while count < MAX_FRAMES:
        b1 = p1.stdout.read(frame_size)
        b2 = p2.stdout.read(frame_size)
        if b1: count += 1
        if b2: count += 1
        if not b1 and not b2: break
        
    p1.terminate()
    p2.terminate()
    
    end_time = time.time()
    duration = end_time - start_time
    fps = count / duration if duration > 0 else 0
    print(f"Parallel decoded {count} frames in {duration:.2f}s ({fps:.2f} fps)")
    return fps

if __name__ == "__main__":
    benchmark_nelux()
