"""
Tests for backend/amv_audio/setup.py

Covers:
- _nelux_importable: returns True/False based on subprocess exit code
- _installed_torch_mode: detects cpu/gpu/missing from wheel tag
- collect_setup_plan: gpu / cpu plan shape
- _summarize_command_error: extracts error line
- apply_success_mode: updates config
"""
import sys
import subprocess
from pathlib import Path
from unittest.mock import patch, MagicMock
import json

import pytest

_BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))


def _get_setup():
    """Import amv_audio.setup inside each test to avoid module-level side effects."""
    import importlib
    import amv_audio.setup
    return importlib.import_module("amv_audio.setup")


# ---------------------------------------------------------------------------
# _nelux_importable — subprocess-level probe
# ---------------------------------------------------------------------------


def test_nelux_importable_returns_true_when_probe_succeeds(mocker):
    m = _get_setup()
    mocker.patch(
        "amv_audio.setup.subprocess.run",
        return_value=MagicMock(returncode=0, stdout="", stderr=""),
    )
    assert m._nelux_importable() is True


def test_nelux_importable_returns_false_when_probe_fails(mocker):
    m = _get_setup()
    mocker.patch(
        "amv_audio.setup.subprocess.run",
        return_value=MagicMock(returncode=1, stdout="", stderr="ImportError: PyTorch must be imported before Nelux."),
    )
    assert m._nelux_importable() is False


def test_nelux_importable_returns_false_on_timeout(mocker):
    m = _get_setup()
    mocker.patch(
        "amv_audio.setup.subprocess.run",
        side_effect=subprocess.TimeoutExpired(cmd="python", timeout=20),
    )
    assert m._nelux_importable() is False


def test_nelux_importable_returns_false_on_file_not_found(mocker):
    m = _get_setup()
    mocker.patch(
        "amv_audio.setup.subprocess.run",
        side_effect=FileNotFoundError("python not found"),
    )
    assert m._nelux_importable() is False


def test_nelux_importable_probe_includes_torch_import(mocker):
    """The subprocess probe must import torch before nelux — per CLAUDE.md requirement."""
    m = _get_setup()
    captured_calls = []
    def fake_run(cmd, **kwargs):
        captured_calls.append(cmd)
        return MagicMock(returncode=0, stdout="", stderr="")

    mock_run = mocker.patch("amv_audio.setup.subprocess.run", side_effect=fake_run)
    m._nelux_importable()
    call_args = mock_run.call_args
    cmd_list = call_args[0][0]
    c_idx = cmd_list.index("-c")
    probe_code = cmd_list[c_idx + 1]
    assert "import torch" in probe_code, "Probe must import torch before nelux"
    assert "import nelux" in probe_code, "Probe must import nelux"


def test_nelux_importable_probe_includes_dll_directory(mocker):
    """The probe must reference add_dll_directory for ffmpeg-shared DLLs."""
    m = _get_setup()
    mock_run = mocker.patch(
        "amv_audio.setup.subprocess.run",
        return_value=MagicMock(returncode=0, stdout="", stderr=""),
    )
    m._nelux_importable()
    call_args = mock_run.call_args
    cmd_list = call_args[0][0]
    c_idx = cmd_list.index("-c")
    probe_code = cmd_list[c_idx + 1]
    assert "add_dll_directory" in probe_code or "ffmpeg-shared" in probe_code


# ---------------------------------------------------------------------------
# _installed_torch_mode
# ---------------------------------------------------------------------------


def test_installed_torch_mode_detects_gpu_wheel(mocker):
    m = _get_setup()
    # version is imported locally inside _installed_torch_mode
    mocker.patch("importlib.metadata.version", return_value="2.3.0+cu128")
    mode, ver, is_gpu = m._installed_torch_mode()
    assert mode == "gpu"
    assert is_gpu is True
    assert "+cu128" in ver


def test_installed_torch_mode_detects_cpu_wheel(mocker):
    m = _get_setup()
    mocker.patch("importlib.metadata.version", return_value="2.3.0+cpu")
    mode, ver, is_gpu = m._installed_torch_mode()
    assert mode == "cpu"
    assert is_gpu is False


def test_installed_torch_mode_missing_returns_missing(mocker):
    m = _get_setup()
    from importlib.metadata import PackageNotFoundError
    mocker.patch("importlib.metadata.version", side_effect=PackageNotFoundError("torch"))
    mode, ver, is_gpu = m._installed_torch_mode()
    assert mode == "missing"
    assert ver is None
    assert is_gpu is False


# ---------------------------------------------------------------------------
# collect_setup_plan — shape validation
# ---------------------------------------------------------------------------


def _patch_setup_checks(mocker, *, nvidia=True, installed_mode="gpu", ort_gpu=True,
                         ort_cpu=False, audio_sep=True, typing_ext=True,
                         pydub=True, missing_audio_rt=None,
                         nelux_installed=True, nelux_importable=True):
    missing_audio_rt = missing_audio_rt or []
    mocker.patch("amv_audio.setup.check_nvidia_gpu", return_value="RTX 4090" if nvidia else None)
    mocker.patch("amv_audio.setup._installed_torch_mode", return_value=(installed_mode, "2.3.0+cu128", installed_mode == "gpu"))
    mocker.patch("amv_audio.setup._check_package", side_effect=lambda pkg: {
        "audio-separator": audio_sep,
        "typing_extensions": typing_ext,
        "pydub": pydub,
        "onnxruntime": ort_cpu,
        "onnxruntime-gpu": ort_gpu,
        "nelux": nelux_installed,
    }.get(pkg, False))
    mocker.patch("amv_audio.setup._missing_audio_runtime_modules", return_value=missing_audio_rt)
    mocker.patch("amv_audio.setup._nelux_importable", return_value=nelux_importable)


