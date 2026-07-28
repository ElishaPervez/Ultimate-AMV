"""Tests for the installer selection layer and the commands it builds."""

import sys

import pytest

from amv_audio import gpu as gpu_mod
from amv_audio import installer as installer_mod


@pytest.fixture(autouse=True)
def clear_probe_cache():
    """The uv probe is cached per process; tests must not leak into each other."""
    installer_mod._UV_CACHE.clear()
    yield
    installer_mod._UV_CACHE.clear()


@pytest.fixture
def with_uv(mocker, tmp_path):
    """Pretend a working uv is installed in the tools directory."""
    uv = tmp_path / installer_mod._UV_EXE
    uv.write_bytes(b"")
    mocker.patch.object(installer_mod, "_tools_dir", return_value=tmp_path)
    mocker.patch.object(installer_mod, "uv_available", return_value=True)
    return uv


@pytest.fixture
def without_uv(mocker, tmp_path):
    """Pretend uv was never downloaded."""
    mocker.patch.object(installer_mod, "_tools_dir", return_value=tmp_path)
    return tmp_path


# ---------------------------------------------------------------------------
# Which installer gets chosen
# ---------------------------------------------------------------------------


def test_uv_is_used_when_present(with_uv):
    assert installer_mod.active_installer() == "uv"


def test_pip_is_used_when_uv_was_never_downloaded(without_uv):
    assert installer_mod.active_installer() == "pip"


def test_override_forces_pip_even_with_uv_present(with_uv, monkeypatch):
    monkeypatch.setenv("ULTIMATE_AMV_INSTALLER", "pip")
    assert installer_mod.active_installer() == "pip"
    assert installer_mod.uv_path() is None


def test_override_cannot_force_a_uv_that_is_not_there(without_uv, monkeypatch):
    """Forcing uv on a machine without it must degrade, not build a dead command."""
    monkeypatch.setenv("ULTIMATE_AMV_INSTALLER", "uv")
    assert installer_mod.active_installer() == "pip"


def test_a_quarantined_uv_counts_as_absent(mocker, tmp_path, monkeypatch):
    """A file that exists but cannot start must not be chosen.

    Antivirus commonly truncates or blocks a downloaded binary. Picking it
    would turn setup into a failure instead of a slower success.
    """
    (tmp_path / installer_mod._UV_EXE).write_bytes(b"not a real program")
    mocker.patch.object(installer_mod, "_tools_dir", return_value=tmp_path)
    mocker.patch.object(
        installer_mod.subprocess, "run", side_effect=OSError("not executable")
    )
    assert installer_mod.uv_available() is False
    assert installer_mod.active_installer() == "pip"


def test_uv_is_never_taken_from_the_system_path(mocker, tmp_path, monkeypatch):
    """Hermeticity: only the app's own copy may be used."""
    monkeypatch.setenv("PATH", str(tmp_path))
    mocker.patch.object(installer_mod, "_tools_dir", return_value=tmp_path / "nothing")
    assert installer_mod.uv_path() is None


# ---------------------------------------------------------------------------
# Command construction
# ---------------------------------------------------------------------------


def test_uv_install_targets_the_bundled_python(with_uv):
    cmd = installer_mod.install_cmd(["pydub"])
    assert cmd[0] == str(with_uv)
    assert cmd[1:3] == ["pip", "install"]
    assert "--python" in cmd
    assert cmd[cmd.index("--python") + 1] == sys.executable
    assert "pydub" in cmd


def test_every_uv_command_blocks_outside_configuration(with_uv):
    """A stray uv config file on a user's machine must not redirect installs."""
    assert "--no-config" in installer_mod.install_cmd(["pydub"])
    assert "--no-config" in installer_mod.uninstall_cmd(["pydub"])


def test_pip_install_keeps_the_isolation_flag(without_uv):
    cmd = installer_mod.install_cmd(["pydub"])
    assert cmd[:5] == [sys.executable, "-I", "-m", "pip", "install"]


def test_uv_reinstall_flag(with_uv):
    cmd = installer_mod.install_cmd(["torch"], reinstall=True)
    assert "--reinstall" in cmd
    assert "--force-reinstall" not in cmd


def test_pip_reinstall_flag(without_uv):
    cmd = installer_mod.install_cmd(["torch"], reinstall=True)
    assert "--force-reinstall" in cmd


def test_uv_keeps_the_index_url(with_uv):
    cmd = installer_mod.install_cmd(["torch"], index_url="https://x/cu128")
    assert cmd[cmd.index("--index-url") + 1] == "https://x/cu128"


def test_pip_keeps_the_index_url(without_uv):
    cmd = installer_mod.install_cmd(["torch"], index_url="https://x/cu128")
    assert cmd[cmd.index("--index-url") + 1] == "https://x/cu128"


def test_uninstall_of_nothing_is_not_a_command(with_uv):
    assert installer_mod.uninstall_cmd([]) is None


# ---------------------------------------------------------------------------
# Falling back to pip
# ---------------------------------------------------------------------------


