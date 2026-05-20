"""
Shared pytest fixtures and path setup for backend tests.

sys.path setup
--------------
Two import styles coexist in this test suite:
  - ``from audio_cli import ...``          (test_audio_cli.py) → needs backend/ on path
  - ``from backend.amv_audio.config import ...`` (test_config.py) → needs repo root on path

Both are added here so pytest collects every test without per-file sys.path hacks.
"""
import sys
import os
from pathlib import Path

# Repo root  (backend/tests/ → backend/ → repo root)
_REPO_ROOT = Path(__file__).resolve().parents[2]
# backend/ directory (for bare ``import audio_cli`` / ``import clip_cli``)
_BACKEND_DIR = _REPO_ROOT / "backend"

for _p in [str(_REPO_ROOT), str(_BACKEND_DIR)]:
    if _p not in sys.path:
        sys.path.insert(0, _p)


import pytest


@pytest.fixture()
def fake_config_dir(tmp_path):
    """Return a temporary directory usable as the AMV state/config dir."""
    config_dir = tmp_path / "ultimateamv"
    config_dir.mkdir()
    return config_dir


@pytest.fixture()
def fake_config_env(fake_config_dir, monkeypatch):
    """
    Point ULTIMATE_AMV_STATE_DIR at a temp dir so config tests never
    touch the real ~/%APPDATA% location.
    """
    monkeypatch.setenv("ULTIMATE_AMV_STATE_DIR", str(fake_config_dir))
    return fake_config_dir
