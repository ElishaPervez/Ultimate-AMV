import json
from types import SimpleNamespace

import pytest

np = pytest.importorskip("numpy")

from amv_interpolate import processor
import interpolate_cli


def test_scene_gate_holds_across_visually_distinct_frames():
    first = np.zeros((72, 128, 3), dtype=np.uint8)
    second = np.full((72, 128, 3), 255, dtype=np.uint8)
    assert processor.is_scene_cut(first, second)


def test_scene_gate_allows_near_identical_frames():
    first = np.full((72, 128, 3), 100, dtype=np.uint8)
    second = np.full((72, 128, 3), 102, dtype=np.uint8)
    assert not processor.is_scene_cut(first, second)


@pytest.mark.parametrize("height,width", [(1080, 1920), (567, 1234)])
def test_pad_and_crop_restore_exact_dimensions(height, width):
    frame = np.zeros((height, width, 3), dtype=np.uint8)
    padded, original = processor.pad_frame(frame)
    assert padded.shape[0] % 64 == 0
    assert padded.shape[1] % 64 == 0
    assert processor.crop_frame(padded, original).shape == frame.shape


@pytest.mark.parametrize("factor", [2, 3, 4])
def test_output_fps_math(factor):
    assert processor.output_fps(23.976, factor) == pytest.approx(23.976 * factor)


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
