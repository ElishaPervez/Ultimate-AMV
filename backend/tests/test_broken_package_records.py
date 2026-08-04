"""Regression tests for a package record that exists but says nothing.

An interrupted GPU/CPU switch left torch's record folder on disk with the file
describing it deleted. Python 3.13 answers "what version is torch?" with
nothing at all in that case rather than reporting torch as absent, and the two
places that searched that answer for text crashed. What the user saw: the app
came up on the first-run setup wizard even though setup had been finished long
ago, and pressing Install failed instantly with a raw error message printed
into the wizard.
"""

import sys
from pathlib import Path

import pytest

_BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

from amv_audio import dependencies as deps_mod
from amv_audio import installer as installer_mod


def _write_record(site_packages, name, metadata=None):
    """Create one package record folder, with or without a description file."""
    record = site_packages / f"{name}.dist-info"
    record.mkdir(parents=True)
    (record / "RECORD").write_text("", encoding="utf-8")
    if metadata is not None:
        (record / "METADATA").write_text(metadata, encoding="utf-8")
    return record


@pytest.fixture
def site_packages(mocker, tmp_path):
    """A throwaway stand-in for the bundled Python's package directory."""
    directory = tmp_path / "Lib" / "site-packages"
    directory.mkdir(parents=True)
    mocker.patch.object(deps_mod, "_site_packages_dir", return_value=directory)
    mocker.patch.object(deps_mod, "add_log")
    return directory


# ---------------------------------------------------------------------------
# The original crash: an unreadable version must never reach a text search
# ---------------------------------------------------------------------------


def test_unreadable_torch_version_is_classified_as_missing(mocker):
    """The exact shape of the reported crash: version() hands back nothing."""
    import amv_audio.setup as setup_mod

    mocker.patch("importlib.metadata.version", return_value=None)

    mode, reported, is_gpu = setup_mod._installed_torch_mode()

    assert mode == "missing"
    assert reported is None
    assert is_gpu is False


def test_unreadable_version_does_not_count_as_installed(mocker):
    mocker.patch("importlib.metadata.version", return_value=None)

    assert installer_mod.recorded_version("torch") is None
    assert installer_mod.is_installed("torch") is False


@pytest.mark.parametrize("answer", [None, "", "   ", 2.11])
def test_every_unusable_version_answer_reads_as_not_installed(mocker, answer):
    mocker.patch("importlib.metadata.version", return_value=answer)

    assert installer_mod.is_installed("torch") is False


def test_a_real_version_still_counts_as_installed(mocker):
    mocker.patch("importlib.metadata.version", return_value="2.11.0+cu128")

    assert installer_mod.recorded_version("torch") == "2.11.0+cu128"
    assert installer_mod.is_installed("torch") is True


def test_pinned_audio_packages_with_unreadable_versions_are_reinstalled(mocker):
    mocker.patch.object(deps_mod, "_module_exists", return_value=True)
    mocker.patch.object(deps_mod, "version", return_value=None)

    assert deps_mod._audio_runtime_missing("beartype", "beartype") is True
    assert deps_mod._audio_runtime_missing("samplerate", "samplerate==0.1.0") is True


# ---------------------------------------------------------------------------
# Cleaning the record so the next install can repair the package
# ---------------------------------------------------------------------------


def test_a_record_with_no_description_is_removed(site_packages):
    broken = _write_record(site_packages, "torch-2.11.0+cu128")

    removed = deps_mod._prune_unreadable_package_records()

    assert removed == ["torch-2.11.0+cu128.dist-info"]
    assert not broken.exists()


def test_a_healthy_record_is_left_alone(site_packages):
    healthy = _write_record(site_packages, "numpy-2.4.4", metadata="Name: numpy\n")

    removed = deps_mod._prune_unreadable_package_records()

    assert removed == []
    assert (healthy / "METADATA").is_file()


def test_only_the_broken_record_goes_and_the_installed_code_stays(site_packages):
    broken = _write_record(site_packages, "torch-2.11.0+cu128")
    healthy = _write_record(site_packages, "numpy-2.4.4", metadata="Name: numpy\n")
    module_dir = site_packages / "torch"
    module_dir.mkdir()
    (module_dir / "__init__.py").write_text("", encoding="utf-8")

    removed = deps_mod._prune_unreadable_package_records()

    assert removed == ["torch-2.11.0+cu128.dist-info"]
    assert not broken.exists()
    assert healthy.is_dir()
    assert (module_dir / "__init__.py").is_file()


def test_an_empty_description_file_counts_as_no_description(site_packages):
    broken = _write_record(site_packages, "torch-2.11.0+cu128", metadata="   \n")

    removed = deps_mod._prune_unreadable_package_records()

    assert removed == ["torch-2.11.0+cu128.dist-info"]
    assert not broken.exists()


def test_a_locked_record_warns_instead_of_failing(site_packages, mocker):
    _write_record(site_packages, "torch-2.11.0+cu128")
    mocker.patch.object(deps_mod.shutil, "rmtree", side_effect=OSError("in use"))

    assert deps_mod._prune_unreadable_package_records() == []


def test_setup_clears_broken_records_before_deciding_what_to_install(mocker):
    """Ordering matters: an unrepaired record makes the plan skip the package."""
    import amv_audio.setup as setup_mod

    order = []
    mocker.patch.object(setup_mod, "_fix_pth_file")
    mocker.patch.object(
        setup_mod,
        "_prune_unreadable_package_records",
        side_effect=lambda: order.append("cleanup") or [],
    )
    mocker.patch.object(
        setup_mod,
        "collect_setup_plan",
        side_effect=lambda _mode: order.append("plan")
        or {"mode": "cpu", "rows": [], "issues": [], "installs": [], "success_mode": "cpu", "gpu_name": None},
    )
    mocker.patch.object(setup_mod, "_prune_stale_numeric_metadata")
    mocker.patch.object(setup_mod, "_prune_unused_package_dirs")
    mocker.patch.object(setup_mod, "_finish_setup", return_value={"ok": True})

    setup_mod.install_setup("cpu", lambda *args: None)

    assert order == ["cleanup", "plan"]


def test_setup_survives_a_cleanup_that_blows_up(mocker):
    import amv_audio.setup as setup_mod

    mocker.patch.object(
        setup_mod,
        "_prune_unreadable_package_records",
        side_effect=RuntimeError("site-packages unreadable"),
    )
    mocker.patch.object(setup_mod, "add_log")

    assert setup_mod._clear_broken_package_records() == []


# ---------------------------------------------------------------------------
# The stored mode preferences must not be rewritten on a guess
# ---------------------------------------------------------------------------


def test_stored_mode_is_untouched_when_the_torch_version_cannot_be_read(mocker):
    import audio_cli

    mocker.patch.object(audio_cli, "recorded_version", return_value=None)
    stored = {"setup_type": "gpu", "force_cpu": False, "clip_extraction_mode": "gpu"}

    result, changed = audio_cli._auto_sync_install_mode(dict(stored))

    assert changed is False
    assert result == stored


def test_stored_mode_still_follows_a_readable_torch_version(mocker):
    import audio_cli

    mocker.patch.object(audio_cli, "recorded_version", return_value="2.11.0+cu128")
    stored = {"setup_type": "cpu", "force_cpu": True, "clip_extraction_mode": "cpu"}

    result, changed = audio_cli._auto_sync_install_mode(stored)

    assert changed is True
    assert result["setup_type"] == "gpu"
    assert result["force_cpu"] is False
    assert result["clip_extraction_mode"] == "gpu"
