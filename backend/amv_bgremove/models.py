import os

# Map human-readable model keys to rembg model names.
# Categories: "anime", "general", "portrait"
# Speed tiers: "fast", "balanced", "slow"
MODELS = {
    "u2netp": {
        "name": "u2netp",
        "label": "Lightweight Fast (u2netp)",
        "description": "Ultra-fast lightweight model. Lower edge accuracy but processes in under a second.",
        "size_mb": 4,
        "category": "general",
        "speed": "fast",
    },
    "silueta": {
        "name": "silueta",
        "label": "Fast Silhouette (silueta)",
        "description": "Fast, lightweight model optimized for clean silhouettes.",
        "size_mb": 43,
        "category": "general",
        "speed": "fast",
    },
    "anime": {
        "name": "isnet-anime",
        "label": "Anime Character (isnet-anime)",
        "description": "Best for anime characters. Specially trained on cel-shaded illustrations.",
        "size_mb": 174,
        "category": "anime",
        "speed": "balanced",
    },
    "general": {
        "name": "isnet-general-use",
        "label": "General Use (isnet-general-use)",
        "description": "Great for mixed content and general subject isolation.",
        "size_mb": 174,
        "category": "general",
        "speed": "balanced",
    },
    "u2net": {
        "name": "u2net",
        "label": "U²-Net Standard (u2net)",
        "description": "Classic general-purpose model. Good balance of speed and quality.",
        "size_mb": 168,
        "category": "general",
        "speed": "balanced",
    },
    "birefnet-lite": {
        "name": "birefnet-general-lite",
        "label": "BiRefNet Lite (birefnet-general-lite)",
        "description": "Lighter BiRefNet variant. Good edge quality with faster processing.",
        "size_mb": 224,
        "category": "general",
        "speed": "balanced",
    },
    "birefnet": {
        "name": "birefnet-general",
        "label": "BiRefNet Standard (birefnet-general)",
        "description": "High-quality edges for complex scenes. Slower but precise.",
        "size_mb": 408,
        "category": "general",
        "speed": "slow",
    },
    "birefnet-massive": {
        "name": "birefnet-massive",
        "label": "BiRefNet Massive (birefnet-massive)",
        "description": "Maximum quality. Largest model with the best edge precision. Very slow.",
        "size_mb": 920,
        "category": "general",
        "speed": "slow",
    },
}

# All valid model keys for argparse validation
MODEL_KEYS = list(MODELS.keys())

def create_session(model_key: str, force_cpu: bool = False):
    """
    Creates and returns a rembg session with the appropriate model and execution providers.
    """
    # Deferred: rembg is installed on first use by ensure_feature_dependencies;
    # importing it at module top would crash the CLI before the repair can run.
    from rembg import new_session

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
                session = new_session(model_name=model_name, providers=["CPUExecutionProvider"])
            except Exception:
                pass
            else:
                try:
                    from amv_audio.logs import add_log

                    add_log(
                        "bgremove.gpu_fallback",
                        f"CUDA session init failed; fell back to CPU: {exc}",
                        level="warning",
                    )
                except Exception:
                    pass
                return session
        raise exc


def _session_providers(session):
    """Active execution providers of the underlying ORT session (rembg exposes
    it as inner_session). Empty when the session shape is unexpected."""
    try:
        return list(session.inner_session.get_providers())
    except Exception:
        return []


def cuda_fallback_message(session, force_cpu: bool):
    """User-facing warning when GPU mode was requested but the session ended up
    CPU-only (clobbered onnxruntime install, missing CUDA DLLs, provider init
    failure). onnxruntime degrades to CPU silently, so this check is the only
    signal that GPU mode is not actually running on the GPU."""
    if force_cpu:
        return None
    if "CUDAExecutionProvider" in _session_providers(session):
        return None
    return (
        "GPU (CUDA) mode was requested but the AI runtime could not use the GPU, "
        "so this job ran on the CPU. Re-run the GPU setup or switch to CPU Mode."
    )
