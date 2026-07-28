import argparse
import json
import os
import sys
import time
from pathlib import Path


if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from amv_audio.logs import add_log
from amv_deadframe.analyzer import DEFAULT_SENSITIVITY, measure_clip
from amv_deadframe.processor import process_batch, remove_dead_frames
from amv_video.encode import OUTPUT_FORMAT_KEYS


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def progress(
    stage,
    percent,
    message,
    started_at,
    clip_index=None,
    clip_count=None,
    clip_name=None,
):
    payload = {
        "type": "progress",
        "stage": stage,
        "percent": -1 if float(percent) < 0 else max(0, min(100, float(percent))),
        "message": message,
        "elapsedSeconds": round(time.perf_counter() - started_at, 2),
    }
    if clip_index is not None:
        payload.update(
            {
                "clipIndex": clip_index,
                "clipCount": clip_count,
                "clipName": clip_name,
            }
        )
    emit(payload)


def _load_jobs(path):
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(payload, list) or not payload:
        raise ValueError("The export queue is empty.")
    jobs = []
    for index, item in enumerate(payload, start=1):
        if not isinstance(item, dict) or not item.get("input") or not item.get("output"):
            raise ValueError(f"Queue item {index} must contain input and output paths.")
        jobs.append({"input": str(item["input"]), "output": str(item["output"])})
    return jobs


def analyze(args):
    """Measure one clip and hand back a change score for every frame."""
    input_path = Path(args.input).expanduser().resolve()
    try:
        measurement = measure_clip(input_path)
        emit({"type": "analysis", **measurement})
        return 0
    except Exception as error:
        # Measuring is per-clip and happens as the queue fills, so only the
        # failures are worth a log line -- logging every success would bury the
        # rest of the log under a forty-clip drop.
        add_log(
            "deadframe.analyze_error",
            f"Duplicate-frame measurement failed for {input_path.name}: {error}",
            level="error",
            details={"input": str(input_path), "error": str(error)},
        )
        emit({"type": "error", "message": str(error)})
        return 1


def preview(args):
    """Render the selected clip small and fast at the current dial position."""
    started_at = time.perf_counter()
    input_path = Path(args.input).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()
    try:
        result = remove_dead_frames(
            input_path,
            output_path,
            args.sensitivity,
            preview=True,
            progress_callback=lambda stage, percent, message: progress(
                stage, percent, message, started_at
            ),
        )
        elapsed = round(time.perf_counter() - started_at, 2)
        add_log(
            "deadframe.preview",
            f"Dead-frame preview ready for {input_path.name}: "
            f"{result['keptFrames']} of {result['sourceFrames']} frames kept",
            details={
                "input": str(input_path),
                "sensitivity": args.sensitivity,
                "kept_frames": result["keptFrames"],
                "source_frames": result["sourceFrames"],
            },
        )
        emit(
            {
                "type": "done",
                "output": result["output"],
                "sourceFrames": result["sourceFrames"],
                "keptFrames": result["keptFrames"],
                "elapsedSeconds": elapsed,
            }
        )
        return 0
    except Exception as error:
        add_log(
            "deadframe.preview_error",
            f"Dead-frame preview failed for {input_path.name}: {error}",
            level="error",
            details={"input": str(input_path), "error": str(error)},
        )
        emit({"type": "error", "message": str(error)})
        return 1


def export(args):
    """Run the whole queue at the previewed dial position."""
    started_at = time.perf_counter()
    try:
        jobs = _load_jobs(args.jobs)
        outcomes = process_batch(
            jobs,
            args.sensitivity,
            use_gpu=bool(args.gpu),
            rate_mode=args.rate_mode,
            quality=args.quality,
            bitrate_mbps=args.bitrate_mbps,
            output_format=args.output_format,
            keep_audio=bool(args.keep_audio),
            fps=args.fps or None,
            progress_callback=lambda stage, percent, message, clip_index, clip_count, clip_name: progress(
                stage,
                percent,
                message,
                started_at,
                clip_index,
                clip_count,
                clip_name,
            ),
        )
        succeeded = [item for item in outcomes if item["ok"]]
        failed = [item for item in outcomes if not item["ok"]]
        elapsed = round(time.perf_counter() - started_at, 2)
        removed_frames = sum(item.get("removedFrames", 0) for item in succeeded)
        add_log(
            "deadframe.complete",
            f"Dead-frame removal finished: {len(succeeded)} succeeded, {len(failed)} failed",
            details={
                "sensitivity": args.sensitivity,
                "output_format": args.output_format,
                "keep_audio": bool(args.keep_audio),
                "fps": args.fps,
                "gpu": bool(args.gpu),
                "removed_frames": removed_frames,
            },
        )
        emit(
            {
                "type": "done",
                "outcomes": outcomes,
                "succeeded": len(succeeded),
                "failed": len(failed),
                "removedFrames": removed_frames,
                "elapsedSeconds": elapsed,
            }
        )
        return 0 if succeeded else 1
    except Exception as error:
        add_log(
            "deadframe.error",
            f"Dead-frame removal failed: {error}",
            level="error",
            details={"error": str(error)},
        )
        emit({"type": "error", "message": str(error)})
        return 1


def _bool_value(value):
    if isinstance(value, bool):
        return value
    normalized = str(value).strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise argparse.ArgumentTypeError(f"Expected true or false, received {value!r}")


def build_parser():
    parser = argparse.ArgumentParser(
        description="Ultimate AMV dead-frame remover sidecar"
    )
    subcommands = parser.add_subparsers(dest="command", required=True)

    analyze_parser = subcommands.add_parser("analyze")
    analyze_parser.add_argument("--input", required=True)

    preview_parser = subcommands.add_parser("preview")
    preview_parser.add_argument("--input", required=True)
    preview_parser.add_argument(
        "--sensitivity", type=float, default=DEFAULT_SENSITIVITY
    )
    preview_parser.add_argument("--output", required=True)

    export_parser = subcommands.add_parser("export")
    export_parser.add_argument("--jobs", required=True)
    export_parser.add_argument(
        "--sensitivity", type=float, default=DEFAULT_SENSITIVITY
    )
    export_parser.add_argument(
        "--rate-mode", choices=("quality", "vbr", "cbr"), default="quality"
    )
    export_parser.add_argument("--quality", type=int, default=18)
    export_parser.add_argument("--bitrate-mbps", type=float, default=20.0)
    export_parser.add_argument(
        "--output-format", choices=OUTPUT_FORMAT_KEYS, default="h264-mp4"
    )
    export_parser.add_argument("--keep-audio", type=_bool_value, default=False)
    # 0 means "keep each clip's own rate". A positive value re-times the
    # surviving frames, which changes the clip's speed and length.
    export_parser.add_argument("--fps", type=float, default=0.0)
    # The encoder family follows the hardware, never a user choice: h264 becomes
    # h264_nvenc on an NVIDIA card and libx264 otherwise. CPU is the default so
    # a machine without one is never handed an encoder it cannot run.
    export_parser.add_argument("--gpu", type=_bool_value, default=False)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.command == "analyze":
        return analyze(args)
    if args.command == "preview":
        return preview(args)
    return export(args)


if __name__ == "__main__":
    raise SystemExit(main())
