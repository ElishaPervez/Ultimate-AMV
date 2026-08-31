from unittest.mock import patch

from amv_audio.status import build_status


def test_build_status_uses_intended_gpu_mode_for_hardware_and_dependencies():
    hw = {
        "device": "Test GPU",
        "gpu_type": "nvidia",
        "fp16_capable": True,
    }
    deps = {"ready": True}

    with (
        patch("amv_audio.status.refresh_hardware", return_value=hw) as refresh,
        patch("amv_audio.status.get_dependency_info", return_value=deps) as dependency_info,
        patch("amv_audio.status.get_active_model", return_value="model.ckpt"),
        patch("amv_audio.status.get_model_display_name", return_value="Test model"),
    ):
        result = build_status(mode="gpu", refresh=True)

    refresh.assert_called_once_with(False)
    dependency_info.assert_called_once_with(False)
    assert result == {
        "type": "status",
        "hardware": hw,
        "dependencies": deps,
        "model": "model.ckpt",
        "model_name": "Test model",
    }


def test_build_status_normal_request_uses_saved_mode_path():
    hw = {"gpu_type": "cpu", "fp16_capable": False}

    with (
        patch("amv_audio.status.get_hw_info", return_value=hw) as get_hw_info,
        patch("amv_audio.status.get_dependency_info", return_value={"ready": True}) as dependency_info,
        patch("amv_audio.status.get_active_model", return_value="model.onnx"),
        patch("amv_audio.status.get_model_display_name", return_value="CPU model"),
    ):
        build_status()

    get_hw_info.assert_called_once_with(None)
    dependency_info.assert_called_once_with(None)
