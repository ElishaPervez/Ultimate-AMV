"""Pinned native runtime versions that must be upgraded as one tested pair."""

TORCH_VERSION = "2.11.0"
TORCH_PACKAGES = [
    f"torch=={TORCH_VERSION}",
    "torchvision==0.26.0",
    f"torchaudio=={TORCH_VERSION}",
]

# Nelux wheels link against a specific PyTorch minor version. Nelux 0.11.0 is
# the Windows CPython 3.13 build verified against PyTorch 2.11 and the exact
# NVDEC reader options used by clip_cli.py.
NELUX_PACKAGE = "nelux==0.11.0"
