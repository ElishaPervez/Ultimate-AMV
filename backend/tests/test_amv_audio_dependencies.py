"""
Tests for backend/amv_audio/dependencies.py

Covers:
- _module_exists: True when importable, False when not
- _package_exists: True when installed, False when not
- missing_feature_dependencies: returns empty list when all present
- missing_feature_dependencies: returns list when modules absent
- FEATURE_REQUIREMENTS contains correct keys
- _summarize_command_error: error extraction
- _install_torch: passes --upgrade --force-reinstall when force=True
"""
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock, call

import pytest

_BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

# The logs module side-effects (reading STATE_DIR) need to be safe.
# We import the module carefully.
import amv_audio.dependencies as deps_mod


# ---------------------------------------------------------------------------
# FEATURE_REQUIREMENTS structure
# ---------------------------------------------------------------------------


def test_feature_requirements_has_audio_key():
    assert "audio" in deps_mod.FEATURE_REQUIREMENTS


def test_feature_requirements_has_clip_cpu_key():
    assert "clip_cpu" in deps_mod.FEATURE_REQUIREMENTS


def test_feature_requirements_has_clip_gpu_key():
    assert "clip_gpu" in deps_mod.FEATURE_REQUIREMENTS


def test_feature_requirements_audio_has_modules_list():
    req = deps_mod.FEATURE_REQUIREMENTS["audio"]
    assert "modules" in req
    assert isinstance(req["modules"], list)


# ---------------------------------------------------------------------------
# _module_exists
# ---------------------------------------------------------------------------


def test_module_exists_returns_true_for_existing_module(mocker):
    mocker.patch("amv_audio.dependencies.importlib.util.find_spec", return_value=MagicMock())
    assert deps_mod._module_exists("some_module") is True


def test_module_exists_returns_false_when_spec_is_none(mocker):
    mocker.patch("amv_audio.dependencies.importlib.util.find_spec", return_value=None)
    assert deps_mod._module_exists("some_module") is False


def test_module_exists_returns_false_on_import_error(mocker):
    mocker.patch("amv_audio.dependencies.importlib.util.find_spec", side_effect=ImportError)
    assert deps_mod._module_exists("bad_module") is False


def test_module_exists_returns_false_on_value_error(mocker):
    mocker.patch("amv_audio.dependencies.importlib.util.find_spec", side_effect=ValueError)
    assert deps_mod._module_exists("bad_module") is False


# ---------------------------------------------------------------------------
# _package_exists
# ---------------------------------------------------------------------------


def test_package_exists_returns_true_when_version_found(mocker):
    mocker.patch("amv_audio.dependencies.version", return_value="1.0.0")
    assert deps_mod._package_exists("some-package") is True


def test_package_exists_returns_false_when_not_found(mocker):
    from importlib.metadata import PackageNotFoundError
    mocker.patch("amv_audio.dependencies.version", side_effect=PackageNotFoundError("pkg"))
    assert deps_mod._package_exists("missing-package") is False


def test_package_exists_returns_false_on_unexpected_error(mocker):
    mocker.patch("amv_audio.dependencies.version", side_effect=RuntimeError("unexpected"))
    assert deps_mod._package_exists("bad-package") is False


# ---------------------------------------------------------------------------
# missing_feature_dependencies
# ---------------------------------------------------------------------------


def test_missing_feature_dependencies_raises_for_unknown_feature():
    with pytest.raises(ValueError, match="Unknown dependency feature"):
        deps_mod.missing_feature_dependencies("nonexistent_feature")


def test_missing_feature_dependencies_returns_empty_when_all_present_clip_cpu(mocker):
    mocker.patch("amv_audio.dependencies._module_exists", return_value=True)
    result = deps_mod.missing_feature_dependencies("clip_cpu")
    assert result == []


def test_missing_feature_dependencies_returns_missing_modules_clip_cpu(mocker):
    # Make numpy missing, typing_extensions present
    def fake_exists(name):
        return name != "numpy"
    mocker.patch("amv_audio.dependencies._module_exists", side_effect=fake_exists)
    result = deps_mod.missing_feature_dependencies("clip_cpu")
    module_names = [m for m, _p in result]
    assert "numpy" in module_names


