"""
Tests for backend/amv_audio/gpu.py

Covers:
- check_nvidia_gpu: GPU found, not found, timeout, FileNotFoundError
- get_torch_install_cmd: --upgrade --force-reinstall form, correct index URL
- get_gpu_switch_cmds / get_cpu_switch_cmds: command composition, no simultaneous
  pip-uninstall + pip-install for torch (only --force-reinstall)
"""
import sys
import subprocess
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

_BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

from amv_audio.gpu import (
    check_nvidia_gpu,
    get_torch_install_cmd,
    get_gpu_switch_cmds,
    get_cpu_switch_cmds,
    TORCH_PACKAGES,
)


# ---------------------------------------------------------------------------
# check_nvidia_gpu
# ---------------------------------------------------------------------------


def test_check_nvidia_gpu_returns_name_when_found(mocker):
    mocker.patch(
        "amv_audio.gpu.subprocess.run",
        return_value=MagicMock(returncode=0, stdout="NVIDIA GeForce RTX 3080\n"),
    )
    result = check_nvidia_gpu()
    assert result == "NVIDIA GeForce RTX 3080"


def test_check_nvidia_gpu_returns_none_when_not_found(mocker):
    mocker.patch(
        "amv_audio.gpu.subprocess.run",
        return_value=MagicMock(returncode=1, stdout=""),
    )
    result = check_nvidia_gpu()
    assert result is None


def test_check_nvidia_gpu_returns_none_on_empty_stdout(mocker):
    mocker.patch(
        "amv_audio.gpu.subprocess.run",
        return_value=MagicMock(returncode=0, stdout="   \n"),
    )
    result = check_nvidia_gpu()
    assert result is None


def test_check_nvidia_gpu_returns_none_on_file_not_found(mocker):
    mocker.patch(
        "amv_audio.gpu.subprocess.run",
        side_effect=FileNotFoundError("nvidia-smi not found"),
    )
    result = check_nvidia_gpu()
    assert result is None


def test_check_nvidia_gpu_returns_none_on_timeout(mocker):
    mocker.patch(
        "amv_audio.gpu.subprocess.run",
        side_effect=subprocess.TimeoutExpired(cmd="nvidia-smi", timeout=10),
    )
    result = check_nvidia_gpu()
    assert result is None


def test_check_nvidia_gpu_returns_first_line_only(mocker):
    """When multiple GPUs are listed, only the first name is returned."""
    mocker.patch(
        "amv_audio.gpu.subprocess.run",
        return_value=MagicMock(returncode=0, stdout="RTX 4090\nRTX 3080\n"),
    )
    result = check_nvidia_gpu()
    assert result == "RTX 4090"


# ---------------------------------------------------------------------------
# get_torch_install_cmd — CLAUDE.md rule: must use --upgrade --force-reinstall
# ---------------------------------------------------------------------------


def test_get_torch_install_cmd_gpu_uses_force_reinstall():
    """GPU torch install must include --upgrade --force-reinstall (never separate uninstall)."""
    cmd = get_torch_install_cmd(gpu=True)
    assert "--upgrade" in cmd
    assert "--force-reinstall" in cmd


def test_get_torch_install_cmd_cpu_uses_force_reinstall():
    cmd = get_torch_install_cmd(gpu=False)
    assert "--upgrade" in cmd
    assert "--force-reinstall" in cmd


def test_get_torch_install_cmd_gpu_uses_cuda_index_url():
    cmd = get_torch_install_cmd(gpu=True)
    joined = " ".join(cmd)
    assert "cu128" in joined
    assert "https://download.pytorch.org/whl/cu128" in joined


def test_get_torch_install_cmd_cpu_uses_cpu_index_url():
    cmd = get_torch_install_cmd(gpu=False)
    joined = " ".join(cmd)
    assert "https://download.pytorch.org/whl/cpu" in joined


