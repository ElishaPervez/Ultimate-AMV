"""Guard the contract between our RIFE networks and the shipped weight files.

The weight files are ~20 MB Google Drive downloads, so CI cannot load them.
Instead `data/rife_checkpoint_keys.json` records every parameter name and
shape found inside the real flownet.pkl for each model (captured from the
files tools.json pins by sha256). These tests replay that manifest against the
freshly built networks.

Why this exists: v0.14.0 shipped networks whose submodules were named
`entry`/`residuals`/`exit` while the checkpoints use
`conv0`/`convblock`/`lastconv`. Not one weight loaded, and the only reason a
user saw an error instead of silent mush was the strict guard in models.py.
Renaming a submodule in arch.py for readability breaks loading, so it must
break a test first.
"""

import json
from pathlib import Path

import pytest

from amv_interpolate.models import TRAINING_ONLY_PREFIXES

CHECKPOINT_KEYS = json.loads(
    (Path(__file__).parent / "data" / "rife_checkpoint_keys.json").read_text()
)


def _inference_weights(model_key):
    return {
        name: tuple(shape)
        for name, shape in CHECKPOINT_KEYS[model_key].items()
        if not name.startswith(TRAINING_ONLY_PREFIXES)
    }


def _network(model_key):
    pytest.importorskip("torch")
    from amv_interpolate.arch import Rife425Net, Rife46Net

    return Rife425Net() if model_key == "rife4.25" else Rife46Net()


@pytest.mark.parametrize("model_key", ["rife4.25", "rife4.6"])
def test_every_checkpoint_weight_has_a_home_in_the_network(model_key):
    expected = _inference_weights(model_key)
    actual = {name: tuple(tensor.shape) for name, tensor in _network(model_key).state_dict().items()}
    assert set(expected) == set(actual)


@pytest.mark.parametrize("model_key", ["rife4.25", "rife4.6"])
def test_checkpoint_and_network_agree_on_every_layer_shape(model_key):
    expected = _inference_weights(model_key)
    actual = {name: tuple(tensor.shape) for name, tensor in _network(model_key).state_dict().items()}
    mismatched = {
        name: (shape, actual[name])
        for name, shape in expected.items()
        if name in actual and actual[name] != shape
    }
    assert mismatched == {}


@pytest.mark.parametrize("model_key", ["rife4.25", "rife4.6"])
def test_loading_the_recorded_checkpoint_leaves_nothing_missing_or_unexpected(model_key):
    torch = pytest.importorskip("torch")
    network = _network(model_key)
    state = {
        name: torch.zeros(shape)
        for name, shape in _inference_weights(model_key).items()
    }
    missing, unexpected = network.load_state_dict(state, strict=False)
    assert list(missing) == []
    assert list(unexpected) == []


def test_training_only_heads_are_dropped_before_loading():
    # RIFE 4.25 ships the distillation teacher and timestep estimator; RIFE 4.6
    # does not. Neither belongs to the inference network.
    raw_425 = set(CHECKPOINT_KEYS["rife4.25"])
    assert any(name.startswith("teacher.") for name in raw_425)
    assert any(name.startswith("caltime.") for name in raw_425)
    assert not any(name.startswith(TRAINING_ONLY_PREFIXES) for name in _inference_weights("rife4.25"))
