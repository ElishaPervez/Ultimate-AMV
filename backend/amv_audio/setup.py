import os
import subprocess
import sys
import importlib.util

from .config import load_config, save_config
from .gpu import check_nvidia_gpu, get_cpu_switch_cmds, get_gpu_switch_cmds
from .dependencies import AUDIO_RUNTIME_MODULES
from .hardware import refresh_hardware
from .logs import add_log, append_terminal_log


def _check_package(package):
    try:
        result = subprocess.run(
            [sys.executable, "-I", "-m", "pip", "show", package],
            capture_output=True,
            text=True,
            timeout=10,
        )
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return False


def _nelux_importable():
    # Nelux's C extension has two non-obvious load requirements that a bare
    # `python -c "import nelux"` subprocess would fail:
    #   1. tools/ffmpeg-shared/ must be on the Windows DLL search path so
    #      avcodec-62.dll / avformat-62.dll / etc. resolve. clip_cli.py
    #      registers that path via os.add_dll_directory at module load.
    #      Phase 2 moved this dir from a bundled tools/ to a per-user
    #      app_local_data_dir/tools/, so the probe must consult the
    #      ULTIMATE_AMV_TOOLS_DIR env var first (set by the Rust shell)
    #      and fall back to the legacy path only for out-of-shell dev runs.
    #   2. torch must be imported first : nelux 0.10+'s __init__.py raises
    #      `ImportError: PyTorch must be imported before Nelux.` otherwise.
    # The probe below mirrors both pre-conditions before attempting the
    # import, so a healthy install does not trip the repair gate.
    probe = (
        "import os, sys\n"
        "from pathlib import Path\n"
        "_env = os.environ.get('ULTIMATE_AMV_TOOLS_DIR')\n"
        "_root = Path(_env) if _env else Path(sys.executable).parent.parent / 'tools'\n"
        "_d = _root / 'ffmpeg-shared'\n"
        "if _d.exists():\n"
        "    os.add_dll_directory(str(_d.resolve()))\n"
        "import torch  # nelux requires torch to be imported first\n"
        "import nelux\n"
    )
    try:
        # Pass the parent process env explicitly so ULTIMATE_AMV_TOOLS_DIR
        # (set by the Rust shell on the audio_cli sidecar) reaches the
        # probe child. subprocess.run inherits env by default, but being
        # explicit makes the dependency obvious and survives any future
        # caller that overrides env=.
        result = subprocess.run(
            [sys.executable, "-I", "-c", probe],
            capture_output=True,
            text=True,
            timeout=20,
            env=os.environ.copy(),
        )
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return False


def _missing_audio_runtime_modules():
    missing = []
    for module, package in AUDIO_RUNTIME_MODULES:
        try:
            found = importlib.util.find_spec(module) is not None
        except (ImportError, AttributeError, ValueError):
            found = False
        if module == "beartype" and found:
            try:
                from importlib.metadata import version
                found = version("beartype").startswith("0.18.")
            except Exception:
                found = False
        if module == "samplerate" and found:
            try:
                from importlib.metadata import version
                found = version("samplerate") == "0.1.0"
            except Exception:
                found = False
        if not found:
            missing.append(package)
    return missing


def _installed_torch_mode():
    # Classify by wheel tag, not by torch.cuda.is_available(). The runtime
    # probe is flaky on cold boots / right after install (driver not fully
    # resident, slow first-import past timeout, subprocess crash with empty
    # stdout) and would silently demote a working +cu install to "cpu",
    # making the repair gate fire on every update with the misleading
    # "Install PyTorch with CUDA 12.8" issue. The readiness check already
    # gates on check_nvidia_gpu(), so a +cu wheel on a CPU-only host is
    # still caught : just by the right signal.
    try:
        from importlib.metadata import version
        torch_version = version("torch")
    except Exception:
        return "missing", None, False

    mode = "gpu" if "+cu" in torch_version else "cpu"
    return mode, torch_version, mode == "gpu"


def collect_setup_plan(mode):
    if mode == "gpu":
        return _collect_gpu_plan()
    if mode == "cpu":
        return _collect_cpu_plan()
    raise ValueError("mode must be 'cpu' or 'gpu'")


