"""Duplicate-frame removal: decode a clip, drop the copies, re-encode.

Frames are removed and nothing is inserted, so the output is shorter and
faster than the source. By default the clip's frame rate is left alone --
fewer frames at the same rate is exactly what produces that. The export can
also re-time the survivors to a chosen rate: no new frames appear, so a rate
above the source plays the same pictures quicker and shortens the clip
further, and a rate below it slows and stretches them.

The preview and the export run through `remove_dead_frames` together, with only
the render size and the encoder settings differing. That is deliberate: the
preview is the user's evidence that the export will look the same, and a second
removal routine would eventually disagree with the first one.
"""

import subprocess
import threading
from collections import deque
from pathlib import Path

# Probing, the raw-pipe reader and the teardown helpers frame interpolation
# already uses. Sharing them keeps both tools counting frames the same way.
from amv_interpolate.processor import (
    _drain_stream,
    _read_frame,
    _stop_process,
    discard_partial_output,
    probe_media,
    resolve_tool,
)
from amv_video.encode import _encoder_command

from .analyzer import measure_clip, removal_set


# Longest edge a preview renders at. The preview only ever has to prove which
# frames were dropped, so it stays small enough to finish while the user is
# still looking at the dial.
PREVIEW_LONGEST_EDGE = 640


def _even(value):
    """Round to an even number of pixels, the minimum yuv420p accepts."""
    return max(2, int(round(value / 2.0)) * 2)


def preview_size(width, height, longest_edge=PREVIEW_LONGEST_EDGE):
    """Return the size a preview renders at, aspect kept, longest edge capped."""
    if width <= 0 or height <= 0:
        raise ValueError("The input video's dimensions could not be read.")
    if max(width, height) <= longest_edge:
        return _even(width), _even(height)
    scale = float(longest_edge) / max(width, height)
    return _even(width * scale), _even(height * scale)


def export_fps(requested, source_fps):
    """The rate an export plays at: the user's choice, or the clip's own.

    Zero and None both mean "keep the source rate" -- that is the wire format
    the CLI uses -- and anything non-positive falls back the same way rather
    than handing FFmpeg a rate it would refuse.
    """
    if requested and float(requested) > 0:
        return float(requested)
    return source_fps


def _fps_text(fps):
    # 23.976023976 has to survive intact while 60.0 still writes as "60".
    return f"{fps:.8f}".rstrip("0").rstrip(".")


def _decoder_command(ffmpeg, input_path, width=None, height=None):
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(input_path),
        "-map",
        "0:v:0",
        # One emitted frame per source frame. The removal list is a list of
        # frame indices, so anything that drops or repeats a frame here would
        # delete the wrong pictures with nothing on screen to show for it.
        "-vsync",
        "0",
    ]
    if width and height:
        command.extend(["-vf", f"scale={width}:{height}"])
    command.extend(["-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"])
    return command


def _preview_encoder_command(ffmpeg, output_path, width, height, fps):
    """The fixed fast encoder every preview uses.

    The user's format and rate settings deliberately do not reach this command:
    the preview attests to the sensitivity dial, not to the encoder, which is
    why changing the export settings does not invalidate it. Audio is dropped
    because there is no soundtrack on the raw pipe to begin with.
    """
    fps_value = _fps_text(fps)
    return [
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
        fps_value,
        "-i",
        "pipe:0",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "30",
        "-pix_fmt",
        "yuv420p",
        "-r",
        fps_value,
        "-movflags",
        "+faststart",
        str(output_path),
    ]


