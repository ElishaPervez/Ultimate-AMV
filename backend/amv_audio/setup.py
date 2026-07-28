import os
import subprocess
import sys
import importlib.util

from . import installer
from .config import load_config, save_config
from .gpu import (
    check_nvidia_gpu,
    get_cpu_switch_cmds,
    get_gpu_switch_cmds,
    get_numeric_runtime_repair_cmd,
)
from .dependencies import (
    AUDIO_RUNTIME_MODULES,
    _numeric_runtime_ready,
    _prune_stale_numeric_metadata,
    _prune_unused_package_dirs,
    invalidate_numeric_runtime_probe,
)
from .logs import add_log, append_terminal_log
from .runtime_versions import TORCH_VERSION
from .status import build_status

_LAST_NELUX_IMPORT_ERROR = None


def _nelux_failure_status(error):
    text = (error or "").lower()
    if "built for pytorch" in text or "pytorch minor version" in text:
        return "PyTorch version mismatch", f"Install Nelux compatible with PyTorch {TORCH_VERSION}"
    return "Cannot load (repair)", "Repair Nelux native files"


def _check_package(package):
    # Reads the installed-package records directly instead of shelling out.
    # Six of these run every time the setup screen opens; each one used to
    # start a fresh Python process, so opening the screen took seconds. It
    # also stays correct no matter which installer put the package there.
    return installer.is_installed(package)


def _nelux_importable():
    global _LAST_NELUX_IMPORT_ERROR
    _LAST_NELUX_IMPORT_ERROR = None
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
        if result.returncode != 0:
            lines = [line.strip() for line in (result.stderr or "").splitlines() if line.strip()]
            _LAST_NELUX_IMPORT_ERROR = lines[-1] if lines else "Nelux could not load"
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError) as error:
        _LAST_NELUX_IMPORT_ERROR = str(error)
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


def _run_side_by_side(probes):
    """Run independent probes at the same time instead of one after another.

    Each of these launches something and then just waits for it: a fresh
    Python that loads PyTorch, another that loads the maths libraries, and the
    graphics driver's own query tool. Run in sequence their waiting adds up,
    and the slowest of the three takes longer than the other two together.
    """
    from concurrent.futures import ThreadPoolExecutor

    with ThreadPoolExecutor(max_workers=len(probes)) as pool:
        started = {name: pool.submit(probe) for name, probe in probes.items()}
        return {name: pending.result() for name, pending in started.items()}