def _collect_gpu_plan():
    rows = []
    issues = []

    gpu_name = check_nvidia_gpu()
    installed_mode, torch_version, _cuda_ready = _installed_torch_mode()
    audio_separator = _check_package("audio-separator")
    typing_extensions = _check_package("typing_extensions")
    pydub = _check_package("pydub")
    missing_audio_runtime = _missing_audio_runtime_modules()
    ort_cpu = _check_package("onnxruntime")
    ort_gpu = _check_package("onnxruntime-gpu")
    nelux_installed = _check_package("nelux")
    nelux_importable = nelux_installed and _nelux_importable()
    nelux = nelux_installed and nelux_importable
    nelux_broken_binaries = nelux_installed and not nelux_importable

    rows.append({"component": "Detected GPU", "status": gpu_name or "No NVIDIA GPU found"})
    rows.append({"component": "Current Mode", "status": "NOT INSTALLED" if installed_mode == "missing" else installed_mode.upper()})
    rows.append({"component": "Target Mode", "status": "GPU (CUDA 12.8 / cu128)"})
    rows.append({"component": "PyTorch", "status": torch_version or "Missing"})
    rows.append({"component": "GPU Runtime", "status": "Installed" if ort_gpu else "Needs install"})
    rows.append({"component": "Nelux", "status": "Installed" if nelux else ("Missing DLLs (reinstall)" if nelux_broken_binaries else "Needs install")})
    rows.append({"component": "audio-separator", "status": "Installed" if audio_separator else "Needs install"})
    rows.append({"component": "Audio runtime deps", "status": "Installed" if not missing_audio_runtime else f"Missing {len(missing_audio_runtime)}"})
    rows.append({"component": "typing_extensions", "status": "Installed" if typing_extensions else "Needs install"})
    rows.append({"component": "pydub", "status": "Installed" if pydub else "Needs install"})
    rows.append({"component": "CPU Runtime", "status": "Installed (will remove)" if ort_cpu else "Not installed"})

    ready = bool(gpu_name) and installed_mode == "gpu" and ort_gpu and nelux and audio_separator and typing_extensions and pydub and not missing_audio_runtime and not ort_cpu
    if ready:
        return {"mode": "gpu", "rows": rows, "issues": [], "installs": [], "success_mode": "gpu", "gpu_name": gpu_name}

    reinstall_torch = installed_mode != "gpu"
    install_audio_separator = not audio_separator or not typing_extensions or not ort_gpu or not pydub or not nelux or bool(missing_audio_runtime)

    if not gpu_name:
        issues.append("No NVIDIA GPU found")
    if reinstall_torch:
        issues.append("Install PyTorch with CUDA 12.8")
    if install_audio_separator:
        issues.append("Install audio-separator[gpu], typing_extensions, and pydub")
    if nelux_broken_binaries:
        issues.append("Reinstall Nelux (bundled FFmpeg DLLs missing)")
    if ort_cpu:
        issues.append("Remove CPU ONNX Runtime")

    return {
        "mode": "gpu",
        "rows": rows,
        "issues": issues,
        "installs": get_gpu_switch_cmds(
            reinstall_torch=reinstall_torch,
            cleanup_cpu_runtime=ort_cpu,
            install_audio_separator=install_audio_separator,
            force_reinstall_nelux=nelux_broken_binaries,
        ),
        "success_mode": None,
        "gpu_name": gpu_name,
    }


def _collect_cpu_plan():
    rows = []
    issues = []

    installed_mode, torch_version, _cuda_ready = _installed_torch_mode()
    audio_separator = _check_package("audio-separator")
    typing_extensions = _check_package("typing_extensions")
    pydub = _check_package("pydub")
    missing_audio_runtime = _missing_audio_runtime_modules()
    ort_cpu = _check_package("onnxruntime")
    ort_gpu = _check_package("onnxruntime-gpu")

    rows.append({"component": "Current Mode", "status": "NOT INSTALLED" if installed_mode == "missing" else installed_mode.upper()})
    rows.append({"component": "Target Mode", "status": "CPU"})
    rows.append({"component": "PyTorch", "status": torch_version or "Missing"})
    rows.append({"component": "ONNX Runtime", "status": "Installed" if ort_cpu else "Needs install"})
    rows.append({"component": "audio-separator", "status": "Installed" if audio_separator else "Needs install"})
    rows.append({"component": "Audio runtime deps", "status": "Installed" if not missing_audio_runtime else f"Missing {len(missing_audio_runtime)}"})
    rows.append({"component": "typing_extensions", "status": "Installed" if typing_extensions else "Needs install"})
    rows.append({"component": "pydub", "status": "Installed" if pydub else "Needs install"})
    rows.append({"component": "GPU Runtime", "status": "Installed (will remove)" if ort_gpu else "Not installed"})

    ready = installed_mode == "cpu" and ort_cpu and audio_separator and typing_extensions and pydub and not missing_audio_runtime and not ort_gpu
    if ready:
        return {"mode": "cpu", "rows": rows, "issues": [], "installs": [], "success_mode": "cpu", "gpu_name": None}

    reinstall_torch = installed_mode != "cpu"
    if reinstall_torch:
        issues.append("Install CPU-only PyTorch" if installed_mode == "missing" else "Replace CUDA PyTorch with CPU-only PyTorch")
    if not ort_cpu:
        issues.append("Install onnxruntime")
    if not audio_separator or not typing_extensions or not pydub or missing_audio_runtime:
        issues.append("Install audio-separator, typing_extensions, and pydub")
    if ort_gpu:
        issues.append("Remove GPU ONNX Runtime")

    return {
        "mode": "cpu",
        "rows": rows,
        "issues": issues,
        "installs": get_cpu_switch_cmds(
            reinstall_torch=reinstall_torch,
            cleanup_gpu_runtime=ort_gpu,
            install_onnxruntime=not ort_cpu,
            install_audio_separator=not audio_separator or not typing_extensions or not pydub or bool(missing_audio_runtime),
        ),
        "success_mode": None,
        "gpu_name": None,
    }


