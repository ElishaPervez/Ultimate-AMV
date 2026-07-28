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
# Scoped upgrades — uv applies a bare --upgrade to everything it resolves
# ---------------------------------------------------------------------------


def test_uv_upgrade_can_be_limited_to_named_packages(with_uv):
    """Regression: a bare --upgrade let uv move packages nobody asked about.

    Installing the CPU ONNX runtime with a bare --upgrade also pulled NumPy to
    the newest release on the index. Numba cannot load against it, so audio
    separation died the moment a GPU -> CPU switch reported success.
    """
    cmd = installer_mod.install_cmd(["onnxruntime"], upgrade_packages=["onnxruntime"])
    assert "--upgrade" not in cmd, "the blanket form is what moved NumPy"
    assert cmd[cmd.index("--upgrade-package") + 1] == "onnxruntime"


def test_uv_reinstall_can_be_limited_to_named_packages(with_uv):
    cmd = installer_mod.install_cmd(["torch"], reinstall_packages=["torch"])
    assert "--reinstall" not in cmd
    assert cmd[cmd.index("--reinstall-package") + 1] == "torch"


def test_pip_needs_no_scoping_because_it_never_upgrades_eagerly(without_uv):
    """pip only replaces a dependency the new requirement cannot live with."""
    cmd = installer_mod.install_cmd(["onnxruntime"], upgrade_packages=["onnxruntime"])
    assert "--upgrade" in cmd
    assert "--upgrade-package" not in cmd


def test_scoped_flags_survive_the_rewrite_to_pip(with_uv):
    uv_cmd = installer_mod.install_cmd(
        ["torch"], upgrade_packages=["torch"], reinstall_packages=["torch"]
    )
    pip_cmd = installer_mod.to_pip_cmd(uv_cmd)

    assert "--upgrade" in pip_cmd
    assert "--force-reinstall" in pip_cmd
    # The package names that followed the uv-only switches must not survive as
    # loose arguments, or pip would try to install "torch" twice.
    assert pip_cmd.count("torch") == 1
    assert "--upgrade-package" not in pip_cmd
    assert "--reinstall-package" not in pip_cmd


def test_blanket_and_scoped_upgrades_do_not_double_up_in_the_pip_rewrite(with_uv):
    pip_cmd = installer_mod.to_pip_cmd(
        installer_mod.install_cmd(["numpy"], upgrade=True, upgrade_packages=["numpy"])
    )
    assert pip_cmd.count("--upgrade") == 1


# ---------------------------------------------------------------------------
# The version pin — no install may move the tested PyTorch/NumPy/Numba set
# ---------------------------------------------------------------------------


def test_runtime_constraints_file_pins_the_whole_tested_set(tmp_path):
    path = installer_mod.runtime_constraints_file()
    body = path.read_text(encoding="utf-8")
    for package in installer_mod.TORCH_PACKAGES:
        assert package in body
    # NumPy and Numba are pinned for the same reason PyTorch is: an install
    # that resolves them as a side effect must not be able to move them.
    assert installer_mod.NUMPY_PACKAGE in body
    assert installer_mod.NUMBA_PACKAGE in body


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


def _all_switch_install_cmds():
    """Every install command either mode switch can plan, all options on."""
    plans = [
        gpu_mod.get_gpu_switch_cmds(
            reinstall_torch=True,
            cleanup_cpu_runtime=True,
            install_audio_separator=True,
            force_reinstall_nelux=True,
            repair_numeric_runtime=True,
        ),
        gpu_mod.get_cpu_switch_cmds(
            reinstall_torch=True,
            cleanup_gpu_runtime=True,
            install_onnxruntime=True,
            install_audio_separator=True,
            repair_numeric_runtime=True,
        ),
    ]
    return [cmd for plan in plans for cmd in plan if "install" in cmd]


@pytest.mark.parametrize("uv", [True, False])
def test_no_switch_step_can_move_numpy_or_numba(request, uv):
    """The guard for the whole class of bug, not just the one that bit.

    Every install a mode switch can run must either name the NumPy and Numba
    versions itself or carry the pin file. One step that did neither -- the
    CPU ONNX runtime install -- replaced NumPy with a release Numba refuses to
    load against, and the switch reported success on a dead audio engine.
    """
    request.getfixturevalue("with_uv" if uv else "without_uv")

    for cmd in _all_switch_install_cmds():
        if "--no-deps" in cmd:
            # Nothing else is resolved, so nothing else can be moved.
            continue
        assert "-c" in cmd, f"unpinned install with no constraint file: {' '.join(cmd)}"
        body = open(cmd[cmd.index("-c") + 1], encoding="utf-8").read()
        assert installer_mod.NUMPY_PACKAGE in body
        assert installer_mod.NUMBA_PACKAGE in body


@pytest.mark.parametrize("uv", [True, False])
def test_no_switch_step_can_move_torch(request, uv):
    """Same guard for PyTorch: the audio packages depend on it."""
    request.getfixturevalue("with_uv" if uv else "without_uv")

    for cmd in _all_switch_install_cmds():
        joined = " ".join(cmd)
        if all(package in cmd for package in gpu_mod.TORCH_PACKAGES):
            continue
        if "--no-deps" in cmd:
            # Nothing is resolved, so nothing can be moved.
            continue
        assert "-c" in cmd, f"unpinned install with no constraint file: {joined}"
        body = open(cmd[cmd.index("-c") + 1], encoding="utf-8").read()
        for package in gpu_mod.TORCH_PACKAGES:
            assert package in body


def test_the_cpu_runtime_step_carries_the_pin(with_uv):
    """The exact step that broke the audio engine on a GPU -> CPU switch."""
    cmds = gpu_mod.get_cpu_switch_cmds(
        reinstall_torch=False,
        cleanup_gpu_runtime=False,
        install_onnxruntime=True,
        install_audio_separator=False,
    )
    assert len(cmds) == 1
    step = cmds[0]
    assert "--upgrade" not in step, "a blanket upgrade is what moved NumPy"
    assert step[step.index("--upgrade-package") + 1] == "onnxruntime"
    body = open(step[step.index("-c") + 1], encoding="utf-8").read()
    assert installer_mod.NUMPY_PACKAGE in body


def test_the_torch_swap_only_rewrites_the_torch_packages(with_uv):
    """It used to rewrite all 14 packages in the chain and downgrade one."""
    cmd = gpu_mod.get_torch_install_cmd(gpu=False)
    assert "--reinstall" not in cmd
    assert "--upgrade" not in cmd
    scoped = {cmd[i + 1] for i, token in enumerate(cmd) if token == "--reinstall-package"}
    assert scoped == {"torch", "torchvision", "torchaudio"}


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
