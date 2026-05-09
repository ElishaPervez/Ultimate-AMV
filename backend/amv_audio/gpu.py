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
    base = [sys.executable, "-I", "-m", "pip", "install", "torch", "torchvision", "torchaudio", "--index-url"]
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
):
    cmds = []
    uninstall_packages = []
    if reinstall_torch:
        uninstall_packages.extend(TORCH_PACKAGES)
    if cleanup_cpu_runtime:
        uninstall_packages.append("onnxruntime")

    uninstall_cmd = _get_uninstall_cmd(uninstall_packages)
    if uninstall_cmd:
        cmds.append(uninstall_cmd)
    if reinstall_torch:
        cmds.append(get_torch_install_cmd(True))
    if install_audio_separator:
        # GPU mode: install audio-separator[gpu], nelux, and transnetv2-pytorch
        cmds.append([sys.executable, "-I", "-m", "pip", "install", "typing_extensions", "audio-separator[gpu]", "nelux", "transnetv2-pytorch", *AUDIO_RUNTIME_PACKAGES])
    return cmds


def get_cpu_switch_cmds(
    *,
    reinstall_torch=True,
    cleanup_gpu_runtime=True,
    install_onnxruntime=True,
    install_audio_separator=True,
):
    cmds = []
    uninstall_packages = []
    if reinstall_torch:
        uninstall_packages.extend(TORCH_PACKAGES)
    if cleanup_gpu_runtime:
        uninstall_packages.append("onnxruntime-gpu")

    uninstall_cmd = _get_uninstall_cmd(uninstall_packages)
    if uninstall_cmd:
        cmds.append(uninstall_cmd)
    if reinstall_torch:
        cmds.append(get_torch_install_cmd(False))
    if install_onnxruntime:
        cmds.append([sys.executable, "-I", "-m", "pip", "install", "onnxruntime"])
    if install_audio_separator:
        # CPU mode: install audio-separator and scenedetect[opencv]
        cmds.append([sys.executable, "-I", "-m", "pip", "install", "typing_extensions", "audio-separator", "scenedetect[opencv]", *AUDIO_RUNTIME_PACKAGES])
    return cmds
