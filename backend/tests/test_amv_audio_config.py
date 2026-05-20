"""
Tests for backend/amv_audio/config.py

Covers:
- DEFAULT_CONFIG values (clip_hover_preview=False, audio_output_format="wav")
- load_config: missing file, partial file, invalid JSON, round-trip
- save_config: writes valid JSON
- add_recent_file: dedup, ordering, max_recent cap
"""
import json
import sys
import os
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

# Ensure backend/ is on sys.path (conftest.py already does this,
# but be explicit for standalone runs)
_BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

# We import the module under test WITHOUT touching the real filesystem.
# All disk interaction is redirected via ULTIMATE_AMV_STATE_DIR env var.
from amv_audio.config import (
    DEFAULT_CONFIG,
    _default_config,
    load_config,
    save_config,
    add_recent_file,
)


# ---------------------------------------------------------------------------
# DEFAULT_CONFIG shape / values
# ---------------------------------------------------------------------------


def test_clip_hover_preview_default_is_false():
    """clip_hover_preview must default to False (was True before commit 97601c3)."""
    assert DEFAULT_CONFIG["clip_hover_preview"] is False


def test_audio_output_format_default_is_wav():
    """audio_output_format must default to 'wav'."""
    assert DEFAULT_CONFIG["audio_output_format"] == "wav"


def test_default_config_has_required_keys():
    """DEFAULT_CONFIG must contain all expected keys."""
    required = {
        "recent_files",
        "max_recent",
        "force_cpu",
        "setup_type",
        "clip_extraction_mode",
        "setup_complete",
        "download_path",
        "provider_url",
        "theme",
        "theme_color_a",
        "theme_color_b",
        "audio_output_format",
        "clip_hover_preview",
    }
    missing = required - DEFAULT_CONFIG.keys()
    assert not missing, f"DEFAULT_CONFIG missing keys: {missing}"


def test_default_config_returns_independent_copies():
    """_default_config() must return a new deep copy each time."""
    a = _default_config()
    b = _default_config()
    a["theme"] = "__mutated__"
    assert b["theme"] != "__mutated__"


def test_default_recent_files_is_empty_list():
    assert DEFAULT_CONFIG["recent_files"] == []


def test_default_max_recent_is_twenty():
    assert DEFAULT_CONFIG["max_recent"] == 20


def test_default_force_cpu_is_false():
    assert DEFAULT_CONFIG["force_cpu"] is False


# ---------------------------------------------------------------------------
# load_config — missing file → writes and returns defaults
# ---------------------------------------------------------------------------


def test_load_config_missing_file_returns_defaults(fake_config_env):
    """When no config file exists load_config creates one and returns defaults."""
    from amv_audio import config as cfg_module

    # Reload relevant module-level paths so they respect the tmp env var
    config_file = Path(fake_config_env) / "config.json"
    with patch.object(cfg_module, "CONFIG_FILE", config_file), \
         patch.object(cfg_module, "STATE_DIR", fake_config_env), \
         patch.object(cfg_module, "MODELS_DIR", fake_config_env / "models"):
        # File must not exist yet
        config_file.unlink(missing_ok=True)
        result = cfg_module.load_config()

    expected = _default_config()
    for key, value in expected.items():
        assert result[key] == value, f"Key {key!r} mismatch: {result[key]!r} != {value!r}"


def test_load_config_missing_file_creates_config_file(fake_config_env):
    """load_config creates the config.json file when it is absent."""
    from amv_audio import config as cfg_module

    config_file = Path(fake_config_env) / "config.json"
    with patch.object(cfg_module, "CONFIG_FILE", config_file), \
         patch.object(cfg_module, "STATE_DIR", fake_config_env), \
         patch.object(cfg_module, "MODELS_DIR", fake_config_env / "models"):
        config_file.unlink(missing_ok=True)
        cfg_module.load_config()
        assert config_file.exists()


# ---------------------------------------------------------------------------
# load_config — partial config merges with defaults
# ---------------------------------------------------------------------------


def test_load_config_partial_file_fills_defaults(fake_config_env):
    """A config file missing some keys should be completed with defaults."""
    from amv_audio import config as cfg_module

    config_file = Path(fake_config_env) / "config.json"
    config_file.write_text(json.dumps({"force_cpu": True}), encoding="utf-8")

    with patch.object(cfg_module, "CONFIG_FILE", config_file), \
         patch.object(cfg_module, "STATE_DIR", fake_config_env), \
         patch.object(cfg_module, "MODELS_DIR", fake_config_env / "models"):
        result = cfg_module.load_config()

    # Explicit value preserved
    assert result["force_cpu"] is True
    # Default-filled values present
    assert result["audio_output_format"] == "wav"
    assert result["clip_hover_preview"] is False
    assert result["max_recent"] == 20


