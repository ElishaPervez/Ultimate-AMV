import unittest
from unittest.mock import patch, MagicMock

# Inject backend path into sys.path
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bgremove_cli import status, process

class TestBgRemoveCli(unittest.TestCase):
    @patch("bgremove_cli.emit")
    @patch("bgremove_cli.get_dependency_info")
    @patch("bgremove_cli.get_hw_info")
    def test_status(self, mock_hw, mock_deps, mock_emit):
        mock_hw.return_value = {"device": "cuda", "hasCuda": True}
        mock_deps.return_value = {"has_onnxruntime": True}
        
        status()
        
        mock_emit.assert_called_once()
        args = mock_emit.call_args[0][0]
        self.assertEqual(args["type"], "status")
        self.assertEqual(args["hardware"]["device"], "cuda")
        self.assertEqual(args["dependencies"]["has_onnxruntime"], True)
        self.assertIn("anime", args["models"])

    @patch("bgremove_cli.emit")
    @patch("bgremove_cli.remove_background_video")
    @patch("bgremove_cli.ensure_feature_dependencies")
    def test_process_success(self, mock_ensure_deps, mock_remove_bg, mock_emit):
        mock_remove_bg.return_value = 100
        
        result = process(
            input_file="input.mp4",
            output_file="output.webm",
            model_key="anime",
            export_format="webm",
            force_cpu=False
        )
        
        self.assertEqual(result, 0)
        mock_ensure_deps.assert_called_once()
        mock_remove_bg.assert_called_once()
        
        # Verify done payload was emitted
        done_calls = [call for call in mock_emit.call_args_list if call[0][0].get("type") == "done"]
        self.assertEqual(len(done_calls), 1)
        self.assertEqual(done_calls[0][0][0]["frames"], 100)

    @patch("bgremove_cli.emit")
    @patch("bgremove_cli.remove_background_video")
    @patch("bgremove_cli.ensure_feature_dependencies")
    def test_process_error(self, mock_ensure_deps, mock_remove_bg, mock_emit):
        mock_remove_bg.side_effect = RuntimeError("Encoding failed")
        
        result = process(
            input_file="input.mp4",
            output_file="output.webm",
            model_key="anime",
            export_format="webm",
            force_cpu=False
        )
        
        self.assertEqual(result, 1)
        
        # Verify error payload was emitted
        err_calls = [call for call in mock_emit.call_args_list if call[0][0].get("type") == "error"]
        self.assertEqual(len(err_calls), 1)
        self.assertEqual(err_calls[0][0][0]["message"], "Encoding failed")
