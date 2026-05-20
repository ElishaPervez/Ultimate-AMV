"""
Infrastructure smoke tests — verify the test environment itself is wired correctly.
These tests must pass on a clean checkout with only:
  pip install -r backend/requirements-dev.txt
No GPU, no Tauri runtime, no real filesystem writes.
"""


def test_import_amv_audio_config():
    """amv_audio.config must be importable without side-effects."""
    from amv_audio import config as cfg  # noqa: F401
    assert hasattr(cfg, "load_config"), "load_config must be exported"
    assert hasattr(cfg, "save_config"), "save_config must be exported"
    assert hasattr(cfg, "DEFAULT_CONFIG"), "DEFAULT_CONFIG must be exported"


def test_default_config_shape():
    """_default_config() must return a dict with the expected keys."""
    from amv_audio.config import _default_config
    defaults = _default_config()
    assert isinstance(defaults, dict)
    required_keys = {
        "force_cpu", "setup_type", "clip_extraction_mode",
        "setup_complete", "download_path", "theme",
    }
    missing = required_keys - defaults.keys()
    assert not missing, f"DEFAULT_CONFIG is missing keys: {missing}"


def test_default_config_returns_independent_copy():
    """Each call to _default_config must return a fresh copy (mutation safety)."""
    from amv_audio.config import _default_config
    a = _default_config()
    b = _default_config()
    a["theme"] = "__mutated__"
    assert b["theme"] != "__mutated__", "_default_config should return a deep copy"


def test_import_amv_audio_models():
    """amv_audio.models must be importable and expose the expected symbols."""
    from amv_audio import models as m  # noqa: F401
    assert hasattr(m, "get_active_model")
    assert hasattr(m, "MODEL_PRESETS")


def test_pytest_mock_available(mocker):
    """pytest-mock fixture must be injected (proves dev-dep is installed)."""
    mock_fn = mocker.MagicMock(return_value=42)
    assert mock_fn() == 42
    mock_fn.assert_called_once()
