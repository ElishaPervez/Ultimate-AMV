import sys
from pathlib import Path

_BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

from amv_audio.separator import _last_separator_failure


def test_last_separator_failure_preserves_the_real_processing_error():
    stderr = (
        "2026-07-17 19:36:48,051 - ERROR - separator - "
        "Failed to process file C:\\Users\\Elisha\\Videos\\edit.mp4: "
        "Numba needs NumPy 2.4 or less. Got NumPy 2.5.\n"
    )

    assert _last_separator_failure(stderr) == (
        "Numba needs NumPy 2.4 or less. Got NumPy 2.5."
    )


def test_last_separator_failure_ignores_unrelated_progress_output():
    assert _last_separator_failure("47%|####| downloading model\n") is None

