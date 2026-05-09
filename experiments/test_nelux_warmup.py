import os
import sys
import time
from pathlib import Path

# Add project root to path
sys.path.append(os.getcwd())

# Add DLLs
ffmpeg_shared = Path("tools/ffmpeg-shared")
if ffmpeg_shared.exists():
    os.add_dll_directory(str(ffmpeg_shared.resolve()))

def test_nelux():
    print("Testing Nelux + Torch CUDA...")
    import torch
    import nelux
    from transnetv2_pytorch import TransNetV2

    print(f"Torch: {torch.__version__}")
    print(f"CUDA: {torch.cuda.is_available()}")
    if not torch.cuda.is_available():
        print("ERROR: CUDA not available")
        return

    video_path = "C:/Users/Elisha/Videos/NVIDIA/Desktop/Desktop 2026.04.02 - 03.05.07.02.mp4"
    if not os.path.exists(video_path):
        print(f"ERROR: Video not found: {video_path}")
        return

    print(f"Opening: {video_path}")
    reader = nelux.VideoReader(video_path, decode_accelerator="nvdec")
    print(f"Frames: {len(reader)}")
    
    # Load model
    device = torch.device("cuda")
    model = TransNetV2(device=device)
    model.eval()

    # Test batch
    print("Running test batch (100 frames)...")
    indices = list(range(0, 100))
    start_time = time.time()
    
    with torch.inference_mode():
        # 1. GPU Decode [B, H, W, 3]
        batch = reader.get_batch(indices)
        print(f"Nelux output shape: {batch.shape}, dtype: {batch.dtype}")
        
        # 2. Reshape to [B, 3, H, W] and convert to float for resizing
        batch = batch.permute(0, 3, 1, 2).float()
        
        # 3. GPU Resize -> [B, 3, 27, 48]
        batch = torch.nn.functional.interpolate(batch, size=(27, 48), mode='bilinear')
        print(f"Resized shape: {batch.shape}, dtype: {batch.dtype}")
        
        # 4. Transform back to [1, B, 27, 48, 3] (BTHWC)
        batch = batch.permute(0, 2, 3, 1).unsqueeze(0)
        print(f"Final input shape: {batch.shape}")
        
        # 5. Ensure uint8 for TransNetV2
        batch = batch.clamp(0, 255).to(torch.uint8)
        print(f"Final input dtype: {batch.dtype}")
            
        # 6. Infer
        out, _ = model(batch)
        print(f"Output shape: {out.shape}")

    end_time = time.time()
    print(f"Test batch took: {end_time - start_time:.4f}s")
    print("Nelux Warmup SUCCESS")

if __name__ == "__main__":
    test_nelux()
