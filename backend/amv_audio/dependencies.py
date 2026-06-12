import importlib.util
import subprocess
import sys
from importlib.metadata import PackageNotFoundError, version

from .logs import add_log, append_terminal_log


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
            ("numpy", "numpy"),
        ],
        "packages": [],
    },
    "clip_gpu": {
        "modules": [
            ("typing_extensions", "typing_extensions"),
            ("numpy", "numpy"),
            ("transnetv2_pytorch", "transnetv2-pytorch"),
            ("nelux", "nelux"),
        ],
        "packages": [],
    },
    "bgremove_cpu": {
        "modules": [
            ("typing_extensions", "typing_extensions"),
            ("numpy", "numpy"),
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
            ("numpy", "numpy"),
            ("cv2", "opencv-python"),
            ("rembg", "rembg[gpu]>=2.0.50"),
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
    "nelux": "nelux",
    "numpy": "numpy",
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
    "scenedetect": "scenedetect[opencv]",
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

TORCH_PACKAGES = ["torch", "torchvision", "torchaudio"]
AUDIO_RUNTIME_MODULES = [
    ("audioop", "audioop-lts"),
    ("beartype", "beartype>=0.18.5,<0.19.0"),
    ("diffq", "diffq-fixed"),
    ("einops", "einops"),
    ("julius", "julius"),
    ("librosa", "librosa"),
    ("ml_collections", "ml_collections"),
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


def _run_pip_install(args, progress_callback=None):
    _ensure_pip(progress_callback)
    cmd = [sys.executable, "-I", "-m", "pip", "install", *args]
    append_terminal_log(f"$ {' '.join(cmd)}")
    add_log("deps.repair.step", "Running dependency repair command", details={"command": cmd})
    if progress_callback:
        progress_callback("dependency-repair", -1, f"Installing {' '.join(args)}...")

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
        if progress_callback:
            progress_callback("dependency-repair", -1, line)
    code = process.wait(timeout=1200)
    if code != 0:
        summary = _summarize_command_error(output_lines, code)
        add_log("deps.repair.step.error", "Dependency repair command failed", level="error", details={"error": summary})
        raise RuntimeError(summary)


def _run_pip_uninstall(packages, progress_callback=None):
    _ensure_pip(progress_callback)
    cmd = [sys.executable, "-I", "-m", "pip", "uninstall", "-y", *packages]
    append_terminal_log(f"$ {' '.join(cmd)}")
    add_log("deps.repair.step", "Removing conflicting packages", details={"command": cmd})
    if progress_callback:
        progress_callback("dependency-repair", -1, f"Removing {' '.join(packages)}...")

    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=600,
        encoding="utf-8",
        errors="replace",
    )
    output_lines = [
        line.rstrip()
        for line in ((result.stdout or "") + (result.stderr or "")).splitlines()
        if line.strip()
    ]
    for line in output_lines:
        append_terminal_log(line)
    if result.returncode != 0:
        summary = _summarize_command_error(output_lines, result.returncode)
        add_log("deps.repair.step.error", "Package removal failed", level="error", details={"error": summary})
        raise RuntimeError(summary)


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


def _torch_import_error():
    try:
        import torch

        _ = torch.__version__
        return None
    except Exception as exc:
        return f"{type(exc).__name__}: {exc}"


def _install_torch(gpu, progress_callback=None, force=False):
    index_url = "https://download.pytorch.org/whl/cu128" if gpu else "https://download.pytorch.org/whl/cpu"
    args = [*TORCH_PACKAGES, "--index-url", index_url]
    if force:
        args.extend(["--upgrade", "--force-reinstall"])
    _run_pip_install(args, progress_callback)


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
    # onnxruntime and onnxruntime-gpu ship the same module directory, so
    # installing one next to the other leaves two dists claiming the same
    # files and the loser's metadata lying about what is on disk. Remove
    # whatever runtime dists exist before installing the wanted one.
    installed = [
        name for name in ("onnxruntime", "onnxruntime-gpu") if _package_exists(name)
    ]
    if installed:
        _run_pip_uninstall(installed, progress_callback)
    _run_pip_install(["onnxruntime-gpu" if gpu else "onnxruntime"], progress_callback)


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
        if module_name in {"torch", "onnxruntime"}:
            continue
        if package_name not in pip_packages:
            pip_packages.append(package_name)
    if pip_packages:
        _run_pip_install(pip_packages, progress_callback)

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
        _install_runtime(gpu, progress_callback, force=_module_exists("onnxruntime"))
    else:
        _run_pip_install([package_name], progress_callback)
    return True
