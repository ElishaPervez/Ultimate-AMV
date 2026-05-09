import importlib.util
from importlib.metadata import version

from .config import load_config

_CACHE = {
    "checked": False,
    "torch_available": False,
    "torch_version": None,
    "ort_available": False,
    "ort_version": None,
    "hw_info": None,
}


def _ensure_init():
    if _CACHE["checked"]:
        return

    config = load_config()
    force_cpu = config.get("force_cpu", False)

    try:
        import torch

        _CACHE["torch_available"] = True
        _CACHE["torch_version"] = torch.__version__
    except Exception:
        _CACHE["torch_available"] = False
        _CACHE["torch_version"] = None

    try:
        import onnxruntime as ort

        _ = ort.get_available_providers()
        _CACHE["ort_available"] = True
        try:
            _CACHE["ort_version"] = version("onnxruntime")
        except Exception:
            _CACHE["ort_version"] = "installed"
    except Exception:
        _CACHE["ort_available"] = False
        _CACHE["ort_version"] = None

    gpu_detected = False
    if not force_cpu and _CACHE["torch_available"]:
        import torch

        if torch.cuda.is_available():
            props = torch.cuda.get_device_properties(0)
            gpu_name = torch.cuda.get_device_name(0)
            sm = (props.major, props.minor)
            _CACHE["hw_info"] = {
                "device": gpu_name,
                "device_short": "CUDA",
                "gpu_type": "nvidia",
                "tensor_cores": sm >= (7, 0),
                "fp16_capable": sm >= (7, 0),
                "fp8_capable": sm >= (8, 9),
                "provider": "CUDAExecutionProvider",
                "vram": f"{props.total_memory / (1024**3):.1f} GB",
            }
            gpu_detected = True

    if not gpu_detected:
        from .gpu import check_nvidia_gpu

        nvidia_name = check_nvidia_gpu()
        if nvidia_name:
            msg = "(Forced CPU)" if force_cpu else "(CUDA torch not installed)"
            _CACHE["hw_info"] = {
                "device": f"{nvidia_name} {msg}",
                "device_short": "CPU",
                "gpu_type": "nvidia",
                "tensor_cores": False,
                "fp16_capable": False,
                "fp8_capable": False,
                "provider": "CPU until CUDA torch is installed",
                "vram": None,
            }
            gpu_detected = True

    if not gpu_detected:
        _CACHE["hw_info"] = {
            "device": "CPU (Forced)" if force_cpu else "CPU",
            "device_short": "CPU",
            "gpu_type": "cpu",
            "tensor_cores": False,
            "fp16_capable": False,
            "fp8_capable": False,
            "provider": "CPUExecutionProvider" if _CACHE["ort_available"] else "CPU",
            "vram": None,
        }

    _CACHE["checked"] = True


def get_hw_info():
    _ensure_init()
    return _CACHE["hw_info"]


def get_dependency_info():
    _ensure_init()
    audio_separator = importlib.util.find_spec("audio_separator") is not None
    pydub = importlib.util.find_spec("pydub") is not None
    typing_extensions = importlib.util.find_spec("typing_extensions") is not None
    cuda_ready = verify_cuda_torch()
    runtime_ready = cuda_ready or _CACHE["ort_available"]
    return {
        "audio_separator": audio_separator,
        "pydub": pydub,
        "typing_extensions": typing_extensions,
        "torch": _CACHE["torch_available"],
        "torch_version": _CACHE["torch_version"],
        "onnxruntime": _CACHE["ort_available"],
        "onnxruntime_version": _CACHE["ort_version"],
        "runtime_ready": runtime_ready,
        "ready": audio_separator and pydub and typing_extensions and runtime_ready,
    }


def get_torch_status():
    _ensure_init()
    return _CACHE["torch_available"], _CACHE["torch_version"]


def verify_cuda_torch():
    try:
        import torch

        return torch.cuda.is_available()
    except Exception:
        return False


def refresh_hardware():
    _CACHE["checked"] = False
    _ensure_init()
    return _CACHE["hw_info"]