def _collect_gpu_plan():
    rows = []
    issues = []

    installed_mode, torch_version, _cuda_ready = _installed_torch_mode()
    audio_separator = _check_package("audio-separator")
    typing_extensions = _check_package("typing_extensions")
    pydub = _check_package("pydub")
    missing_audio_runtime = _missing_audio_runtime_modules()
    ort_cpu = _check_package("onnxruntime")
    ort_gpu = _check_package("onnxruntime-gpu")
    nelux_installed = _check_package("nelux")
    global _LAST_NELUX_IMPORT_ERROR
    _LAST_NELUX_IMPORT_ERROR = None
    probed = _run_side_by_side(
        {
            "gpu_name": check_nvidia_gpu,
            "numeric_runtime": _numeric_runtime_ready,
            "nelux_importable": _nelux_importable if nelux_installed else (lambda: False),
        }
    )
    gpu_name = probed["gpu_name"]
    numeric_runtime = probed["numeric_runtime"]
    nelux_importable = nelux_installed and probed["nelux_importable"]
    nelux = nelux_installed and nelux_importable
    nelux_broken_binaries = nelux_installed and not nelux_importable
    nelux_failure_status, nelux_repair_issue = _nelux_failure_status(_LAST_NELUX_IMPORT_ERROR)

    rows.append({"component": "Detected GPU", "status": gpu_name or "No NVIDIA GPU found"})
    rows.append({"component": "Current Mode", "status": "NOT INSTALLED" if installed_mode == "missing" else installed_mode.upper()})
    rows.append({"component": "Target Mode", "status": "GPU (CUDA 12.8 / cu128)"})
    rows.append({"component": "PyTorch", "status": torch_version or "Missing"})
    rows.append({"component": "GPU Runtime", "status": "Installed" if ort_gpu else "Needs install"})
    rows.append({"component": "Nelux", "status": "Installed" if nelux else (nelux_failure_status if nelux_broken_binaries else "Needs install")})
    rows.append({"component": "audio-separator", "status": "Installed" if audio_separator else "Needs install"})
    rows.append({"component": "Audio runtime deps", "status": "Installed" if not missing_audio_runtime else f"Missing {len(missing_audio_runtime)}"})
    rows.append({"component": "NumPy / Numba", "status": "Installed" if numeric_runtime else "Needs repair"})
    rows.append({"component": "typing_extensions", "status": "Installed" if typing_extensions else "Needs install"})
    rows.append({"component": "pydub", "status": "Installed" if pydub else "Needs install"})
    rows.append({"component": "CPU Runtime", "status": "Installed (will remove)" if ort_cpu else "Not installed"})

    ready = bool(gpu_name) and installed_mode == "gpu" and ort_gpu and nelux and audio_separator and typing_extensions and pydub and not missing_audio_runtime and numeric_runtime and not ort_cpu
    if ready:
        return {"mode": "gpu", "rows": rows, "issues": [], "installs": [], "success_mode": "gpu", "gpu_name": gpu_name}

    reinstall_torch = installed_mode != "gpu"
    # The GPU sound runtime is deliberately NOT part of this condition. Every
    # switch to CPU removes it, so every switch back was reinstalling the
    # entire audio stack -- 70 packages resolved, all of them handed blanket
    # upgrade permission -- to recover one file. It gets its own targeted step
    # below. The stack install still runs when the stack itself is missing,
    # and in that case it brings the runtime along with it.
    install_audio_separator = (
        not audio_separator
        or not typing_extensions
        or not pydub
        or not nelux
        or bool(missing_audio_runtime)
    )
    install_gpu_runtime = not ort_gpu and not install_audio_separator

    if not gpu_name:
        issues.append("No NVIDIA GPU found")
    if reinstall_torch:
        issues.append("Install PyTorch with CUDA 12.8")
    if install_audio_separator:
        issues.append("Install audio-separator[gpu], typing_extensions, and pydub")
    if install_gpu_runtime:
        issues.append("Install GPU ONNX Runtime")
    if not numeric_runtime:
        issues.append("Repair the NumPy/Numba audio runtime")
    if nelux_broken_binaries:
        issues.append(nelux_repair_issue)
    if ort_cpu:
        issues.append("Remove CPU ONNX Runtime")

    return {
        "mode": "gpu",
        "rows": rows,
        "issues": issues,
        "installs": get_gpu_switch_cmds(
            reinstall_torch=reinstall_torch,
            cleanup_cpu_runtime=ort_cpu,
            install_gpu_runtime=install_gpu_runtime,
            install_audio_separator=install_audio_separator,
            force_reinstall_nelux=nelux_broken_binaries,
            repair_numeric_runtime=not numeric_runtime,
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
    numeric_runtime = _numeric_runtime_ready()
    ort_cpu = _check_package("onnxruntime")
    ort_gpu = _check_package("onnxruntime-gpu")

    rows.append({"component": "Current Mode", "status": "NOT INSTALLED" if installed_mode == "missing" else installed_mode.upper()})
    rows.append({"component": "Target Mode", "status": "CPU"})
    rows.append({"component": "PyTorch", "status": torch_version or "Missing"})
    rows.append({"component": "ONNX Runtime", "status": "Installed" if ort_cpu else "Needs install"})
    rows.append({"component": "audio-separator", "status": "Installed" if audio_separator else "Needs install"})
    rows.append({"component": "Audio runtime deps", "status": "Installed" if not missing_audio_runtime else f"Missing {len(missing_audio_runtime)}"})
    rows.append({"component": "NumPy / Numba", "status": "Installed" if numeric_runtime else "Needs repair"})
    rows.append({"component": "typing_extensions", "status": "Installed" if typing_extensions else "Needs install"})
    rows.append({"component": "pydub", "status": "Installed" if pydub else "Needs install"})
    rows.append({"component": "GPU Runtime", "status": "Installed (will remove)" if ort_gpu else "Not installed"})

    ready = installed_mode == "cpu" and ort_cpu and audio_separator and typing_extensions and pydub and not missing_audio_runtime and numeric_runtime and not ort_gpu
    if ready:
        return {"mode": "cpu", "rows": rows, "issues": [], "installs": [], "success_mode": "cpu", "gpu_name": None}

    reinstall_torch = installed_mode != "cpu"
    if reinstall_torch:
        issues.append("Install CPU-only PyTorch" if installed_mode == "missing" else "Replace CUDA PyTorch with CPU-only PyTorch")
    if not ort_cpu:
        issues.append("Install onnxruntime")
    if not audio_separator or not typing_extensions or not pydub or missing_audio_runtime:
        issues.append("Install audio-separator, typing_extensions, and pydub")
    if not numeric_runtime:
        issues.append("Repair the NumPy/Numba audio runtime")
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
            repair_numeric_runtime=not numeric_runtime,
        ),
        "success_mode": None,
        "gpu_name": None,
    }