def test_a_uv_install_can_be_rewritten_as_the_pip_equivalent(with_uv):
    uv_cmd = installer_mod.install_cmd(
        ["torch"], index_url="https://x/cu128", upgrade=True, reinstall=True
    )
    pip_cmd = installer_mod.to_pip_cmd(uv_cmd)

    assert pip_cmd[:5] == [sys.executable, "-I", "-m", "pip", "install"]
    assert "--force-reinstall" in pip_cmd
    assert "--reinstall" not in pip_cmd
    assert "--upgrade" in pip_cmd
    assert "torch" in pip_cmd
    assert pip_cmd[pip_cmd.index("--index-url") + 1] == "https://x/cu128"
    # uv-only flags and the interpreter selection must not leak into pip.
    assert "--no-config" not in pip_cmd
    assert "--no-progress" not in pip_cmd
    assert "--python" not in pip_cmd


def test_a_uv_uninstall_rewrites_with_the_confirmation_flag(with_uv):
    pip_cmd = installer_mod.to_pip_cmd(installer_mod.uninstall_cmd(["onnxruntime"]))
    assert pip_cmd[:6] == [sys.executable, "-I", "-m", "pip", "uninstall", "-y"]
    assert "onnxruntime" in pip_cmd


def test_a_pip_command_has_no_fallback_to_rewrite(without_uv):
    assert installer_mod.to_pip_cmd(installer_mod.install_cmd(["pydub"])) is None


def test_constraints_survive_the_rewrite_to_pip(with_uv, tmp_path):
    pin = tmp_path / "pin.txt"
    pin.write_text("torch==2.11.0\n", encoding="utf-8")
    pip_cmd = installer_mod.to_pip_cmd(
        installer_mod.install_cmd(["audio-separator"], upgrade=True, constraints=pin)
    )
    assert pip_cmd[pip_cmd.index("-c") + 1] == str(pin)


# ---------------------------------------------------------------------------
# The PyTorch pin — the audio step must not drag PyTorch off its tested build
# ---------------------------------------------------------------------------


def test_torch_constraints_file_lists_every_pinned_torch_package(tmp_path):
    path = installer_mod.torch_constraints_file()
    body = path.read_text(encoding="utf-8")
    for package in installer_mod.TORCH_PACKAGES:
        assert package in body


@pytest.mark.parametrize("gpu", [True, False])
def test_audio_step_is_constrained_so_it_cannot_move_torch(with_uv, gpu):
    """Regression: without this the audio step replaces the pinned PyTorch.

    That step installs from the public index with --upgrade, and several of
    its packages depend on PyTorch. Unconstrained, the upgrade pulls PyTorch
    forward to a build with no CUDA in it and a version the GPU clip engine
    cannot load against, so setup "succeeds" and the app immediately asks for
    CUDA PyTorch again.
    """
    if gpu:
        cmds = gpu_mod.get_gpu_switch_cmds(
            reinstall_torch=False,
            cleanup_cpu_runtime=False,
            install_audio_separator=True,
        )
    else:
        cmds = gpu_mod.get_cpu_switch_cmds(
            reinstall_torch=False,
            cleanup_gpu_runtime=False,
            install_onnxruntime=False,
            install_audio_separator=True,
        )

    audio_steps = [cmd for cmd in cmds if any("audio-separator" in part for part in cmd)]
    assert audio_steps, "the audio install step should be planned"
    for cmd in audio_steps:
        assert "-c" in cmd, "the audio step must carry the PyTorch constraint"
        constraint_body = open(cmd[cmd.index("-c") + 1], encoding="utf-8").read()
        assert "torch==" in constraint_body


def test_switch_plans_still_pin_the_torch_versions(with_uv):
    cmds = gpu_mod.get_gpu_switch_cmds(
        reinstall_torch=True,
        cleanup_cpu_runtime=False,
        install_audio_separator=False,
    )
    torch_step = " ".join(cmds[0])
    assert "cu128" in torch_step
    for package in gpu_mod.TORCH_PACKAGES:
        assert package in torch_step


# ---------------------------------------------------------------------------
# Environment sealing and failure reporting
# ---------------------------------------------------------------------------


def test_outside_installer_settings_are_stripped_from_the_environment(monkeypatch):
    monkeypatch.setenv("UV_INDEX_URL", "https://evil.invalid/simple")
    monkeypatch.setenv("PIP_INDEX_URL", "https://evil.invalid/simple")
    monkeypatch.setenv("ULTIMATE_AMV_TOOLS_DIR", "C:/tools")

    env = installer_mod.subprocess_env()

    assert "UV_INDEX_URL" not in env
    assert "PIP_INDEX_URL" not in env
    # The app's own settings must survive.
    assert env["ULTIMATE_AMV_TOOLS_DIR"] == "C:/tools"


def test_failure_summary_finds_the_real_line_from_either_tool():
    pip_output = [
        "Collecting torch",
        "ERROR: Could not find a version that satisfies the requirement torch==9.9.9",
        "[notice] A new release of pip is available",
    ]
    assert "Could not find a version" in installer_mod.summarize_failure(pip_output, 1)

    uv_output = [
        "Resolved 3 packages",
        "error: Distribution not found at: torch==9.9.9",
    ]
    assert "Distribution not found" in installer_mod.summarize_failure(uv_output, 1)


def test_failure_summary_never_returns_a_version_nag():
    output = [
        "ERROR: something actually broke",
        "[notice] A new release of pip is available: 24.0 -> 25.0",
        "[notice] To update, run: python -m pip install --upgrade pip",
    ]
    assert installer_mod.summarize_failure(output, 1) == "ERROR: something actually broke"


def test_pruning_is_a_no_op_without_uv(without_uv):
    assert installer_mod.prune_cache() is False
