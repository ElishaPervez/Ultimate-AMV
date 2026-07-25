"""Streaming FFmpeg-to-RIFE frame interpolation."""

import json
import math
import os
import subprocess
import threading
from collections import deque
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path


SCENE_DIFFERENCE_THRESHOLD = 0.075


@dataclass(frozen=True)
class MediaInfo:
    width: int
    height: int
    fps: float
    frame_count: int
    duration: float
    has_audio: bool


def round_up(value, multiple):
    return int(math.ceil(value / multiple) * multiple)


def padded_dimensions(width, height, multiple=64):
    return round_up(width, multiple), round_up(height, multiple)


def pad_frame(frame, multiple=64):
    import numpy as np

    height, width = frame.shape[:2]
    padded_width, padded_height = padded_dimensions(width, height, multiple)
    if (padded_width, padded_height) == (width, height):
        return frame, (height, width)
    return np.pad(
        frame,
        ((0, padded_height - height), (0, padded_width - width), (0, 0)),
        mode="edge",
    ), (height, width)


def crop_frame(frame, original_shape):
    height, width = original_shape
    return frame[:height, :width]


def scene_difference(first, second):
    """Return a cheap normalized difference score for a consecutive pair."""
    import numpy as np

    height, width = first.shape[:2]
    row_step = max(1, height // 64)
    column_step = max(1, width // 64)
    sampled_first = first[::row_step, ::column_step].astype(np.float32)
    sampled_second = second[::row_step, ::column_step].astype(np.float32)
    first_gray = (
        sampled_first[..., 0] * 0.299
        + sampled_first[..., 1] * 0.587
        + sampled_first[..., 2] * 0.114
    )
    second_gray = (
        sampled_second[..., 0] * 0.299
        + sampled_second[..., 1] * 0.587
        + sampled_second[..., 2] * 0.114
    )
    return float(np.mean(((first_gray - second_gray) / 255.0) ** 2))


def is_scene_cut(first, second, threshold=SCENE_DIFFERENCE_THRESHOLD):
    # Clips normally contain one shot. This inexpensive guard exists because a
    # user can still drag in an arbitrary video; without it RIFE visibly morphs
    # two unrelated shots across an internal hard cut.
    return scene_difference(first, second) >= threshold


def output_fps(source_fps, factor):
    if factor not in (2, 3, 4):
        raise ValueError("Interpolation factor must be 2, 3, or 4")
    return float(source_fps) * factor


def _parse_fraction(value):
    if not value or value == "0/0":
        return 0.0
    return float(Fraction(value))


def resolve_tool(name):
    tools_root = os.environ.get("ULTIMATE_AMV_TOOLS_DIR")
    if not tools_root:
        raise FileNotFoundError(
            "The bundled tools directory was not provided to the interpolation process."
        )
    path = Path(tools_root) / f"{name}.exe"
    if not path.is_file():
        raise FileNotFoundError(
            f"The bundled {name} tool is missing. Restart the app to repair its tools."
        )
    return str(path)


def probe_media(input_path, ffprobe_path=None):
    ffprobe = ffprobe_path or resolve_tool("ffprobe")
    command = [
        ffprobe,
        "-v",
        "error",
        "-count_frames",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,avg_frame_rate,r_frame_rate,nb_read_frames,nb_frames,duration",
        "-show_entries",
        "format=duration",
        "-show_streams",
        "-of",
        "json",
        str(input_path),
    ]
    result = subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "FFprobe could not inspect the input video.")
    payload = json.loads(result.stdout)
    streams = payload.get("streams") or []
    video = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
    if not video:
        raise ValueError("The selected file has no video stream.")
    fps = _parse_fraction(video.get("avg_frame_rate")) or _parse_fraction(
        video.get("r_frame_rate")
    )
    if fps <= 0:
        raise ValueError("The input video's frame rate could not be read.")
    duration = float(
        video.get("duration")
        or (payload.get("format") or {}).get("duration")
        or 0
    )
    frame_count = int(video.get("nb_read_frames") or video.get("nb_frames") or 0)
    if frame_count <= 0 and duration > 0:
        frame_count = max(1, round(duration * fps))
    return MediaInfo(
        width=int(video["width"]),
        height=int(video["height"]),
        fps=fps,
        frame_count=frame_count,
        duration=duration,
        has_audio=any(stream.get("codec_type") == "audio" for stream in streams),
    )


def _drain_stream(stream, tail):
    try:
        for raw_line in iter(stream.readline, b""):
            tail.append(raw_line.decode("utf-8", errors="replace").strip())
    finally:
        stream.close()


def _read_frame(stream, frame_bytes):
    data = bytearray()
    while len(data) < frame_bytes:
        chunk = stream.read(frame_bytes - len(data))
        if not chunk:
            break
        data.extend(chunk)
    if not data:
        return None
    if len(data) != frame_bytes:
        raise RuntimeError("FFmpeg returned an incomplete decoded video frame.")
    return bytes(data)


def _decoder_command(ffmpeg, input_path):
    return [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(input_path),
        "-map",
        "0:v:0",
        "-vsync",
        "0",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
    ]


def _encoder_command(
    ffmpeg,
    input_path,
    output_path,
    width,
    height,
    fps,
    use_gpu,
    has_audio,
):
    fps_text = f"{fps:.8f}".rstrip("0").rstrip(".")
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-s:v",
        f"{width}x{height}",
        "-r",
        fps_text,
        "-i",
        "pipe:0",
    ]
    if has_audio:
        command.extend(["-i", str(input_path)])
    command.extend(["-map", "0:v:0"])
    if has_audio:
        command.extend(["-map", "1:a:0?", "-c:a", "copy"])
    if use_gpu:
        command.extend(
            [
                "-c:v",
                "h264_nvenc",
                "-preset",
                "p5",
                "-tune",
                "hq",
                "-rc",
                "vbr",
                "-cq",
                "18",
                "-b:v",
                "0",
            ]
        )
    else:
        command.extend(["-c:v", "libx264", "-preset", "medium", "-crf", "18"])
    command.extend(
        [
            "-pix_fmt",
            "yuv420p",
            "-r",
            fps_text,
            "-movflags",
            "+faststart",
            "-shortest",
            str(output_path),
        ]
    )
    return command