def remove_dead_frames(
    input_path,
    output_path,
    sensitivity,
    preview=False,
    use_gpu=False,
    rate_mode="quality",
    quality=18,
    bitrate_mbps=20.0,
    output_format="h264-mp4",
    keep_audio=False,
    fps=None,
    scores=None,
    progress_callback=None,
    ffmpeg_path=None,
    ffprobe_path=None,
):
    """Write one clip with its duplicate frames removed.

    `preview` swaps the render size and the encoder, and nothing else: the
    frames that survive are the same ones the export would keep at the same
    dial position.
    """
    ffmpeg = ffmpeg_path or resolve_tool("ffmpeg")
    destination = Path(output_path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if preview:
        # The old preview goes before anything can fail, so a clip that turns
        # out to be unreadable never leaves the previous render sitting in the
        # player looking like the current one.
        destination.unlink(missing_ok=True)
    info = probe_media(input_path, ffprobe_path=ffprobe_path)

    def report(stage, percent, message):
        if progress_callback:
            progress_callback(stage, percent, message)

    if scores is None:
        report("measure", -1, "Looking for duplicate frames")
        scores = measure_clip(
            input_path, ffmpeg_path=ffmpeg, ffprobe_path=ffprobe_path
        )["scores"]
    removable = removal_set(scores, sensitivity)
    # The measured count is the exact one; the probe's is an estimate on files
    # with a broken header.
    frame_count = len(scores) or info.frame_count

    if preview:
        width, height = preview_size(info.width, info.height)
    else:
        width, height = info.width, info.height
    rescaled = (width, height) != (info.width, info.height)
    frame_bytes = width * height * 3
    decode_tail = deque(maxlen=30)
    encode_tail = deque(maxlen=30)

    # The rate the surviving frames play at. The preview always uses the
    # source rate: it attests to which frames the dial drops, and the export
    # settings deliberately never invalidate it.
    output_fps = info.fps if preview else export_fps(fps, info.fps)

    if preview:
        encoder_command = _preview_encoder_command(
            ffmpeg, output_path, width, height, info.fps
        )
        has_audio = False
    else:
        has_audio = bool(keep_audio and info.has_audio)
        encoder_command = _encoder_command(
            ffmpeg,
            input_path,
            output_path,
            width,
            height,
            # The source rate by default -- fewer frames at the same rate is
            # what shortens the clip. A chosen rate re-times the survivors.
            output_fps,
            use_gpu,
            has_audio,
            rate_mode=rate_mode,
            quality=quality,
            bitrate_mbps=bitrate_mbps,
            output_format=output_format,
            audio_codec=info.audio_codec,
        )

    destination.unlink(missing_ok=True)
    decoder = subprocess.Popen(
        _decoder_command(
            ffmpeg,
            input_path,
            width if rescaled else None,
            height if rescaled else None,
        ),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    encoder = subprocess.Popen(
        encoder_command,
        stdin=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    # Both pipes have to be emptied on their own threads: FFmpeg writes enough
    # to fill the buffer on a long clip, and a full buffer looks like a slow
    # encode rather than the deadlock it actually is.
    decode_thread = threading.Thread(
        target=_drain_stream, args=(decoder.stderr, decode_tail), daemon=True
    )
    encode_thread = threading.Thread(
        target=_drain_stream, args=(encoder.stderr, encode_tail), daemon=True
    )
    decode_thread.start()
    encode_thread.start()
    source_frames = 0
    kept_frames = 0

    def write_frame(raw_frame):
        try:
            encoder.stdin.write(raw_frame)
        except OSError:
            # The encoder is already gone, so the write only reports a closed
            # pipe ("invalid argument"). FFmpeg's own last words are the only
            # thing that tells the user what actually went wrong.
            try:
                encoder.wait(timeout=5)
            except Exception:
                pass
            encode_thread.join(timeout=2)
            raise RuntimeError(
                "\n".join(encode_tail)
                or "FFmpeg could not write the shortened video."
            ) from None

    try:
        while True:
            raw_frame = _read_frame(decoder.stdout, frame_bytes)
            if raw_frame is None:
                break
            # Frames past the end of the score list can only appear if the
            # decode disagreed with the measurement, and keeping them is the
            # safe answer: an unmeasured frame is never a known duplicate.
            if source_frames not in removable:
                write_frame(raw_frame)
                kept_frames += 1
            source_frames += 1
            percent = (
                min(99.0, source_frames / frame_count * 100.0)
                if frame_count
                else -1
            )
            report(
                "remove",
                percent,
                f"Kept {kept_frames:,} of {source_frames:,} frames",
            )

        if not source_frames:
            raise ValueError("FFmpeg decoded no video frames from the selected file.")

        decoder.stdout.close()
        decoder_code = decoder.wait()
        decode_thread.join(timeout=2)
        if decoder_code != 0:
            raise RuntimeError(
                "\n".join(decode_tail)
                or "FFmpeg stopped while decoding the source video."
            )
        report("encode", 99, "Finishing video")
        encoder.stdin.close()
        encoder_code = encoder.wait()
        encode_thread.join(timeout=2)
        if encoder_code != 0:
            raise RuntimeError(
                "\n".join(encode_tail)
                or "FFmpeg could not finish the shortened video."
            )
        report("encode", 100, f"Removed {source_frames - kept_frames:,} frames")
        return {
            "input": str(input_path),
            "output": str(output_path),
            "sourceFrames": source_frames,
            "keptFrames": kept_frames,
            "removedFrames": source_frames - kept_frames,
            "fps": output_fps,
            "width": width,
            "height": height,
            "sourceDuration": info.duration,
            "outputDuration": round(kept_frames / output_fps, 3) if output_fps else 0.0,
            "hasAudio": has_audio,
        }
    except BaseException:
        for process in (decoder, encoder):
            _stop_process(process)
        discard_partial_output(destination)
        raise


def process_batch(
    jobs,
    sensitivity,
    use_gpu=False,
    rate_mode="quality",
    quality=18,
    bitrate_mbps=20.0,
    output_format="h264-mp4",
    keep_audio=False,
    fps=None,
    progress_callback=None,
    ffmpeg_path=None,
    ffprobe_path=None,
):
    """Run the whole queue at one dial position, one clip at a time.

    A clip that fails is recorded and the queue carries on, so one unreadable
    file cannot cost the user the other thirty-nine.
    """
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
            result = remove_dead_frames(
                input_path,
                output_path,
                sensitivity,
                use_gpu=use_gpu,
                rate_mode=rate_mode,
                quality=quality,
                bitrate_mbps=bitrate_mbps,
                output_format=output_format,
                keep_audio=keep_audio,
                fps=fps,
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
