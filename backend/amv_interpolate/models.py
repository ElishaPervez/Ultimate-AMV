"""RIFE model discovery and one-time batch loading."""

import os
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class ModelSpec:
    key: str
    label: str
    description: str
    relative_weight_path: str


MODEL_SPECS = {
    "rife4.25": ModelSpec(
        key="rife4.25",
        label="RIFE 4.25",
        description="Best detail and line stability for anime footage.",
        relative_weight_path="models/rife425/flownet.pkl",
    ),
    "rife4.6": ModelSpec(
        key="rife4.6",
        label="RIFE 4.6",
        description="Lower-memory compatibility model for constrained systems.",
        relative_weight_path="models/rife46/flownet.pkl",
    ),
}
MODEL_KEYS = tuple(MODEL_SPECS)


def tools_dir():
    configured = os.environ.get("ULTIMATE_AMV_TOOLS_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    return Path(sys.executable).resolve().parent.parent / "tools"


def weight_path(model_key):
    try:
        spec = MODEL_SPECS[model_key]
    except KeyError as error:
        raise ValueError(f"Unknown interpolation model: {model_key}") from error
    return tools_dir() / Path(spec.relative_weight_path)


def model_status():
    return {
        key: {
            "key": spec.key,
            "label": spec.label,
            "description": spec.description,
            "installed": weight_path(key).is_file(),
            "path": str(weight_path(key)),
        }
        for key, spec in MODEL_SPECS.items()
    }


class RifeModel:
    """Load one upstream weight set and reuse it for an entire batch."""

    def __init__(self, model_key, use_gpu=True, half=True):
        import torch

        from .arch import Rife425Net, Rife46Net

        if model_key not in MODEL_SPECS:
            raise ValueError(f"Unknown interpolation model: {model_key}")
        weights = weight_path(model_key)
        if not weights.is_file():
            raise FileNotFoundError(
                f"{MODEL_SPECS[model_key].label} is not installed. "
                "Open Frame interpolation and start the batch again to download it."
            )
        if use_gpu and not torch.cuda.is_available():
            raise RuntimeError(
                "GPU interpolation was requested, but CUDA PyTorch is not available. "
                "Switch the app to CPU mode or repair the GPU engine in Settings."
            )

        self.torch = torch
        self.device = torch.device("cuda" if use_gpu else "cpu")
        self.half = bool(half and use_gpu)
        self.network = Rife425Net() if model_key == "rife4.25" else Rife46Net()
        state = torch.load(str(weights), map_location="cpu", weights_only=True)
        if isinstance(state, dict) and "state_dict" in state:
            state = state["state_dict"]
        state = {
            key.removeprefix("module."): value
            for key, value in state.items()
        }
        missing, unexpected = self.network.load_state_dict(state, strict=False)
        if unexpected:
            raise RuntimeError(
                "The downloaded RIFE model contains unexpected layers. "
                "Delete it from the tools cache and let the app download it again."
            )
        # Training-only weights are not part of the inference network. Every
        # inference layer must still be present.
        if missing:
            raise RuntimeError(
                "The downloaded RIFE model is incomplete. "
                "Delete it from the tools cache and let the app download it again."
            )
        self.network.eval().to(self.device)
        if self.half:
            self.network.half()

    def _tensor(self, frame):
        torch = self.torch
        tensor = torch.from_numpy(frame).to(self.device, non_blocking=True)
        tensor = tensor.permute(2, 0, 1).unsqueeze(0)
        dtype = torch.float16 if self.half else torch.float32
        return tensor.to(dtype=dtype).div_(255.0)

    def interpolate(self, first, second, timestep, inference_scale=1.0):
        torch = self.torch
        first_tensor = self._tensor(first)
        second_tensor = self._tensor(second)
        with torch.inference_mode():
            result = self.network(
                first_tensor,
                second_tensor,
                float(timestep),
                inference_scale=float(inference_scale),
            )
        result = result.clamp_(0, 1).mul_(255).byte()
        return result.squeeze(0).permute(1, 2, 0).cpu().numpy()

    def reset_state(self):
        # Current RIFE networks are stateless between frame pairs. Keep this
        # method explicit so scene-cut handling remains correct if a future
        # upstream model introduces cached temporal state.
        return None
