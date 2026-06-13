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

# Re-use PyTorch's bundled CUDA/cuDNN DLLs for ONNX Runtime GPU support.
# PyTorch has built-in CUDA runtimes inside its "lib" folder. Adding it to the
# system environment PATH allows ONNX Runtime (used by rembg) to find and load
# the required CUDA and cuDNN DLLs instantly without separate system-wide installs.
try:
    import torch
    _torch_lib = os.path.join(os.path.dirname(torch.__file__), "lib")
    if os.path.exists(_torch_lib) and _torch_lib not in os.environ.get("PATH", ""):
        os.environ["PATH"] = _torch_lib + os.pathsep + os.environ.get("PATH", "")
except ImportError:
    pass

from amv_audio.dependencies import ensure_feature_dependencies, repair_missing_module
from amv_audio.hardware import get_dependency_info, get_hw_info
from amv_audio.logs import add_log
from amv_bgremove.models import MODELS, MODEL_KEYS
from amv_bgremove.processor import remove_background_video, extract_single_frame, remove_background_frame

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
    
    # Map hasCuda and has_onnxruntime for frontend type compatibility
    from amv_audio.hardware import verify_cuda_torch
    hw["hasCuda"] = verify_cuda_torch()
    deps["has_onnxruntime"] = deps.get("onnxruntime", False)
    
    emit({
        "type": "status",
        "hardware": hw,
        "dependencies": deps,
        "models": MODELS,
    })

def process(input_file, output_file, model_key, export_format, force_cpu, showcase_dir=None):
    started_at = time.perf_counter()
    input_path = Path(input_file).expanduser().resolve()
    output_path = Path(output_file).expanduser().resolve()
    showcase_path = None
    if showcase_dir:
        showcase_path = str(Path(showcase_dir).expanduser().resolve() / "showcase.webm")

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
        
        is_image = input_path.suffix.lower() in [".png", ".jpg", ".jpeg", ".webp", ".bmp"]
        
        on_progress("process", 10, "Starting background removal...")
        
        # Execute background removal
        fps = None
        showcase_file = None
        cpu_fallback = None
        try:
            if is_image:
                cpu_fallback = remove_background_frame(
                    input_image_path=str(input_path),
                    output_image_path=str(output_path),
                    model_key=model_key,
                    force_cpu=force_cpu
                )
                total_frames = 1
            else:
                total_frames, fps, showcase_file, cpu_fallback = remove_background_video(
                    input_path=str(input_path),
                    output_path=str(output_path),
                    model_key=model_key,
                    export_format=export_format,
                    force_cpu=force_cpu,
                    progress_callback=on_progress,
                    showcase_path=showcase_path
                )
        except ModuleNotFoundError as missing:
            # Automatic dependency repair if module missing unexpectedly
            if not repair_missing_module(missing.name, gpu=gpu, progress_callback=on_progress):
                raise
            on_progress("dependencies", -1, "Retrying process after dependency repair...")
            if is_image:
                cpu_fallback = remove_background_frame(
                    input_image_path=str(input_path),
                    output_image_path=str(output_path),
                    model_key=model_key,
                    force_cpu=force_cpu
                )
                total_frames = 1
            else:
                total_frames, fps, showcase_file, cpu_fallback = remove_background_video(
                    input_path=str(input_path),
                    output_path=str(output_path),
                    model_key=model_key,
                    export_format=export_format,
                    force_cpu=force_cpu,
                    progress_callback=on_progress,
                    showcase_path=showcase_path
                )
            
        elapsed = time.perf_counter() - started_at
        if cpu_fallback:
            add_log(
                "bgremove.gpu_fallback",
                cpu_fallback,
                level="warning",
                details={"input": str(input_path)}
            )
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
            "fps": fps,
            "showcase": showcase_file,
            "cpuFallback": bool(cpu_fallback),
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

def preview(input_file, output_dir, model_key, frame_index, force_cpu):
    started_at = time.perf_counter()
    input_path = Path(input_file).expanduser().resolve()
    output_dir_path = Path(output_dir).expanduser().resolve()
    output_dir_path.mkdir(parents=True, exist_ok=True)
    
    orig_path = output_dir_path / "orig.png"
    isolated_path = output_dir_path / "isolated.png"
    
    gpu = not force_cpu
    feature = "bgremove_gpu" if gpu else "bgremove_cpu"
    
    def on_progress(stage, percent, message):
        progress(stage, percent, message, started_at)
        
    try:
        on_progress("dependencies", 10, "Checking background removal dependencies...")
        ensure_feature_dependencies(
            feature,
            gpu=gpu,
            progress_callback=lambda stage, percent, message: on_progress("dependencies", percent, message)
        )
        
        is_image = input_path.suffix.lower() in [".png", ".jpg", ".jpeg", ".webp", ".bmp"]
        
        if is_image:
            on_progress("preview-extract", 30, "Preparing image preview...")
            from PIL import Image
            img = Image.open(str(input_path))
            img.save(str(orig_path), "PNG")
            frame_to_use = 0
            total_frames = 1
        else:
            on_progress("preview-extract", 30, "Extracting video preview frame...")
            total_frames = 300
            try:
                import cv2
                cap = cv2.VideoCapture(str(input_path))
                if cap.isOpened():
                    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
                    cap.release()
            except Exception:
                pass
                
            frame_to_use = frame_index if frame_index >= 0 else max(0, int(total_frames * 0.33))
            extract_single_frame(str(input_path), str(orig_path), frame_to_use)
        
        on_progress("preview-isolate", 60, "Running AI character isolation on frame...")
        cpu_fallback = remove_background_frame(str(orig_path), str(isolated_path), model_key, force_cpu=force_cpu)

        if cpu_fallback:
            add_log(
                "bgremove.gpu_fallback",
                cpu_fallback,
                level="warning",
                details={"input": str(input_path)}
            )

        elapsed = time.perf_counter() - started_at
        emit({
            "type": "preview_done",
            "original": str(orig_path),
            "isolated": str(isolated_path),
            "frame": frame_to_use,
            "totalFrames": total_frames,
            "cpuFallback": bool(cpu_fallback),
            "elapsedSeconds": round(elapsed, 2)
        })
        return 0
        
    except Exception as exc:
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
    process_parser.add_argument("--model", default="anime", choices=MODEL_KEYS, help="AI model key")
    process_parser.add_argument("--format", default="mov", choices=["mov", "webm", "png"], help="Export format")
    process_parser.add_argument("--cpu", action="store_true", help="Force CPU mode")
    process_parser.add_argument("--showcase-dir", default=None, help="Directory for the in-app comparison preview WebM")
    
    preview_parser = sub.add_parser("preview")
    preview_parser.add_argument("--input", required=True, help="Input video file path")
    preview_parser.add_argument("--output-dir", required=True, help="Directory to save preview frames")
    preview_parser.add_argument("--model", default="anime", choices=MODEL_KEYS, help="AI model key")
    preview_parser.add_argument("--frame", type=int, default=-1, help="Frame index to extract (default is 33% of video)")
    preview_parser.add_argument("--cpu", action="store_true", help="Force CPU mode")
    
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
            force_cpu=args.cpu,
            showcase_dir=args.showcase_dir
        )
    elif args.command == "preview":
        return preview(
            input_file=args.input,
            output_dir=args.output_dir,
            model_key=args.model,
            frame_index=args.frame,
            force_cpu=args.cpu
        )
    return 1

if __name__ == "__main__":
    raise SystemExit(main())
