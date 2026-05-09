MODEL_PRESETS = {
    "Kim_Vocal_2.onnx": {
        "name": "Kim Vocal 2 (ONNX)",
        "type": "onnx",
        "cpu": {"fp16": False, "batch_size": 1},
    },
    "model_bs_roformer_ep_317_sdr_12.9755.ckpt": {
        "name": "BS-Roformer (Best Quality)",
        "type": "pytorch",
        "cpu": {"fp16": False, "batch_size": 1},
        "gpu": {"fp16": True, "batch_size": 1},
    },
}

BS_ROFORMER = "model_bs_roformer_ep_317_sdr_12.9755.ckpt"
KIM_VOCAL_2 = "Kim_Vocal_2.onnx"


def get_active_model(hw_info):
    if hw_info.get("gpu_type") != "cpu" and hw_info.get("fp16_capable"):
        return BS_ROFORMER
    return KIM_VOCAL_2


def get_model_settings(model_filename, hw_info=None):
    preset = MODEL_PRESETS.get(model_filename)
    if preset is None:
        return {"fp16": False, "batch_size": 1}
    if hw_info and hw_info.get("gpu_type") != "cpu" and "gpu" in preset:
        return preset["gpu"].copy()
    return preset["cpu"].copy()


def get_model_display_name(model_filename):
    preset = MODEL_PRESETS.get(model_filename)
    return preset["name"] if preset else model_filename

