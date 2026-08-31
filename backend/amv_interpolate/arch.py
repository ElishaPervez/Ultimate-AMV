"""Native RIFE 4.25 and 4.6 inference networks.

The layer shapes and inference flow are derived from the model files distributed
by hzwer/Practical-RIFE. No TheAnimeScripter source is used. Practical-RIFE is
MIT licensed; the retained license notice is in THIRD_PARTY.md.
"""

import torch
import torch.nn as nn
import torch.nn.functional as functional

from .warp import warp


def _conv(in_channels, out_channels, kernel_size=3, stride=1, padding=1):
    return nn.Sequential(
        nn.Conv2d(
            in_channels,
            out_channels,
            kernel_size=kernel_size,
            stride=stride,
            padding=padding,
            bias=True,
        ),
        nn.LeakyReLU(0.2, True),
    )


class _ResidualConv(nn.Module):
    def __init__(self, channels):
        super().__init__()
        self.conv = nn.Conv2d(channels, channels, 3, 1, 1)
        self.beta = nn.Parameter(torch.ones((1, channels, 1, 1)))
        self.activation = nn.LeakyReLU(0.2, True)

    def forward(self, value):
        return self.activation(self.conv(value) * self.beta + value)


class _FeatureHead(nn.Module):
    def __init__(self):
        super().__init__()
        self.cnn0 = nn.Conv2d(3, 16, 3, 2, 1)
        self.cnn1 = nn.Conv2d(16, 16, 3, 1, 1)
        self.cnn2 = nn.Conv2d(16, 16, 3, 1, 1)
        self.cnn3 = nn.ConvTranspose2d(16, 4, 4, 2, 1)
        self.activation = nn.LeakyReLU(0.2, True)

    def forward(self, value):
        value = self.activation(self.cnn0(value))
        value = self.activation(self.cnn1(value))
        value = self.activation(self.cnn2(value))
        return self.cnn3(value)