def interpolate_clip(
    input_path,
    output_path,
    model,
    factor,
    use_gpu,
    progress_callback=None,
    ffmpeg_path=None,
    ffprobe_path=None,
):
    """Interpolate one clip while retaining only two decoded frames."""
    import numpy as np

    ffmpeg = ffmpeg_path or resolve_tool("ffmpeg")
    info = probe_media(input_path, ffprobe_path=ffprobe_path)
    destination = Path(output_path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.unlink(missing_ok=True)
    target_fps = output_fps(info.fps, factor)
    frame_bytes = info.width * info.height * 3
    decode_tail = deque(maxlen=30)
    encode_tail = deque(maxlen=30)

    decoder = subprocess.Popen(
        _decoder_command(ffmpeg, input_path),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    encoder = subprocess.Popen(
        _encoder_command(
            ffmpeg,
            input_path,
            output_path,
            info.width,
            info.height,
            target_fps,
            use_gpu,
            info.has_audio,
        ),
        stdin=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    decode_thread = threading.Thread(
        target=_drain_stream, args=(decoder.stderr, decode_tail), daemon=True
    )
    encode_thread = threading.Thread(
        target=_drain_stream, args=(encoder.stderr, encode_tail), daemon=True
    )
    decode_thread.start()
    encode_thread.start()
    source_frames = 0
    written_frames = 0
    scene_holds = 0

    def report(stage, percent, message):
        if progress_callback:
            progress_callback(stage, percent, message)

    try:
        first_bytes = _read_frame(decoder.stdout, frame_bytes)
        if first_bytes is None:
            raise ValueError("FFmpeg decoded no video frames from the selected file.")
        first = np.frombuffer(first_bytes, dtype=np.uint8).reshape(
            info.height, info.width, 3
        )
        source_frames = 1
        encoder.stdin.write(first.tobytes())
        written_frames = 1

        while True:
            second_bytes = _read_frame(decoder.stdout, frame_bytes)
            if second_bytes is None:
                break
            second = np.frombuffer(second_bytes, dtype=np.uint8).reshape(
                info.height, info.width, 3
            )
            source_frames += 1
            cut = is_scene_cut(first, second)
            padded_first, original_shape = pad_frame(first)
            padded_second, _ = pad_frame(second)
            if cut:
                scene_holds += 1
                model.reset_state()
            for step in range(1, factor):
                if cut:
                    intermediate = first
                else:
                    intermediate = crop_frame(
                        model.interpolate(padded_first, padded_second, step / factor),
                        original_shape,
                    )
                encoder.stdin.write(intermediate.tobytes())
                written_frames += 1
            encoder.stdin.write(second.tobytes())
            written_frames += 1
            first = second
            percent = (
                min(99.0, source_frames / info.frame_count * 100.0)
                if info.frame_count
                else -1
            )
            report(
                "interpolate",
                percent,
                f"Interpolated {source_frames:,} source frames",
            )

        decoder.stdout.close()
        decoder_code = decoder.wait()
        decode_thread.join(timeout=2)
        if decoder_code != 0:
            raise RuntimeError(
                "\n".join(decode_tail)
                or "FFmpeg stopped while decoding the source video."
            )
        report("encode", 99, "Finishing video and copying audio")
        encoder.stdin.close()
        encoder_code = encoder.wait()
        encode_thread.join(timeout=2)
        if encoder_code != 0:
            raise RuntimeError(
                "\n".join(encode_tail)
                or "FFmpeg could not finish the interpolated video."
            )
        report("encode", 100, "Interpolated video finished")
        return {
            "input": str(input_path),
            "output": str(output_path),
            "sourceFrames": source_frames,
            "outputFrames": written_frames,
            "sourceFps": info.fps,
            "outputFps": target_fps,
            "sceneHolds": scene_holds,
        }
    except BaseException:
        for process in (decoder, encoder):
            if process.poll() is None:
                process.kill()
        destination.unlink(missing_ok=True)
        raise


def process_batch(
    jobs,
    model,
    factor,
    use_gpu,
    progress_callback=None,
    ffmpeg_path=None,
    ffprobe_path=None,
):
    outcomes = []
    clip_count = len(jobs)
    for clip_index, job in enumerate(jobs, start=1):
        input_path = Path(job["input"]).expanduser().resolve()
        output_path = Path(job["output"]).expanduser().resolve()

        def clip_progress(stage, percent, message):
            if progress_callback:
                progress_callback(
                    stage,
                    percent,
                    message,
                    clip_index,
                    clip_count,
                    input_path.name,
                )

        try:
            if not input_path.is_file():
                raise FileNotFoundError(f"Input video was not found: {input_path}")
            result = interpolate_clip(
                input_path,
                output_path,
                model,
                factor,
                use_gpu,
                progress_callback=clip_progress,
                ffmpeg_path=ffmpeg_path,
                ffprobe_path=ffprobe_path,
            )
            outcomes.append({"ok": True, **result})
        except Exception as error:
            Path(output_path).unlink(missing_ok=True)
            outcomes.append(
                {
                    "ok": False,
                    "input": str(input_path),
                    "output": str(output_path),
                    "error": str(error),
                }
            )
    return outcomes
