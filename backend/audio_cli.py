import argparse
import json
import os
import sys

# Force UTF-8 I/O for all platforms to prevent unicode issues on Windows.
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pathlib import Path

# Ensure bundled tools (ffmpeg, ffprobe) are discoverable by audio-separator,
# pydub, librosa, and any other library that shells out to ffmpeg via PATH.
# Phase 2: the Rust shell sets ULTIMATE_AMV_TOOLS_DIR to the per-user tools
# cache; honor that first and fall back to the legacy bundled location only
# when the env var is missing (out-of-shell dev runs).
_tools_dir = os.environ.get("ULTIMATE_AMV_TOOLS_DIR") or str(
    Path(sys.executable).parent.parent / "tools"
)
if _tools_dir not in os.environ.get("PATH", ""):
    os.environ["PATH"] = _tools_dir + os.pathsep + os.environ.get("PATH", "")

from amv_audio.config import load_config, save_config
from amv_audio.dependencies import ensure_feature_dependencies, repair_missing_module
from amv_audio.hardware import get_dependency_info, get_hw_info
from amv_audio.logs import add_log, get_terminal_logs
from amv_audio.models import get_active_model, get_model_display_name
from amv_audio.separator import run_separation
from amv_audio.setup import collect_setup_plan, install_setup

THEME_PRESETS = {
    "cyan": ("#48d7ff", "#63e6a2"),
    "mint": ("#63e6a2", "#48d7ff"),
    "violet": ("#a98cff", "#48d7ff"),
    "rose": ("#ff6d91", "#a98cff"),
    "amber": ("#f4c267", "#ff6d91"),
}


def emit(payload):
    print(json.dumps(payload), flush=True)


def status():
    hw = get_hw_info()
    model = get_active_model(hw)
    deps = get_dependency_info()
    emit(
        {
            "type": "status",
            "hardware": hw,
            "dependencies": deps,
            "model": model,
            "model_name": get_model_display_name(model),
        }
    )


def logs():
    emit({"type": "logs", "lines": get_terminal_logs()})


BACKGROUND_DEFAULTS = {
    "background_image": "",
    "background_scale": 1.0,
    "background_offset_x": 50.0,
    "background_offset_y": 50.0,
    "background_dim": 55,
    "background_blur": 0,
    "background_video": "",
    "background_video_source": "",
    "background_video_fps": 30,
}


def _config_payload(cfg):
    return {
        "type": "config",
        "force_cpu": cfg.get("force_cpu", False),
        "setup_type": cfg.get("setup_type", "cpu"),
        "clip_extraction_mode": cfg.get("clip_extraction_mode", "gpu"),
        "setup_complete": cfg.get("setup_complete", False),
        "download_path": cfg.get("download_path", ""),
        "provider_url": cfg.get("provider_url", "https://anikai.to"),
        "theme": cfg.get("theme", "cyan"),
        "theme_color_a": cfg.get("theme_color_a", THEME_PRESETS.get(cfg.get("theme", "cyan"), THEME_PRESETS["cyan"])[0]),
        "theme_color_b": cfg.get("theme_color_b", THEME_PRESETS.get(cfg.get("theme", "cyan"), THEME_PRESETS["cyan"])[1]),
        "background_image": cfg.get("background_image", BACKGROUND_DEFAULTS["background_image"]),
        "background_scale": float(cfg.get("background_scale", BACKGROUND_DEFAULTS["background_scale"])),
        "background_offset_x": float(cfg.get("background_offset_x", BACKGROUND_DEFAULTS["background_offset_x"])),
        "background_offset_y": float(cfg.get("background_offset_y", BACKGROUND_DEFAULTS["background_offset_y"])),
        "background_dim": int(cfg.get("background_dim", BACKGROUND_DEFAULTS["background_dim"])),
        "background_blur": int(cfg.get("background_blur", BACKGROUND_DEFAULTS["background_blur"])),
        "background_video": cfg.get("background_video", BACKGROUND_DEFAULTS["background_video"]),
        "background_video_source": cfg.get("background_video_source", BACKGROUND_DEFAULTS["background_video_source"]),
        "background_video_fps": int(cfg.get("background_video_fps", BACKGROUND_DEFAULTS["background_video_fps"])),
        "audio_output_format": cfg.get("audio_output_format", "wav"),
        "clip_hover_preview": bool(cfg.get("clip_hover_preview", False)),
    }