def test_get_torch_install_cmd_contains_all_torch_packages():
    for mode in (True, False):
        cmd = get_torch_install_cmd(gpu=mode)
        for pkg in TORCH_PACKAGES:
            assert pkg in cmd, f"Package {pkg!r} missing from {'GPU' if mode else 'CPU'} install cmd"


def test_get_torch_install_cmd_no_separate_uninstall_step():
    """There must be no 'uninstall' in the torch install command."""
    for mode in (True, False):
        cmd = get_torch_install_cmd(gpu=mode)
        assert "uninstall" not in cmd, "torch install should not include a separate uninstall step"


# ---------------------------------------------------------------------------
# get_gpu_switch_cmds
# ---------------------------------------------------------------------------


def test_get_gpu_switch_cmds_default_includes_torch_and_separator():
    cmds = get_gpu_switch_cmds()
    flat = [" ".join(c) for c in cmds]
    # At least one command installs torch
    assert any("torch" in s for s in flat)
    # At least one command installs audio-separator
    assert any("audio-separator" in s for s in flat)


def test_get_gpu_switch_cmds_uninstalls_onnxruntime_cpu_not_gpu():
    """GPU switch pre-uninstalls onnxruntime (CPU runtime), not onnxruntime-gpu."""
    cmds = get_gpu_switch_cmds(cleanup_cpu_runtime=True)
    flat = [" ".join(c) for c in cmds]
    uninstall_cmds = [s for s in flat if "uninstall" in s]
    assert any("onnxruntime" in s for s in uninstall_cmds)
    # onnxruntime-gpu must NOT be uninstalled in GPU switch
    assert not any("onnxruntime-gpu" in s for s in uninstall_cmds)


def test_get_gpu_switch_cmds_no_uninstall_when_cleanup_disabled():
    cmds = get_gpu_switch_cmds(cleanup_cpu_runtime=False)
    flat = [" ".join(c) for c in cmds]
    assert not any("uninstall" in s for s in flat)


def test_get_gpu_switch_cmds_force_reinstall_nelux():
    cmds = get_gpu_switch_cmds(force_reinstall_nelux=True)
    flat = [" ".join(c) for c in cmds]
    nelux_reinstall = [s for s in flat if "nelux" in s and "--force-reinstall" in s]
    assert nelux_reinstall, "force_reinstall_nelux=True must produce a nelux force-reinstall command"


# ---------------------------------------------------------------------------
# get_cpu_switch_cmds
# ---------------------------------------------------------------------------


def test_get_cpu_switch_cmds_default_includes_torch_and_separator():
    cmds = get_cpu_switch_cmds()
    flat = [" ".join(c) for c in cmds]
    assert any("torch" in s for s in flat)
    assert any("audio-separator" in s for s in flat)


def test_get_cpu_switch_cmds_uninstalls_onnxruntime_gpu_not_cpu():
    """CPU switch pre-uninstalls onnxruntime-gpu, never the CPU runtime."""
    cmds = get_cpu_switch_cmds(cleanup_gpu_runtime=True)
    flat = [" ".join(c) for c in cmds]
    uninstall_cmds = [s for s in flat if "uninstall" in s]
    assert any("onnxruntime-gpu" in s for s in uninstall_cmds)
    # CPU onnxruntime must NOT be uninstalled during a CPU switch
    standalone_ort = [s for s in uninstall_cmds if "onnxruntime" in s and "onnxruntime-gpu" not in s]
    assert not standalone_ort


def test_get_cpu_switch_cmds_no_uninstall_when_cleanup_disabled():
    cmds = get_cpu_switch_cmds(cleanup_gpu_runtime=False)
    flat = [" ".join(c) for c in cmds]
    assert not any("uninstall" in s for s in flat)


def test_get_cpu_switch_cmds_torch_uses_cpu_index_url():
    cmds = get_cpu_switch_cmds(reinstall_torch=True)
    flat = [" ".join(c) for c in cmds]
    torch_cmds = [s for s in flat if "torch" in s and "index-url" in s]
    assert torch_cmds
    assert all("cpu" in s for s in torch_cmds)
