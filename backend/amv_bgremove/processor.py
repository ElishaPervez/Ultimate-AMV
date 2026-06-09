import os
import sys
import time
import subprocess
from pathlib import Path

from .models import create_session

# cv2, PIL and rembg are imported inside the functions that need them: they
# are installed on first use by ensure_feature_dependencies, and a module-top
# import would crash bgremove_cli before that repair can run.

def require_tool(name):
    env_dir = os.environ.get("ULTIMATE_AMV_TOOLS_DIR")
    if env_dir:
        bundled = Path(env_dir) / f"{name}.exe"
    else:
        bundled = Path(sys.executable).parent.parent / "tools" / f"{name}.exe"
    
    # On Windows, add .exe. On other systems, keep it as is.
    if os.name == "nt" and not bundled.name.endswith(".exe"):
        bundled = bundled.with_suffix(".exe")
        
    if not bundled.exists():
        # Fallback to PATH search
        import shutil
        path_tool = shutil.which(name)
        if path_tool:
            return path_tool
        raise RuntimeError(
            f"{name} not found. The first-launch tools download did not complete; relaunch the app and let the setup gate finish."
        )
    return str(bundled)

def remove_background_video(
    input_path: str,
    output_path: str,
    model_key: str = "anime",
    export_format: str = "webm",
    force_cpu: bool = False,
    progress_callback = None
):
    """
    Processes video frame-by-frame, removes background with the selected model,
    and encodes the output as WebM with alpha or a PNG sequence.
    """
    import cv2
    from PIL import Image
    from rembg import remove

    input_file = Path(input_path).resolve()
    if not input_file.exists():
        raise FileNotFoundError(f"Input video file not found: {input_path}")

    cap = cv2.VideoCapture(str(input_file))
    if not cap.isOpened():
        raise RuntimeError(f"Could not open input video file: {input_path}")
        
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    
    if total_frames <= 0:
        total_frames = 1
        
    if progress_callback:
        progress_callback("model-init", 5, f"Initializing background removal model ({model_key})...")
        
    session = create_session(model_key, force_cpu=force_cpu)
    
    if progress_callback:
        progress_callback("processing", 10, f"Model initialized. Processing {total_frames} frames...")
        
    ffmpeg_proc = None
    output_dir = None
    
    if export_format == "webm":
        ffmpeg_bin = require_tool("ffmpeg")
        # FFmpeg VP9 with alpha encoding pipeline
        cmd = [
            ffmpeg_bin,
            "-y",
            "-f", "rawvideo",
            "-vcodec", "rawvideo",
            "-s", f"{width}x{height}",
            "-pix_fmt", "rgba",
            "-r", str(fps),
            "-i", "-",
            "-an",
            "-c:v", "libvpx-vp9",
            "-pix_fmt", "yuva420p",
            "-b:v", "0",
            "-crf", "22",          # Balanced high quality
            "-speed", "6",         # Fast encode speed for vp9 realtime/near-realtime
            "-auto-alt-ref", "0",  # VP9 transparency fix
            str(output_path)
        ]
        ffmpeg_proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )
    elif export_format == "png":
        output_dir = Path(output_path)
        output_dir.mkdir(parents=True, exist_ok=True)
        
    frame_idx = 0
    start_time = time.perf_counter()
    last_emit = 0.0
    
    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                break
                
            # OpenCV is BGR. Convert to RGB for PIL / rembg
            frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            img = Image.fromarray(frame_rgb)
            
            # Perform background removal
            out_img = remove(img, session=session)
            
            if export_format == "webm":
                rgba_data = out_img.tobytes()
                if ffmpeg_proc and ffmpeg_proc.stdin:
                    ffmpeg_proc.stdin.write(rgba_data)
            elif export_format == "png":
                # Save as frame_0001.png, frame_0002.png etc.
                frame_name = output_dir / f"frame_{frame_idx:04d}.png"
                out_img.save(frame_name, "PNG")
                
            frame_idx += 1
            
            # Emit progress periodically
            now = time.perf_counter()
            if now - last_emit >= 0.35 or frame_idx == total_frames:
                last_emit = now
                percent = 10 + (frame_idx / total_frames) * 90 # scale from 10% to 100%
                elapsed = now - start_time
                fps_val = frame_idx / elapsed if elapsed > 0 else 0.0
                
                # Estimate remaining time
                remaining_frames = max(0, total_frames - frame_idx)
                eta_seconds = remaining_frames / fps_val if fps_val > 0 else 0.0
                eta_str = f"{int(eta_seconds)}s remaining" if eta_seconds > 0 else "estimating..."
                
                if progress_callback:
                    progress_callback(
                        "processing",
                        percent,
                        f"Isolated frame {frame_idx}/{total_frames} ({fps_val:.1f} FPS) — {eta_str}"
                    )
                    
    finally:
        cap.release()
        if ffmpeg_proc:
            if ffmpeg_proc.stdin:
                ffmpeg_proc.stdin.close()
            # Wait for encode to finish
            stdout, stderr = ffmpeg_proc.communicate()
            if ffmpeg_proc.returncode != 0:
                err_msg = stderr.decode("utf-8", errors="replace") if stderr else "Unknown FFmpeg encoding error."
                raise RuntimeError(f"FFmpeg transparent WebM encoding failed:\n{err_msg}")
                
    return frame_idx

def extract_single_frame(video_path: str, output_path: str, frame_index: int):
    """
    Extracts a single frame from the video at frame_index and saves it as an image.
    Uses cv2 for absolute precision and speed.
    """
    import cv2

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"Could not open input video file: {video_path}")
        
    try:
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        if total_frames > 0:
            frame_index = min(max(0, frame_index), total_frames - 1)
            
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_index)
        ret, frame = cap.read()
        if not ret:
            # Fallback to frame 0 if reading at index failed
            cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
            ret, frame = cap.read()
            if not ret:
                raise RuntimeError(f"Could not read frame at index {frame_index} from: {video_path}")
                
        # Save as PNG
        cv2.imwrite(output_path, frame)
    finally:
        cap.release()

def remove_background_frame(
    input_image_path: str,
    output_image_path: str,
    model_key: str,
    force_cpu: bool = False
):
    """
    Runs background removal on a single image frame using the selected model.
    """
    from PIL import Image
    from rembg import remove

    session = create_session(model_key, force_cpu=force_cpu)
    img = Image.open(input_image_path)
    out_img = remove(img, session=session)
    out_img.save(output_image_path, "PNG")