def _auto_sync_install_mode(cfg):
    # apply_success_mode() ties setup_type / force_cpu / clip_extraction_mode
    # to the installed torch wheel, but a crashed install or a config that
    # predates apply_success_mode can leave the stored prefs drifting from
    # the actual install. Heal silently here so the UI doesn't show
    # "GPU installed - CPU configured" on a +cu torch and so downstream code
    # that reads clip_extraction_mode (e.g. DownloaderPanel's post-download
    # clip-server warmup) sees the right mode.
    try:
        from importlib.metadata import version
        torch_version = version("torch")
    except Exception:
        return cfg, False

    if "+cu" in torch_version:
        installed_mode = "gpu"
    elif "+cpu" in torch_version:
        installed_mode = "cpu"
    else:
        return cfg, False

    changed = False
    if cfg.get("setup_type") != installed_mode:
        cfg["setup_type"] = installed_mode
        changed = True
    if cfg.get("force_cpu") != (installed_mode == "cpu"):
        cfg["force_cpu"] = installed_mode == "cpu"
        changed = True
    if cfg.get("clip_extraction_mode") != installed_mode:
        cfg["clip_extraction_mode"] = installed_mode
        changed = True
    return cfg, changed


def show_config():
    cfg = load_config()
    cfg, changed = _auto_sync_install_mode(cfg)
    if changed:
        save_config(cfg)
    emit(_config_payload(cfg))


def set_config(key, value):
    cfg = load_config()
    if key == "force_cpu":
        cfg["force_cpu"] = value.lower() == "true"
        if cfg["force_cpu"]:
            cfg["setup_type"] = "cpu"
    elif key == "setup_type":
        cfg["setup_type"] = value
        cfg["force_cpu"] = value == "cpu"
    elif key == "clip_extraction_mode":
        if value not in {"cpu", "gpu"}:
            emit({"type": "error", "message": "clip_extraction_mode must be cpu or gpu"})
            return 1
        cfg["clip_extraction_mode"] = value
    elif key == "setup_complete":
        cfg["setup_complete"] = value.lower() == "true"
    elif key == "download_path":
        cfg["download_path"] = value
    elif key == "provider_url":
        cfg["provider_url"] = value
    elif key == "theme":
        if value not in {*THEME_PRESETS, "custom"}:
            emit({"type": "error", "message": "theme must be cyan, mint, violet, rose, amber, or custom"})
            return 1
        cfg["theme"] = value
    elif key in {"theme_color_a", "theme_color_b"}:
        if not isinstance(value, str) or len(value) != 7 or value[0] != "#":
            emit({"type": "error", "message": f"{key} must be a hex color like #48d7ff"})
            return 1
        try:
            int(value[1:], 16)
        except ValueError:
            emit({"type": "error", "message": f"{key} must be a hex color like #48d7ff"})
            return 1
        cfg[key] = value.lower()
        cfg["theme"] = "custom"
    elif key == "background_image":
        cfg["background_image"] = value
    elif key in {"background_scale", "background_offset_x", "background_offset_y"}:
        try:
            number = float(value)
        except ValueError:
            emit({"type": "error", "message": f"{key} must be a number"})
            return 1
        if key == "background_scale":
            number = max(1.0, min(5.0, number))
        else:
            number = max(0.0, min(100.0, number))
        cfg[key] = number
    elif key in {"background_dim", "background_blur"}:
        try:
            number = int(float(value))
        except ValueError:
            emit({"type": "error", "message": f"{key} must be an integer"})
            return 1
        if key == "background_dim":
            number = max(0, min(100, number))
        else:
            number = max(0, min(40, number))
        cfg[key] = number
    elif key in {"background_video", "background_video_source"}:
        cfg[key] = value
    elif key == "background_video_fps":
        try:
            number = int(float(value))
        except ValueError:
            emit({"type": "error", "message": "background_video_fps must be an integer"})
            return 1
        cfg["background_video_fps"] = max(15, min(60, number))
    elif key == "audio_output_format":
        normalized = (value or "").strip().lower()
        if normalized not in {"wav", "mp3"}:
            emit({"type": "error", "message": "audio_output_format must be wav or mp3"})
            return 1
        cfg["audio_output_format"] = normalized
    elif key == "clip_hover_preview":
        cfg["clip_hover_preview"] = value.lower() == "true"
    save_config(cfg)
    emit(_config_payload(cfg))


