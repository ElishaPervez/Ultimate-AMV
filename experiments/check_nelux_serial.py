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

def check_serial_device():
    reader = VideoReader(INPUT_VIDEO, decode_accelerator="nvdec", resize=(FRAME_W, FRAME_H))
    frame = reader.read_frame()
    print(f"Frame device: {frame.device}")
    print(f"Frame shape: {frame.shape}")
    print(f"Frame dtype: {frame.dtype}")

if __name__ == "__main__":
    check_serial_device()
