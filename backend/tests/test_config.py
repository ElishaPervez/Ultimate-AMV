import unittest
from unittest.mock import patch
import json

from backend.amv_audio.config import load_config, _default_config

class TestConfig(unittest.TestCase):
    @patch('backend.amv_audio.config.ensure_dirs')
    @patch('pathlib.Path.exists', return_value=True)
    @patch('pathlib.Path.read_text')
    def test_load_config_valid_json(self, mock_read_text, mock_exists, mock_ensure_dirs):
        valid_json_data = json.dumps({"force_cpu": True, "download_path": "/test/path"})
        mock_read_text.return_value = valid_json_data

        config = load_config()

        self.assertEqual(config["force_cpu"], True)
        self.assertEqual(config["download_path"], "/test/path")
        self.assertEqual(config["setup_type"], "cpu")  # Ensure defaults are merged

    @patch('backend.amv_audio.config.ensure_dirs')
    @patch('pathlib.Path.exists', return_value=True)
    @patch('pathlib.Path.read_text')
    @patch('backend.amv_audio.config.logging.warning')
    def test_load_config_json_decode_error(self, mock_warning, mock_read_text, mock_exists, mock_ensure_dirs):
        malformed_json_data = "{ malformed: json"
        mock_read_text.return_value = malformed_json_data

        config = load_config()

        self.assertEqual(config, _default_config())
        mock_warning.assert_called_once()
        self.assertTrue("Could not load audio config" in mock_warning.call_args[0][0])

    @patch('backend.amv_audio.config.ensure_dirs')
    @patch('pathlib.Path.exists', return_value=True)
    @patch('pathlib.Path.read_text')
    @patch('backend.amv_audio.config.logging.warning')
    def test_load_config_os_error(self, mock_warning, mock_read_text, mock_exists, mock_ensure_dirs):
        mock_read_text.side_effect = OSError("Read failed")

        config = load_config()

        self.assertEqual(config, _default_config())
        mock_warning.assert_called_once()
        self.assertTrue("Could not load audio config" in mock_warning.call_args[0][0])