def test_load_config_full_round_trip_preserves_values(fake_config_env):
    """save_config followed by load_config must return the same values."""
    from amv_audio import config as cfg_module

    config_file = Path(fake_config_env) / "config.json"

    custom = _default_config()
    custom["force_cpu"] = True
    custom["theme"] = "pink"
    custom["audio_output_format"] = "mp3"
    custom["clip_hover_preview"] = True
    custom["recent_files"] = ["/some/file.mp3"]

    with patch.object(cfg_module, "CONFIG_FILE", config_file), \
         patch.object(cfg_module, "STATE_DIR", fake_config_env), \
         patch.object(cfg_module, "MODELS_DIR", fake_config_env / "models"):
        cfg_module.save_config(custom)
        loaded = cfg_module.load_config()

    for key, value in custom.items():
        assert loaded[key] == value, f"Round-trip mismatch for {key!r}"


# ---------------------------------------------------------------------------
# load_config — corrupt / invalid JSON
# ---------------------------------------------------------------------------


def test_load_config_invalid_json_returns_defaults(fake_config_env):
    """Corrupt JSON should fall back to defaults and log a warning."""
    from amv_audio import config as cfg_module
    import logging

    config_file = Path(fake_config_env) / "config.json"
    config_file.write_text("{ not valid json !!!", encoding="utf-8")

    with patch.object(cfg_module, "CONFIG_FILE", config_file), \
         patch.object(cfg_module, "STATE_DIR", fake_config_env), \
         patch.object(cfg_module, "MODELS_DIR", fake_config_env / "models"), \
         patch.object(cfg_module.logging, "warning") as mock_warn:
        result = cfg_module.load_config()
        mock_warn.assert_called_once()

    assert result == _default_config()


# ---------------------------------------------------------------------------
# save_config — writes valid JSON
# ---------------------------------------------------------------------------


def test_save_config_writes_valid_json(fake_config_env):
    """save_config must write readable JSON."""
    from amv_audio import config as cfg_module

    config_file = Path(fake_config_env) / "config.json"
    cfg = _default_config()
    cfg["theme"] = "purple"

    with patch.object(cfg_module, "CONFIG_FILE", config_file), \
         patch.object(cfg_module, "STATE_DIR", fake_config_env), \
         patch.object(cfg_module, "MODELS_DIR", fake_config_env / "models"):
        cfg_module.save_config(cfg)

    on_disk = json.loads(config_file.read_text(encoding="utf-8"))
    assert on_disk["theme"] == "purple"


# ---------------------------------------------------------------------------
# add_recent_file — dedup, order, cap
# ---------------------------------------------------------------------------


def test_add_recent_file_prepends_new_path(fake_config_env):
    """add_recent_file puts the new path at the front of the list."""
    from amv_audio import config as cfg_module

    config_file = Path(fake_config_env) / "config.json"
    initial = _default_config()
    initial["recent_files"] = ["/older/file.mp3"]
    config_file.write_text(json.dumps(initial), encoding="utf-8")

    with patch.object(cfg_module, "CONFIG_FILE", config_file), \
         patch.object(cfg_module, "STATE_DIR", fake_config_env), \
         patch.object(cfg_module, "MODELS_DIR", fake_config_env / "models"):
        cfg_module.add_recent_file("/new/file.mp3")
        result = cfg_module.load_config()

    assert result["recent_files"][0] == "/new/file.mp3"
    assert "/older/file.mp3" in result["recent_files"]


def test_add_recent_file_deduplicates(fake_config_env):
    """Adding a path already in the list should move it to front, not duplicate."""
    from amv_audio import config as cfg_module

    config_file = Path(fake_config_env) / "config.json"
    initial = _default_config()
    initial["recent_files"] = ["/a.mp3", "/b.mp3", "/c.mp3"]
    config_file.write_text(json.dumps(initial), encoding="utf-8")

    with patch.object(cfg_module, "CONFIG_FILE", config_file), \
         patch.object(cfg_module, "STATE_DIR", fake_config_env), \
         patch.object(cfg_module, "MODELS_DIR", fake_config_env / "models"):
        cfg_module.add_recent_file("/b.mp3")
        result = cfg_module.load_config()

    assert result["recent_files"].count("/b.mp3") == 1
    assert result["recent_files"][0] == "/b.mp3"


def test_add_recent_file_caps_at_max_recent(fake_config_env):
    """recent_files must never exceed max_recent entries."""
    from amv_audio import config as cfg_module

    config_file = Path(fake_config_env) / "config.json"
    initial = _default_config()
    initial["max_recent"] = 5
    initial["recent_files"] = [f"/file{i}.mp3" for i in range(5)]
    config_file.write_text(json.dumps(initial), encoding="utf-8")

    with patch.object(cfg_module, "CONFIG_FILE", config_file), \
         patch.object(cfg_module, "STATE_DIR", fake_config_env), \
         patch.object(cfg_module, "MODELS_DIR", fake_config_env / "models"):
        cfg_module.add_recent_file("/new.mp3")
        result = cfg_module.load_config()

    assert len(result["recent_files"]) <= 5
    assert result["recent_files"][0] == "/new.mp3"