def test_missing_feature_dependencies_audio_includes_torch_check(mocker):
    """Audio feature must check torch readiness."""
    mocker.patch("amv_audio.dependencies._module_exists", return_value=True)
    mocker.patch("amv_audio.dependencies._audio_runtime_missing", return_value=False)
    mocker.patch("amv_audio.dependencies._runtime_ready", return_value=True)
    mocker.patch("amv_audio.dependencies._torch_ready", return_value=False)
    mocker.patch("amv_audio.dependencies._numeric_runtime_ready", return_value=True)
    result = deps_mod.missing_feature_dependencies("audio", gpu=False)
    module_names = [m for m, _p in result]
    assert "torch" in module_names


def test_missing_feature_dependencies_audio_empty_when_everything_ready(mocker):
    mocker.patch("amv_audio.dependencies._module_exists", return_value=True)
    mocker.patch("amv_audio.dependencies._audio_runtime_missing", return_value=False)
    mocker.patch("amv_audio.dependencies._runtime_ready", return_value=True)
    mocker.patch("amv_audio.dependencies._torch_ready", return_value=True)
    mocker.patch("amv_audio.dependencies._numeric_runtime_ready", return_value=True)
    result = deps_mod.missing_feature_dependencies("audio", gpu=False)
    assert result == []


def test_missing_feature_dependencies_clip_gpu_checks_torch_cuda(mocker):
    """clip_gpu must flag torch as missing when CUDA torch not ready."""
    mocker.patch("amv_audio.dependencies._module_exists", return_value=True)
    mocker.patch("amv_audio.dependencies._torch_ready", return_value=False)
    result = deps_mod.missing_feature_dependencies("clip_gpu")
    module_names = [m for m, _p in result]
    assert "torch" in module_names


# ---------------------------------------------------------------------------
# _install_torch — must use --force-reinstall when force=True
# ---------------------------------------------------------------------------


def test_install_torch_with_force_uses_force_reinstall(mocker):
    """When force=True, --force-reinstall must appear in the pip command."""
    mock_pip = mocker.patch("amv_audio.dependencies._run_pip_install")
    mocker.patch("amv_audio.dependencies._ensure_pip")  # prevent network calls

    deps_mod._install_torch(gpu=False, progress_callback=None, force=True)

    call_args = mock_pip.call_args[0][0]  # first positional arg = args list
    assert "--force-reinstall" in call_args
    assert "--upgrade" in call_args


def test_install_torch_without_force_omits_force_reinstall(mocker):
    mock_pip = mocker.patch("amv_audio.dependencies._run_pip_install")
    mocker.patch("amv_audio.dependencies._ensure_pip")

    deps_mod._install_torch(gpu=False, progress_callback=None, force=False)

    call_args = mock_pip.call_args[0][0]
    assert "--force-reinstall" not in call_args


def test_install_torch_gpu_uses_cuda_index_url(mocker):
    mock_pip = mocker.patch("amv_audio.dependencies._run_pip_install")
    mocker.patch("amv_audio.dependencies._ensure_pip")

    deps_mod._install_torch(gpu=True, progress_callback=None, force=False)

    call_args_str = " ".join(mock_pip.call_args[0][0])
    assert "cu128" in call_args_str


def test_install_torch_cpu_uses_cpu_index_url(mocker):
    mock_pip = mocker.patch("amv_audio.dependencies._run_pip_install")
    mocker.patch("amv_audio.dependencies._ensure_pip")

    deps_mod._install_torch(gpu=False, progress_callback=None, force=False)

    call_args_str = " ".join(mock_pip.call_args[0][0])
    assert "/cpu" in call_args_str


# ---------------------------------------------------------------------------
# repair_missing_module — gpu-aware package resolution
# ---------------------------------------------------------------------------


def test_repair_missing_module_rembg_gpu_installs_gpu_extras(mocker):
    """GPU repairs must install rembg[gpu], never plain rembg."""
    mock_pip = mocker.patch("amv_audio.dependencies._run_pip_install")
    mocker.patch("amv_audio.dependencies._module_exists", return_value=False)
    mocker.patch("amv_audio.dependencies.add_log")

    assert deps_mod.repair_missing_module("rembg", gpu=True) is True
    assert mock_pip.call_args[0][0] == ["rembg[gpu]>=2.0.50"]


