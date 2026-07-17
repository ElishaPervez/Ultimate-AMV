from pathlib import Path

from amv_audio.runtime_versions import (
    NUMBA_PACKAGE,
    NUMBA_VERSION,
    NUMPY_PACKAGE,
    NUMPY_VERSION,
)

_ROOT = Path(__file__).resolve().parents[2]


def test_verified_numeric_runtime_versions_are_exact():
    assert NUMPY_VERSION == "2.4.4"
    assert NUMPY_PACKAGE == "numpy==2.4.4"
    assert NUMBA_VERSION == "0.65.1"
    assert NUMBA_PACKAGE == "numba==0.65.1"


def test_bundle_and_dependency_files_share_the_numpy_pin():
    bundle_script = (_ROOT / "bundle-deps.ps1").read_text(encoding="utf-8")
    requirements = (_ROOT / "backend" / "requirements.txt").read_text(encoding="utf-8")
    release_workflow = (_ROOT / ".github" / "workflows" / "release.yml").read_text(encoding="utf-8")

    assert '"numpy==2.4.4"' in bundle_script
    assert "numpy==2.4.4" in requirements.splitlines()
    assert "numpy.__version__ == '2.4.4'" in release_workflow


def test_audio_dependency_list_shares_the_numba_pin():
    requirements = (_ROOT / "backend" / "requirements.txt").read_text(encoding="utf-8")
    assert "numba==0.65.1" in requirements.splitlines()
