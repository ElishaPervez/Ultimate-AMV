import os
from rembg import new_session

# Map human-readable model keys to rembg model names
MODELS = {
    "anime": {
        "name": "isnet-anime",
        "label": "Anime Character (isnet-anime)",
        "description": "Best for anime characters. Specially trained on illustrations.",
        "size_mb": 174,
    },
    "general": {
        "name": "isnet-general-use",
        "label": "General Use (isnet-general-use)",
        "description": "Great for mixed content and general subject isolation.",
        "size_mb": 174,
    },
    "birefnet": {
        "name": "birefnet-general",
        "label": "High Quality (birefnet-general)",
        "description": "Ultra high-quality edges, but slower and larger download.",
        "size_mb": 408,
    },
}

def create_session(model_key: str, force_cpu: bool = False):
    """
    Creates and returns a rembg session with the appropriate model and execution providers.
    """
    model_info = MODELS.get(model_key)
    if not model_info:
        raise ValueError(f"Unknown background removal model: {model_key}")
        
    model_name = model_info["name"]
    
    # Configure execution providers
    # If not forced to CPU, we prefer CUDA (GPU) if onnxruntime-gpu is available
    providers = None
    if force_cpu:
        providers = ["CPUExecutionProvider"]
    else:
        # rembg/onnxruntime will default to available providers, but we can explicitly list them
        # to ensure GPU is prioritized if present.
        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
        
    try:
        # new_session automatically downloads the model if it's not present locally
        return new_session(model_name=model_name, providers=providers)
    except Exception as exc:
        # Fall back to CPU only if CUDA provider fails to initialize
        if not force_cpu:
            try:
                return new_session(model_name=model_name, providers=["CPUExecutionProvider"])
            except Exception:
                pass
        raise exc
