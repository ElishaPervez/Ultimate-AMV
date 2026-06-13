"""
Priority coverage for audio_cli.set_config:
  - Every accepted key: valid value + type coercion
  - Invalid values: correct error payload + exit code 1
  - Unknown key: matches actual silent-accept behavior (no error, saves unchanged key, emits config)
  - Range clamping for numeric keys
  - clip_hover_preview default is False (commit 97601c3 semantic)
  - audio_output_format default is "wav"
"""
import pytest
from unittest.mock import patch, call


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

BASE_CFG = {
    "force_cpu": False,
    "setup_type": "gpu",
    "clip_extraction_mode": "gpu",
    "setup_complete": False,
    "download_path": "",
    "provider_url": "https://anikai.to",
    "theme": "cyan",
    "theme_color_a": "#48d7ff",
    "theme_color_b": "#63e6a2",
    "background_image": "",
    "background_scale": 1.0,
    "background_offset_x": 50.0,
    "background_offset_y": 50.0,
    "background_dim": 55,
    "background_blur": 0,
    "audio_output_format": "wav",
    "clip_hover_preview": False,
}

EXPECTED_CONFIG_PAYLOAD = {
    "type": "config",
    "force_cpu": False,
    "setup_type": "gpu",
    "clip_extraction_mode": "gpu",
    "setup_complete": False,
    "download_path": "",
    "provider_url": "https://anikai.to",
    "theme": "cyan",
    "theme_color_a": "#48d7ff",
    "theme_color_b": "#63e6a2",
    "background_image": "",
    "background_scale": 1.0,
    "background_offset_x": 50.0,
    "background_offset_y": 50.0,
    "background_dim": 55,
    "background_blur": 0,
    "audio_output_format": "wav",
    "clip_hover_preview": False,
}


def base_cfg(**overrides):
    return {**BASE_CFG, **overrides}


def expected_payload(**overrides):
    return {**EXPECTED_CONFIG_PAYLOAD, **overrides}


# ---------------------------------------------------------------------------
# _config_payload default fallbacks
# ---------------------------------------------------------------------------

class TestConfigPayloadDefaults:
    """_config_payload must never raise KeyError on a stripped-down config."""

    def test_empty_config_no_key_error(self):
        from audio_cli import _config_payload
        payload = _config_payload({})
        assert payload["type"] == "config"

    def test_audio_output_format_default_is_wav(self):
        from audio_cli import _config_payload
        payload = _config_payload({})
        assert payload["audio_output_format"] == "wav"

    def test_clip_hover_preview_default_is_false(self):
        """Commit 97601c3 flipped the default from True to False. Must stay False."""
        from audio_cli import _config_payload
        payload = _config_payload({})
        assert payload["clip_hover_preview"] is False

    def test_force_cpu_default_false(self):
        from audio_cli import _config_payload
        assert _config_payload({})["force_cpu"] is False

    def test_setup_type_default_cpu(self):
        from audio_cli import _config_payload
        assert _config_payload({})["setup_type"] == "cpu"

    def test_background_scale_is_float(self):
        from audio_cli import _config_payload
        val = _config_payload({"background_scale": "2"})["background_scale"]
        assert isinstance(val, float)

    def test_background_dim_is_int(self):
        from audio_cli import _config_payload
        val = _config_payload({"background_dim": "30"})["background_dim"]
        assert isinstance(val, int)

    def test_clip_hover_preview_is_bool(self):
        from audio_cli import _config_payload
        val = _config_payload({"clip_hover_preview": 1})["clip_hover_preview"]
        assert isinstance(val, bool)

    def test_theme_defaults_to_cyan(self):
        from audio_cli import _config_payload
        assert _config_payload({})["theme"] == "cyan"

    def test_theme_colors_match_preset(self):
        from audio_cli import _config_payload, THEME_PRESETS
        payload = _config_payload({"theme": "violet"})
        assert payload["theme_color_a"] == THEME_PRESETS["violet"][0]
        assert payload["theme_color_b"] == THEME_PRESETS["violet"][1]


