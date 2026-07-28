"""Duplicate-frame removal for Ultimate AMV."""

from .analyzer import (
    DEFAULT_SENSITIVITY,
    measure_clip,
    removal_set,
    removal_threshold,
)

__all__ = [
    "DEFAULT_SENSITIVITY",
    "measure_clip",
    "removal_set",
    "removal_threshold",
]
