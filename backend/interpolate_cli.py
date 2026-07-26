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

from amv_audio.dependencies import ensure_feature_dependencies
from amv_audio.hardware import get_hw_info, verify_cuda_torch
from amv_audio.logs import add_log
from amv_interpolate.models import MODEL_KEYS, RifeModel, model_status
from amv_interpolate.processor import process_batch


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


def status():
    hardware = get_hw_info()
    hardware["hasCuda"] = verify_cuda_torch()
    emit(
        {
            "type": "status",
            "hardware": hardware,
            "models": model_status(),
        }
    )


def _load_jobs(path):
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(payload, list) or not payload:
        raise ValueError("The interpolation queue is empty.")
    jobs = []
    for index, item in enumerate(payload, start=1):
        if not isinstance(item, dict) or not item.get("input") or not item.get("output"):
            raise ValueError(f"Queue item {index} must contain input and output paths.")
        jobs.append({"input": str(item["input"]), "output": str(item["output"])})
    return jobs


def interpolate(args):
    started_at = time.perf_counter()
    use_gpu = bool(args.gpu)
    half = bool(args.half and use_gpu)
    try:
        jobs = _load_jobs(args.jobs)
        feature = "interpolate_gpu" if use_gpu else "interpolate_cpu"
        progress(
            "dependencies",
            -1,
            "Checking frame interpolation dependencies",
            started_at,
        )
        ensure_feature_dependencies(
            feature,
            gpu=use_gpu,
            progress_callback=lambda _stage, percent, message: progress(
                "dependencies", percent, message, started_at
            ),
        )
        progress(
            "model-init",
            -1,
            f"Loading {args.model} once for the full queue",
            started_at,
        )
        model = RifeModel(args.model, use_gpu=use_gpu, half=half)
        outcomes = process_batch(
            jobs,
            model,
            args.factor,
            use_gpu,
            target_fps=args.target_fps,
            rate_mode=args.rate_mode,
            quality=args.quality,
            bitrate_mbps=args.bitrate_mbps,
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
        scene_holds = sum(item.get("sceneHolds", 0) for item in succeeded)
        add_log(
            "interpolate.complete",
            f"Frame interpolation finished: {len(succeeded)} succeeded, {len(failed)} failed",
            details={
                "model": args.model,
                "factor": args.factor,
                "target_fps": args.target_fps,
                "gpu": use_gpu,
                "scene_holds": scene_holds,
            },
        )
        emit(
            {
                "type": "done",
                "outcomes": outcomes,
                "succeeded": len(succeeded),
                "failed": len(failed),
                "sceneHolds": scene_holds,
                "elapsedSeconds": elapsed,
            }
        )
        return 0 if succeeded else 1
    except Exception as error:
        add_log(
            "interpolate.error",
            f"Frame interpolation failed: {error}",
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
        description="Ultimate AMV frame interpolation sidecar"
    )
    subcommands = parser.add_subparsers(dest="command", required=True)
    subcommands.add_parser("status")
    run_parser = subcommands.add_parser("interpolate")
    run_parser.add_argument("--jobs", required=True)
    run_parser.add_argument("--factor", type=int, choices=(2, 3, 4), default=2)
    run_parser.add_argument("--target-fps", type=float, default=None)
    run_parser.add_argument("--model", choices=MODEL_KEYS, default="rife4.25")
    run_parser.add_argument("--gpu", type=_bool_value, default=True)
    run_parser.add_argument("--half", type=_bool_value, default=True)
    run_parser.add_argument(
        "--rate-mode", choices=("quality", "vbr", "cbr"), default="quality"
    )
    run_parser.add_argument("--quality", type=int, default=18)
    run_parser.add_argument("--bitrate-mbps", type=float, default=20.0)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.command == "status":
        status()
        return 0
    return interpolate(args)


if __name__ == "__main__":
    raise SystemExit(main())