def test_repair_missing_module_rembg_cpu_installs_plain_package(mocker):
    mock_pip = mocker.patch("amv_audio.dependencies._run_pip_install")
    mocker.patch("amv_audio.dependencies._module_exists", return_value=False)
    mocker.patch("amv_audio.dependencies.add_log")

    assert deps_mod.repair_missing_module("rembg", gpu=False) is True
    assert mock_pip.call_args[0][0] == ["rembg>=2.0.50"]


# ---------------------------------------------------------------------------
# _install_runtime — onnxruntime and onnxruntime-gpu may never coexist
# ---------------------------------------------------------------------------


def test_install_runtime_uninstalls_existing_dists_first(mocker):
    """Both runtime dists ship the same module path; installing one over the
    other corrupts pip's view of what is on disk. The repair must wipe both
    before installing the wanted variant."""
    mock_uninstall = mocker.patch("amv_audio.dependencies._run_pip_uninstall")
    mock_pip = mocker.patch("amv_audio.dependencies._run_pip_install")
    mocker.patch("amv_audio.dependencies._package_exists", return_value=True)

    deps_mod._install_runtime(gpu=True)

    assert mock_uninstall.call_args[0][0] == ["onnxruntime", "onnxruntime-gpu"]
    assert mock_pip.call_args[0][0] == ["onnxruntime-gpu"]


def test_install_runtime_skips_uninstall_when_nothing_installed(mocker):
    mock_uninstall = mocker.patch("amv_audio.dependencies._run_pip_uninstall")
    mock_pip = mocker.patch("amv_audio.dependencies._run_pip_install")
    mocker.patch("amv_audio.dependencies._package_exists", return_value=False)

    deps_mod._install_runtime(gpu=False)

    mock_uninstall.assert_not_called()
    assert mock_pip.call_args[0][0] == ["onnxruntime"]


# ---------------------------------------------------------------------------
# _runtime_ready(gpu=True) — must not trust stale dist metadata
# ---------------------------------------------------------------------------


def test_runtime_ready_gpu_false_when_gpu_package_missing(mocker):
    mocker.patch("amv_audio.dependencies._package_exists", return_value=False)
    assert deps_mod._runtime_ready(True) is False


def test_runtime_ready_gpu_false_when_both_dists_registered(mocker):
    """A CPU onnxruntime next to onnxruntime-gpu means one clobbered the
    other's files; readiness must report broken so the repair re-fires."""
    mocker.patch("amv_audio.dependencies._package_exists", return_value=True)
    probe = mocker.patch("amv_audio.dependencies._ort_cuda_probe")
    assert deps_mod._runtime_ready(True) is False
    probe.assert_not_called()


def test_runtime_ready_gpu_consults_cuda_probe_when_clean(mocker):
    def fake_package_exists(name):
        return name == "onnxruntime-gpu"
    mocker.patch("amv_audio.dependencies._package_exists", side_effect=fake_package_exists)
    mocker.patch("amv_audio.dependencies._ort_cuda_probe", return_value=False)
    assert deps_mod._runtime_ready(True) is False

    mocker.patch("amv_audio.dependencies._ort_cuda_probe", return_value=True)
    assert deps_mod._runtime_ready(True) is True


# ---------------------------------------------------------------------------
# KNOWN_MODULE_PACKAGES completeness spot-check
# ---------------------------------------------------------------------------


def test_known_module_packages_has_torch():
    assert "torch" in deps_mod.KNOWN_MODULE_PACKAGES


def test_known_module_packages_has_nelux():
    assert "nelux" in deps_mod.KNOWN_MODULE_PACKAGES
    assert deps_mod.KNOWN_MODULE_PACKAGES["nelux"] == "nelux==0.11.0"


def test_known_module_packages_has_numpy():
    assert "numpy" in deps_mod.KNOWN_MODULE_PACKAGES
    assert deps_mod.KNOWN_MODULE_PACKAGES["numpy"] == "numpy==2.4.4"


def test_known_module_packages_has_numba_pin():
    assert deps_mod.KNOWN_MODULE_PACKAGES["numba"] == "numba==0.65.1"


