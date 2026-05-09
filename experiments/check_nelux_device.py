import os
import sys
from pathlib import Path
import torch

ffmpeg_shared = Path(r"c:\Projects (code)\27. Ultimate AMV script\tools\ffmpeg-shared")
if ffmpeg_shared.exists():
    os.add_dll_directory(str(ffmpeg_shared.resolve()))

from nelux import VideoReader

INPUT_VIDEO = r"c:\Projects (code)\28. Fastest decode\test footage.mp4"

def check_device():
    reader = VideoReader(INPUT_VIDEO, decode_accelerator="nvdec")
    batch = reader.get_batch(range(0, 10))
    print(f"Batch device: {batch.device}")
    print(f"Batch shape: {batch.shape}")

if __name__ == "__main__":
    check_device()
