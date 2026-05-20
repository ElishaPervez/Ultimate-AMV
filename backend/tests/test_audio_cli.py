import unittest
from unittest.mock import patch

from audio_cli import set_config


class TestSetConfig(unittest.TestCase):
    def assert_config_emitted(self, mock_emit, **overrides):
        payload = {
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
        payload.update(overrides)
        mock_emit.assert_called_once_with(payload)

    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_force_cpu_true(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = {"force_cpu": False, "setup_type": "gpu"}

        result = set_config("force_cpu", "true")

        mock_save.assert_called_once_with({"force_cpu": True, "setup_type": "cpu"})
        self.assert_config_emitted(mock_emit, force_cpu=True, setup_type="cpu")
        self.assertIsNone(result)

    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_force_cpu_false(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = {"force_cpu": True, "setup_type": "cpu"}

        result = set_config("force_cpu", "false")

        mock_save.assert_called_once_with({"force_cpu": False, "setup_type": "cpu"})
        self.assert_config_emitted(mock_emit, setup_type="cpu")
        self.assertIsNone(result)

    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_setup_type_cpu(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = {"force_cpu": False, "setup_type": "gpu"}

        result = set_config("setup_type", "cpu")

        mock_save.assert_called_once_with({"force_cpu": True, "setup_type": "cpu"})
        self.assert_config_emitted(mock_emit, force_cpu=True, setup_type="cpu")
        self.assertIsNone(result)

    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_setup_type_gpu(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = {"force_cpu": True, "setup_type": "cpu"}

        result = set_config("setup_type", "gpu")

        mock_save.assert_called_once_with({"force_cpu": False, "setup_type": "gpu"})
        self.assert_config_emitted(mock_emit)
        self.assertIsNone(result)

    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_clip_extraction_mode_valid(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = {"force_cpu": False, "setup_type": "gpu"}

        result = set_config("clip_extraction_mode", "cpu")

        mock_save.assert_called_once_with({"force_cpu": False, "setup_type": "gpu", "clip_extraction_mode": "cpu"})
        self.assert_config_emitted(mock_emit, clip_extraction_mode="cpu")
        self.assertIsNone(result)

    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_clip_extraction_mode_invalid(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = {"force_cpu": False, "setup_type": "gpu"}

        result = set_config("clip_extraction_mode", "invalid")

        mock_save.assert_not_called()
        mock_emit.assert_called_once_with({"type": "error", "message": "clip_extraction_mode must be cpu or gpu"})
        self.assertEqual(result, 1)

    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_setup_complete(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = {"force_cpu": False, "setup_type": "gpu"}

        result = set_config("setup_complete", "true")

        mock_save.assert_called_once_with({"force_cpu": False, "setup_type": "gpu", "setup_complete": True})
        self.assert_config_emitted(mock_emit, setup_complete=True)
        self.assertIsNone(result)

    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_download_path(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = {"force_cpu": False, "setup_type": "gpu"}

        result = set_config("download_path", "/new/path")

        mock_save.assert_called_once_with({"force_cpu": False, "setup_type": "gpu", "download_path": "/new/path"})
        self.assert_config_emitted(mock_emit, download_path="/new/path")
        self.assertIsNone(result)

    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_theme_valid(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = {"force_cpu": False, "setup_type": "gpu"}

        result = set_config("theme", "violet")

        mock_save.assert_called_once_with({"force_cpu": False, "setup_type": "gpu", "theme": "violet"})
        self.assert_config_emitted(
            mock_emit,
            theme="violet",
            theme_color_a="#a98cff",
            theme_color_b="#48d7ff",
        )
        self.assertIsNone(result)

    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_theme_color_valid(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = {"force_cpu": False, "setup_type": "gpu"}

        result = set_config("theme_color_a", "#123abc")

        mock_save.assert_called_once_with(
            {"force_cpu": False, "setup_type": "gpu", "theme_color_a": "#123abc", "theme": "custom"}
        )
        self.assert_config_emitted(mock_emit, theme="custom", theme_color_a="#123abc")
        self.assertIsNone(result)

    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_theme_color_invalid(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = {"force_cpu": False, "setup_type": "gpu"}

        result = set_config("theme_color_a", "blue")

        mock_save.assert_not_called()
        mock_emit.assert_called_once_with({"type": "error", "message": "theme_color_a must be a hex color like #48d7ff"})
        self.assertEqual(result, 1)

    @patch("audio_cli.emit")
    @patch("audio_cli.save_config")
    @patch("audio_cli.load_config")
    def test_theme_invalid(self, mock_load, mock_save, mock_emit):
        mock_load.return_value = {"force_cpu": False, "setup_type": "gpu"}

        result = set_config("theme", "blue")

        mock_save.assert_not_called()
        mock_emit.assert_called_once_with({"type": "error", "message": "theme must be cyan, mint, violet, rose, amber, or custom"})
        self.assertEqual(result, 1)

if __name__ == "__main__":
    unittest.main()
