import os
import sys
from pathlib import Path
import torch
import cv2
import numpy as np

# Setup DLL path for Nelux
ffmpeg_shared = Path(r"c:\Projects (code)\27. Ultimate AMV script\tools\ffmpeg-shared")
if ffmpeg_shared.exists():
    os.add_dll_directory(str(ffmpeg_shared.resolve()))

from nelux import VideoReader

INPUT_VIDEO = r"c:\Projects (code)\28. Fastest decode\test footage.mp4"
FRAME_W = 48
FRAME_H = 27

def verify_nelux_output():
    print("--- Verifying Nelux Output ---")
    reader = VideoReader(INPUT_VIDEO, decode_accelerator="nvdec", resize=(FRAME_W, FRAME_H))
    
    # Get frame 100
    for _ in range(100):
        frame = reader.read_frame()
        
    if frame is not None:
        print(f"Frame shape: {frame.shape}, Device: {frame.device}, Dtype: {frame.dtype}")
        # Move to CPU for saving
        img = frame.cpu().numpy()
        # RGB to BGR for OpenCV
        img_bgr = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
        cv2.imwrite("debug_frame_nelux.png", img_bgr)
        print("Saved debug_frame_nelux.png")
    else:
        print("Failed to get frame")

if __name__ == "__main__":
    verify_nelux_output()
