import importlib.util
import shutil
import subprocess
import sys
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

from . import installer
from .logs import add_log, append_terminal_log
from .runtime_versions import (
    NELUX_PACKAGE,
    NUMBA_PACKAGE,
    NUMBA_VERSION,
    NUMPY_PACKAGE,
    NUMPY_VERSION,
    TORCH_PACKAGES,
)


FEATURE_REQUIREMENTS = {
    "audio": {
        "modules": [
            ("typing_extensions", "typing_extensions"),
            ("pydub", "pydub"),
            ("audio_separator", "audio-separator"),
        ],
        "packages": [],
    },
    "clip_cpu": {
        "modules": [
            ("typing_extensions", "typing_extensions"),
            ("numpy", NUMPY_PACKAGE),
            # CPU scene detection runs PySceneDetect's ContentDetector, which
            # pulls in cv2 for its HSV frame scoring (0.7 lists opencv-python as
            # a core dep, so no [opencv] extra needed). <0.8 caps the API we
            # drive directly (detector.process_frame).
            ("scenedetect", "scenedetect>=0.6.7,<0.8"),
        ],
        "packages": [],
    },
    "clip_gpu": {
        "modules": [
            ("typing_extensions", "typing_extensions"),
            ("numpy", NUMPY_PACKAGE),
            ("transnetv2_pytorch", "transnetv2-pytorch"),
            ("nelux", NELUX_PACKAGE),
        ],
        "packages": [],
    },
    "bgremove_cpu": {
        "modules": [
            ("typing_extensions", "typing_extensions"),
            ("numpy", NUMPY_PACKAGE),
            # cv2 listed explicitly: processor.py needs it for video decode and
            # rembg >= 2.0.7x no longer depends on opencv itself.
            ("cv2", "opencv-python"),
            ("rembg", "rembg>=2.0.50"),
        ],
        "packages": [],
    },
    "bgremove_gpu": {
        "modules": [
            ("typing_extensions", "typing_extensions"),
            ("numpy", NUMPY_PACKAGE),
            ("cv2", "opencv-python"),
            ("rembg", "rembg[gpu]>=2.0.50"),
        ],
        "packages": [],
    },
    "interpolate_cpu": {
        "modules": [
            ("typing_extensions", "typing_extensions"),
            ("numpy", NUMPY_PACKAGE),
            ("torch", "torch"),
            ("torchvision", "torchvision"),
        ],
        "packages": [],
    },
    "interpolate_gpu": {
        "modules": [
            ("typing_extensions", "typing_extensions"),
            ("numpy", NUMPY_PACKAGE),
            ("torch", "torch"),
            ("torchvision", "torchvision"),
        ],
        "packages": [],
    },
}

KNOWN_MODULE_PACKAGES = {
    "audio_separator": "audio-separator",
    "audioop": "audioop-lts",
    "beartype": "beartype>=0.18.5,<0.19.0",
    "cv2": "opencv-python",
    "diffq": "diffq-fixed",
    "einops": "einops",
    "flatbuffers": "flatbuffers",
    "google.protobuf": "protobuf",
    "julius": "julius",
    "librosa": "librosa",
    "ml_collections": "ml_collections",
    "nelux": NELUX_PACKAGE,
    "numba": NUMBA_PACKAGE,
    "numpy": NUMPY_PACKAGE,
    "onnx": "onnx-weekly",
    "onnxruntime": "onnxruntime",
    "packaging": "packaging",
    "PIL": "pillow",
    "pydub": "pydub",
    "rembg": "rembg>=2.0.50",
    "yaml": "pyyaml",
    "requests": "requests",
    "resampy": "resampy",
    "samplerate": "samplerate==0.1.0",
    "scenedetect": "scenedetect>=0.6.7,<0.8",
    "scipy": "scipy",
    "six": "six",
    "soundfile": "soundfile",
    "torch": "torch",
    "torchaudio": "torchaudio",
    "torchvision": "torchvision",
    "tqdm": "tqdm",
    "transnetv2_pytorch": "transnetv2-pytorch",
    "typing_extensions": "typing_extensions",
}

# GPU runtimes need extras-form installs: recent rembg ships onnxruntime only
# behind its extras, so [gpu] is what guarantees onnxruntime-gpu lands with it.
GPU_MODULE_PACKAGES = {
    "rembg": "rembg[gpu]>=2.0.50",
}

