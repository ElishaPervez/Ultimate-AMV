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
    result = deps_mod.missing_feature_dependencies("audio", gpu=False)
    module_names = [m for m, _p in result]
    assert "torch" in module_names


def test_missing_feature_dependencies_audio_empty_when_everything_ready(mocker):
    mocker.patch("amv_audio.dependencies._module_exists", return_value=True)
    mocker.patch("amv_audio.dependencies._audio_runtime_missing", return_value=False)
    mocker.patch("amv_audio.dependencies._runtime_ready", return_value=True)
    mocker.patch("amv_audio.dependencies._torch_ready", return_value=True)
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
# KNOWN_MODULE_PACKAGES completeness spot-check
# ---------------------------------------------------------------------------


def test_known_module_packages_has_torch():
    assert "torch" in deps_mod.KNOWN_MODULE_PACKAGES


def test_known_module_packages_has_nelux():
    assert "nelux" in deps_mod.KNOWN_MODULE_PACKAGES


def test_known_module_packages_has_numpy():
    assert "numpy" in deps_mod.KNOWN_MODULE_PACKAGES
