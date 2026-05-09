import unittest
import sys
import os

# Add the parent directory of 'backend' to sys.path so we can import 'backend' module
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))

from backend.amv_audio.models import (
    get_active_model,
    get_model_settings,
    get_model_display_name,
    BS_ROFORMER,
    KIM_VOCAL_2,
    MODEL_PRESETS
)

class TestModels(unittest.TestCase):

    def test_get_active_model_gpu_fp16(self):
        hw_info = {"gpu_type": "cuda", "fp16_capable": True}
        self.assertEqual(get_active_model(hw_info), BS_ROFORMER)

    def test_get_active_model_gpu_no_fp16(self):
        hw_info = {"gpu_type": "cuda", "fp16_capable": False}
        self.assertEqual(get_active_model(hw_info), KIM_VOCAL_2)

    def test_get_active_model_cpu_fp16(self):
        hw_info = {"gpu_type": "cpu", "fp16_capable": True}
        self.assertEqual(get_active_model(hw_info), KIM_VOCAL_2)

    def test_get_active_model_cpu_no_fp16(self):
        hw_info = {"gpu_type": "cpu", "fp16_capable": False}
        self.assertEqual(get_active_model(hw_info), KIM_VOCAL_2)

    def test_get_active_model_missing_gpu_type(self):
        hw_info = {"fp16_capable": True}
        # If "gpu_type" is missing, get("gpu_type") returns None, which != "cpu"
        # So if fp16_capable is True, it should return BS_ROFORMER
        self.assertEqual(get_active_model(hw_info), BS_ROFORMER)

    def test_get_active_model_empty_hw_info(self):
        hw_info = {}
        self.assertEqual(get_active_model(hw_info), KIM_VOCAL_2)

    def test_get_model_settings_unknown_model(self):
        self.assertEqual(get_model_settings("unknown_model.onnx"), {"fp16": False, "batch_size": 1})
        self.assertEqual(get_model_settings("unknown_model.onnx", {"gpu_type": "cuda"}), {"fp16": False, "batch_size": 1})

    def test_get_model_settings_kim_vocal(self):
        # KIM_VOCAL_2 only has "cpu" settings
        self.assertEqual(get_model_settings(KIM_VOCAL_2), MODEL_PRESETS[KIM_VOCAL_2]["cpu"])
        self.assertEqual(get_model_settings(KIM_VOCAL_2, {"gpu_type": "cuda"}), MODEL_PRESETS[KIM_VOCAL_2]["cpu"])

    def test_get_model_settings_bs_roformer(self):
        # BS_ROFORMER has both "cpu" and "gpu" settings
        self.assertEqual(get_model_settings(BS_ROFORMER), MODEL_PRESETS[BS_ROFORMER]["cpu"])
        self.assertEqual(get_model_settings(BS_ROFORMER, {"gpu_type": "cpu"}), MODEL_PRESETS[BS_ROFORMER]["cpu"])
        self.assertEqual(get_model_settings(BS_ROFORMER, {"gpu_type": "cuda"}), MODEL_PRESETS[BS_ROFORMER]["gpu"])

    def test_get_model_settings_independent_copy(self):
        # Check that it returns a copy
        settings = get_model_settings(BS_ROFORMER)
        settings["batch_size"] = 100
        self.assertEqual(MODEL_PRESETS[BS_ROFORMER]["cpu"]["batch_size"], 1)

    def test_get_model_display_name(self):
        self.assertEqual(get_model_display_name(KIM_VOCAL_2), MODEL_PRESETS[KIM_VOCAL_2]["name"])
        self.assertEqual(get_model_display_name(BS_ROFORMER), MODEL_PRESETS[BS_ROFORMER]["name"])
        self.assertEqual(get_model_display_name("unknown_model"), "unknown_model")

if __name__ == '__main__':
    unittest.main()