# ---------------------------------------------------------------------------
# set_config — force_cpu
# ---------------------------------------------------------------------------

class TestSetConfigForceCpu:
    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_force_cpu_true_sets_setup_type_cpu(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = base_cfg()
        from audio_cli import set_config
        result = set_config("force_cpu", "true")
        saved = mock_save.call_args[0][0]
        assert saved["force_cpu"] is True
        assert saved["setup_type"] == "cpu"
        assert result is None

    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_force_cpu_false_does_not_change_setup_type(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = base_cfg(force_cpu=True, setup_type="cpu")
        from audio_cli import set_config
        set_config("force_cpu", "false")
        saved = mock_save.call_args[0][0]
        assert saved["force_cpu"] is False
        # setup_type is NOT changed by force_cpu=false branch
        assert saved["setup_type"] == "cpu"

    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_force_cpu_emits_config_payload(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = base_cfg()
        from audio_cli import set_config
        set_config("force_cpu", "true")
        payload = mock_emit.call_args[0][0]
        assert payload["type"] == "config"
        assert payload["force_cpu"] is True


# ---------------------------------------------------------------------------
# set_config — setup_type
# ---------------------------------------------------------------------------

class TestSetConfigSetupType:
    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_setup_type_cpu_sets_force_cpu_true(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = base_cfg(setup_type="gpu", force_cpu=False)
        from audio_cli import set_config
        set_config("setup_type", "cpu")
        saved = mock_save.call_args[0][0]
        assert saved["setup_type"] == "cpu"
        assert saved["force_cpu"] is True

    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_setup_type_gpu_sets_force_cpu_false(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = base_cfg(setup_type="cpu", force_cpu=True)
        from audio_cli import set_config
        set_config("setup_type", "gpu")
        saved = mock_save.call_args[0][0]
        assert saved["setup_type"] == "gpu"
        assert saved["force_cpu"] is False


# ---------------------------------------------------------------------------
# set_config — clip_extraction_mode
# ---------------------------------------------------------------------------

class TestSetConfigClipExtractionMode:
    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_valid_cpu(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = base_cfg()
        from audio_cli import set_config
        result = set_config("clip_extraction_mode", "cpu")
        assert result is None
        saved = mock_save.call_args[0][0]
        assert saved["clip_extraction_mode"] == "cpu"

    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_valid_gpu(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = base_cfg(clip_extraction_mode="cpu")
        from audio_cli import set_config
        result = set_config("clip_extraction_mode", "gpu")
        assert result is None
        saved = mock_save.call_args[0][0]
        assert saved["clip_extraction_mode"] == "gpu"

    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_invalid_value_returns_1(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = base_cfg()
        from audio_cli import set_config
        result = set_config("clip_extraction_mode", "nvenc")
        assert result == 1
        mock_save.assert_not_called()
        payload = mock_emit.call_args[0][0]
        assert payload["type"] == "error"
        assert "cpu or gpu" in payload["message"]

    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_empty_string_invalid(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = base_cfg()
        from audio_cli import set_config
        result = set_config("clip_extraction_mode", "")
        assert result == 1
        mock_save.assert_not_called()


# ---------------------------------------------------------------------------
# set_config — setup_complete
# ---------------------------------------------------------------------------

class TestSetConfigSetupComplete:
    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_setup_complete_true(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = base_cfg()
        from audio_cli import set_config
        set_config("setup_complete", "true")
        saved = mock_save.call_args[0][0]
        assert saved["setup_complete"] is True

    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_setup_complete_false(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = base_cfg(setup_complete=True)
        from audio_cli import set_config
        set_config("setup_complete", "false")
        saved = mock_save.call_args[0][0]
        assert saved["setup_complete"] is False


# ---------------------------------------------------------------------------
# set_config — download_path
# ---------------------------------------------------------------------------

class TestSetConfigDownloadPath:
    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_sets_string_path(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = base_cfg()
        from audio_cli import set_config
        result = set_config("download_path", "C:/Users/test/Downloads")
        assert result is None
        saved = mock_save.call_args[0][0]
        assert saved["download_path"] == "C:/Users/test/Downloads"

    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_sets_empty_string(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = base_cfg(download_path="/old/path")
        from audio_cli import set_config
        set_config("download_path", "")
        saved = mock_save.call_args[0][0]
        assert saved["download_path"] == ""


# ---------------------------------------------------------------------------
# set_config — provider_url
# ---------------------------------------------------------------------------

class TestSetConfigProviderUrl:
    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_sets_provider_url(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = base_cfg()
        from audio_cli import set_config
        result = set_config("provider_url", "https://example.com")
        assert result is None
        saved = mock_save.call_args[0][0]
        assert saved["provider_url"] == "https://example.com"


# ---------------------------------------------------------------------------
# set_config — theme
# ---------------------------------------------------------------------------

class TestSetConfigTheme:
    @pytest.mark.parametrize("theme", ["cyan", "mint", "violet", "rose", "amber", "custom"])
    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_valid_theme_values(self, mock_load, mock_save, mock_emit, theme):
        mock_load.return_value = base_cfg()
        from audio_cli import set_config
        result = set_config("theme", theme)
        assert result is None
        saved = mock_save.call_args[0][0]
        assert saved["theme"] == theme

    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_invalid_theme_returns_1(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = base_cfg()
        from audio_cli import set_config
        result = set_config("theme", "blue")
        assert result == 1
        mock_save.assert_not_called()
        payload = mock_emit.call_args[0][0]
        assert payload["type"] == "error"

    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_invalid_theme_empty_string_returns_1(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = base_cfg()
        from audio_cli import set_config
        result = set_config("theme", "")
        assert result == 1
        mock_save.assert_not_called()


# ---------------------------------------------------------------------------
# set_config — theme_color_a / theme_color_b
# ---------------------------------------------------------------------------

class TestSetConfigThemeColors:
    @pytest.mark.parametrize("key", ["theme_color_a", "theme_color_b"])
    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_valid_hex_color(self, mock_load, mock_save, mock_emit, key):
        mock_load.return_value = base_cfg()
        from audio_cli import set_config
        result = set_config(key, "#aabbcc")
        assert result is None
        saved = mock_save.call_args[0][0]
        assert saved[key] == "#aabbcc"
        assert saved["theme"] == "custom"

    @pytest.mark.parametrize("key", ["theme_color_a", "theme_color_b"])
    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_uppercase_hex_lowercased(self, mock_load, mock_save, mock_emit, key):
        mock_load.return_value = base_cfg()
        from audio_cli import set_config
        set_config(key, "#AABBCC")
        saved = mock_save.call_args[0][0]
        assert saved[key] == "#aabbcc"

    @pytest.mark.parametrize("bad_value", ["blue", "123abc", "#gggggg", "#12345", ""])
    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_invalid_color_returns_1(self, mock_load, mock_save, mock_emit, bad_value):
        mock_load.return_value = base_cfg()
        from audio_cli import set_config
        result = set_config("theme_color_a", bad_value)
        assert result == 1
        mock_save.assert_not_called()
        payload = mock_emit.call_args[0][0]
        assert payload["type"] == "error"


# ---------------------------------------------------------------------------
# set_config — background_image
# ---------------------------------------------------------------------------

class TestSetConfigBackgroundImage:
    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_sets_background_image(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = base_cfg()
        from audio_cli import set_config
        result = set_config("background_image", "C:/bg.jpg")
        assert result is None
        saved = mock_save.call_args[0][0]
        assert saved["background_image"] == "C:/bg.jpg"


# ---------------------------------------------------------------------------
# set_config — background_scale / background_offset_x / background_offset_y
# ---------------------------------------------------------------------------

class TestSetConfigBackgroundFloats:
    @pytest.mark.parametrize("key,value,expected", [
        ("background_scale", "2.5", 2.5),
        ("background_offset_x", "75.0", 75.0),
        ("background_offset_y", "10", 10.0),
    ])
    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_valid_float_values(self, mock_load, mock_save, mock_emit, key, value, expected):
        mock_load.return_value = base_cfg()
        from audio_cli import set_config
        result = set_config(key, value)
        assert result is None
        saved = mock_save.call_args[0][0]
        assert saved[key] == pytest.approx(expected)

    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_background_scale_clamped_to_min_1(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = base_cfg()
        from audio_cli import set_config
        set_config("background_scale", "0.1")
        saved = mock_save.call_args[0][0]
        assert saved["background_scale"] == pytest.approx(1.0)

    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_background_scale_clamped_to_max_5(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = base_cfg()
        from audio_cli import set_config
        set_config("background_scale", "99.9")
        saved = mock_save.call_args[0][0]
        assert saved["background_scale"] == pytest.approx(5.0)

    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_background_offset_x_clamped_to_0_100(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = base_cfg()
        from audio_cli import set_config
        set_config("background_offset_x", "-5")
        saved = mock_save.call_args[0][0]
        assert saved["background_offset_x"] == pytest.approx(0.0)
        set_config("background_offset_x", "200")
        saved = mock_save.call_args[0][0]
        assert saved["background_offset_x"] == pytest.approx(100.0)

    @pytest.mark.parametrize("key", ["background_scale", "background_offset_x", "background_offset_y"])
    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_non_numeric_returns_1(self, mock_load, mock_save, mock_emit, key):
        mock_load.return_value = base_cfg()
        from audio_cli import set_config
        result = set_config(key, "not-a-number")
        assert result == 1
        mock_save.assert_not_called()
        payload = mock_emit.call_args[0][0]
        assert payload["type"] == "error"
        assert "must be a number" in payload["message"]


# ---------------------------------------------------------------------------
# set_config — background_dim / background_blur
# ---------------------------------------------------------------------------

class TestSetConfigBackgroundInts:
    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_background_dim_valid(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = base_cfg()
        from audio_cli import set_config
        result = set_config("background_dim", "40")
        assert result is None
        saved = mock_save.call_args[0][0]
        assert saved["background_dim"] == 40

    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_background_dim_clamped_0_100(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = base_cfg()
        from audio_cli import set_config
        set_config("background_dim", "999")
        saved = mock_save.call_args[0][0]
        assert saved["background_dim"] == 100
        set_config("background_dim", "-10")
        saved = mock_save.call_args[0][0]
        assert saved["background_dim"] == 0

    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_background_blur_clamped_0_40(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = base_cfg()
        from audio_cli import set_config
        set_config("background_blur", "100")
        saved = mock_save.call_args[0][0]
        assert saved["background_blur"] == 40
        set_config("background_blur", "-5")
        saved = mock_save.call_args[0][0]
        assert saved["background_blur"] == 0

    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_background_dim_float_string_truncated(self, mock_load, mock_save, mock_emit):
        """float string like "30.7" is accepted and truncated to int."""
        mock_load.return_value = base_cfg()
        from audio_cli import set_config
        result = set_config("background_dim", "30.7")
        assert result is None
        saved = mock_save.call_args[0][0]
        assert saved["background_dim"] == 30

    @pytest.mark.parametrize("key", ["background_dim", "background_blur"])
    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_non_numeric_returns_1(self, mock_load, mock_save, mock_emit, key):
        mock_load.return_value = base_cfg()
        from audio_cli import set_config
        result = set_config(key, "lots")
        assert result == 1
        mock_save.assert_not_called()
        payload = mock_emit.call_args[0][0]
        assert payload["type"] == "error"
        assert "must be an integer" in payload["message"]


# ---------------------------------------------------------------------------
# set_config — background_bright_text
# ---------------------------------------------------------------------------

class TestSetConfigBackgroundBrightText:
    @pytest.mark.parametrize("value", ["1", "true", "TRUE", " true "])
    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_truthy_values_store_true(self, mock_load, mock_save, mock_emit, value):
        mock_load.return_value = base_cfg()
        from audio_cli import set_config
        result = set_config("background_bright_text", value)
        assert result is None
        saved = mock_save.call_args[0][0]
        assert saved["background_bright_text"] is True

    @pytest.mark.parametrize("value", ["0", "false", "", "yes", "garbage"])
    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_everything_else_stores_false(self, mock_load, mock_save, mock_emit, value):
        mock_load.return_value = base_cfg(background_bright_text=True)
        from audio_cli import set_config
        result = set_config("background_bright_text", value)
        assert result is None
        saved = mock_save.call_args[0][0]
        assert saved["background_bright_text"] is False

    def test_payload_default_is_false(self):
        from audio_cli import _config_payload
        assert _config_payload({})["background_bright_text"] is False

    def test_payload_coerces_to_bool(self):
        from audio_cli import _config_payload
        assert _config_payload({"background_bright_text": 1})["background_bright_text"] is True


# ---------------------------------------------------------------------------
# set_config — audio_output_format
# ---------------------------------------------------------------------------

class TestSetConfigAudioOutputFormat:
    @pytest.mark.parametrize("value,expected", [("wav", "wav"), ("mp3", "mp3"),
                                                 ("WAV", "wav"), ("MP3", "mp3"),
                                                 ("  wav  ", "wav")])
    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_valid_formats_normalized(self, mock_load, mock_save, mock_emit, value, expected):
        mock_load.return_value = base_cfg()
        from audio_cli import set_config
        result = set_config("audio_output_format", value)
        assert result is None
        saved = mock_save.call_args[0][0]
        assert saved["audio_output_format"] == expected

    @pytest.mark.parametrize("bad", ["flac", "ogg", "", "mp4", "aac"])
    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_invalid_format_returns_1(self, mock_load, mock_save, mock_emit, bad):
        mock_load.return_value = base_cfg()
        from audio_cli import set_config
        result = set_config("audio_output_format", bad)
        assert result == 1
        mock_save.assert_not_called()
        payload = mock_emit.call_args[0][0]
        assert payload["type"] == "error"
        assert "wav or mp3" in payload["message"]


# ---------------------------------------------------------------------------
# set_config — clip_hover_preview
# ---------------------------------------------------------------------------

class TestSetConfigClipHoverPreview:
    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_true_string_sets_true(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = base_cfg(clip_hover_preview=False)
        from audio_cli import set_config
        result = set_config("clip_hover_preview", "true")
        assert result is None
        saved = mock_save.call_args[0][0]
        assert saved["clip_hover_preview"] is True

    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_false_string_sets_false(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = base_cfg(clip_hover_preview=True)
        from audio_cli import set_config
        result = set_config("clip_hover_preview", "false")
        assert result is None
        saved = mock_save.call_args[0][0]
        assert saved["clip_hover_preview"] is False

    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_emits_config_with_updated_value(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = base_cfg()
        from audio_cli import set_config
        set_config("clip_hover_preview", "true")
        payload = mock_emit.call_args[0][0]
        assert payload["clip_hover_preview"] is True


# ---------------------------------------------------------------------------
# set_config — unknown key (actual behavior: silent accept, saves, emits config)
# ---------------------------------------------------------------------------

class TestSetConfigUnknownKey:
    """
    set_config has no else/catch-all for unknown keys.
    The function falls through all elif branches, calls save_config with the
    unchanged dict (the unknown key is NOT added), then emits _config_payload.
    Return value is None (not 1). This is the actual behavior — test encodes it.
    """

    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_unknown_key_returns_none(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = base_cfg()
        from audio_cli import set_config
        result = set_config("nonexistent_key", "anything")
        # No error branch — falls through all elif, returns None
        assert result is None

    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_unknown_key_still_saves_and_emits(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = base_cfg()
        from audio_cli import set_config
        set_config("nonexistent_key", "anything")
        # save_config IS called (no early return on unknown key)
        mock_save.assert_called_once()
        # emit IS called with a config payload (not an error)
        payload = mock_emit.call_args[0][0]
        assert payload["type"] == "config"

    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_unknown_key_does_not_add_to_config(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = base_cfg()
        from audio_cli import set_config
        set_config("nonexistent_key", "anything")
        saved = mock_save.call_args[0][0]
        assert "nonexistent_key" not in saved


