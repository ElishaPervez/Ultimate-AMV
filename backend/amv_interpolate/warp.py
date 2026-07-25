"""RIFE back-warp layer.

Derived from hzwer/Practical-RIFE at commit
17d8c7a1005b37f4c97bfee04e316aaec7fdc536. Practical-RIFE is MIT licensed;
the retained license notice is in THIRD_PARTY.md.
"""

import torch
import torch.nn.functional as functional


_GRID_CACHE = {}


def warp(source, flow):
    """Sample *source* at coordinates displaced by *flow*."""
    cache_key = (str(flow.device), str(flow.dtype), tuple(flow.shape))
    grid = _GRID_CACHE.get(cache_key)
    if grid is None:
        horizontal = torch.linspace(
            -1.0, 1.0, flow.shape[3], device=flow.device, dtype=flow.dtype
        ).view(1, 1, 1, flow.shape[3])
        vertical = torch.linspace(
            -1.0, 1.0, flow.shape[2], device=flow.device, dtype=flow.dtype
        ).view(1, 1, flow.shape[2], 1)
        grid = torch.cat(
            (
                horizontal.expand(flow.shape[0], -1, flow.shape[2], -1),
                vertical.expand(flow.shape[0], -1, -1, flow.shape[3]),
            ),
            dim=1,
        )
        _GRID_CACHE[cache_key] = grid

    normalized_flow = torch.cat(
        (
            flow[:, 0:1] / ((source.shape[3] - 1.0) / 2.0),
            flow[:, 1:2] / ((source.shape[2] - 1.0) / 2.0),
        ),
        dim=1,
    )
    sample_grid = (grid + normalized_flow).permute(0, 2, 3, 1)
    return functional.grid_sample(
        source,
        sample_grid,
        mode="bilinear",
        padding_mode="border",
        align_corners=True,
    )
