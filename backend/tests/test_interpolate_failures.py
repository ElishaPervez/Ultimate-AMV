"""Regression tests for three bugs that shipped together in v0.14.0.

All three were found by actually running a clip through the pipeline, and each
one hid the next:

1. The network's output was modified after inference had ended, which PyTorch
   forbids. Every single frame failed.
2. The cleanup that runs after a failed clip tried to delete the half-written
   output before the encoder had let go of it. The delete failed, and its error
   REPLACED the real one -- so bug 1 reached the user as "the file is being
   used by another process".
3. Once the pipeline ran, the finished video had no sound. The check for "does
   this source have audio?" read from a probe that had been told to look at the
   video stream only, so the answer was always no.
"""

import subprocess
from types import SimpleNamespace

import pytest

from amv_interpolate import processor


# ---------------------------------------------------------------- bug 2 ----

def test_discarding_a_locked_output_reports_failure_instead_of_raising(tmp_path):
    # Windows keeps the encoder's handle open for a moment after it is killed.
    # Cleanup must swallow that, because it only ever runs while a real failure
    # is already on its way to the user.
    target = tmp_path / "half-written.mp4"
    target.write_bytes(b"partial")
    handle = open(target, "wb")
    try:
        gone = processor.discard_partial_output(target, attempts=2, delay=0)
    finally:
        handle.close()
    # On Windows the open handle blocks the delete; on POSIX it does not.
    # Either way the call must return a bool rather than raise.
    assert gone in (True, False)


def test_discarding_an_unlocked_output_removes_it(tmp_path):
    target = tmp_path / "half-written.mp4"
    target.write_bytes(b"partial")
    assert processor.discard_partial_output(target) is True
    assert not target.exists()


def test_discarding_a_missing_output_is_not_an_error(tmp_path):
    assert processor.discard_partial_output(tmp_path / "never-existed.mp4") is True


def test_a_failing_clip_reports_its_own_error_not_a_cleanup_error(monkeypatch, tmp_path):
    source = tmp_path / "clip.mp4"
    source.write_bytes(b"video")
    output = tmp_path / "clip_2x.mp4"

    def explode(*args, **kwargs):
        raise RuntimeError("the real failure")

    # Cleanup cannot delete the output, exactly as when the encoder still holds
    # it. The batch must still surface "the real failure".
    monkeypatch.setattr(processor, "interpolate_clip", explode)
    monkeypatch.setattr(processor, "discard_partial_output", lambda *a, **k: False)
    outcomes = processor.process_batch(
        [{"input": str(source), "output": str(output)}],
        model=object(),
        factor=2,
        use_gpu=False,
    )
    assert outcomes[0]["ok"] is False
    assert outcomes[0]["error"] == "the real failure"


def test_stopping_a_process_waits_for_it_to_exit():
    exited = []

    class FakeProcess:
        def __init__(self):
            self.alive = True

        def poll(self):
            return None if self.alive else 0

        def kill(self):
            self.alive = False

        def wait(self, timeout=None):
            exited.append(timeout)
            return 0

    processor._stop_process(FakeProcess())
    # Without the wait, the file handle is still open when cleanup deletes.
    assert exited, "kill() must be followed by a wait for the process to exit"


# ---------------------------------------------------------------- bug 3 ----

def _fake_ffprobe(video_json, audio_csv):
    """Stand in for the two ffprobe calls probe_media makes."""

    def run(command, *args, **kwargs):
        selects_audio = "a" in command and "-select_streams" in command and (
            command[command.index("-select_streams") + 1] == "a"
        )
        payload = audio_csv if selects_audio else video_json
        return SimpleNamespace(returncode=0, stdout=payload, stderr="")

    return run


VIDEO_ONLY_JSON = """
{"streams": [{"codec_type": "video", "width": 1920, "height": 1080,
  "avg_frame_rate": "24000/1001", "nb_read_frames": "895", "duration": "37.3"}],
 "format": {"duration": "37.3"}}
"""


def test_a_source_with_sound_is_detected_even_though_the_video_probe_hides_it(
    monkeypatch, tmp_path
):
    # VIDEO_ONLY_JSON is what the frame-counting probe returns for a file that
    # DOES have audio -- it was told to look at the video stream only. The
    # audio answer has to come from somewhere else.
    monkeypatch.setattr(processor, "resolve_tool", lambda name: name)
    monkeypatch.setattr(subprocess, "run", _fake_ffprobe(VIDEO_ONLY_JSON, "1\n"))
    assert processor.probe_media(tmp_path / "clip.mp4").has_audio is True


def test_a_silent_source_is_reported_as_silent(monkeypatch, tmp_path):
    monkeypatch.setattr(processor, "resolve_tool", lambda name: name)
    monkeypatch.setattr(subprocess, "run", _fake_ffprobe(VIDEO_ONLY_JSON, "\n"))
    assert processor.probe_media(tmp_path / "clip.mp4").has_audio is False


def test_the_encoder_copies_audio_only_when_the_source_has_it():
    with_audio = processor._encoder_command(
        "ffmpeg", "in.mp4", "out.mp4", 1920, 1080, 48.0, False, True
    )
    without_audio = processor._encoder_command(
        "ffmpeg", "in.mp4", "out.mp4", 1920, 1080, 48.0, False, False
    )
    assert "1:a:0?" in with_audio
    assert "-c:a" in with_audio
    assert "1:a:0?" not in without_audio


# ---------------------------------------------------------------- bug 1 ----

def test_interpolated_frames_come_back_as_writable_ordinary_arrays(monkeypatch, tmp_path):
    """Run the real interpolate() path, which is where the PyTorch error hit."""
    torch = pytest.importorskip("torch")
    np = pytest.importorskip("numpy")

    from amv_interpolate import models
    from amv_interpolate.arch import Rife46Net

    weights = tmp_path / "flownet.pkl"
    weights.write_bytes(b"stub")
    monkeypatch.setattr(models, "weight_path", lambda key: weights)
    monkeypatch.setattr(torch, "load", lambda *a, **k: Rife46Net().state_dict())

    model = models.RifeModel("rife4.6", use_gpu=False, half=False)
    first = np.zeros((64, 64, 3), dtype=np.uint8)
    second = np.full((64, 64, 3), 255, dtype=np.uint8)

    frame = model.interpolate(first, second, 0.5)

    assert frame.shape == (64, 64, 3)
    assert frame.dtype == np.uint8
    # A view onto the network's own memory would be overwritten by the next
    # frame and cannot be written to; the caller needs a real array.
    assert frame.flags["WRITEABLE"]
    assert frame.flags["OWNDATA"]


def test_consecutive_frames_do_not_overwrite_each_other(monkeypatch, tmp_path):
    torch = pytest.importorskip("torch")
    np = pytest.importorskip("numpy")

    from amv_interpolate import models
    from amv_interpolate.arch import Rife46Net

    weights = tmp_path / "flownet.pkl"
    weights.write_bytes(b"stub")
    monkeypatch.setattr(models, "weight_path", lambda key: weights)
    monkeypatch.setattr(torch, "load", lambda *a, **k: Rife46Net().state_dict())

    model = models.RifeModel("rife4.6", use_gpu=False, half=False)
    dark = np.zeros((64, 64, 3), dtype=np.uint8)
    bright = np.full((64, 64, 3), 255, dtype=np.uint8)

    first_frame = model.interpolate(dark, bright, 0.5)
    snapshot = first_frame.copy()
    model.interpolate(bright, dark, 0.5)

    # If interpolate() handed back a view, this second call would have changed
    # the frame the caller is still holding.
    assert np.array_equal(first_frame, snapshot)