AUDIO_RUNTIME_MODULES = [
    ("audioop", "audioop-lts"),
    ("beartype", "beartype>=0.18.5,<0.19.0"),
    ("diffq", "diffq-fixed"),
    ("einops", "einops"),
    ("julius", "julius"),
    ("librosa", "librosa"),
    ("ml_collections", "ml_collections"),
    ("numba", NUMBA_PACKAGE),
    ("onnx", "onnx-weekly"),
    ("yaml", "pyyaml"),
    ("requests", "requests"),
    ("resampy", "resampy"),
    ("samplerate", "samplerate==0.1.0"),
    ("scipy", "scipy"),
    ("six", "six"),
    ("soundfile", "soundfile"),
    ("flatbuffers", "flatbuffers"),
    ("packaging", "packaging"),
    ("google.protobuf", "protobuf"),
]


def _module_exists(module_name):
    try:
        return importlib.util.find_spec(module_name) is not None
    except (ImportError, AttributeError, ValueError):
        return False


def _package_exists(package_name):
    try:
        version(package_name)
        return True
    except PackageNotFoundError:
        return False
    except Exception:
        return False


def _audio_runtime_missing(module_name, package_name):
    if not _module_exists(module_name):
        return True
    if module_name == "beartype":
        try:
            current = version("beartype")
            return not current.startswith("0.18.")
        except Exception:
            return True
    if module_name == "samplerate":
        try:
            return version("samplerate") != "0.1.0"
        except Exception:
            return True
    return False


def _stream_command(cmd, progress_callback):
    """Run one installer command, streaming its output into the log and UI.

    A command that cannot start at all has to come back as a failed exit code
    rather than an exception. The retry that follows only looks at the exit
    code, and the case it exists for -- antivirus removing the downloaded
    installer between choosing it and running it -- shows up exactly here, as
    a file that is suddenly not there.
    """
    append_terminal_log(f"$ {' '.join(cmd)}")
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
            if progress_callback:
                progress_callback("dependency-repair", -1, line)
        return process.wait(timeout=1200), output_lines
    except (OSError, subprocess.SubprocessError) as error:
        message = f"error: could not run the installer: {error}"
        output_lines.append(message)
        append_terminal_log(message)
        return 1, output_lines


def _run_with_fallback(cmd, progress_callback, failure_event, failure_message):
    """Run an installer command; retry once through pip if uv cannot do it.

    uv is downloaded on demand, so it can be missing, quarantined or broken on
    a machine where pip works fine. Falling back keeps such a user on the slow
    install instead of stranding them with a failure they cannot act on.
    """
    code, output_lines = _stream_command(cmd, progress_callback)
    if code == 0:
        return output_lines

    fallback = installer.to_pip_cmd(cmd)
    if fallback is not None:
        summary = installer.summarize_failure(output_lines, code)
        add_log(
            "deps.installer.fallback",
            "Fast installer failed, retrying with the bundled one",
            level="warning",
            details={"error": summary},
        )
        if progress_callback:
            progress_callback("dependency-repair", -1, "Retrying with the bundled installer...")
        _ensure_pip(progress_callback)
        code, output_lines = _stream_command(fallback, progress_callback)
        if code == 0:
            return output_lines

    summary = installer.summarize_failure(output_lines, code)
    add_log(failure_event, failure_message, level="error", details={"error": summary})
    raise RuntimeError(summary)


def _run_pip_install(args, progress_callback=None):
    cmd = installer.install_cmd(args)
    _ensure_installer(cmd, progress_callback)
    add_log("deps.repair.step", "Running dependency repair command", details={"command": cmd})
    if progress_callback:
        progress_callback("dependency-repair", -1, f"Installing {' '.join(args)}...")

    _run_with_fallback(
        cmd,
        progress_callback,
        "deps.repair.step.error",
        "Dependency repair command failed",
    )
    _prune_unused_package_dirs()


def _run_prepared_install(cmd, progress_callback=None):
    """Run an already-built install command (the mode-switch plan builds its own)."""
    _ensure_installer(cmd, progress_callback)
    _run_with_fallback(
        cmd,
        progress_callback,
        "deps.repair.step.error",
        "Dependency repair command failed",
    )
    _prune_unused_package_dirs()


def _run_pip_uninstall(packages, progress_callback=None):
    cmd = installer.uninstall_cmd(packages)
    if cmd is None:
        return
    _ensure_installer(cmd, progress_callback)
    add_log("deps.repair.step", "Removing conflicting packages", details={"command": cmd})
    if progress_callback:
        progress_callback("dependency-repair", -1, f"Removing {' '.join(packages)}...")

    _run_with_fallback(
        cmd,
        progress_callback,
        "deps.repair.step.error",
        "Package removal failed",
    )