def test_collect_gpu_plan_has_required_keys(mocker):
    m = _get_setup()
    _patch_setup_checks(mocker)
    plan = m.collect_setup_plan("gpu")
    for key in ("mode", "rows", "issues", "installs", "success_mode", "gpu_name"):
        assert key in plan, f"Missing key: {key!r}"


def test_collect_gpu_plan_ready_when_all_installed(mocker):
    m = _get_setup()
    _patch_setup_checks(mocker, nvidia=True, installed_mode="gpu", ort_gpu=True,
                         ort_cpu=False, audio_sep=True, typing_ext=True,
                         pydub=True, nelux_installed=True, nelux_importable=True)
    plan = m.collect_setup_plan("gpu")
    assert plan["issues"] == []
    assert plan["installs"] == []
    assert plan["success_mode"] == "gpu"


def test_collect_gpu_plan_reports_missing_nvidia(mocker):
    m = _get_setup()
    _patch_setup_checks(mocker, nvidia=False)
    plan = m.collect_setup_plan("gpu")
    assert any("NVIDIA" in issue or "GPU" in issue for issue in plan["issues"])


def test_collect_gpu_plan_reports_wrong_torch_mode(mocker):
    m = _get_setup()
    _patch_setup_checks(mocker, installed_mode="cpu")
    plan = m.collect_setup_plan("gpu")
    assert any("PyTorch" in issue or "CUDA" in issue for issue in plan["issues"])


def test_collect_cpu_plan_has_required_keys(mocker):
    m = _get_setup()
    _patch_setup_checks(mocker, installed_mode="cpu", ort_cpu=True, ort_gpu=False)
    plan = m.collect_setup_plan("cpu")
    for key in ("mode", "rows", "issues", "installs", "success_mode", "gpu_name"):
        assert key in plan, f"Missing key: {key!r}"


def test_collect_cpu_plan_ready_when_all_installed(mocker):
    m = _get_setup()
    _patch_setup_checks(mocker, installed_mode="cpu", ort_cpu=True, ort_gpu=False,
                         audio_sep=True, typing_ext=True, pydub=True)
    plan = m.collect_setup_plan("cpu")
    assert plan["issues"] == []
    assert plan["installs"] == []
    assert plan["success_mode"] == "cpu"


def test_collect_cpu_plan_reports_gpu_runtime_present(mocker):
    m = _get_setup()
    _patch_setup_checks(mocker, installed_mode="cpu", ort_cpu=True, ort_gpu=True)
    plan = m.collect_setup_plan("cpu")
    assert any("GPU" in issue or "onnxruntime" in issue.lower() for issue in plan["issues"])


def test_collect_plan_raises_for_invalid_mode():
    m = _get_setup()
    with pytest.raises(ValueError):
        m.collect_setup_plan("invalid")


# ---------------------------------------------------------------------------
# _summarize_command_error
# ---------------------------------------------------------------------------


def test_summarize_command_error_returns_error_line():
    m = _get_setup()
    lines = [
        "Collecting torch",
        "ERROR: Could not find a version that satisfies the requirement",
        "Some other line",
    ]
    result = m._summarize_command_error(lines, 1)
    assert "ERROR" in result


def test_summarize_command_error_ignores_notice_lines():
    m = _get_setup()
    lines = [
        "[notice] A new release of pip is available",
        "To update, run: pip install --upgrade pip",
        "ERROR: Real error message",
    ]
    result = m._summarize_command_error(lines, 1)
    assert "Real error message" in result
    assert "[notice]" not in result


def test_summarize_command_error_fallback_when_no_error_line():
    m = _get_setup()
    lines = ["Some output", "More output", "Last line"]
    result = m._summarize_command_error(lines, 42)
    assert result == "Last line"


def test_summarize_command_error_empty_lines_uses_exit_code():
    m = _get_setup()
    result = m._summarize_command_error([], 99)
    assert "99" in result


# ---------------------------------------------------------------------------
# apply_success_mode — config mutation
# ---------------------------------------------------------------------------


def test_apply_success_mode_gpu_sets_config(mocker):
    m = _get_setup()
    mocker.patch("amv_audio.setup.refresh_hardware")
    saved = {}
    mocker.patch("amv_audio.setup.load_config", return_value={"setup_type": "cpu", "force_cpu": False})
    mocker.patch("amv_audio.setup.save_config", side_effect=lambda c: saved.update(c))

    m.apply_success_mode("gpu")

    assert saved["setup_type"] == "gpu"
    assert saved["force_cpu"] is False


def test_apply_success_mode_cpu_sets_force_cpu_true(mocker):
    m = _get_setup()
    mocker.patch("amv_audio.setup.refresh_hardware")
    saved = {}
    mocker.patch("amv_audio.setup.load_config", return_value={"setup_type": "gpu", "force_cpu": False})
    mocker.patch("amv_audio.setup.save_config", side_effect=lambda c: saved.update(c))

    m.apply_success_mode("cpu")

    assert saved["setup_type"] == "cpu"
    assert saved["force_cpu"] is True