def separate(input_file):
    def on_progress(stage, percent, message):
        emit({"type": "progress", "stage": stage, "percent": percent, "message": message})

    try:
        add_log("audio.extract.start", f"Started vocal extraction for {Path(input_file).name}", details={"input": input_file})
        cfg = load_config()
        gpu = cfg.get("setup_type", "cpu") == "gpu" and not cfg.get("force_cpu", False)
        output_format = cfg.get("audio_output_format", "wav")
        ensure_feature_dependencies("audio", gpu=gpu, progress_callback=on_progress)
        try:
            result = run_separation(input_file, progress_callback=on_progress, output_format=output_format)
        except ModuleNotFoundError as missing:
            if not repair_missing_module(missing.name, gpu=gpu, progress_callback=on_progress):
                raise
            on_progress("dependency-repair", -1, "Retrying extraction after dependency repair...")
            result = run_separation(input_file, progress_callback=on_progress, output_format=output_format)
        add_log(
            "audio.extract.complete",
            f"Completed vocal extraction for {Path(input_file).name}",
            details={"input": input_file, "outputs": result.get("outputs", [])},
        )
        emit({"type": "done", **result})
    except Exception as exc:
        add_log(
            "audio.extract.error",
            f"Vocal extraction failed for {Path(input_file).name}",
            level="error",
            details={"input": input_file, "error": str(exc)},
        )
        emit({"type": "error", "message": str(exc)})
        return 1
    return 0


def setup(mode):
    def on_progress(step, total, state, message):
        emit({"type": "setup-progress", "step": step, "total": total, "state": state, "message": message})

    try:
        add_log("audio.setup.start", f"Started {mode.upper()} audio setup", details={"mode": mode})
        result = install_setup(mode, progress_callback=on_progress)
        add_log("audio.setup.complete", f"Completed {mode.upper()} audio setup", details={"mode": mode})
        emit({"type": "setup-done", **result})
    except Exception as exc:
        add_log(
            "audio.setup.error",
            f"{mode.upper()} audio setup failed",
            level="error",
            details={"mode": mode, "error": str(exc)},
        )
        emit({"type": "setup-error", "message": str(exc)})
        return 1
    return 0


def setup_plan(mode):
    try:
        plan = collect_setup_plan(mode)
        emit({"type": "setup-plan", **plan})
    except Exception as exc:
        emit({"type": "error", "message": str(exc)})
        return 1
    return 0


def main():
    parser = argparse.ArgumentParser(description="Ultimate AMV audio extraction bridge")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status")
    sub.add_parser("logs")
    sub.add_parser("config")
    set_config_parser = sub.add_parser("set-config")
    set_config_parser.add_argument("key")
    set_config_parser.add_argument("value")
    setup_parser = sub.add_parser("setup")
    setup_parser.add_argument("mode", choices=["cpu", "gpu"])
    setup_plan_parser = sub.add_parser("setup-plan")
    setup_plan_parser.add_argument("mode", choices=["cpu", "gpu"])
    separate_parser = sub.add_parser("separate")
    separate_parser.add_argument("input_file")
    args = parser.parse_args()

    if args.command == "status":
        status()
        return 0
    if args.command == "logs":
        logs()
        return 0
    if args.command == "config":
        show_config()
        return 0
    if args.command == "set-config":
        return set_config(args.key, args.value) or 0
    if args.command == "setup":
        return setup(args.mode)
    if args.command == "setup-plan":
        return setup_plan(args.mode)
    if args.command == "separate":
        return separate(str(Path(args.input_file)))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