def _ensure_installer(cmd, progress_callback=None):
    """Make sure the tool this command names can actually run.

    uv arrives as a self-contained program, so there is nothing to prepare.
    pip has to exist inside the bundled Python, and on a fresh embeddable
    Python it does not.
    """
    if installer.is_uv_cmd(cmd):
        return
    _ensure_pip(progress_callback)


def _ensure_pip(progress_callback=None):
    try:
        result = subprocess.run(
            [sys.executable, "-I", "-m", "pip", "--version"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0:
            return
    except Exception:
        pass

    import os
    import tempfile
    import urllib.request

    if progress_callback:
        progress_callback("dependency-repair", -1, "Bootstrapping pip into bundled Python...")
    tmp = tempfile.NamedTemporaryFile(suffix=".py", delete=False)
    try:
        urllib.request.urlretrieve("https://bootstrap.pypa.io/get-pip.py", tmp.name)
        tmp.close()
        result = subprocess.run(
            [sys.executable, "-I", tmp.name],
            capture_output=True,
            text=True,
            timeout=300,
        )
        if result.returncode != 0:
            output = (result.stderr or result.stdout or "").strip()
            raise RuntimeError(f"pip bootstrap failed: {output[-500:]}")
    finally:
        os.unlink(tmp.name)



def _numeric_runtime_probe_error():
    """Return why the loaded NumPy/Numba pair is unusable, or None.

    This must run outside the current process. If the probe finds a broken
    NumPy build, pip needs to replace its files; importing NumPy here would
    keep native modules loaded while that replacement happens on Windows.
    """
    probe = (
        "import numpy\n"
        f"assert numpy.__version__ == {NUMPY_VERSION!r}, "
        "f'Expected NumPy " + NUMPY_VERSION + ", loaded {numpy.__version__}'\n"
        "import numba\n"
        f"assert numba.__version__ == {NUMBA_VERSION!r}, "
        "f'Expected Numba " + NUMBA_VERSION + ", loaded {numba.__version__}'\n"
    )
    try:
        result = subprocess.run(
            [sys.executable, "-I", "-c", probe],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError) as error:
        return str(error)
    if result.returncode == 0:
        return None
    lines = [
        line.strip()
        for line in ((result.stderr or "") + "\n" + (result.stdout or "")).splitlines()
        if line.strip()
    ]
    return lines[-1] if lines else "NumPy and Numba could not load together"


def _numeric_runtime_ready():
    return _numeric_runtime_probe_error() is None


def _site_packages_dir():
    # The app's embeddable Python is the environment. Never consult PATH or a
    # user/system site directory when cleaning its package records.
    return Path(sys.executable).resolve().parent / "Lib" / "site-packages"


# Installed directories nothing in this app ever reads. onnx ships its own
# test-suite fixtures as ~3,800 directories holding 9 files, and Tauri walks the
# bundled Python on every dev start and every build: its resource walker calls
# itself once per directory it skips and only unwinds when it reaches a file, so
# that many empty directories in a row overflow the build script's stack and the
# build dies before Rust compiles. Removing them also keeps them out of the
# installer.
UNUSED_PACKAGE_DIRS = ("onnx/backend/test/data",)


def _prune_unused_package_dirs():
    """Remove installed directories the app never reads. Never fatal."""
    site_packages = _site_packages_dir()
    if not site_packages.is_dir():
        return []

    removed = []
    for relative in UNUSED_PACKAGE_DIRS:
        target = site_packages.joinpath(*relative.split("/"))
        if not target.is_dir():
            continue
        try:
            shutil.rmtree(target)
        except OSError as error:
            # Leaving it behind only costs disk and a slower build, so a locked
            # file here must not fail an otherwise successful install.
            add_log(
                "deps.unused_dirs.prune_failed",
                "Could not remove an unused package directory",
                level="warning",
                details={"path": str(target), "error": str(error)},
            )
            continue
        removed.append(relative)
    if removed:
        add_log(
            "deps.unused_dirs.pruned",
            "Removed unused package directories",
            details={"removed": removed},
        )
    return removed


def _prune_stale_numeric_metadata():
    """Remove only obsolete NumPy/Numba version records after a good probe."""
    if not _numeric_runtime_ready():
        return []

    site_packages = _site_packages_dir()
    if not site_packages.is_dir():
        return []

    removed = []
    expected = {
        "numpy": f"numpy-{NUMPY_VERSION}.dist-info".lower(),
        "numba": f"numba-{NUMBA_VERSION}.dist-info".lower(),
    }
    for package, expected_name in expected.items():
        for candidate in site_packages.glob(f"{package}-*.dist-info"):
            if not candidate.is_dir() or candidate.name.lower() == expected_name:
                continue
            try:
                shutil.rmtree(candidate)
            except OSError as error:
                raise RuntimeError(
                    f"The audio runtime is repaired, but the stale package record "
                    f"{candidate.name} could not be removed: {error}"
                ) from error
            removed.append(candidate.name)
    if removed:
        add_log(
            "deps.numeric_metadata.pruned",
            "Removed stale numeric package records",
            details={"removed": removed},
        )
    return removed


def _repair_numeric_runtime(progress_callback=None):
    _run_prepared_install(
        installer.install_cmd(
            [NUMPY_PACKAGE, NUMBA_PACKAGE],
            upgrade=True,
            reinstall=True,
        ),
        progress_callback,
    )
    error = _numeric_runtime_probe_error()
    if error:
        raise RuntimeError(
            "NumPy and Numba were reinstalled, but audio processing still cannot start. "
            f"Last load error: {error}"
        )
    _prune_stale_numeric_metadata()


def _torch_import_error():
    try:
        import torch

        _ = torch.__version__
        return None
    except Exception as exc:
        return f"{type(exc).__name__}: {exc}"


def _install_torch(gpu, progress_callback=None, force=False):
    from .gpu import TORCH_CPU_INDEX, TORCH_CUDA_INDEX

    index_url = TORCH_CUDA_INDEX if gpu else TORCH_CPU_INDEX
    _run_prepared_install(
        installer.install_cmd(
            TORCH_PACKAGES,
            index_url=index_url,
            upgrade=force,
            reinstall=force,
        ),
        progress_callback,
    )


def _torch_ready(gpu):
    try:
        import torch

        if gpu:
            return torch.cuda.is_available()
        return True
    except Exception:
        return False


def _onnxruntime_import_error():
    try:
        import onnxruntime as ort

        _ = ort.get_available_providers()
        return None
    except Exception as exc:
        return f"{type(exc).__name__}: {exc}"


def _ort_cuda_probe():
    # Probe in a subprocess: importing onnxruntime here would pin its DLLs in
    # this process, and Windows would then block the pip uninstall/reinstall a
    # failed probe leads to.
    code = (
        "import sys, onnxruntime; "
        "sys.exit(0 if 'CUDAExecutionProvider' in onnxruntime.get_available_providers() else 1)"
    )
    try:
        result = subprocess.run(
            [sys.executable, "-I", "-c", code],
            capture_output=True,
            timeout=120,
        )
        return result.returncode == 0
    except Exception:
        return False


def _runtime_ready(gpu):
    if not gpu:
        return _onnxruntime_import_error() is None
    if not _package_exists("onnxruntime-gpu"):
        return False
    if _package_exists("onnxruntime"):
        # Both runtime dists registered: they ship the same onnxruntime module
        # directory, so whichever installed last owns the files and pip's
        # metadata is stale. Treat as broken so the repair reinstalls cleanly.
        return False
    # Dist metadata alone can lie (a CPU build may have clobbered the files),
    # so ask the installed module which providers its build actually has.
    return _ort_cuda_probe()


def _install_runtime(gpu, progress_callback=None):
    # The CPU and GPU ONNX runtimes ship the same module directory, so having
    # both installed leaves two records claiming the same files and the loser
    # describing something that is not on disk. Only the unwanted one is
    # removed: removing the wanted one first would mean a failed download
    # leaves the user with no runtime at all, which is the situation the
    # install-over rule exists to prevent.
    #
    # The wanted one is then reinstalled outright rather than installed,
    # because removing its twin can take shared files with it while leaving
    # its record intact -- and a plain install trusts that record and does
    # nothing.
    wanted = "onnxruntime-gpu" if gpu else "onnxruntime"
    opposite = "onnxruntime" if gpu else "onnxruntime-gpu"
    if _package_exists(opposite):
        _run_pip_uninstall([opposite], progress_callback)
    _run_prepared_install(
        installer.install_cmd([wanted], upgrade=True, reinstall=True),
        progress_callback,
    )


def missing_feature_dependencies(feature, gpu=False):
    req = FEATURE_REQUIREMENTS.get(feature)
    if req is None:
        raise ValueError(f"Unknown dependency feature: {feature}")

    missing = []
    for module_name, package_name in req["modules"]:
        if not _module_exists(module_name):
            missing.append((module_name, package_name))
    for package_name in req.get("packages", []):
        if not _package_exists(package_name):
            missing.append((package_name, package_name))

    if feature == "audio":
        for module_name, package_name in AUDIO_RUNTIME_MODULES:
            if _audio_runtime_missing(module_name, package_name):
                missing.append((module_name, package_name))
        if not _runtime_ready(gpu):
            missing.append(("onnxruntime", "onnxruntime-gpu" if gpu else "onnxruntime"))
        if not _torch_ready(gpu):
            missing.append(("torch", "torch CUDA" if gpu else "torch CPU"))
        if not _numeric_runtime_ready():
            missing.append(("numeric_runtime", f"{NUMPY_PACKAGE} + {NUMBA_PACKAGE}"))
    elif feature == "clip_gpu":
        if not _torch_ready(True):
            missing.append(("torch", "torch CUDA"))
    elif feature == "bgremove_gpu":
        if not _runtime_ready(True):
            missing.append(("onnxruntime", "onnxruntime-gpu"))
    elif feature == "bgremove_cpu":
        if not _runtime_ready(False):
            missing.append(("onnxruntime", "onnxruntime"))

    return missing


def ensure_feature_dependencies(feature, gpu=False, progress_callback=None):
    missing = missing_feature_dependencies(feature, gpu=gpu)
    if not missing:
        if feature == "audio":
            # A fixed update can restore the correct module files while stale
            # dist-info records from the broken update remain. Remove those
            # records before pip has another chance to trust them.
            _prune_stale_numeric_metadata()
        return False

    labels = [package for _module, package in missing]
    add_log(
        "deps.repair.start",
        "Repairing missing feature dependencies",
        details={"feature": feature, "gpu": gpu, "missing": labels},
    )
    if progress_callback:
        progress_callback("dependency-repair", -1, f"Repairing missing dependencies: {', '.join(labels)}")

    if any(module == "torch" for module, _package in missing):
        _install_torch(gpu, progress_callback, force=_module_exists("torch"))

    if any(module == "onnxruntime" for module, _package in missing):
        _install_runtime(gpu, progress_callback)

    pip_packages = []
    for module_name, package_name in missing:
        if module_name in {"torch", "onnxruntime", "numeric_runtime"}:
            continue
        if package_name not in pip_packages:
            pip_packages.append(package_name)
    if pip_packages:
        _run_pip_install(pip_packages, progress_callback)

    if feature == "audio" and not _numeric_runtime_ready():
        # Re-check after every other installation. A transitive dependency
        # must not be allowed to replace the verified pair mid-repair.
        _repair_numeric_runtime(progress_callback)

    if feature == "audio":
        _prune_stale_numeric_metadata()

    remaining = missing_feature_dependencies(feature, gpu=gpu)
    if remaining:
        labels = [package for _module, package in remaining]
        torch_error = _torch_import_error() if any(module == "torch" for module, _package in remaining) else None
        if torch_error:
            raise RuntimeError(
                "Dependency repair finished, but PyTorch still cannot load. "
                f"Last import error: {torch_error}. "
                "Run the setup again; if it repeats, reset hardware dependencies from manager.bat and reinstall."
            )
        onnxruntime_error = _onnxruntime_import_error() if any(module == "onnxruntime" for module, _package in remaining) else None
        if onnxruntime_error:
            raise RuntimeError(
                "Dependency repair finished, but ONNX Runtime still cannot load. "
                f"Last import error: {onnxruntime_error}. "
                "Close the app completely and run setup again; if it repeats, reset hardware dependencies from manager.bat and reinstall."
            )
        raise RuntimeError(f"Dependency repair finished but these packages are still missing: {', '.join(labels)}")

    add_log("deps.repair.complete", "Dependency repair completed", details={"feature": feature, "gpu": gpu})
    if progress_callback:
        progress_callback("dependency-repair", -1, "Dependency repair complete")
    return True


def repair_missing_module(module_name, gpu=False, progress_callback=None):
    package_name = KNOWN_MODULE_PACKAGES.get(module_name)
    if gpu and module_name in GPU_MODULE_PACKAGES:
        package_name = GPU_MODULE_PACKAGES[module_name]
    if not package_name:
        return False
    if _module_exists(module_name) and module_name != "torch":
        return False

    add_log(
        "deps.repair.module.start",
        "Repairing missing Python module",
        details={"module": module_name, "package": package_name, "gpu": gpu},
    )
    if module_name == "torch":
        _install_torch(gpu, progress_callback, force=_module_exists("torch"))
    elif module_name == "onnxruntime":
        _install_runtime(gpu, progress_callback)
    else:
        _run_pip_install([package_name], progress_callback)
    return True
