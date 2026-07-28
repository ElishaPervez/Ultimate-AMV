"""Streaming FFmpeg-to-RIFE frame interpolation."""

import json
import math
import os
import subprocess
import threading
import time
from collections import deque
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path

# Output settings live in amv_video so the dead-frame remover writes files with
# exactly the same encoder behaviour. Re-exported here because callers (and the
# tests) still reach for them through this module.
from amv_video.encode import (  # noqa: F401
    OUTPUT_FORMAT_KEYS,
    OUTPUT_FORMATS,
    QUICKTIME_AUDIO_CODECS,
    QUICKTIME_CONTAINERS,
    _audio_args,
    _encoder_command,
    _rate_args,
    _video_args,
    format_extension,
)


SCENE_DIFFERENCE_THRESHOLD = 0.075
INTERPOLATION_FACTORS = (2, 3, 4)
SLOW_MOTION_FACTORS = (2, 3, 4, 8, 16, 32, 64)


def _stop_process(process, timeout=5):
    """Kill a helper process and wait for it to actually be gone.

    On Windows kill() only *requests* termination; the process keeps its file
    handles for a moment afterwards. Returning before it exits is what made a
    partially written output file impossible to delete.
    """
    if process.poll() is None:
        try:
            process.kill()
        except OSError:
            return
    try:
        process.wait(timeout=timeout)
    except Exception:
        pass


def discard_partial_output(path, attempts=20, delay=0.1):
    """Delete a half-written output file, tolerating a still-closing writer.

    Returns True if the file is gone. Never raises: this only ever runs while
    another failure is already being reported, and an exception here would
    REPLACE that failure. A PyTorch error once reached the user as "the file is
    being used by another process" for exactly that reason.
    """
    target = Path(path)
    for attempt in range(attempts):
        try:
            target.unlink(missing_ok=True)
            return True
        except OSError:
            if attempt == attempts - 1:
                return False
            time.sleep(delay)
    return False


@dataclass(frozen=True)
class MediaInfo:
    width: int
    height: int
    fps: float
    frame_count: int
    duration: float
    has_audio: bool
    audio_codec: str = ""


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


def output_fps(source_fps, factor=None, target_fps=None):
    if target_fps is not None:
        target = float(target_fps)
        if not math.isfinite(target) or target <= source_fps:
            raise ValueError(
                "Target frame rate must be higher than the source frame rate."
            )
        return target
    if factor not in INTERPOLATION_FACTORS:
        raise ValueError("Interpolation factor must be 2, 3, or 4")
    return float(source_fps) * factor


def interpolation_rates(source_fps, factor, target_fps=None, slow_motion=False):
    if slow_motion and target_fps is not None:
        raise ValueError("Slow motion cannot be combined with a target frame rate.")
    if slow_motion:
        if factor not in SLOW_MOTION_FACTORS:
            raise ValueError(
                "Slow-motion factor must be 2, 3, 4, 8, 16, 32, or 64"
            )
        generated_fps = float(source_fps) * factor
    else:
        generated_fps = output_fps(source_fps, factor=factor, target_fps=target_fps)
    playback_fps = float(source_fps) if slow_motion else generated_fps
    return generated_fps, playback_fps


def pair_timesteps(source_fps, target_fps, pair_index, next_output_index):
    """Return output positions inside one source-frame interval."""
    pair_start = pair_index / source_fps
    pair_end = (pair_index + 1) / source_fps
    timesteps = []
    epsilon = 1e-9
    while next_output_index / target_fps < pair_end - epsilon:
        output_time = next_output_index / target_fps
        timestep = (output_time - pair_start) * source_fps
        if timestep >= -epsilon:
            timesteps.append(max(0.0, min(1.0, timestep)))
        next_output_index += 1
    return timesteps, next_output_index


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


