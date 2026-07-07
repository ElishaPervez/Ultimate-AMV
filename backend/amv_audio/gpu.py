import subprocess
import sys

TORCH_PACKAGES = ["torch", "torchvision", "torchaudio"]
AUDIO_RUNTIME_PACKAGES = [
    "audioop-lts",
    "beartype>=0.18.5,<0.19.0",
    "diffq-fixed",
    "einops",
    "julius",
    "librosa",
    "ml_collections",
    "onnx-weekly",
    "pyyaml",
    "requests",
    "resampy",
    "samplerate==0.1.0",
    "scipy<2.0.0,>=1.13.0",
    "six",
    "soundfile",
    "flatbuffers",
    "packaging",
    "protobuf",
]


def check_nvidia_gpu():
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip().split("\n")[0].strip()
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        pass
    return None


def get_torch_install_cmd(gpu):
    # --force-reinstall + --upgrade lets pip swap a +cpu wheel for a +cu128
    # wheel (or vice versa) in one shot. Pip downloads the replacement
    # before removing the existing install, so a network failure mid-repair
    # leaves the prior working install in place instead of an empty hole
    # the Settings panel reports as "missing".
    base = [
        sys.executable, "-I", "-m", "pip", "install",
        "--upgrade", "--force-reinstall",
        "torch", "torchvision", "torchaudio",
        "--index-url",
    ]
    if gpu:
        return base + ["https://download.pytorch.org/whl/cu128"]
    return base + ["https://download.pytorch.org/whl/cpu"]


def _get_uninstall_cmd(packages):
    if not packages:
        return None
    return [sys.executable, "-I", "-m", "pip", "uninstall", "-y", *packages]


def get_gpu_switch_cmds(
    *,
    reinstall_torch=True,
    cleanup_cpu_runtime=True,
    install_audio_separator=True,
    force_reinstall_nelux=False,
):
    cmds = []
    # We only pre-uninstall the *opposite* runtime (onnxruntime CPU when
    # switching to GPU): keeping both installed would let pip resolve to
    # whichever was on path. Torch swaps via --force-reinstall in the
    # install step itself so a failed download cannot leave the user with
    # no torch at all.
    if cleanup_cpu_runtime:
        uninstall_cmd = _get_uninstall_cmd(["onnxruntime"])
        if uninstall_cmd:
            cmds.append(uninstall_cmd)
    if reinstall_torch:
        cmds.append(get_torch_install_cmd(True))
    if install_audio_separator:
        # GPU mode: install audio-separator[gpu], nelux, and transnetv2-pytorch
        cmds.append([sys.executable, "-I", "-m", "pip", "install", "--upgrade", "typing_extensions", "audio-separator[gpu]", "nelux", "transnetv2-pytorch", *AUDIO_RUNTIME_PACKAGES])
    if force_reinstall_nelux:
        # Wheel metadata says nelux is installed but the C extension cannot
        # actually load (e.g. a file was quarantined by AV). A plain `pip
        # install nelux` would short-circuit as already-satisfied.
        cmds.append([sys.executable, "-I", "-m", "pip", "install", "--force-reinstall", "--no-deps", "nelux"])
    return cmds


def get_cpu_switch_cmds(
    *,
    reinstall_torch=True,
    cleanup_gpu_runtime=True,
    install_onnxruntime=True,
    install_audio_separator=True,
):
    cmds = []
    # See get_gpu_switch_cmds for why only the opposite runtime is
    # pre-uninstalled here : torch is swapped in-place via --force-reinstall.
    if cleanup_gpu_runtime:
        uninstall_cmd = _get_uninstall_cmd(["onnxruntime-gpu"])
        if uninstall_cmd:
            cmds.append(uninstall_cmd)
    if reinstall_torch:
        cmds.append(get_torch_install_cmd(False))
    if install_onnxruntime:
        cmds.append([sys.executable, "-I", "-m", "pip", "install", "--upgrade", "onnxruntime"])
    if install_audio_separator:
        # CPU mode: install audio-separator and scenedetect
        cmds.append([sys.executable, "-I", "-m", "pip", "install", "--upgrade", "typing_extensions", "audio-separator", "scenedetect>=0.6.7,<0.8", *AUDIO_RUNTIME_PACKAGES])
    return cmds
