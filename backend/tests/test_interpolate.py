import json
from types import SimpleNamespace

import pytest

from amv_interpolate import processor
import interpolate_cli


def test_scene_gate_holds_across_visually_distinct_frames():
    np = pytest.importorskip("numpy")
    first = np.zeros((72, 128, 3), dtype=np.uint8)
    second = np.full((72, 128, 3), 255, dtype=np.uint8)
    assert processor.is_scene_cut(first, second)


def test_scene_gate_allows_near_identical_frames():
    np = pytest.importorskip("numpy")
    first = np.full((72, 128, 3), 100, dtype=np.uint8)
    second = np.full((72, 128, 3), 102, dtype=np.uint8)
    assert not processor.is_scene_cut(first, second)


@pytest.mark.parametrize("height,width", [(1080, 1920), (567, 1234)])
def test_pad_and_crop_restore_exact_dimensions(height, width):
    np = pytest.importorskip("numpy")
    frame = np.zeros((height, width, 3), dtype=np.uint8)
    padded, original = processor.pad_frame(frame)
    assert padded.shape[0] % 64 == 0
    assert padded.shape[1] % 64 == 0
    assert processor.crop_frame(padded, original).shape == frame.shape


@pytest.mark.parametrize("factor", [2, 3, 4])
def test_output_fps_math(factor):
    assert processor.output_fps(23.976, factor) == pytest.approx(23.976 * factor)


def test_target_fps_math_and_fractional_timesteps():
    assert processor.output_fps(24, target_fps=60) == 60
    first, next_index = processor.pair_timesteps(24, 60, 0, 0)
    second, _ = processor.pair_timesteps(24, 60, 1, next_index)
    assert first == pytest.approx([0.0, 0.4, 0.8])
    assert second == pytest.approx([0.2, 0.6])


@pytest.mark.parametrize("factor", [2, 3, 4, 8, 16, 32, 64])
def test_slow_motion_generates_extra_frames_at_the_source_playback_rate(factor):
    generated_fps, playback_fps = processor.interpolation_rates(
        23.976,
        factor,
        slow_motion=True,
    )
    assert generated_fps == pytest.approx(23.976 * factor)
    assert playback_fps == pytest.approx(23.976)


def test_slow_motion_rejects_a_target_frame_rate():
    with pytest.raises(ValueError, match="cannot be combined"):
        processor.interpolation_rates(24, 2, target_fps=60, slow_motion=True)


@pytest.mark.parametrize(
    "use_gpu,rate_mode,expected",
    [
        (True, "cbr", ("h264_nvenc", "-cbr_padding", "-minrate", "-maxrate")),
        (False, "quality", ("libx264", "-crf")),
    ],
)
def test_encoder_rate_controls_match_selected_mode(use_gpu, rate_mode, expected):
    command = processor._encoder_command(
        "ffmpeg",
        "input.mp4",
        "output.mp4",
        1920,
        1080,
        60,
        use_gpu,
        True,
        rate_mode=rate_mode,
        quality=21,
        bitrate_mbps=20,
    )
    for value in expected:
        assert value in command


@pytest.mark.parametrize(
    "output_format,output_path,expected,forbidden",
    [
        ("h264-mp4", "out.mp4", ("h264_nvenc", "-movflags"), ("hvc1",)),
        ("hevc-mp4", "out.mp4", ("hevc_nvenc", "hvc1", "-movflags"), ()),
        # Matroska rejects the fast-start flag and the QuickTime stream tag;
        # sending either aborts FFmpeg before the first frame is written.
        ("h264-mkv", "out.mkv", ("h264_nvenc",), ("-movflags", "hvc1")),
        ("prores-mov", "out.mov", ("prores_ks", "yuv422p10le"), ("-crf", "-b:v")),
    ],
)
def test_output_format_selects_codec_and_container_flags(
    output_format, output_path, expected, forbidden
):
    command = processor._encoder_command(
        "ffmpeg",
        "input.mp4",
        output_path,
        1920,
        1080,
        60,
        True,
        False,
        output_format=output_format,
    )
    for value in expected:
        assert value in command
    for value in forbidden:
        assert value not in command


def test_unknown_output_format_is_rejected():
    with pytest.raises(ValueError):
        processor._encoder_command(
            "ffmpeg", "input.mp4", "out.mp4", 1920, 1080, 60, False, False,
            output_format="vp9-webm",
        )