class _FlowBlock425(nn.Module):
    def __init__(self, in_channels, channels):
        super().__init__()
        # Attribute names mirror the upstream Practical-RIFE checkpoint
        # layout (conv0 / convblock / lastconv). They are the keys inside
        # flownet.pkl, so renaming them for readability would silently load
        # zero weights.
        self.conv0 = nn.Sequential(
            _conv(in_channels, channels // 2, 3, 2, 1),
            _conv(channels // 2, channels, 3, 2, 1),
        )
        self.convblock = nn.Sequential(*(_ResidualConv(channels) for _ in range(8)))
        self.lastconv = nn.Sequential(
            nn.ConvTranspose2d(channels, 4 * 13, 4, 2, 1),
            nn.PixelShuffle(2),
        )

    def forward(self, value, flow=None, scale=1):
        value = functional.interpolate(
            value, scale_factor=1.0 / scale, mode="bilinear", align_corners=False
        )
        if flow is not None:
            scaled_flow = functional.interpolate(
                flow, scale_factor=1.0 / scale, mode="bilinear", align_corners=False
            ) / scale
            value = torch.cat((value, scaled_flow), dim=1)
        features = self.convblock(self.conv0(value))
        output = self.lastconv(features)
        output = functional.interpolate(
            output, scale_factor=scale, mode="bilinear", align_corners=False
        )
        return output[:, :4] * scale, output[:, 4:5], output[:, 5:]


class Rife425Net(nn.Module):
    """RIFE 4.25 inference-only network."""

    def __init__(self):
        super().__init__()
        self.block0 = _FlowBlock425(15, 192)
        self.block1 = _FlowBlock425(28, 128)
        self.block2 = _FlowBlock425(28, 96)
        self.block3 = _FlowBlock425(28, 64)
        self.block4 = _FlowBlock425(28, 32)
        self.encode = _FeatureHead()

    def forward(self, first, second, timestep=0.5, inference_scale=1.0):
        pair = torch.cat((first, second), dim=1)
        if not torch.is_tensor(timestep):
            timestep = pair[:, :1].clone().fill_(float(timestep))
        else:
            timestep = timestep.to(device=pair.device, dtype=pair.dtype)
            if timestep.ndim == 0:
                timestep = timestep.reshape(1, 1, 1, 1)
            timestep = timestep.expand(pair.shape[0], 1, pair.shape[2], pair.shape[3])

        first_features = self.encode(first)
        second_features = self.encode(second)
        warped_first = first
        warped_second = second
        flow = None
        mask = None
        block_features = None
        blocks = (self.block0, self.block1, self.block2, self.block3, self.block4)
        scales = tuple(value / inference_scale for value in (16, 8, 4, 2, 1))

        for block, scale in zip(blocks, scales):
            if flow is None:
                flow, mask, block_features = block(
                    torch.cat(
                        (first, second, first_features, second_features, timestep),
                        dim=1,
                    ),
                    scale=scale,
                )
            else:
                warped_first_features = warp(first_features, flow[:, :2])
                warped_second_features = warp(second_features, flow[:, 2:4])
                delta, mask, block_features = block(
                    torch.cat(
                        (
                            warped_first,
                            warped_second,
                            warped_first_features,
                            warped_second_features,
                            timestep,
                            mask,
                            block_features,
                        ),
                        dim=1,
                    ),
                    flow=flow,
                    scale=scale,
                )
                flow = flow + delta
            warped_first = warp(first, flow[:, :2])
            warped_second = warp(second, flow[:, 2:4])

        blend = torch.sigmoid(mask)
        return warped_first * blend + warped_second * (1.0 - blend)


class _FlowBlock46(nn.Module):
    def __init__(self, in_channels, channels):
        super().__init__()
        # Same checkpoint-key constraint as _FlowBlock425 above.
        self.conv0 = nn.Sequential(
            _conv(in_channels, channels // 2, 3, 2, 1),
            _conv(channels // 2, channels, 3, 2, 1),
        )
        self.convblock = nn.Sequential(*(_ResidualConv(channels) for _ in range(8)))
        self.lastconv = nn.Sequential(
            nn.ConvTranspose2d(channels, 4 * 6, 4, 2, 1),
            nn.PixelShuffle(2),
        )

    def forward(self, value, flow=None, scale=1):
        value = functional.interpolate(
            value, scale_factor=1.0 / scale, mode="bilinear", align_corners=False
        )
        if flow is not None:
            scaled_flow = functional.interpolate(
                flow, scale_factor=1.0 / scale, mode="bilinear", align_corners=False
            ) / scale
            value = torch.cat((value, scaled_flow), dim=1)
        output = self.lastconv(self.convblock(self.conv0(value)))
        output = functional.interpolate(
            output, scale_factor=scale, mode="bilinear", align_corners=False
        )
        return output[:, :4] * scale, output[:, 4:5]


class Rife46Net(nn.Module):
    """RIFE 4.6 inference-only network."""

    def __init__(self):
        super().__init__()
        self.block0 = _FlowBlock46(7, 192)
        self.block1 = _FlowBlock46(12, 128)
        self.block2 = _FlowBlock46(12, 96)
        self.block3 = _FlowBlock46(12, 64)

    def forward(self, first, second, timestep=0.5, inference_scale=1.0):
        pair = torch.cat((first, second), dim=1)
        if not torch.is_tensor(timestep):
            timestep = pair[:, :1].clone().fill_(float(timestep))
        else:
            timestep = timestep.to(device=pair.device, dtype=pair.dtype)
            if timestep.ndim == 0:
                timestep = timestep.reshape(1, 1, 1, 1)
            timestep = timestep.expand(pair.shape[0], 1, pair.shape[2], pair.shape[3])

        warped_first = first
        warped_second = second
        flow = None
        mask = None
        blocks = (self.block0, self.block1, self.block2, self.block3)
        scales = tuple(value / inference_scale for value in (8, 4, 2, 1))

        for block, scale in zip(blocks, scales):
            if flow is None:
                flow, mask = block(
                    torch.cat((first, second, timestep), dim=1), scale=scale
                )
            else:
                delta, mask_delta = block(
                    torch.cat((warped_first, warped_second, timestep, mask), dim=1),
                    flow=flow,
                    scale=scale,
                )
                flow = flow + delta
                mask = mask + mask_delta
            warped_first = warp(first, flow[:, :2])
            warped_second = warp(second, flow[:, 2:4])

        blend = torch.sigmoid(mask)
        return warped_first * blend + warped_second * (1.0 - blend)
