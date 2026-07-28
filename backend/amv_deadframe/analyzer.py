"""Duplicate-frame detection for the dead-frame remover.

Anime is drawn on twos or threes: one drawing is held for two or three frames
of a 24fps timeline, so most frames are exact copies of the one before them.
The measurement pass decodes a clip once at thumbnail size and scores how much
each frame changed against its predecessor; the threshold function turns the
user's single dial into the set of frame indices to drop.
"""

import subprocess
import threading
from collections import deque

# The probe and the raw-pipe reader frame interpolation already uses. Sharing
# them keeps both tools counting frames from the same ffprobe call instead of
# drifting apart behind a second copy.
from amv_interpolate.processor import (
    _drain_stream,
    _read_frame,
    _stop_process,
    probe_media,
    resolve_tool,
)


# Width the clip is decoded at for measurement. 160px grayscale is ~14 KB a
# frame, so the arithmetic costs nothing and the pass runs at decode speed --
# identical on CPU-only machines, with no CUDA path, no model, no new package.
MEASURE_WIDTH = 160

# The dial is 0-100 and maps onto an ABSOLUTE amount of change, never onto each
# clip's own distribution. The user tunes on one clip and exports the whole
# queue, so 18 has to mean the same physical amount of change on every file; a
# percentile mapping would silently mean something different per clip.
MIN_THRESHOLD = 0.001
THRESHOLD_SPAN = 0.029
DEFAULT_SENSITIVITY = 18


def removal_threshold(sensitivity):
    """Return the change score below which a frame counts as a duplicate."""
    dial = max(0.0, min(100.0, float(sensitivity)))
    return MIN_THRESHOLD + (dial / 100.0) * THRESHOLD_SPAN


def removal_set(scores, sensitivity):
    """Return the indices to drop for one score list at one dial position.

    Pure arithmetic over the cached scores, so the live count in the panel can
    be recomputed on every drag without decoding anything again. The comparison
    is strict: a frame scoring exactly the threshold is kept.
    """
    threshold = removal_threshold(sensitivity)
    return {
        index
        for index, score in enumerate(scores)
        # Frame 0 has no predecessor, so it is never removable.
        if index > 0 and float(score) < threshold
    }


def measurement_size(width, height, target_width=MEASURE_WIDTH):
    """Return the size the clip is decoded at, height following the aspect.

    The height is computed here and handed to FFmpeg explicitly rather than
    left to `scale=160:-2`, because the reader has to know the exact byte count
    of a frame before the first one arrives; a two-pixel disagreement would
    misalign every frame and quietly poison every score.
    """
    if width <= 0 or height <= 0:
        raise ValueError("The input video's dimensions could not be read.")
    scaled_height = int(round(target_width * height / width / 2.0)) * 2
    return target_width, max(2, scaled_height)


def _measure_command(ffmpeg, input_path, width, height):
    return [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(input_path),
        "-map",
        "0:v:0",
        # One emitted frame per source frame. The removal set is a list of frame
        # indices, so anything that drops or duplicates frames here would delete
        # the wrong ones later without any visible error.
        "-vsync",
        "0",
        "-vf",
        f"scale={width}:{height},format=gray",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "gray",
        "pipe:1",
    ]


def measure_clip(input_path, ffmpeg_path=None, ffprobe_path=None):
    """Score every frame of one clip against the frame before it.

    Returns the score array plus the source's frame count, fps, dimensions and
    duration. Scores are mean absolute pixel difference divided by 255, so 0.0
    is an identical frame and 1.0 is black against white.
    """
    import numpy as np

    ffmpeg = ffmpeg_path or resolve_tool("ffmpeg")
    info = probe_media(input_path, ffprobe_path=ffprobe_path)
    scaled_width, scaled_height = measurement_size(info.width, info.height)
    frame_bytes = scaled_width * scaled_height
    decode_tail = deque(maxlen=30)

    decoder = subprocess.Popen(
        _measure_command(ffmpeg, input_path, scaled_width, scaled_height),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    decode_thread = threading.Thread(
        target=_drain_stream, args=(decoder.stderr, decode_tail), daemon=True
    )
    decode_thread.start()
    scores = []

    try:
        previous = None
        while True:
            raw_frame = _read_frame(decoder.stdout, frame_bytes)
            if raw_frame is None:
                break
            # int16 because the difference of two uint8 frames wraps around.
            frame = np.frombuffer(raw_frame, dtype=np.uint8).reshape(
                scaled_height, scaled_width
            ).astype(np.int16)
            if previous is None:
                # Nothing to compare frame 0 against, so it scores as an
                # entirely new drawing and stays out of every removal set.
                scores.append(1.0)
            else:
                scores.append(float(np.mean(np.abs(frame - previous))) / 255.0)
            previous = frame

        decoder.stdout.close()
        decoder_code = decoder.wait()
        decode_thread.join(timeout=2)
        if decoder_code != 0:
            raise RuntimeError(
                "\n".join(decode_tail)
                or "FFmpeg stopped while measuring the source video."
            )
        if not scores:
            raise ValueError("FFmpeg decoded no video frames from the selected file.")
        return {
            "input": str(input_path),
            "frameCount": len(scores),
            "fps": info.fps,
            "width": info.width,
            "height": info.height,
            "duration": info.duration,
            "scores": scores,
        }
    except BaseException:
        _stop_process(decoder)
        raise
