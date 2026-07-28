"""FFmpeg output settings shared by every tool that writes a video.

Frame interpolation and dead-frame removal hand the user the same format,
rate-control and audio choices, so the command assembly lives here once. A
second copy would drift and the two tools would quietly stop matching.
"""

import math
from pathlib import Path


OUTPUT_FORMATS = {
    "h264-mp4": {"codec": "h264", "extension": "mp4"},
    "hevc-mp4": {"codec": "hevc", "extension": "mp4"},
    "h264-mkv": {"codec": "h264", "extension": "mkv"},
    "prores-mov": {"codec": "prores", "extension": "mov"},
}
OUTPUT_FORMAT_KEYS = tuple(OUTPUT_FORMATS)

# Containers descended from the QuickTime file format. Only these accept the
# fast-start flag and the hvc1 stream tag; handing either to Matroska aborts
# FFmpeg before a single frame is written.
QUICKTIME_CONTAINERS = {"mp4", "mov", "m4v"}

# Audio those containers can hold untouched. A WebM or MKV source usually
# carries Opus or Vorbis, which MP4 refuses outright -- copying it through
# fails the whole clip, so it is converted instead.
QUICKTIME_AUDIO_CODECS = {
    "aac",
    "ac3",
    "alac",
    "eac3",
    "mp3",
    "pcm_s16le",
    "pcm_s24le",
}


def format_extension(output_format):
    try:
        return OUTPUT_FORMATS[output_format]["extension"]
    except KeyError:
        raise ValueError(f"Unknown output format: {output_format}") from None


def _rate_args(family, rate_mode, quality, bitrate_text, buffer_text):
    """Rate-control flags for one encoder family."""
    if rate_mode not in {"quality", "vbr", "cbr"}:
        raise ValueError("Rate control must be quality, vbr, or cbr.")
    if family == "nvenc":
        if rate_mode == "quality":
            return ["-rc", "constqp", "-cq", str(quality)]
        if rate_mode == "vbr":
            return ["-rc", "vbr", "-b:v", bitrate_text]
        return [
            "-rc",
            "cbr",
            "-b:v",
            bitrate_text,
            "-minrate",
            bitrate_text,
            "-maxrate",
            bitrate_text,
            "-bufsize",
            buffer_text,
            "-cbr_padding",
            "1",
        ]
    if rate_mode == "quality":
        return ["-crf", str(quality)]
    if rate_mode == "vbr":
        return ["-b:v", bitrate_text]
    args = [
        "-b:v",
        bitrate_text,
        "-minrate",
        bitrate_text,
        "-maxrate",
        bitrate_text,
        "-bufsize",
        buffer_text,
    ]
    if family == "x264":
        # x265 has no equivalent switch: its buffer limits above already pin
        # the bitrate, and passing an x264 parameter to it aborts the encode.
        args.extend(["-x264-params", "nal-hrd=cbr"])
    return args


def _video_args(codec, use_gpu, quicktime, rate_mode, quality, bitrate_mbps):
    if codec == "prores":
        # ProRes has no rate control at all: the profile alone fixes how much
        # detail survives, and it keeps full colour resolution, so the encode
        # stays visually identical to the frames the model produced.
        return ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le"]

    quality = max(14, min(28, int(quality)))
    bitrate = float(bitrate_mbps)
    if not math.isfinite(bitrate) or bitrate <= 0:
        raise ValueError("Target bitrate must be greater than 0 Mbps.")
    bitrate_text = f"{bitrate:g}M"
    buffer_text = f"{bitrate * 2:g}M"

    if codec == "hevc":
        if use_gpu:
            args = ["-c:v", "hevc_nvenc", "-preset", "p4"]
            args.extend(_rate_args("nvenc", rate_mode, quality, bitrate_text, buffer_text))
            args.extend(["-spatial-aq", "1", "-temporal-aq", "1"])
        else:
            args = ["-c:v", "libx265", "-preset", "slow"]
            args.extend(_rate_args("x265", rate_mode, quality, bitrate_text, buffer_text))
        if quicktime:
            # Without this tag QuickTime and most Apple software refuse to open
            # the file even though the video inside is perfectly valid.
            args.extend(["-tag:v", "hvc1"])
        args.extend(["-pix_fmt", "yuv420p"])
        return args

    if use_gpu:
        args = ["-c:v", "h264_nvenc", "-preset", "p4"]
        args.extend(_rate_args("nvenc", rate_mode, quality, bitrate_text, buffer_text))
        args.extend(["-spatial-aq", "1", "-temporal-aq", "1"])
    else:
        args = ["-c:v", "libx264", "-preset", "slow"]
        args.extend(_rate_args("x264", rate_mode, quality, bitrate_text, buffer_text))
    args.extend(["-pix_fmt", "yuv420p"])
    return args


def _audio_args(quicktime, audio_codec):
    if quicktime and audio_codec and audio_codec.lower() not in QUICKTIME_AUDIO_CODECS:
        return ["-c:a", "aac", "-b:a", "320k"]
    return ["-c:a", "copy"]


def _encoder_command(
    ffmpeg,
    input_path,
    output_path,
    width,
    height,
    fps,
    use_gpu,
    has_audio,
    rate_mode="quality",
    quality=18,
    bitrate_mbps=20.0,
    output_format="h264-mp4",
    audio_codec="",
):
    if output_format not in OUTPUT_FORMATS:
        raise ValueError(f"Unknown output format: {output_format}")
    codec = OUTPUT_FORMATS[output_format]["codec"]
    # The container comes from the file being written rather than the selected
    # format, because the in-place smoothing path reuses the exported clip's
    # own extension.
    extension = Path(output_path).suffix.lower().lstrip(".")
    quicktime = extension in QUICKTIME_CONTAINERS

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
        command.extend(["-map", "1:a:0?"])
        command.extend(_audio_args(quicktime, audio_codec))
    command.extend(
        _video_args(codec, use_gpu, quicktime, rate_mode, quality, bitrate_mbps)
    )
    command.extend(["-r", fps_text])
    if quicktime:
        command.extend(["-movflags", "+faststart"])
    command.extend(["-shortest", str(output_path)])
    return command
