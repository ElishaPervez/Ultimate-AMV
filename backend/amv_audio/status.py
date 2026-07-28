from .hardware import get_dependency_info, get_hw_info, refresh_hardware
from .models import get_active_model, get_model_display_name


def build_status(*, mode=None, refresh=False):
    """Return the single status shape used by setup and normal status reads.

    Setup supplies the intended mode because its configuration is deliberately
    not saved until verification succeeds. Without that override, a CPU to GPU
    switch can inspect the old CPU preference and incorrectly report a healthy
    CUDA install as a CPU fallback.
    """
    force_cpu = None if mode is None else mode == "cpu"
    if refresh:
        hw = refresh_hardware(force_cpu)
    else:
        hw = get_hw_info(force_cpu)
    deps = get_dependency_info(force_cpu)
    model = get_active_model(hw)
    return {
        "type": "status",
        "hardware": hw,
        "dependencies": deps,
        "model": model,
        "model_name": get_model_display_name(model),
    }
