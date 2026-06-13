import unittest
from unittest.mock import patch, MagicMock
from pathlib import Path

# Inject backend path into sys.path
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bgremove_cli import status, process, preview

class TestBgRemoveCli(unittest.TestCase):
    @patch("bgremove_cli.emit")
    @patch("bgremove_cli.get_dependency_info")
    @patch("bgremove_cli.get_hw_info")
    def test_status(self, mock_hw, mock_deps, mock_emit):
        mock_hw.return_value = {"device": "cuda", "hasCuda": True}
        mock_deps.return_value = {"onnxruntime": True}
        
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
        mock_remove_bg.return_value = (100, 24.0, "C:\\cache\\showcase.webm", None)

        result = process(
            input_file="input.mp4",
            output_file="output.webm",
            model_key="anime",
            export_format="webm",
            force_cpu=False,
            showcase_dir="C:\\cache"
        )

        self.assertEqual(result, 0)
        mock_ensure_deps.assert_called_once()
        mock_remove_bg.assert_called_once()

        # Verify done payload was emitted
        done_calls = [call for call in mock_emit.call_args_list if call[0][0].get("type") == "done"]
        self.assertEqual(len(done_calls), 1)
        self.assertEqual(done_calls[0][0][0]["frames"], 100)
        self.assertEqual(done_calls[0][0][0]["fps"], 24.0)
        self.assertEqual(done_calls[0][0][0]["showcase"], "C:\\cache\\showcase.webm")
        self.assertEqual(done_calls[0][0][0]["cpuFallback"], False)

    @patch("bgremove_cli.emit")
    @patch("bgremove_cli.remove_background_video")
    @patch("bgremove_cli.ensure_feature_dependencies")
    def test_process_flags_silent_cpu_fallback(self, mock_ensure_deps, mock_remove_bg, mock_emit):
        mock_remove_bg.return_value = (100, 24.0, None, "GPU unavailable, ran on CPU")

        result = process(
            input_file="input.mp4",
            output_file="output.webm",
            model_key="anime",
            export_format="webm",
            force_cpu=False,
        )

        self.assertEqual(result, 0)
        done_calls = [call for call in mock_emit.call_args_list if call[0][0].get("type") == "done"]
        self.assertEqual(len(done_calls), 1)
        self.assertEqual(done_calls[0][0][0]["cpuFallback"], True)

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

    @patch("bgremove_cli.emit")
    @patch("bgremove_cli.remove_background_frame")
    @patch("bgremove_cli.extract_single_frame")
    @patch("bgremove_cli.ensure_feature_dependencies")
    def test_preview_success(self, mock_ensure_deps, mock_extract, mock_remove_bg_frame, mock_emit):
        mock_remove_bg_frame.return_value = None
        result = preview(
            input_file="input.mp4",
            output_dir="temp_dir",
            model_key="anime",
            frame_index=150,
            force_cpu=False
        )
        
        self.assertEqual(result, 0)
        mock_ensure_deps.assert_called_once()
        mock_extract.assert_called_once()
        mock_remove_bg_frame.assert_called_once()
        
        # Verify preview_done payload was emitted
        done_calls = [call for call in mock_emit.call_args_list if call[0][0].get("type") == "preview_done"]
        self.assertEqual(len(done_calls), 1)
        self.assertEqual(done_calls[0][0][0]["frame"], 150)
        self.assertIn("totalFrames", done_calls[0][0][0])

    @patch("bgremove_cli.emit")
    @patch("bgremove_cli.extract_single_frame")
    @patch("bgremove_cli.ensure_feature_dependencies")
    def test_preview_error(self, mock_ensure_deps, mock_extract, mock_emit):
        mock_extract.side_effect = RuntimeError("Frame extraction failed")
        
        result = preview(
            input_file="input.mp4",
            output_dir="temp_dir",
            model_key="anime",
            frame_index=150,
            force_cpu=False
        )
        
        err_calls = [call for call in mock_emit.call_args_list if call[0][0].get("type") == "error"]
        self.assertEqual(len(err_calls), 1)
        self.assertEqual(err_calls[0][0][0]["message"], "Frame extraction failed")

    @patch("bgremove_cli.emit")
    @patch("bgremove_cli.remove_background_frame")
    @patch("bgremove_cli.ensure_feature_dependencies")
    def test_process_image_success(self, mock_ensure_deps, mock_remove_bg_frame, mock_emit):
        mock_remove_bg_frame.return_value = None
        result = process(
            input_file="input.png",
            output_file="output.png",
            model_key="anime",
            export_format="webm",
            force_cpu=False
        )
        
        self.assertEqual(result, 0)
        mock_ensure_deps.assert_called_once()
        mock_remove_bg_frame.assert_called_once_with(
            input_image_path=str(Path("input.png").resolve()),
            output_image_path=str(Path("output.png").resolve()),
            model_key="anime",
            force_cpu=False
        )

    @patch("PIL.Image.open")
    @patch("bgremove_cli.emit")
    @patch("bgremove_cli.remove_background_frame")
    @patch("bgremove_cli.ensure_feature_dependencies")
    def test_preview_image_success(self, mock_ensure_deps, mock_remove_bg_frame, mock_emit, mock_image_open):
        mock_img = MagicMock()
        mock_image_open.return_value = mock_img
        mock_remove_bg_frame.return_value = None

        result = preview(
            input_file="input.png",
            output_dir="temp_dir",
            model_key="anime",
            frame_index=-1,
            force_cpu=False
        )
        
        self.assertEqual(result, 0)
        mock_ensure_deps.assert_called_once()
        mock_image_open.assert_called_once_with(str(Path("input.png").resolve()))
        mock_img.save.assert_called_once()
        mock_remove_bg_frame.assert_called_once()