def apply_success_mode(mode):
    config = load_config()
    config["setup_type"] = mode
    config["force_cpu"] = mode == "cpu"
    config["clip_extraction_mode"] = mode
    save_config(config)


def _prune_package_cache():
    """Keep cache cleanup nonfatal even if an installer implementation changes."""
    try:
        return installer.prune_cache()
    except Exception as error:
        add_log(
            "audio.setup.cache_cleanup.error",
            "Package cache cleanup failed",
            level="warning",
            details={"error": str(error)},
        )
        return False


def _finish_setup(mode, progress_callback, total):
    """Verify the new engine, load its status, and clean cache concurrently."""
    progress_callback(
        total,
        total,
        "running",
        "Verifying GPU/CPU engine and cleaning package cache...",
        "verify",
    )
    try:
        completed = _run_side_by_side(
            {
                "plan": lambda: collect_setup_plan(mode),
                "status": lambda: build_status(mode=mode, refresh=True),
                "cache": _prune_package_cache,
            }
        )
    except Exception as error:
        progress_callback(total, total, "error", str(error), "verify")
        raise

    final_plan = completed["plan"]
    if final_plan["issues"]:
        # The mode is still saved: the user asked for it, most of it worked,
        # and the Settings panel offers the repair. Logging it means a switch
        # that leaves something broken is findable afterwards instead of only
        # visible in the moment.
        add_log(
            "audio.setup.incomplete",
            "Setup finished with unresolved issues",
            level="warning",
            details={"mode": mode, "issues": final_plan["issues"]},
        )

    # All mode fields move together and only after both verification jobs
    # succeed. The status job used the intended mode directly, so saving does
    # not require another hardware refresh.
    apply_success_mode(mode)
    return {
        "ok": True,
        "mode": mode,
        "plan": final_plan,
        "status": completed["status"],
    }


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


def _ensure_installer_for(cmd, progress_callback):
    """uv is self-contained; pip has to exist inside the bundled Python first."""
    if installer.is_uv_cmd(cmd):
        return
    _ensure_pip(progress_callback)


def install_setup(mode, progress_callback):
    # Whichever installer runs, packages land in Lib\site-packages and the
    # embeddable Python only looks there when site loading is switched on. It
    # ships switched off, so a Python that was never prepared imports nothing
    # that gets installed.
    _fix_pth_file()
    plan = collect_setup_plan(mode)
    installs = plan["installs"]
    if not installs:
        _prune_stale_numeric_metadata()
        _prune_unused_package_dirs()
        return _finish_setup(mode, progress_callback, 0)

    add_log(
        "audio.setup.installer",
        "Setup installer selected",
        details={"mode": mode, "installer": installer.active_installer()},
    )

    total = len(installs)
    for index, cmd in enumerate(installs, start=1):
        progress_callback(index, total, "running", " ".join(cmd))
        add_log("audio.setup.step", f"Running setup step {index}/{total}", details={"mode": mode, "command": cmd})
        returncode, output_lines = _run_step(cmd, index, total, mode, progress_callback)

        if returncode != 0:
            error = _summarize_command_error(output_lines, returncode)
            progress_callback(index, total, "error", error)
            add_log("audio.setup.step.error", f"Setup step {index}/{total} failed", level="error", details={"mode": mode, "error": error})
            raise RuntimeError(error)
        progress_callback(index, total, "done", f"Step {index}/{total} complete")
        add_log("audio.setup.step.complete", f"Setup step {index}/{total} complete", details={"mode": mode})

    _restore_numeric_runtime(mode, total, progress_callback)
    _prune_stale_numeric_metadata()
    _prune_unused_package_dirs()
    return _finish_setup(mode, progress_callback, total)


