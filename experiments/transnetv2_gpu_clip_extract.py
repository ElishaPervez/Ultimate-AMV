"""
RTX-first TransNetV2 clip extractor prototype.

Install dependency:
    python -m pip install transnetv2-pytorch

Usage:
    python experiments/transnetv2_gpu_clip_extract.py "C:\\path\\episode.mp4"
    python experiments/transnetv2_gpu_clip_extract.py

What it does:
    1. Decodes the input with NVIDIA NVDEC through ffmpeg.
    2. Feeds 48x27 RGB frames into transnetv2-pytorch on CUDA.
    3. Converts detected shot boundaries into segment times.
    4. Re-encodes exact-cut clips with NVIDIA NVENC into a new folder.

This is intentionally not a general fallback script. It is tuned for a Windows
RTX machine with a full ffmpeg build that supports cuvid decoders and nvenc.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

FRAME_W = 48
FRAME_H = 27
FRAME_BYTES = FRAME_W * FRAME_H * 3
BAR_WIDTH = 28


@dataclass
class VideoInfo:
    codec: str
    fps: float
    duration: float


class StepTimer:
    def __init__(self, label: str) -> None:
        self.label = label
        self.start = time.perf_counter()
        print(f"\n{label}...")

    def done(self, detail: str = "") -> float:
        elapsed = time.perf_counter() - self.start
        suffix = f"  {detail}" if detail else ""
        print(f"{self.label} done in {format_elapsed(elapsed)}.{suffix}")
        return elapsed


def format_elapsed(seconds: float) -> str:
    total = max(0, int(seconds))
    hours = total // 3600
    minutes = (total % 3600) // 60
    secs = total % 60
    if hours:
        return f"{hours:02}:{minutes:02}:{secs:02}"
    return f"{minutes:02}:{secs:02}"


def render_progress(label: str, current: float, total: float, start: float, extra: str = "") -> None:
    if total <= 0:
        return
    fraction = max(0.0, min(1.0, current / total))
    filled = int(round(fraction * BAR_WIDTH))
    bar = "#" * filled + "-" * (BAR_WIDTH - filled)
    elapsed = time.perf_counter() - start
    rate = current / elapsed if elapsed > 0 else 0.0
    eta = (total - current) / rate if rate > 0 else 0.0
    line = (
        f"\r{label:<12} [{bar}] {fraction * 100:6.2f}%  "
        f"elapsed {format_elapsed(elapsed)}  eta {format_elapsed(eta)}"
    )
    if extra:
        line += f"  {extra}"
    print(line[:180], end="", flush=True)


def finish_progress() -> None:
    print("", flush=True)


def require_tool(name: str) -> str:
    resolved = shutil.which(name) or shutil.which(f"{name}.exe")
    if not resolved:
        raise RuntimeError(f"{name} was not found on PATH.")
    return resolved


def run(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, capture_output=True, text=True)


def ffprobe_json(ffprobe: str, input_path: Path) -> dict:
    result = run([
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
    ])
    if result.returncode != 0:
        raise RuntimeError((result.stderr or "ffprobe failed").strip())
    return json.loads(result.stdout)


def parse_ratio(value: str) -> float:
    if "/" not in value:
        return float(value)
    left, right = value.split("/", 1)
    denominator = float(right)
    if denominator == 0:
        return 0.0
    return float(left) / denominator


def probe_video(ffprobe: str, input_path: Path) -> VideoInfo:
    payload = ffprobe_json(ffprobe, input_path)
    stream = (payload.get("streams") or [{}])[0]
    fmt = payload.get("format") or {}
    codec = str(stream.get("codec_name") or "").lower()
    fps = parse_ratio(str(stream.get("avg_frame_rate") or stream.get("r_frame_rate") or "0/1"))
    duration = float(fmt.get("duration") or 0)

    if codec not in {"h264", "hevc"}:
        raise RuntimeError(f"Unsupported codec for this RTX prototype: {codec!r}. Expected h264 or hevc.")
    if fps <= 0:
        raise RuntimeError("Could not read video FPS.")
    if duration <= 0:
        raise RuntimeError("Could not read video duration.")

    return VideoInfo(codec=codec, fps=fps, duration=duration)


def cuvid_decoder(codec: str) -> str:
    if codec == "h264":
        return "h264_cuvid"
    if codec == "hevc":
        return "hevc_cuvid"
    raise RuntimeError(f"No cuvid decoder mapping for codec: {codec}")


def unique_output_dir(input_path: Path, output_root: Path | None) -> Path:
    root = output_root or input_path.parent
    base = root / f"{input_path.stem}_transnetv2_clips"
    candidate = base
    index = 1
    while candidate.exists():
        candidate = root / f"{base.name}_{index}"
        index += 1
    candidate.mkdir(parents=True)
    return candidate


def decode_frames_nvdec(ffmpeg: str, input_path: Path, info: VideoInfo) -> np.ndarray:
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
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
    ]

    timer = StepTimer(f"Decode analysis frames with {decoder}")
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert process.stdout is not None

    chunks: list[bytes] = []
    total = 0
    last_draw = 0.0
    while True:
        chunk = process.stdout.read(FRAME_BYTES * 512)
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
        frames = total // FRAME_BYTES
        now = time.perf_counter()
        if now - last_draw >= 0.25:
            last_draw = now
            render_progress("Decode", min(frames, estimated_frames), estimated_frames, timer.start, f"{frames:,} frames")

    stderr = process.stderr.read().decode("utf-8", errors="replace") if process.stderr else ""
    status = process.wait()
    finish_progress()
    if status != 0:
        raise RuntimeError(f"ffmpeg NVDEC decode failed:\n{stderr.strip()}")

    payload = b"".join(chunks)
    usable = (len(payload) // FRAME_BYTES) * FRAME_BYTES
    frame_count = usable // FRAME_BYTES
    if frame_count <= 0:
        raise RuntimeError("No frames decoded.")

    elapsed = time.perf_counter() - timer.start
    timer.done(f"{frame_count:,} frames at {frame_count / max(elapsed, 0.001):.1f} FPS")
    return np.frombuffer(payload[:usable], dtype=np.uint8).reshape(frame_count, FRAME_H, FRAME_W, 3).copy()


def boundary_frames_to_seconds(
    boundary_mask: np.ndarray,
    scores: np.ndarray | None,
    fps: float,
    duration: float,
    min_clip_seconds: float,
) -> list[float]:
    import numpy as np

    cuts: list[float] = []
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

    merged: list[float] = []
    for cut in cuts:
        if not merged or cut - merged[-1] >= min_clip_seconds:
            merged.append(cut)
    return merged


def transnet_scores(
    frames: np.ndarray,
    threshold: float,
    batch_frames: int,
    overlap: int,
) -> tuple[np.ndarray, list[int]]:
    import numpy as np
    import torch

    try:
        from transnetv2_pytorch import TransNetV2
    except ImportError as error:
        raise RuntimeError(
            "transnetv2-pytorch is not installed. Run: python -m pip install transnetv2-pytorch"
        ) from error

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is not available in PyTorch. This prototype is RTX/CUDA-first.")

    device = torch.device("cuda")
    model = TransNetV2(device=device)
    model.eval()

    frame_count = len(frames)
    scores = np.zeros(frame_count, dtype=np.float32)
    counts = np.zeros(frame_count, dtype=np.float32)
    stride = max(1, batch_frames - overlap)

    total_windows = max(1, ((frame_count - 1) // stride) + 1)
    done_windows = 0
    timer = StepTimer(f"Run TransNetV2 on CUDA in {batch_frames}-frame windows")
    last_draw = 0.0
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

            now = time.perf_counter()
            if now - last_draw >= 0.25 or done_windows == total_windows:
                last_draw = now
                analyzed = min(frame_count, window_end)
                render_progress(
                    "TransNetV2",
                    done_windows,
                    total_windows,
                    timer.start,
                    f"{analyzed:,}/{frame_count:,} frames",
                )

    scores /= np.maximum(counts, 1)
    finish_progress()
    elapsed = time.perf_counter() - timer.start
    timer.done(f"{frame_count:,} frames at {frame_count / max(elapsed, 0.001):.1f} FPS")
    return scores, np.flatnonzero(scores >= threshold).tolist()


def write_cuts_manifest(output_dir: Path, cuts: list[float]) -> None:
    (output_dir / "cuts.txt").write_text(
        "\n".join(f"{cut:.6f}" for cut in cuts) + ("\n" if cuts else ""),
        encoding="utf-8",
    )


def run_ffmpeg_with_progress(command: list[str], duration_seconds: float, start: float, label: str) -> None:
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    assert process.stdout is not None
    assert process.stderr is not None

    last_draw = 0.0
    last_fps = ""
    last_speed = ""
    stderr_lines: list[str] = []

    for line in process.stdout:
        key, _, value = line.strip().partition("=")
        if key == "fps":
            last_fps = value
        elif key == "speed":
            last_speed = value
        elif key == "out_time_ms":
            try:
                done_seconds = int(value) / 1_000_000.0
            except ValueError:
                continue
            now = time.perf_counter()
            if now - last_draw >= 0.25:
                last_draw = now
                extra = " ".join(part for part in [f"fps={last_fps}" if last_fps else "", f"speed={last_speed}" if last_speed else ""] if part)
                render_progress(label, min(done_seconds, duration_seconds), duration_seconds, start, extra)
        elif key == "progress" and value == "end":
            break

    stderr_text = process.stderr.read()
    if stderr_text:
        stderr_lines.append(stderr_text)

    status = process.wait()
    render_progress(label, duration_seconds, duration_seconds, start, "done")
    finish_progress()
    if status != 0:
        raise RuntimeError(f"ffmpeg failed with exit code {status}:\n{''.join(stderr_lines).strip()}")


def segment_with_nvenc(
    ffmpeg: str,
    input_path: Path,
    output_dir: Path,
    info: VideoInfo,
    cuts: list[float],
    qp: int,
) -> None:
    decoder = cuvid_decoder(info.codec)
    segment_times = ",".join(f"{cut:.6f}" for cut in cuts)
    timer = StepTimer(f"Write clips with {decoder} -> hevc_nvenc")

    if not cuts:
        output_file = output_dir / f"{input_path.stem}_clip_0000.mov"
        command = [
            ffmpeg,
            "-y",
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
            "-map",
            "0:v:0",
            "-map",
            "0:a?",
            "-c:v",
            "hevc_nvenc",
            "-preset",
            "p1",
            "-rc",
            "constqp",
            "-qp",
            str(qp),
            "-g",
            "0",
            "-bf",
            "0",
            "-profile:v",
            "main10",
            "-highbitdepth",
            "1",
            "-c:a",
            "copy",
            "-progress",
            "pipe:1",
            "-stats_period",
            "0.5",
            str(output_file),
        ]
        print("No cuts detected. Writing one GPU transcode.")
        run_ffmpeg_with_progress(command, info.duration, timer.start, "NVENC")
        timer.done("1 clip")
        return

    output_pattern = output_dir / f"{input_path.stem}_clip_%04d.mov"

    command = [
        ffmpeg,
        "-y",
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
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-c:v",
        "hevc_nvenc",
        "-preset",
        "p1",
        "-rc",
        "constqp",
        "-qp",
        str(qp),
        "-g",
        "0",
        "-bf",
        "0",
        "-profile:v",
        "main10",
        "-highbitdepth",
        "1",
        "-c:a",
        "copy",
        "-f",
        "segment",
        "-reset_timestamps",
        "1",
        "-progress",
        "pipe:1",
        "-stats_period",
        "0.5",
    ]

    if segment_times:
        command.extend(["-segment_times", segment_times])

    command.append(str(output_pattern))

    print(f"Writing {len(cuts) + 1} exact-cut clips.")
    run_ffmpeg_with_progress(command, info.duration, timer.start, "NVENC")
    timer.done(f"{len(cuts) + 1} clips")


def select_input_file() -> Path | None:
    try:
        import tkinter as tk
        from tkinter import filedialog
    except Exception as error:
        raise RuntimeError(f"Could not open file picker: {error}") from error

    root = tk.Tk()
    root.withdraw()
    root.update()
    try:
        selected = filedialog.askopenfilename(
            title="Choose an episode/video to split",
            filetypes=[
                ("Video files", "*.mp4 *.mkv *.mov *.webm *.avi"),
                ("All files", "*.*"),
            ],
        )
    finally:
        root.destroy()

    if not selected:
        return None
    return Path(selected)


def main() -> int:
    total_start = time.perf_counter()
    parser = argparse.ArgumentParser(description="RTX-first TransNetV2 clip extractor.")
    parser.add_argument("input", type=Path, nargs="?", help="Input anime episode/video. Opens a file picker if omitted.")
    parser.add_argument("--output-root", type=Path, default=None, help="Folder where the per-video clip folder is created.")
    parser.add_argument("--threshold", type=float, default=0.5, help="TransNetV2 boundary threshold.")
    parser.add_argument("--min-clip-seconds", type=float, default=0.35, help="Merge/ignore cuts closer than this.")
    parser.add_argument("--batch-frames", type=int, default=100, help="Frames per TransNetV2 inference window.")
    parser.add_argument("--overlap", type=int, default=50, help="Overlap between inference windows.")
    parser.add_argument("--qp", type=int, default=16, help="NVENC constqp value. Lower is higher quality/larger files.")
    args = parser.parse_args()

    input_arg = args.input
    if input_arg is None:
        selected = select_input_file()
        if selected is None:
            print("No file selected.")
            return 0
        input_arg = selected

    input_path = input_arg.expanduser().resolve()
    if not input_path.is_file():
        raise SystemExit(f"Input file not found: {input_path}")

    ffmpeg = require_tool("ffmpeg")
    ffprobe = require_tool("ffprobe")
    info = probe_video(ffprobe, input_path)
    output_dir = unique_output_dir(input_path, args.output_root.resolve() if args.output_root else None)

    print(f"Input:  {input_path}")
    print(f"Codec:  {info.codec} -> {cuvid_decoder(info.codec)}")
    print(f"FPS:    {info.fps:.3f}")
    print(f"Length: {info.duration:.1f}s")
    print(f"Output: {output_dir}")

    frames = decode_frames_nvdec(ffmpeg, input_path, info)
    scores, _indices = transnet_scores(frames, args.threshold, args.batch_frames, args.overlap)

    timer = StepTimer("Build cut list")
    cuts = boundary_frames_to_seconds(
        scores >= args.threshold,
        scores,
        info.fps,
        info.duration,
        args.min_clip_seconds,
    )
    write_cuts_manifest(output_dir, cuts)
    timer.done(f"{len(cuts)} cuts. Manifest: {output_dir / 'cuts.txt'}")

    segment_with_nvenc(ffmpeg, input_path, output_dir, info, cuts, args.qp)

    clips = sorted(output_dir.glob(f"{input_path.stem}_clip_*.mov"))
    total_elapsed = time.perf_counter() - total_start
    print(f"\nAll done in {format_elapsed(total_elapsed)}. Created {len(clips)} clips:")
    for clip in clips[:12]:
        print(f"  {clip.name}")
    if len(clips) > 12:
        print(f"  ... {len(clips) - 12} more")

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