def test_audio_mp4_cannot_hold_is_converted_but_mkv_keeps_it():
    # A WebM source carries Opus, which MP4 refuses outright -- copying it
    # through used to fail the whole clip.
    into_mp4 = processor._encoder_command(
        "ffmpeg", "input.webm", "out.mp4", 1920, 1080, 60, False, True,
        audio_codec="opus",
    )
    into_mkv = processor._encoder_command(
        "ffmpeg", "input.webm", "out.mkv", 1920, 1080, 60, False, True,
        output_format="h264-mkv", audio_codec="opus",
    )
    kept = processor._encoder_command(
        "ffmpeg", "input.mp4", "out.mp4", 1920, 1080, 60, False, True,
        audio_codec="aac",
    )
    assert "aac" in into_mp4 and "copy" not in into_mp4
    assert "copy" in into_mkv
    assert "copy" in kept


@pytest.mark.parametrize(
    "factor,expected_filter",
    [
        (2, "atempo=0.5,apad"),
        (3, "atempo=0.5,atempo=0.66666667,apad"),
        (4, "atempo=0.5,atempo=0.5,apad"),
        (
            64,
            "atempo=0.5,atempo=0.5,atempo=0.5,atempo=0.5,atempo=0.5,atempo=0.5,apad",
        ),
    ],
)
def test_slow_motion_audio_keeps_pitch_and_reaches_the_video_end(
    factor, expected_filter
):
    command = processor._encoder_command(
        "ffmpeg",
        "input.mp4",
        "out.mp4",
        1920,
        1080,
        24,
        False,
        True,
        audio_codec="aac",
        audio_tempo=1 / factor,
    )
    assert expected_filter in command
    assert command[command.index("-c:a") + 1] == "aac"
    assert "-shortest" in command


def test_batch_continues_after_bad_path(monkeypatch, tmp_path):
    good = tmp_path / "good.mp4"
    good.write_bytes(b"video")
    calls = []

    def fake_interpolate(input_path, output_path, *args, **kwargs):
        calls.append(input_path)
        return {
            "input": str(input_path),
            "output": str(output_path),
            "sceneHolds": 0,
        }

    monkeypatch.setattr(processor, "interpolate_clip", fake_interpolate)
    outcomes = processor.process_batch(
        [
            {"input": str(tmp_path / "missing.mp4"), "output": str(tmp_path / "a.mp4")},
            {"input": str(good), "output": str(tmp_path / "b.mp4")},
        ],
        model=object(),
        factor=2,
        use_gpu=False,
    )
    assert [item["ok"] for item in outcomes] == [False, True]
    assert calls == [good.resolve()]


def test_cli_constructs_model_once_for_multi_clip_batch(monkeypatch, tmp_path):
    jobs_path = tmp_path / "jobs.json"
    jobs_path.write_text(
        json.dumps(
            [
                {"input": "one.mp4", "output": "one-out.mp4"},
                {"input": "two.mp4", "output": "two-out.mp4"},
            ]
        ),
        encoding="utf-8",
    )
    constructed = []
    monkeypatch.setattr(interpolate_cli, "ensure_feature_dependencies", lambda *a, **k: False)
    monkeypatch.setattr(
        interpolate_cli,
        "RifeModel",
        lambda *a, **k: constructed.append((a, k)) or object(),
    )
    monkeypatch.setattr(
        interpolate_cli,
        "process_batch",
        lambda jobs, *a, **k: [
            {"ok": True, "sceneHolds": 0, **job} for job in jobs
        ],
    )
    monkeypatch.setattr(interpolate_cli, "add_log", lambda *a, **k: None)
    result = interpolate_cli.interpolate(
        SimpleNamespace(
            jobs=str(jobs_path),
            factor=2,
            model="rife4.25",
            gpu=False,
            half=True,
            target_fps=None,
            slow_motion=False,
            rate_mode="quality",
            quality=18,
            bitrate_mbps=20.0,
            output_format="h264-mp4",
        )
    )
    assert result == 0
    assert len(constructed) == 1


def test_parser_supplies_optional_defaults():
    args = interpolate_cli.build_parser().parse_args(
        ["interpolate", "--jobs", "jobs.json"]
    )
    assert args.factor == 2
    assert args.model == "rife4.25"
    assert args.gpu is True
    assert args.half is True
    assert args.target_fps is None
    assert args.slow_motion is False
    assert args.rate_mode == "quality"
    assert args.output_format == "h264-mp4"


def test_progress_protocol_is_json_and_carries_queue_context(capsys):
    interpolate_cli.progress(
        "interpolate",
        42,
        "Working",
        0,
        clip_index=3,
        clip_count=30,
        clip_name="Scene 004.mp4",
    )
    payload = json.loads(capsys.readouterr().out)
    assert payload["type"] == "progress"
    assert payload["clipIndex"] == 3
    assert payload["clipCount"] == 30