def _run_step(cmd, index, total, mode, progress_callback):
    """Run one setup command, retrying through the bundled installer.

    The fast installer is downloaded on demand, so on some machines it is
    absent, quarantined or broken while the bundled one works fine. Retrying
    keeps such a user on the slow install instead of failing a setup that can
    still succeed.
    """
    _ensure_installer_for(cmd, progress_callback)
    returncode, output_lines = _run_command_streaming(cmd, index, total, progress_callback)
    if returncode == 0:
        return returncode, output_lines

    fallback = installer.to_pip_cmd(cmd)
    if fallback is None:
        return returncode, output_lines

    add_log(
        "audio.setup.step.fallback",
        f"Step {index}/{total} retrying with the bundled installer",
        level="warning",
        details={"mode": mode, "error": _summarize_command_error(output_lines, returncode)},
    )
    progress_callback(index, total, "running", "Retrying with the bundled installer...")
    _ensure_pip(progress_callback)
    return _run_command_streaming(fallback, index, total, progress_callback)


def _restore_numeric_runtime(mode, total, progress_callback):
    """Put NumPy and Numba back on the tested pair if a step moved them.

    The step list is decided before anything is installed, so a repair for
    damage done *during* the run can never appear in it. An install can still
    pull NumPy forward as a side effect of resolving something else, and Numba
    then refuses to load, which stops audio separation. Without this check the
    switch saves the new mode and reports success on an engine that cannot
    start, and the user has to notice the repair prompt themselves.
    """
    if _numeric_runtime_ready():
        return

    add_log(
        "audio.setup.numeric_runtime.repair",
        "A setup step moved NumPy or Numba off the tested pair; restoring it",
        level="warning",
        details={"mode": mode},
    )
    progress_callback(total, total, "running", "Restoring the tested NumPy/Numba pair...")

    cmd = get_numeric_runtime_repair_cmd()
    returncode, output_lines = _run_step(cmd, total, total, mode, progress_callback)
    if returncode != 0:
        error = _summarize_command_error(output_lines, returncode)
        progress_callback(total, total, "error", error)
        add_log(
            "audio.setup.numeric_runtime.error",
            "Could not restore the NumPy/Numba pair",
            level="error",
            details={"mode": mode, "error": error},
        )
        raise RuntimeError(error)

    if not _numeric_runtime_ready():
        error = (
            "Setup finished, but the audio engine's NumPy and Numba still cannot load "
            "together. Close the app completely and run setup again."
        )
        progress_callback(total, total, "error", error)
        add_log(
            "audio.setup.numeric_runtime.error",
            error,
            level="error",
            details={"mode": mode},
        )
        raise RuntimeError(error)

    add_log(
        "audio.setup.numeric_runtime.repaired",
        "Restored the tested NumPy/Numba pair",
        details={"mode": mode},
    )


def _run_command_streaming(cmd, step, total, progress_callback):
    """Run one setup step, streaming its output into the log and the wizard.

    A step that cannot start at all comes back as a failed exit code, not an
    exception, so the retry below can take over. Antivirus removing the
    downloaded installer between the moment it was chosen and the moment it
    runs lands here as a file that is suddenly missing, and that is precisely
    the case the retry exists for.
    """
    append_terminal_log(f"$ {' '.join(cmd)}")
    # This step can move NumPy or Numba as a side effect of resolving
    # something else, so any remembered health answer is stale from here on.
    invalidate_numeric_runtime_probe()
    output_lines = []
    try:
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            encoding="utf-8",
            errors="replace",
            env=installer.subprocess_env(),
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        assert process.stdout is not None
        for raw_line in process.stdout:
            line = raw_line.rstrip()
            if not line:
                continue
            output_lines.append(line)
            append_terminal_log(line)
            progress_callback(step, total, "running", line)
        return process.wait(timeout=1200), output_lines
    except (OSError, subprocess.SubprocessError) as error:
        message = f"error: could not run the installer: {error}"
        output_lines.append(message)
        append_terminal_log(message)
        return 1, output_lines


def _summarize_command_error(output_lines, code):
    return installer.summarize_failure(output_lines, code)
