import pytest

import deadframe_cli
from amv_deadframe import analyzer, processor


NEW_DRAWING = 0.12
HELD_DUPLICATE = 0.002


def held_pattern(hold, frames=24):
    """Scores for a clip drawn on `hold`s: a new drawing, then held copies."""
    return [
        NEW_DRAWING if index % hold == 0 else HELD_DUPLICATE
        for index in range(frames)
    ]


def test_a_clip_on_twos_loses_exactly_half_its_frames():
    scores = held_pattern(2)
    removed = analyzer.removal_set(scores, analyzer.DEFAULT_SENSITIVITY)
    assert removed == set(range(1, 24, 2))
    assert len(removed) == len(scores) // 2


def test_a_clip_on_threes_loses_exactly_two_thirds_of_its_frames():
    scores = held_pattern(3)
    removed = analyzer.removal_set(scores, analyzer.DEFAULT_SENSITIVITY)
    assert removed == {index for index in range(1, 24) if index % 3}
    assert len(removed) == len(scores) * 2 // 3


@pytest.mark.parametrize("sensitivity", [0, 18, 50, 100])
def test_an_all_new_sequence_loses_nothing_at_any_dial_position(sensitivity):
    scores = [0.4] + [NEW_DRAWING] * 23
    assert analyzer.removal_set(scores, sensitivity) == set()


@pytest.mark.parametrize("sensitivity", [0, 18, 100])
def test_frame_zero_survives_even_when_it_scores_lowest(sensitivity):
    scores = [0.0, 0.0, NEW_DRAWING, 0.0]
    assert 0 not in analyzer.removal_set(scores, sensitivity)


def test_a_score_equal_to_the_threshold_is_kept():
    threshold = analyzer.removal_threshold(analyzer.DEFAULT_SENSITIVITY)
    scores = [1.0, threshold, threshold * 0.5]
    removed = analyzer.removal_set(scores, analyzer.DEFAULT_SENSITIVITY)
    assert removed == {2}


@pytest.mark.parametrize(
    "sensitivity,expected",
    [(0, 0.001), (100, 0.030)],
)
def test_both_ends_of_the_dial_are_valid(sensitivity, expected):
    assert analyzer.removal_threshold(sensitivity) == pytest.approx(expected)
    removed = analyzer.removal_set(held_pattern(2), sensitivity)
    assert isinstance(removed, set)
    assert all(index > 0 for index in removed)


@pytest.mark.parametrize(
    "width,height,expected",
    [
        (1920, 1080, (640, 360)),
        (1080, 1920, (360, 640)),
        (640, 360, (640, 360)),
        (320, 180, (320, 180)),
    ],
)
def test_a_preview_caps_its_longest_edge_and_keeps_the_shape(width, height, expected):
    assert processor.preview_size(width, height) == expected


def test_every_preview_size_is_even():
    # Odd dimensions are rejected by the encoder's pixel format, so the source
    # can never hand one through.
    width, height = processor.preview_size(1919, 1079)
    assert width % 2 == 0 and height % 2 == 0


def test_the_preview_encoder_is_fixed_and_drops_audio():
    command = processor._preview_encoder_command(
        "ffmpeg", "preview.mp4", 640, 360, 23.976023976
    )
    assert "libx264" in command
    assert command[command.index("-preset") + 1] == "ultrafast"
    assert command[command.index("-crf") + 1] == "30"
    # Audio is never carried into a preview, and the fractional frame rate has
    # to survive intact or the preview would drift against the export.
    assert "-an" in command
    assert "23.97602398" in command


@pytest.mark.parametrize(
    "requested,expected",
    [
        # None and 0 are both the wire form of "keep the source rate", and a
        # negative value falls back the same way instead of reaching FFmpeg.
        (None, 23.976),
        (0, 23.976),
        (-5, 23.976),
        (60, 60.0),
        (23.976, 23.976),
    ],
)
def test_the_export_rate_is_the_users_choice_or_the_sources_own(requested, expected):
    assert processor.export_fps(requested, 23.976) == pytest.approx(expected)


def test_the_export_parser_reads_a_frame_rate_and_defaults_to_the_source():
    parser = deadframe_cli.build_parser()
    chosen = parser.parse_args(["export", "--jobs", "queue.json", "--fps", "60"])
    assert chosen.fps == 60.0
    default = parser.parse_args(["export", "--jobs", "queue.json"])
    assert default.fps == 0.0


def test_the_batch_hands_every_clip_the_chosen_frame_rate(tmp_path, monkeypatch):
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"")
    received = {}

    def fake_remove(input_path, output_path, sensitivity, **kwargs):
        received.update(kwargs)
        return {"input": str(input_path), "output": str(output_path)}

    monkeypatch.setattr(processor, "remove_dead_frames", fake_remove)
    processor.process_batch(
        [{"input": str(clip), "output": str(tmp_path / "out.mp4")}],
        analyzer.DEFAULT_SENSITIVITY,
        fps=60,
    )
    assert received["fps"] == 60


def test_a_failing_clip_does_not_stop_the_rest_of_the_queue(tmp_path, monkeypatch):
    good = tmp_path / "good.mp4"
    good.write_bytes(b"")
    processed = []

    def fake_remove(input_path, output_path, sensitivity, **kwargs):
        processed.append(str(input_path))
        return {"input": str(input_path), "output": str(output_path)}

    monkeypatch.setattr(processor, "remove_dead_frames", fake_remove)
    outcomes = processor.process_batch(
        [
            {"input": str(tmp_path / "missing.mp4"), "output": str(tmp_path / "a.mp4")},
            {"input": str(good), "output": str(tmp_path / "b.mp4")},
        ],
        analyzer.DEFAULT_SENSITIVITY,
    )
    assert [item["ok"] for item in outcomes] == [False, True]
    assert processed == [str(good.resolve())]
