import os
import sys
import time
import threading
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
    progress_callback = None,
    showcase_path: str = None
):
    """
    Processes video frame-by-frame, removes background with the selected model,
    and encodes the output as ProRes MOV / WebM with alpha or a PNG sequence.

    Returns (frames, fps, showcase): when showcase_path is given, a compact
    VP9+alpha preview of the finished export is encoded there for in-app
    comparison playback (WebView2 can't decode ProRes and a PNG sequence
    isn't a video). Showcase failure is non-fatal — showcase is None then.
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
    stderr_tail = []

    if export_format in ("webm", "mov"):
        ffmpeg_bin = require_tool("ffmpeg")
        safe_fps = fps if fps and fps > 0 else 24
        # Common raw RGBA stdin pipeline; -nostats keeps the encode chatter
        # off stderr so the drain thread only carries real errors.
        cmd = [
            ffmpeg_bin,
            "-y",
            "-hide_banner", "-nostats", "-loglevel", "error",
            "-f", "rawvideo",
            "-vcodec", "rawvideo",
            "-s", f"{width}x{height}",
            "-pix_fmt", "rgba",
            "-r", str(safe_fps),
            "-i", "-",
            "-an",
        ]
        if export_format == "webm":
            # VP9 with alpha: compact transparent video for web/OBS use.
            cmd += [
                "-c:v", "libvpx-vp9",
                "-pix_fmt", "yuva420p",
                "-b:v", "0",
                "-crf", "22",          # Balanced high quality
                "-speed", "6",         # Fast encode speed for vp9 realtime/near-realtime
                "-auto-alt-ref", "0",  # VP9 transparency fix
            ]
        else:
            # ProRes 4444 with alpha: the transparent format editors actually
            # import (Premiere, After Effects, DaVinci Resolve).
            cmd += [
                "-c:v", "prores_ks",
                "-profile:v", "4444",
                "-pix_fmt", "yuva444p10le",
                "-vendor", "apl0",
            ]
        cmd.append(str(output_path))
        ffmpeg_proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE
        )

        # Drain stderr on a thread: with stderr left undrained, a chatty
        # encode fills the 64KB pipe buffer, ffmpeg blocks on stderr writes,
        # stops reading stdin, and the frame loop deadlocks mid-job.
        def _drain_stderr(proc=ffmpeg_proc):
            for raw_line in proc.stderr:
                stderr_tail.append(raw_line)
                if len(stderr_tail) > 200:
                    del stderr_tail[0]
        stderr_thread = threading.Thread(target=_drain_stderr, daemon=True)
        stderr_thread.start()
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
            
            if export_format in ("webm", "mov"):
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
            # Wait for encode to finish; stderr is consumed by the drain thread.
            ffmpeg_proc.wait()
            stderr_thread.join(timeout=5)
            if ffmpeg_proc.returncode != 0:
                err_msg = (
                    b"".join(stderr_tail).decode("utf-8", errors="replace").strip()
                    or "Unknown FFmpeg encoding error."
                )
                raise RuntimeError(f"FFmpeg transparent video encoding failed:\n{err_msg}")

    showcase_file = None
    if showcase_path and frame_idx > 0:
        if progress_callback:
            progress_callback("showcase", 99, "Encoding comparison preview...")
        showcase_file = _build_showcase(export_format, output_path, output_dir, fps, showcase_path)

    return frame_idx, fps, showcase_file


def _build_showcase(export_format, output_path, png_dir, fps, showcase_path):
    """Encode a compact VP9+alpha WebM of the finished export for the in-app
    before/after player. Best-effort: the export already succeeded, so any
    failure here just disables the showcase instead of failing the job."""
    try:
        ffmpeg_bin = require_tool("ffmpeg")
        target = Path(showcase_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        safe_fps = fps if fps and fps > 0 else 24
        if export_format == "png":
            input_args = ["-framerate", str(safe_fps), "-i", str(Path(png_dir) / "frame_%04d.png")]
        else:
            input_args = ["-i", str(output_path)]
        cmd = [
            ffmpeg_bin,
            "-y", "-hide_banner", "-nostats", "-loglevel", "error",
            *input_args,
            "-an",
            "-vf", "scale=-2:min(720\\,ih)",
            "-c:v", "libvpx-vp9",
            "-pix_fmt", "yuva420p",
            "-b:v", "0",
            "-crf", "32",
            "-speed", "8",
            "-row-mt", "1",
            "-auto-alt-ref", "0",
            str(target),
        ]
        result = subprocess.run(cmd, capture_output=True, check=False)
        if result.returncode != 0 or not target.exists():
            return None
        return str(target)
    except Exception:
        return None

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
