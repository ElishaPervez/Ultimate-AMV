import os
from pathlib import Path

# Setup DLL path for dependencies
ffmpeg_shared = Path(r"c:\Projects (code)\27. Ultimate AMV script\tools\ffmpeg-shared")
if ffmpeg_shared.exists():
    os.add_dll_directory(str(ffmpeg_shared.resolve()))

import torch
import torchcodec
import time

INPUT_VIDEO = r"c:\Projects (code)\28. Fastest decode\test footage.mp4"
FRAME_W = 48
FRAME_H = 27

def benchmark_torchcodec():
    print("--- Benchmarking Torchcodec ---")
    try:
        # Check if cuda decoder is available
        # In recent versions of torchcodec, it might use NVDEC if torch was built with it
        # Actually torchcodec has a CUDA backend in newer versions
        
        from torchcodec.decoders import VideoDecoder
        
        # Try to use GPU
        # If it doesn't support it directly, we might have to use CPU and then upload, but that's slow.
        # User task says "with its CUDA decoder"
        
        try:
            decoder = VideoDecoder(INPUT_VIDEO, device="cuda")
        except Exception as e:
            print(f"Could not initialize CUDA decoder: {e}")
            return 0
            
        frame_count = len(decoder)
        start_time = time.perf_counter()
        
        batch_size = 100
        for i in range(0, frame_count, batch_size):
            indices = list(range(i, min(i + batch_size, frame_count)))
            # Decode batch
            frames = decoder.get_frames_at_indices(indices) # This returns a tensor [B, C, H, W]
            
            # Resize
            frames = torch.nn.functional.interpolate(frames.float(), size=(FRAME_H, FRAME_W), mode='bilinear')
            
        end_time = time.perf_counter()
        duration = end_time - start_time
        fps = frame_count / duration
        print(f"Frames: {frame_count}")
        print(f"Time: {duration:.2f}s")
        print(f"FPS: {fps:.2f}")
        return fps
    except Exception as e:
        print(f"Torchcodec benchmark failed: {e}")
        return 0

if __name__ == "__main__":
    benchmark_torchcodec()