def apply_success_mode(mode):
    config = load_config()
    config["setup_type"] = mode
    config["force_cpu"] = mode == "cpu"
    save_config(config)
    refresh_hardware()


def _fix_pth_file():
    python_dir = os.path.dirname(sys.executable)
    for name in os.listdir(python_dir):
        if name.endswith("._pth"):
            pth = os.path.join(python_dir, name)
            try:
                text = open(pth, encoding="utf-8").read()
                if "#import site" in text:
                    open(pth, "w", encoding="utf-8").write(text.replace("#import site", "import site"))
            except OSError:
                pass


def _ensure_pip(progress_callback):
    _fix_pth_file()
    try:
        result = subprocess.run(
            [sys.executable, "-I", "-m", "pip", "--version"],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode == 0:
            return
    except Exception:
        pass

    import tempfile
    import urllib.request

    progress_callback(0, 0, "running", "Downloading pip bootstrap...")
    tmp = tempfile.NamedTemporaryFile(suffix=".py", delete=False)
    try:
        urllib.request.urlretrieve("https://bootstrap.pypa.io/get-pip.py", tmp.name)
        tmp.close()
        progress_callback(0, 0, "running", "Installing pip into embedded Python...")
        result = subprocess.run(
            [sys.executable, "-I", tmp.name],
            capture_output=True, text=True, timeout=300,
        )
        if result.returncode != 0:
            raise RuntimeError(f"pip bootstrap failed: {(result.stderr or result.stdout).strip()[-500:]}")
    finally:
        os.unlink(tmp.name)


def install_setup(mode, progress_callback):
    _ensure_pip(progress_callback)
    plan = collect_setup_plan(mode)
    installs = plan["installs"]
    if not installs:
        apply_success_mode(mode)
        return {"ok": True, "mode": mode, "plan": plan}

    total = len(installs)
    for index, cmd in enumerate(installs, start=1):
        progress_callback(index, total, "running", " ".join(cmd))
        add_log("audio.setup.step", f"Running setup step {index}/{total}", details={"mode": mode, "command": cmd})
        returncode, output_lines = _run_command_streaming(cmd, index, total, progress_callback)
        if returncode != 0:
            error = _summarize_command_error(output_lines, returncode)
            progress_callback(index, total, "error", error)
            add_log("audio.setup.step.error", f"Setup step {index}/{total} failed", level="error", details={"mode": mode, "error": error})
            raise RuntimeError(error)
        progress_callback(index, total, "done", f"Step {index}/{total} complete")
        add_log("audio.setup.step.complete", f"Setup step {index}/{total} complete", details={"mode": mode})

    apply_success_mode(mode)
    return {"ok": True, "mode": mode, "plan": collect_setup_plan(mode)}


def _run_command_streaming(cmd, step, total, progress_callback):
    append_terminal_log(f"$ {' '.join(cmd)}")
    process = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        encoding="utf-8",
        errors="replace",
    )
    output_lines = []
    assert process.stdout is not None
    for raw_line in process.stdout:
        line = raw_line.rstrip()
        if not line:
            continue
        output_lines.append(line)
        append_terminal_log(line)
        progress_callback(step, total, "running", line)
    return process.wait(timeout=1200), output_lines


def _summarize_command_error(output_lines, code):
    lines = [line.strip() for line in output_lines if line.strip()]
    lines = [
        line
        for line in lines
        if not line.startswith("[notice]")
        and "A new release of pip" not in line
        and "To update, run:" not in line
    ]
    for line in reversed(lines):
        if "ERROR:" in line or "error:" in line.lower():
            return line
    return lines[-1] if lines else f"Command failed with exit code {code}"
