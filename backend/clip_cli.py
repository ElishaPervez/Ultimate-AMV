import argparse
import json
import os
import subprocess
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from amv_audio.dependencies import ensure_feature_dependencies, repair_missing_module

# Hardware-accelerated DLL discovery for torchcodec/nelux
ffmpeg_shared = Path(sys.executable).parent.parent / "tools" / "ffmpeg-shared"
if ffmpeg_shared.exists():
    os.add_dll_directory(str(ffmpeg_shared.resolve()))

FRAME_W = 48
FRAME_H = 27
FRAME_BYTES = FRAME_W * FRAME_H * 3
PROGRESS_STAGE_ALIASES = {
    "cpu-detect": "analyze",
    "transnet": "analyze",
    "dependency-repair": "dependencies",
    "setup": "dependencies",
    "setup-progress": "dependencies",
}


@dataclass
class VideoInfo:
    codec: str
    fps: float
    duration: float


def emit(payload):
    print(json.dumps(payload), flush=True)


def progress(stage, percent, message, started_at):
    normalized_stage = PROGRESS_STAGE_ALIASES.get(stage, stage)
    emit(
        {
            "type": "progress",
            "stage": normalized_stage,
            "percent": max(0, min(100, float(percent))),
            "message": message,
            "elapsedSeconds": round(time.perf_counter() - started_at, 2),
        }
    )


def require_tool(name):
    bundled = Path(sys.executable).parent.parent / "tools" / f"{name}.exe"
    if not bundled.exists():
        raise RuntimeError(
            f"{name} not found at {bundled}. The app is hermetic — bundled tools/ must contain {name}.exe."
        )
    return str(bundled)


def run(args):
    return subprocess.run(args, capture_output=True, text=True)


def parse_ratio(value):
    if "/" not in value:
        return float(value)
    left, right = value.split("/", 1)
    denominator = float(right)
    if denominator == 0:
        return 0.0
    return float(left) / denominator


def probe_video(ffprobe, input_path):
    result = run(
        [
            ffprobe,
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_name,avg_frame_rate,r_frame_rate:format=duration",
            "-of",
            "json",
            str(input_path),
        ]
    )
    if result.returncode != 0:
        raise RuntimeError((result.stderr or "ffprobe failed").strip())

    payload = json.loads(result.stdout)
    stream = (payload.get("streams") or [{}])[0]
    fmt = payload.get("format") or {}
    codec = str(stream.get("codec_name") or "").lower()
    fps = parse_ratio(str(stream.get("avg_frame_rate") or stream.get("r_frame_rate") or "0/1"))
    duration = float(fmt.get("duration") or 0)

    if not codec:
        raise RuntimeError("Could not read video codec.")
    if fps <= 0:
        raise RuntimeError("Could not read video FPS.")
    if duration <= 0:
        raise RuntimeError("Could not read video duration.")
    return VideoInfo(codec=codec, fps=fps, duration=duration)


def cuvid_decoder(codec):
    if codec == "h264":
        return "h264_cuvid"
    if codec == "hevc":
        return "hevc_cuvid"
    if codec == "av1":
        return "av1_cuvid"
    raise RuntimeError(f"No cuvid decoder mapping for codec: {codec}")