def probe_audio_codec(input_path, ffprobe_path=None):
    """Return the source's first audio codec, or an empty string if silent.

    This is a separate probe on purpose. The video probe below restricts itself
    to the first video stream so that frame counting stays cheap, which means
    its stream list can never contain audio -- reading `has_audio` off that list
    silently stripped the soundtrack from every interpolated clip. The codec
    name is what decides whether the track can be copied into the chosen
    container or has to be converted.
    """
    ffprobe = ffprobe_path or resolve_tool("ffprobe")
    result = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-select_streams",
            "a",
            "-show_entries",
            "stream=codec_name",
            "-of",
            "csv=p=0",
            str(input_path),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if result.returncode != 0:
        return ""
    for line in result.stdout.splitlines():
        name = line.strip()
        if name:
            return name.lower()
    return ""


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
    audio_codec = probe_audio_codec(input_path, ffprobe_path=ffprobe)
    return MediaInfo(
        width=int(video["width"]),
        height=int(video["height"]),
        fps=fps,
        frame_count=frame_count,
        duration=duration,
        has_audio=bool(audio_codec),
        audio_codec=audio_codec,
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


def interpolate_clip(
    input_path,
    output_path,
    model,
    factor,
    use_gpu,
    target_fps=None,
    slow_motion=False,
    rate_mode="quality",
    quality=18,
    bitrate_mbps=20.0,
    output_format="h264-mp4",
    max_model_dimension=1920,
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
    generated_fps, playback_fps = interpolation_rates(
        info.fps,
        factor,
        target_fps=target_fps,
        slow_motion=slow_motion,
    )
    requested_scale = min(
        1.0, float(max_model_dimension) / max(info.width, info.height)
    )
    inference_scale = (
        1.0
        if requested_scale >= 1.0
        else 0.5
        if requested_scale >= 0.5
        else 0.25
    )
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
            playback_fps,
            use_gpu,
            info.has_audio,
            rate_mode=rate_mode,
            quality=quality,
            bitrate_mbps=bitrate_mbps,
            output_format=output_format,
            audio_codec=info.audio_codec,
            audio_tempo=1.0 / factor if slow_motion and info.has_audio else None,
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
        next_output_index = 0
        written_frames = 0
        pair_index = 0

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
            timesteps, next_output_index = pair_timesteps(
                info.fps,
                generated_fps,
                pair_index,
                next_output_index,
            )
            for timestep in timesteps:
                if timestep <= 1e-8:
                    output_frame = first
                elif cut:
                    output_frame = first
                else:
                    output_frame = crop_frame(
                        model.interpolate(
                            padded_first,
                            padded_second,
                            timestep,
                            inference_scale=inference_scale,
                        ),
                        original_shape,
                    )
                encoder.stdin.write(output_frame.tobytes())
                written_frames += 1
            first = second
            pair_index += 1
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

        final_time = (source_frames - 1) / info.fps
        while next_output_index / generated_fps <= final_time + 1e-9:
            encoder.stdin.write(first.tobytes())
            written_frames += 1
            next_output_index += 1
        if slow_motion:
            # Every source frame owns one source-FPS interval. The interpolation
            # loop covers the intervals between frames, so hold the last frame
            # long enough for its interval to slow down by the same factor.
            expected_frames = source_frames * factor
            while written_frames < expected_frames:
                encoder.stdin.write(first.tobytes())
                written_frames += 1

        decoder.stdout.close()
        decoder_code = decoder.wait()
        decode_thread.join(timeout=2)
        if decoder_code != 0:
            raise RuntimeError(
                "\n".join(decode_tail)
                or "FFmpeg stopped while decoding the source video."
            )
        report(
            "encode",
            99,
            "Finishing video and stretching audio"
            if slow_motion and info.has_audio
            else "Finishing video and copying audio",
        )
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
            "outputFps": playback_fps,
            "generatedFps": generated_fps,
            "sceneHolds": scene_holds,
            "inferenceScale": inference_scale,
            "outputFormat": output_format,
        }
    except BaseException:
        for process in (decoder, encoder):
            _stop_process(process)
        discard_partial_output(destination)
        raise


def process_batch(
    jobs,
    model,
    factor,
    use_gpu,
    target_fps=None,
    slow_motion=False,
    rate_mode="quality",
    quality=18,
    bitrate_mbps=20.0,
    output_format="h264-mp4",
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
                target_fps=target_fps,
                slow_motion=slow_motion,
                rate_mode=rate_mode,
                quality=quality,
                bitrate_mbps=bitrate_mbps,
                output_format=output_format,
                progress_callback=clip_progress,
                ffmpeg_path=ffmpeg_path,
                ffprobe_path=ffprobe_path,
            )
            outcomes.append({"ok": True, **result})
        except Exception as error:
            discard_partial_output(output_path)
            outcomes.append(
                {
                    "ok": False,
                    "input": str(input_path),
                    "output": str(output_path),
                    "error": str(error),
                }
            )
    return outcomes