# ---------------------------------------------------------------------------
# NumPy/Numba compatibility — do not trust stale dist-info metadata
# ---------------------------------------------------------------------------


def test_numeric_runtime_probe_accepts_the_verified_pair(mocker):
    mocker.patch(
        "amv_audio.dependencies.subprocess.run",
        return_value=MagicMock(returncode=0, stdout="", stderr=""),
    )
    assert deps_mod._numeric_runtime_probe_error() is None


def test_numeric_runtime_probe_returns_the_loaded_version_failure(mocker):
    mocker.patch(
        "amv_audio.dependencies.subprocess.run",
        return_value=MagicMock(
            returncode=1,
            stdout="",
            stderr="ImportError: Numba needs NumPy 2.4 or less. Got NumPy 2.5.\n",
        ),
    )
    assert deps_mod._numeric_runtime_probe_error().endswith("Got NumPy 2.5.")


def test_audio_dependencies_flag_incompatible_numeric_runtime(mocker):
    mocker.patch("amv_audio.dependencies._module_exists", return_value=True)
    mocker.patch("amv_audio.dependencies._audio_runtime_missing", return_value=False)
    mocker.patch("amv_audio.dependencies._runtime_ready", return_value=True)
    mocker.patch("amv_audio.dependencies._torch_ready", return_value=True)
    mocker.patch("amv_audio.dependencies._numeric_runtime_ready", return_value=False)

    result = deps_mod.missing_feature_dependencies("audio", gpu=True)

    assert ("numeric_runtime", "numpy==2.4.4 + numba==0.65.1") in result


def test_numeric_runtime_repair_force_reinstalls_the_verified_pair(mocker):
    pip_install = mocker.patch("amv_audio.dependencies._run_pip_install")
    mocker.patch("amv_audio.dependencies._numeric_runtime_probe_error", return_value=None)
    mocker.patch("amv_audio.dependencies._prune_stale_numeric_metadata")

    deps_mod._repair_numeric_runtime()

    assert pip_install.call_args[0][0] == [
        "--upgrade",
        "--force-reinstall",
        "numpy==2.4.4",
        "numba==0.65.1",
    ]


def test_ensure_audio_dependencies_routes_collision_to_numeric_repair(mocker):
    missing = [("numeric_runtime", "numpy==2.4.4 + numba==0.65.1")]
    mocker.patch(
        "amv_audio.dependencies.missing_feature_dependencies",
        side_effect=[missing, []],
    )
    repair = mocker.patch("amv_audio.dependencies._repair_numeric_runtime")
    mocker.patch("amv_audio.dependencies._numeric_runtime_ready", return_value=False)
    normal_install = mocker.patch("amv_audio.dependencies._run_pip_install")
    mocker.patch("amv_audio.dependencies._prune_stale_numeric_metadata")
    mocker.patch("amv_audio.dependencies.add_log")

    assert deps_mod.ensure_feature_dependencies("audio", gpu=True) is True

    repair.assert_called_once_with(None)
    normal_install.assert_not_called()


def test_prune_stale_numeric_metadata_keeps_only_verified_records(mocker, tmp_path):
    site_packages = tmp_path / "Lib" / "site-packages"
    site_packages.mkdir(parents=True)
    for name in (
        "numpy-2.4.4.dist-info",
        "numpy-2.5.1.dist-info",
        "numpy-2.4.6.dist-info",
        "numba-0.65.1.dist-info",
        "numba-0.64.0.dist-info",
        "unrelated-1.0.dist-info",
    ):
        (site_packages / name).mkdir()
    mocker.patch("amv_audio.dependencies._numeric_runtime_ready", return_value=True)
    mocker.patch("amv_audio.dependencies._site_packages_dir", return_value=site_packages)
    mocker.patch("amv_audio.dependencies.add_log")

    removed = deps_mod._prune_stale_numeric_metadata()

    assert set(removed) == {
        "numpy-2.5.1.dist-info",
        "numpy-2.4.6.dist-info",
        "numba-0.64.0.dist-info",
    }
    assert (site_packages / "numpy-2.4.4.dist-info").is_dir()
    assert (site_packages / "numba-0.65.1.dist-info").is_dir()
    assert (site_packages / "unrelated-1.0.dist-info").is_dir()