def decode_frames_nvdec(ffmpeg, input_path, info, started_at):
    import numpy as np

    decoder = cuvid_decoder(info.codec)
    estimated_frames = max(1, int(round(info.duration * info.fps)))
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-hwaccel",
        "cuda",
        "-hwaccel_output_format",
        "cuda",
        "-c:v",
        decoder,
        "-i",
        str(input_path),
        "-an",
        "-vf",
        f"scale_cuda={FRAME_W}:{FRAME_H},hwdownload,format=nv12,format=rgb24",
        "-f",
        "image2pipe",
        "-pix_fmt",
        "rgb24",
        "-vcodec",
        "rawvideo",
        "pipe:1",
    ]

    progress("decode", 2, f"Decoding analysis frames with {decoder}...", started_at)
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if process.stdout is None:
        raise RuntimeError("Could not read ffmpeg output.")

    chunks = []
    total = 0
    last_emit = 0.0
    while True:
        chunk = process.stdout.read(FRAME_BYTES * 512)
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
        frames = total // FRAME_BYTES
        now = time.perf_counter()
        if now - last_emit >= 0.25:
            last_emit = now
            stage_percent = min(frames / estimated_frames, 1.0)
            progress("decode", 2 + stage_percent * 46, f"Decoded {frames:,}/{estimated_frames:,} analysis frames", started_at)

    stderr = process.stderr.read().decode("utf-8", errors="replace") if process.stderr else ""
    status = process.wait()
    if status != 0:
        raise RuntimeError(f"ffmpeg NVDEC decode failed:\n{stderr.strip()}")

    payload = b"".join(chunks)
    usable = (len(payload) // FRAME_BYTES) * FRAME_BYTES
    frame_count = usable // FRAME_BYTES
    if frame_count <= 0:
        raise RuntimeError("No frames decoded.")

    progress("decode", 48, f"Decoded {frame_count:,} analysis frames", started_at)
    return np.frombuffer(payload[:usable], dtype=np.uint8).reshape(frame_count, FRAME_H, FRAME_W, 3).copy()


def decode_frames_cpu(ffmpeg, input_path, info, started_at):
    import numpy as np

    estimated_frames = max(1, int(round(info.duration * info.fps)))
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(input_path),
        "-an",
        "-vf",
        f"scale={FRAME_W}:{FRAME_H},format=rgb24",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
    ]

    progress("decode", 2, "Decoding analysis frames with CPU...", started_at)
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if process.stdout is None:
        raise RuntimeError("Could not read ffmpeg output.")

    chunks = []
    total = 0
    last_emit = 0.0
    while True:
        chunk = process.stdout.read(FRAME_BYTES * 512)
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
        frames = total // FRAME_BYTES
        now = time.perf_counter()
        if now - last_emit >= 0.25:
            last_emit = now
            stage_percent = min(frames / estimated_frames, 1.0)
            progress("decode", 2 + stage_percent * 46, f"Decoded {frames:,}/{estimated_frames:,} analysis frames", started_at)

    stderr = process.stderr.read().decode("utf-8", errors="replace") if process.stderr else ""
    status = process.wait()
    if status != 0:
        raise RuntimeError(f"ffmpeg CPU decode failed:\n{stderr.strip()}")

    payload = b"".join(chunks)
    usable = (len(payload) // FRAME_BYTES) * FRAME_BYTES
    frame_count = usable // FRAME_BYTES
    if frame_count <= 0:
        raise RuntimeError("No frames decoded.")

    progress("decode", 48, f"Decoded {frame_count:,} analysis frames", started_at)
    return np.frombuffer(payload[:usable], dtype=np.uint8).reshape(frame_count, FRAME_H, FRAME_W, 3).copy()


def cpu_scores(frames, started_at):
    import numpy as np

    progress("analyze", 50, "Calculating CPU scene-change scores...", started_at)
    diffs = np.mean(np.abs(frames[1:].astype(np.float32) - frames[:-1].astype(np.float32)), axis=(1, 2, 3))
    scores = np.concatenate(([0.0], diffs))
    progress("analyze", 94, "Finished CPU scene-change analysis", started_at)
    return scores


def transnet_scores(frames, threshold, batch_frames, overlap, started_at, model=None):
    import numpy as np
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is not available in PyTorch. This extractor is currently RTX/CUDA-first.")

    device = torch.device("cuda")

    if model is None:
        try:
            from transnetv2_pytorch import TransNetV2
        except ImportError as error:
            raise RuntimeError("transnetv2-pytorch is not installed. Run: python -m pip install transnetv2-pytorch") from error
        model = TransNetV2(device=device)
        model.eval()

    frame_count = len(frames)
    scores = np.zeros(frame_count, dtype=np.float32)
    counts = np.zeros(frame_count, dtype=np.float32)
    stride = max(1, batch_frames - overlap)
    total_windows = max(1, ((frame_count - 1) // stride) + 1)
    done_windows = 0

    progress("analyze", 50, f"Running TransNetV2 on {torch.cuda.get_device_name(0)}...", started_at)
    with torch.inference_mode():
        for window_start in range(0, frame_count, stride):
            window_end = min(frame_count, window_start + batch_frames)
            batch = frames[window_start:window_end]
            if len(batch) == 0:
                continue

            tensor = torch.from_numpy(batch[None]).to(device)
            single_frame_pred, _all_frame_pred = model(tensor)
            pred = torch.sigmoid(single_frame_pred).detach().float().cpu().numpy().reshape(-1)
            pred = pred[: len(batch)]

            scores[window_start:window_end] += pred
            counts[window_start:window_end] += 1
            done_windows += 1

            if done_windows == total_windows or done_windows % 4 == 0:
                stage_percent = done_windows / total_windows
                progress(
                    "analyze",
                    50 + stage_percent * 44,
                    f"Analyzed {min(frame_count, window_end):,}/{frame_count:,} frames",
                    started_at,
                )

    scores /= np.maximum(counts, 1)
    return scores, np.flatnonzero(scores >= threshold).tolist()


def extract_gpu_nelux(input_path, info, threshold, min_clip_seconds, batch_frames, overlap, started_at):
    import torch
    import numpy as np
    from nelux import VideoReader
    from transnetv2_pytorch import TransNetV2

    device = torch.device("cuda")
    
    # --- STAGE 1: Pure Hardware Decode ---
    progress("decode", 1, f"Decoding at 8000+ FPS with Nelux Ultimate...", started_at)

    reader = VideoReader(str(input_path), decode_accelerator="nvdec", resize=(FRAME_W, FRAME_H))
    frame_count = len(reader)
    
    if hasattr(reader, "start_prefetch"):
        reader.start_prefetch(buffer_size=512)
    
    # Pre-allocate tensor to avoid cloning and list appending overhead
    frames_vram = torch.empty((frame_count, FRAME_H, FRAME_W, 3), dtype=torch.uint8, device=device)
    last_emit = time.perf_counter()
    
    actual_frames = 0
    for i in range(frame_count):
        f = reader.read_frame()
        if f is None:
            break
        # Assignment implicitly copies data into the pre-allocated slice
        frames_vram[i] = f
        actual_frames += 1
        
        now = time.perf_counter()
        if now - last_emit >= 0.1: # High frequency update for 8000 FPS
            last_emit = now
            percent = (i / frame_count) * 48 # Decode is the first 48% of total progress
            progress("decode", 2 + percent, f"Decoding analysis frames: {i:,}/{frame_count:,}", started_at)

    if hasattr(reader, "stop_prefetch"):
        reader.stop_prefetch()
        
    # Truncate tensor and frame count to only the frames we actually read
    if actual_frames < frame_count:
        frames_vram = frames_vram[:actual_frames]
        frame_count = actual_frames

    progress("decode", 48, f"Decoded {len(frames_vram):,}/ {frame_count:,} frames to VRAM", started_at)

    # --- STAGE 2: TransNetV2 Analysis ---
    progress("analyze", 50, f"Analyzing frames with TransNetV2...", started_at)

    model = TransNetV2(device=device)
    model.eval()
    
    scores = np.zeros(frame_count, dtype=np.float32)
    counts = np.zeros(frame_count, dtype=np.float32)
    stride = max(1, batch_frames - overlap)
    total_windows = max(1, ((frame_count - 1) // stride) + 1)
    done_windows = 0

    with torch.inference_mode():
        for window_start in range(0, frame_count, stride):
            window_end = min(frame_count, window_start + batch_frames)
            
            # Since frames_vram is a pre-allocated tensor, we can just slice and unsqueeze it
            # instead of stacking a list of clones.
            batch = frames_vram[window_start:window_end].unsqueeze(0)
            if batch.size(1) == 0:
                break

            # Inference
            single_frame_pred, _ = model(batch)
            pred = torch.sigmoid(single_frame_pred).float().cpu().numpy().reshape(-1)
            
            # Match lengths
            indices_count = window_end - window_start
            pred = pred[:indices_count]

            scores[window_start:window_end] += pred
            counts[window_start:window_end] += 1
            done_windows += 1

            if done_windows == total_windows or done_windows % 25 == 0:
                stage_percent = done_windows / total_windows
                progress(
                    "analyze",
                    50 + stage_percent * 46,
                    f"Analyzed {min(frame_count, window_end):,}/{frame_count:,} frames ({round(stage_percent*100)}%)",
                    started_at,
                )

    scores /= np.maximum(counts, 1)
    
    progress("scenes", 96, "Building scene list...", started_at)
    cuts = boundary_frames_to_seconds(scores >= threshold, scores, info.fps, info.duration, min_clip_seconds)
    scenes = scenes_from_cuts(input_path, cuts, info.duration)
    return scenes, cuts


def boundary_frames_to_seconds(boundary_mask, scores, fps, duration, min_clip_seconds):
    import numpy as np

    cuts = []
    index = 0
    while index < len(boundary_mask):
        if not boundary_mask[index]:
            index += 1
            continue

        start = index
        while index < len(boundary_mask) and boundary_mask[index]:
            index += 1
        end = index

        if scores is not None:
            local = scores[start:end]
            frame = start + int(np.argmax(local))
        else:
            frame = (start + end - 1) // 2

        cut = frame / fps
        if min_clip_seconds <= cut <= duration - min_clip_seconds:
            cuts.append(cut)

    merged = []
    for cut in cuts:
        if not merged or cut - merged[-1] >= min_clip_seconds:
            merged.append(cut)
    return merged


def scenes_from_cuts(input_path, cuts, duration):
    boundaries = [0.0, *cuts, duration]
    scenes = []
    for index in range(len(boundaries) - 1):
        start = round(boundaries[index], 3)
        end = round(boundaries[index + 1], 3)
        if end <= start:
            continue
        scenes.append(
            {
                "index": len(scenes),
                "label": f"Scene {len(scenes) + 1:03d}",
                "source": str(input_path),
                "start": start,
                "end": end,
            }
        )
    return scenes


def scenes_from_ranges(input_path, ranges, duration, min_clip_seconds):
    scenes = []
    for start_time, end_time in ranges:
        start = round(max(0.0, float(start_time)), 3)
        end = round(min(duration, float(end_time)), 3)
        if end - start < min_clip_seconds:
            continue
        scenes.append(
            {
                "index": len(scenes),
                "label": f"Scene {len(scenes) + 1:03d}",
                "source": str(input_path),
                "start": start,
                "end": end,
            }
        )
    if not scenes:
        return scenes_from_cuts(input_path, [], duration)
    return scenes


def extract_gpu(input_path, info, threshold, min_clip_seconds, batch_frames, overlap, started_at):
    if info.codec not in {"h264", "hevc", "av1"}:
        raise RuntimeError(f"Unsupported codec for RTX clip extraction: {info.codec!r}. Expected h264, hevc, or av1.")
    ffmpeg = require_tool("ffmpeg")
    progress("probe", 1, f"{info.codec} at {info.fps:.3f} FPS, {info.duration:.1f}s", started_at)

    # Preload TransNetV2 on a background thread while NVDEC decodes — they use different GPU resources
    _preload: dict = {}
    def _load_model():
        try:
            import torch
            from transnetv2_pytorch import TransNetV2
            device = torch.device("cuda")
            m = TransNetV2(device=device)
            m.eval()
            _preload["model"] = m
        except Exception as exc:
            _preload["error"] = exc
    model_thread = threading.Thread(target=_load_model, daemon=True)
    model_thread.start()

    frames = decode_frames_nvdec(ffmpeg, input_path, info, started_at)

    model_thread.join()
    if "error" in _preload:
        raise _preload["error"]

    scores, _boundary_frames = transnet_scores(frames, threshold, batch_frames, overlap, started_at, model=_preload["model"])
    progress("scenes", 96, "Building scene list...", started_at)
    cuts = boundary_frames_to_seconds(scores >= threshold, scores, info.fps, info.duration, min_clip_seconds)
    scenes = scenes_from_cuts(input_path, cuts, info.duration)
    return scenes, cuts


def extract_cpu(input_path, info, cpu_threshold, min_clip_seconds, started_at):
    ffmpeg = require_tool("ffmpeg")
    progress("probe", 1, f"{info.codec} at {info.fps:.3f} FPS, {info.duration:.1f}s", started_at)

    frames = decode_frames_cpu(ffmpeg, input_path, info, started_at)
    scores = cpu_scores(frames, started_at)
    
    progress("scenes", 96, "Building scene list...", started_at)
    cuts = boundary_frames_to_seconds(scores >= cpu_threshold, scores, info.fps, info.duration, min_clip_seconds)
    scenes = scenes_from_cuts(input_path, cuts, info.duration)
    return scenes, cuts


def extract(input_file, mode, threshold, cpu_threshold, min_clip_seconds, batch_frames, overlap, model=None):
    started_at = time.perf_counter()
    input_path = Path(input_file).expanduser().resolve()
    if not input_path.exists():
        raise RuntimeError(f"Input file does not exist: {input_path}")

    gpu = mode == "gpu"
    feature = "clip_gpu" if gpu else "clip_cpu"
    ensure_feature_dependencies(
        feature,
        gpu=gpu,
        progress_callback=lambda stage, percent, message: progress("dependencies", percent, message, started_at),
    )

    ffprobe = require_tool("ffprobe")
    info = probe_video(ffprobe, input_path)

    def run_detection(current_model=None):
        if mode == "gpu":
            try:
                import torch
                import nelux
                from transnetv2_pytorch import TransNetV2
                
                # Use provided model or load one
                active_model = current_model
                if active_model is None:
                    device = torch.device("cuda")
                    active_model = TransNetV2(device=device)
                    active_model.eval()

                return extract_gpu_nelux_with_model(input_path, info, threshold, min_clip_seconds, batch_frames, overlap, started_at, active_model)
            except Exception as e:
                emit({"type": "log", "message": f"Nelux failed, falling back to legacy NVDEC: {e}"})
                return extract_gpu(input_path, info, threshold, min_clip_seconds, batch_frames, overlap, started_at)
        if mode == "cpu":
            return extract_cpu(input_path, info, cpu_threshold, min_clip_seconds, started_at)
        raise RuntimeError("Clip extraction mode must be cpu or gpu.")

    try:
        scenes, cuts = run_detection(model)
    except ModuleNotFoundError as missing:
        if not repair_missing_module(
            missing.name,
            gpu=gpu,
            progress_callback=lambda stage, percent, message: progress("dependencies", percent, message, started_at),
        ):
            raise
        progress("dependencies", 0, "Retrying clip extraction after dependency repair...", started_at)
        scenes, cuts = run_detection(None)

    progress("scenes", 100, f"Detected {len(scenes)} scenes", started_at)

    total_seconds = time.perf_counter() - started_at
    emit(
        {
            "type": "done",
            "mode": mode,
            "input": str(input_path),
            "scenes": scenes,
            "cuts": cuts,
            "sceneCount": len(scenes),
            "fps": round(info.fps, 3),
            "duration": round(info.duration, 3),
            "totalSeconds": round(total_seconds, 2),
        }
    )


def extract_gpu_nelux_with_model(input_path, info, threshold, min_clip_seconds, batch_frames, overlap, started_at, model):
    import torch
    import numpy as np
    from nelux import VideoReader

    device = torch.device("cuda")
    
    # --- STAGE 1: Pure Hardware Decode ---
    progress("decode", 1, f"Decoding at 8000+ FPS with Nelux Ultimate...", started_at)

    reader = VideoReader(str(input_path), decode_accelerator="nvdec", resize=(FRAME_W, FRAME_H))
    frame_count = len(reader)
    
    if hasattr(reader, "start_prefetch"):
        reader.start_prefetch(buffer_size=512)
    
    frames_vram = []
    last_emit = time.perf_counter()
    
    for i in range(frame_count):
        f = reader.read_frame()
        if f is None:
            break
        # Clone to avoid potential buffer reuse issues in Nelux
        frames_vram.append(f.clone())
        
        now = time.perf_counter()
        if now - last_emit >= 0.1: # High frequency update for 8000 FPS
            last_emit = now
            percent = (i / frame_count) * 48 # Decode is the first 48% of total progress
            progress("decode", 2 + percent, f"Decoding analysis frames: {i:,}/{frame_count:,}", started_at)

    if hasattr(reader, "stop_prefetch"):
        reader.stop_prefetch()
        
    progress("decode", 48, f"Decoded {len(frames_vram):,}/ {frame_count:,} frames to VRAM", started_at)

    # --- STAGE 2: TransNetV2 Analysis ---
    progress("analyze", 50, f"Analyzing frames with TransNetV2...", started_at)

    scores = np.zeros(frame_count, dtype=np.float32)
    counts = np.zeros(frame_count, dtype=np.float32)
    stride = max(1, batch_frames - overlap)
    total_windows = max(1, ((frame_count - 1) // stride) + 1)
    done_windows = 0

    with torch.inference_mode():
        for window_start in range(0, frame_count, stride):
            window_end = min(frame_count, window_start + batch_frames)
            
            batch_list = frames_vram[window_start:window_end]
            if not batch_list:
                break

            # Stack directly on GPU and add sequence dimension -> [1, B, 27, 48, 3]
            batch = torch.stack(batch_list).unsqueeze(0)

            # Inference
            single_frame_pred, _ = model(batch)
            pred = torch.sigmoid(single_frame_pred).float().cpu().numpy().reshape(-1)
            
            # Match lengths
            indices_count = window_end - window_start
            pred = pred[:indices_count]

            scores[window_start:window_end] += pred
            counts[window_start:window_end] += 1
            done_windows += 1

            if done_windows == total_windows or done_windows % 25 == 0:
                stage_percent = done_windows / total_windows
                progress(
                    "analyze",
                    50 + stage_percent * 46,
                    f"Analyzed {min(frame_count, window_end):,}/{frame_count:,} frames ({round(stage_percent*100)}%)",
                    started_at,
                )

    scores /= np.maximum(counts, 1)
    
    progress("scenes", 96, "Building scene list...", started_at)
    cuts = boundary_frames_to_seconds(scores >= threshold, scores, info.fps, info.duration, min_clip_seconds)
    scenes = scenes_from_cuts(input_path, cuts, info.duration)
    return scenes, cuts


def server():
    started_at = time.perf_counter()
    emit({"type": "log", "message": "Clip Server warming up..."})
    
    try:
        ensure_feature_dependencies(
            "clip_gpu",
            gpu=True,
            progress_callback=lambda stage, percent, message: progress("dependencies", percent, message, started_at),
        )
        import torch
        import nelux
        from transnetv2_pytorch import TransNetV2
        
        device = torch.device("cuda")
        model = TransNetV2(device=device)
        model.eval()
        
        # Verify CUDA is actually working
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA not available in server mode")
            
        emit({"type": "log", "message": f"Clip Server warmed up on {torch.cuda.get_device_name(0)}"})
    except Exception as e:
        emit({"type": "error", "message": f"Clip Server warmup failed: {e}"})
        return 1

    print("READY", flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
            command = payload.get("command")
            if command == "extract":
                extract(
                    payload["input_file"],
                    payload.get("mode", "gpu"),
                    payload.get("threshold", 0.5),
                    payload.get("cpu_threshold", 27.0),
                    payload.get("min_clip_seconds", 0.35),
                    payload.get("batch_frames", 100),
                    payload.get("overlap", 50),
                    model=model
                )
            elif command == "quit":
                break
            else:
                emit({"type": "error", "message": f"Unknown server command: {command}"})
        except Exception as e:
            emit({"type": "error", "message": f"Server command error: {e}"})
            
    return 0


def main():
    parser = argparse.ArgumentParser(description="Ultimate AMV RTX TransNetV2 clip bridge")
    parser.add_argument("--server", action="store_true", help="Start in persistent server mode")
    sub = parser.add_subparsers(dest="command")
    
    extract_parser = sub.add_parser("extract")
    extract_parser.add_argument("input_file")
    extract_parser.add_argument("--mode", choices=["cpu", "gpu"], default="gpu")
    extract_parser.add_argument("--threshold", type=float, default=0.5)
    extract_parser.add_argument("--cpu-threshold", type=float, default=27.0)
    extract_parser.add_argument("--min-clip-seconds", type=float, default=0.35)
    extract_parser.add_argument("--batch-frames", type=int, default=100)
    extract_parser.add_argument("--overlap", type=int, default=50)
    
    args = parser.parse_args()

    if args.server:
        return server()

    if not args.command:
        parser.print_help()
        return 1

    try:
        if args.command == "extract":
            extract(
                args.input_file,
                args.mode,
                args.threshold,
                args.cpu_threshold,
                args.min_clip_seconds,
                args.batch_frames,
                args.overlap,
            )
            return 0
    except Exception as exc:
        emit({"type": "error", "message": str(exc)})
        return 1
    return 1


if __name__ == "__main__":
    sys.exit(main())
