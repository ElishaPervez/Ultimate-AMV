import argparse
import json
import os
import sys
import time

# Force UTF-8 I/O for all platforms to prevent unicode issues on Windows.
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pathlib import Path

# Setup tools environment
_tools_dir = os.environ.get("ULTIMATE_AMV_TOOLS_DIR") or str(
    Path(sys.executable).parent.parent / "tools"
)
if _tools_dir not in os.environ.get("PATH", ""):
    os.environ["PATH"] = _tools_dir + os.pathsep + os.environ.get("PATH", "")

from amv_audio.dependencies import ensure_feature_dependencies, repair_missing_module
from amv_audio.hardware import get_dependency_info, get_hw_info
from amv_audio.logs import add_log
from amv_bgremove.models import MODELS
from amv_bgremove.processor import remove_background_video

def emit(payload):
    print(json.dumps(payload), flush=True)

def progress(stage, percent, message, started_at):
    emit({
        "type": "progress",
        "stage": stage,
        "percent": max(0, min(100, float(percent))),
        "message": message,
        "elapsedSeconds": round(time.perf_counter() - started_at, 2),
    })

def status():
    hw = get_hw_info()
    deps = get_dependency_info()
    
    # We can check if rembg is installed
    try:
        import rembg
        rembg_installed = True
    except ImportError:
        rembg_installed = False
        
    deps["rembg_installed"] = rembg_installed
    
    emit({
        "type": "status",
        "hardware": hw,
        "dependencies": deps,
        "models": MODELS,
    })

def process(input_file, output_file, model_key, export_format, force_cpu):
    started_at = time.perf_counter()
    input_path = Path(input_file).expanduser().resolve()
    output_path = Path(output_file).expanduser().resolve()
    
    gpu = not force_cpu
    feature = "bgremove_gpu" if gpu else "bgremove_cpu"
    
    def on_progress(stage, percent, message):
        progress(stage, percent, message, started_at)
        
    try:
        on_progress("dependencies", 2, "Checking background removal dependencies...")
        ensure_feature_dependencies(
            feature,
            gpu=gpu,
            progress_callback=lambda stage, percent, message: on_progress("dependencies", percent, message)
        )
        
        on_progress("process", 10, "Starting background removal...")
        
        # Execute background removal
        try:
            total_frames = remove_background_video(
                input_path=str(input_path),
                output_path=str(output_path),
                model_key=model_key,
                export_format=export_format,
                force_cpu=force_cpu,
                progress_callback=on_progress
            )
        except ModuleNotFoundError as missing:
            # Automatic dependency repair if module missing unexpectedly
            if not repair_missing_module(missing.name, gpu=gpu, progress_callback=on_progress):
                raise
            on_progress("dependencies", -1, "Retrying process after dependency repair...")
            total_frames = remove_background_video(
                input_path=str(input_path),
                output_path=str(output_path),
                model_key=model_key,
                export_format=export_format,
                force_cpu=force_cpu,
                progress_callback=on_progress
            )
            
        elapsed = time.perf_counter() - started_at
        add_log(
            "bgremove.complete",
            f"Background removal complete for {input_path.name}",
            details={"input": str(input_path), "output": str(output_path), "frames": total_frames}
        )
        
        emit({
            "type": "done",
            "input": str(input_path),
            "output": str(output_path),
            "frames": total_frames,
            "elapsedSeconds": round(elapsed, 2)
        })
        return 0
        
    except Exception as exc:
        add_log(
            "bgremove.error",
            f"Background removal failed for {input_path.name}: {exc}",
            level="error",
            details={"input": str(input_path), "error": str(exc)}
        )
        emit({
            "type": "error",
            "message": str(exc)
        })
        return 1

def main():
    parser = argparse.ArgumentParser(description="Ultimate AMV background removal sidecar")
    sub = parser.add_subparsers(dest="command", required=True)
    
    sub.add_parser("status")
    
    process_parser = sub.add_parser("process")
    process_parser.add_argument("--input", required=True, help="Input video file path")
    process_parser.add_argument("--output", required=True, help="Output file path (or folder for PNG sequence)")
    process_parser.add_argument("--model", default="anime", choices=["anime", "general", "birefnet"], help="AI model key")
    process_parser.add_argument("--format", default="webm", choices=["webm", "png"], help="Export format")
    process_parser.add_argument("--cpu", action="store_true", help="Force CPU mode")
    
    args = parser.parse_args()
    
    if args.command == "status":
        status()
        return 0
    elif args.command == "process":
        return process(
            input_file=args.input,
            output_file=args.output,
            model_key=args.model,
            export_format=args.format,
            force_cpu=args.cpu
        )
    return 1

if __name__ == "__main__":
    raise SystemExit(main())
