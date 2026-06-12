"""
Tests for backend/amv_bgremove/models.py

Covers cuda_fallback_message: the post-session check that surfaces silent
GPU-to-CPU degradation (onnxruntime never raises for it).
"""
import sys
from pathlib import Path
from unittest.mock import MagicMock

_BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

from amv_bgremove.models import cuda_fallback_message


def _session_with_providers(providers):
    session = MagicMock()
    session.inner_session.get_providers.return_value = providers
    return session


def test_no_warning_when_cpu_was_requested():
    session = _session_with_providers(["CPUExecutionProvider"])
    assert cuda_fallback_message(session, force_cpu=True) is None


def test_no_warning_when_cuda_is_active():
    session = _session_with_providers(["CUDAExecutionProvider", "CPUExecutionProvider"])
    assert cuda_fallback_message(session, force_cpu=False) is None


def test_warns_when_gpu_requested_but_session_is_cpu_only():
    session = _session_with_providers(["CPUExecutionProvider"])
    message = cuda_fallback_message(session, force_cpu=False)
    assert message is not None
    assert "CPU" in message


def test_warns_when_session_shape_is_unexpected():
    # No inner_session attribute: provider introspection fails closed, which
    # must read as "not on the GPU" rather than crashing the job.
    assert cuda_fallback_message(object(), force_cpu=False) is not None
