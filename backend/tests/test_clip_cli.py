"""
Tests for backend/clip_cli.py.

Scope:
  - Module-level DLL setup (os.add_dll_directory called when ffmpeg-shared exists)
  - _resolve_tools_dir() env-var branch vs. bundled-path fallback
  - require_tool() happy path + missing-tool error
  - parse_ratio() helper
  - probe_video() happy path + returncode != 0 branch
  - scenes_from_cuts() / scenes_from_ranges()
  - boundary_frames_to_seconds()
  - scenedetect_cut_frames() — PySceneDetect ContentDetector driver (mocked)
  - extract_cpu() — PySceneDetect CPU detection path (mocked decode + detector)
  - progress() stage alias normalisation
  - main() command dispatch — help/no command branch
  - extract() missing-file error path
  - server() quit command
"""

import json
import os
import sys
import types
import importlib
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import MagicMock, patch, call
import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _import_clip_cli():
    """Re-import clip_cli with a clean module cache entry each time, so that
    module-level side-effects (DLL dir setup) can be controlled per test."""
    if "clip_cli" in sys.modules:
        return sys.modules["clip_cli"]
    import clip_cli
    return clip_cli


# ---------------------------------------------------------------------------
# _resolve_tools_dir — env var first, fallback second
# ---------------------------------------------------------------------------

class TestResolveToolsDir:
    def test_honors_env_var(self, monkeypatch, tmp_path):
        """ULTIMATE_AMV_TOOLS_DIR must be returned as a Path when set."""
        monkeypatch.setenv("ULTIMATE_AMV_TOOLS_DIR", str(tmp_path))
        import clip_cli
        # call the function directly with the env var in place
        from clip_cli import _resolve_tools_dir
        result = _resolve_tools_dir()
        assert result == tmp_path

    def test_falls_back_to_bundled_path(self, monkeypatch):
        """When env var is absent, falls back to sys.executable/../tools."""
        monkeypatch.delenv("ULTIMATE_AMV_TOOLS_DIR", raising=False)
        from clip_cli import _resolve_tools_dir
        result = _resolve_tools_dir()
        expected = Path(sys.executable).parent.parent / "tools"
        assert result == expected

    def test_env_var_overrides_bundled(self, monkeypatch, tmp_path):
        """A non-empty env var must win over the bundled fallback."""
        custom = tmp_path / "custom_tools"
        monkeypatch.setenv("ULTIMATE_AMV_TOOLS_DIR", str(custom))
        from clip_cli import _resolve_tools_dir
        assert _resolve_tools_dir() != Path(sys.executable).parent.parent / "tools"


# ---------------------------------------------------------------------------
# DLL directory registration (os.add_dll_directory called at module level)
# ---------------------------------------------------------------------------

class TestDllDirectorySetup:
    def test_add_dll_directory_called_when_path_exists(self, tmp_path, monkeypatch):
        """When ffmpeg-shared exists, os.add_dll_directory must be called."""
        # Create a fake ffmpeg-shared directory
        ffmpeg_shared = tmp_path / "ffmpeg-shared"
        ffmpeg_shared.mkdir()

        monkeypatch.setenv("ULTIMATE_AMV_TOOLS_DIR", str(tmp_path))

        calls = []
        real_add_dll = getattr(os, "add_dll_directory", None)

        def fake_add_dll(path):
            calls.append(path)
            # Return a dummy context manager
            cm = MagicMock()
            cm.__enter__ = MagicMock(return_value=None)
            cm.__exit__ = MagicMock(return_value=False)
            return cm

        with patch("os.add_dll_directory", side_effect=fake_add_dll):
            # Force re-execution of module-level code
            if "clip_cli" in sys.modules:
                del sys.modules["clip_cli"]
            import clip_cli  # noqa: F401 — side-effects are what we're testing
            # Restore
            if "clip_cli" in sys.modules:
                del sys.modules["clip_cli"]

        # On Windows the call should have happened with the resolved path
        # (only when add_dll_directory is available on the platform)
        if real_add_dll is not None:
            assert any(str(ffmpeg_shared.resolve()) in str(c) for c in calls), (
                f"os.add_dll_directory was not called with the ffmpeg-shared path. calls={calls}"
            )

    def test_add_dll_directory_skipped_when_path_missing(self, tmp_path, monkeypatch):
        """When ffmpeg-shared does NOT exist, os.add_dll_directory must NOT be called."""
        # tmp_path exists but does NOT contain ffmpeg-shared
        monkeypatch.setenv("ULTIMATE_AMV_TOOLS_DIR", str(tmp_path))

        calls = []

        def fake_add_dll(path):
            calls.append(path)
            cm = MagicMock()
            cm.__enter__ = MagicMock(return_value=None)
            cm.__exit__ = MagicMock(return_value=False)
            return cm

        with patch("os.add_dll_directory", side_effect=fake_add_dll):
            if "clip_cli" in sys.modules:
                del sys.modules["clip_cli"]
            import clip_cli  # noqa: F401
            if "clip_cli" in sys.modules:
                del sys.modules["clip_cli"]

        assert calls == [], f"os.add_dll_directory should not be called. calls={calls}"


# ---------------------------------------------------------------------------
# require_tool
# ---------------------------------------------------------------------------

class TestRequireTool:
    def test_returns_str_path_when_tool_exists(self, tmp_path, monkeypatch):
        # require_tool uses module-level _tools_dir; patch it directly.
        import clip_cli
        monkeypatch.setattr(clip_cli, "_tools_dir", tmp_path)
        ffmpeg_exe = tmp_path / "ffmpeg.exe"
        ffmpeg_exe.write_text("fake")
        result = clip_cli.require_tool("ffmpeg")
        assert result == str(ffmpeg_exe)

    def test_raises_when_tool_missing(self, tmp_path, monkeypatch):
        # require_tool uses the module-level _tools_dir, not the env var at call time.
        # Patch the module attribute directly so the empty tmp_path is used.
        import clip_cli
        monkeypatch.setattr(clip_cli, "_tools_dir", tmp_path)
        with pytest.raises(RuntimeError, match="ffmpeg not found"):
            clip_cli.require_tool("ffmpeg")


# ---------------------------------------------------------------------------
# parse_ratio
# ---------------------------------------------------------------------------

class TestParseRatio:
    def test_plain_float_string(self):
        from clip_cli import parse_ratio
        assert parse_ratio("24.0") == pytest.approx(24.0)

    def test_ratio_string(self):
        from clip_cli import parse_ratio
        assert parse_ratio("30000/1001") == pytest.approx(30000 / 1001)

    def test_zero_denominator_returns_zero(self):
        from clip_cli import parse_ratio
        assert parse_ratio("1/0") == pytest.approx(0.0)

    def test_integer_string(self):
        from clip_cli import parse_ratio
        assert parse_ratio("25") == pytest.approx(25.0)


# ---------------------------------------------------------------------------
# probe_video
# ---------------------------------------------------------------------------

class TestProbeVideo:
    def _make_probe_output(self, codec="h264", fps="24000/1001", duration="120.5"):
        return json.dumps({
            "streams": [{"codec_name": codec, "avg_frame_rate": fps, "r_frame_rate": fps}],
            "format": {"duration": duration},
        })

    def test_happy_path(self, tmp_path):
        from clip_cli import probe_video
        fake_result = CompletedProcess(
            args=[], returncode=0, stdout=self._make_probe_output(), stderr=""
        )
        with patch("clip_cli.run", return_value=fake_result):
            info = probe_video("ffprobe", tmp_path / "video.mp4")
        assert info.codec == "h264"
        assert info.fps == pytest.approx(24000 / 1001, rel=1e-3)
        assert info.duration == pytest.approx(120.5)

    def test_nonzero_returncode_raises(self, tmp_path):
        from clip_cli import probe_video
        fake_result = CompletedProcess(args=[], returncode=1, stdout="", stderr="ffprobe error msg")
        with patch("clip_cli.run", return_value=fake_result):
            with pytest.raises(RuntimeError, match="ffprobe error msg"):
                probe_video("ffprobe", tmp_path / "video.mp4")

    def test_missing_codec_raises(self, tmp_path):
        from clip_cli import probe_video
        payload = json.dumps({"streams": [{}], "format": {"duration": "10.0"}})
        fake_result = CompletedProcess(args=[], returncode=0, stdout=payload, stderr="")
        with patch("clip_cli.run", return_value=fake_result):
            with pytest.raises(RuntimeError, match="codec"):
                probe_video("ffprobe", tmp_path / "video.mp4")

    def test_zero_fps_raises(self, tmp_path):
        from clip_cli import probe_video
        payload = json.dumps({
            "streams": [{"codec_name": "h264", "avg_frame_rate": "0/1"}],
            "format": {"duration": "10.0"},
        })
        fake_result = CompletedProcess(args=[], returncode=0, stdout=payload, stderr="")
        with patch("clip_cli.run", return_value=fake_result):
            with pytest.raises(RuntimeError, match="FPS"):
                probe_video("ffprobe", tmp_path / "video.mp4")

    def test_zero_duration_raises(self, tmp_path):
        from clip_cli import probe_video
        payload = json.dumps({
            "streams": [{"codec_name": "h264", "avg_frame_rate": "24/1"}],
            "format": {"duration": "0"},
        })
        fake_result = CompletedProcess(args=[], returncode=0, stdout=payload, stderr="")
        with patch("clip_cli.run", return_value=fake_result):
            with pytest.raises(RuntimeError, match="duration"):
                probe_video("ffprobe", tmp_path / "video.mp4")


# ---------------------------------------------------------------------------
# scenes_from_cuts
# ---------------------------------------------------------------------------

class TestScenesFromCuts:
    def test_no_cuts_produces_single_scene(self, tmp_path):
        from clip_cli import scenes_from_cuts
        scenes = scenes_from_cuts(tmp_path / "v.mp4", [], 60.0)
        assert len(scenes) == 1
        assert scenes[0]["start"] == 0.0
        assert scenes[0]["end"] == pytest.approx(60.0)

    def test_one_cut_produces_two_scenes(self, tmp_path):
        from clip_cli import scenes_from_cuts
        scenes = scenes_from_cuts(tmp_path / "v.mp4", [30.0], 60.0)
        assert len(scenes) == 2
        assert scenes[0]["end"] == pytest.approx(30.0)
        assert scenes[1]["start"] == pytest.approx(30.0)

    def test_scene_indices_are_sequential(self, tmp_path):
        from clip_cli import scenes_from_cuts
        scenes = scenes_from_cuts(tmp_path / "v.mp4", [10.0, 20.0], 30.0)
        for i, s in enumerate(scenes):
            assert s["index"] == i

    def test_labels_formatted_with_leading_zeros(self, tmp_path):
        from clip_cli import scenes_from_cuts
        scenes = scenes_from_cuts(tmp_path / "v.mp4", [], 10.0)
        assert scenes[0]["label"] == "Scene 001"

    def test_source_path_stored_as_str(self, tmp_path):
        from clip_cli import scenes_from_cuts
        path = tmp_path / "input.mp4"
        scenes = scenes_from_cuts(path, [], 5.0)
        assert isinstance(scenes[0]["source"], str)


# ---------------------------------------------------------------------------
# scenes_from_ranges
# ---------------------------------------------------------------------------

class TestScenesFromRanges:
    def test_valid_ranges(self, tmp_path):
        from clip_cli import scenes_from_ranges
        scenes = scenes_from_ranges(tmp_path / "v.mp4", [(0, 10), (15, 25)], 30.0, 0.35)
        assert len(scenes) == 2

    def test_range_shorter_than_min_clip_excluded(self, tmp_path):
        from clip_cli import scenes_from_ranges
        # 0.1 s range is below min_clip_seconds=0.35
        scenes = scenes_from_ranges(tmp_path / "v.mp4", [(0, 0.1)], 10.0, 0.35)
        # Falls back to scenes_from_cuts with empty cuts → single scene
        assert len(scenes) == 1

    def test_empty_ranges_falls_back_to_single_scene(self, tmp_path):
        from clip_cli import scenes_from_ranges
        scenes = scenes_from_ranges(tmp_path / "v.mp4", [], 60.0, 0.35)
        assert len(scenes) == 1

    def test_ranges_clamped_to_duration(self, tmp_path):
        from clip_cli import scenes_from_ranges
        scenes = scenes_from_ranges(tmp_path / "v.mp4", [(-5, 200)], 60.0, 0.35)
        assert scenes[0]["start"] == pytest.approx(0.0)
        assert scenes[0]["end"] == pytest.approx(60.0)


# ---------------------------------------------------------------------------
# boundary_frames_to_seconds
# ---------------------------------------------------------------------------

class TestBoundaryFramesToSeconds:
    def test_no_boundaries_returns_empty(self):
        import numpy as np
        from clip_cli import boundary_frames_to_seconds
        mask = np.zeros(100, dtype=bool)
        cuts = boundary_frames_to_seconds(mask, None, 24.0, 10.0, 0.35)
        assert cuts == []

    def test_boundary_at_valid_position(self):
        import numpy as np
        from clip_cli import boundary_frames_to_seconds
        mask = np.zeros(240, dtype=bool)
        # Put a boundary at frame 120 (= 5.0 s in a 10 s video at 24 fps)
        mask[120] = True
        cuts = boundary_frames_to_seconds(mask, None, 24.0, 10.0, 0.35)
        assert len(cuts) == 1
        assert cuts[0] == pytest.approx(5.0)

    def test_boundaries_too_close_to_edge_dropped(self):
        import numpy as np
        from clip_cli import boundary_frames_to_seconds
        mask = np.zeros(240, dtype=bool)
        # Frame 1 → 1/24 ≈ 0.04 s — below min_clip_seconds=0.35
        mask[1] = True
        cuts = boundary_frames_to_seconds(mask, None, 24.0, 10.0, 0.35)
        assert cuts == []

    def test_too_close_consecutive_cuts_merged(self):
        import numpy as np
        from clip_cli import boundary_frames_to_seconds
        mask = np.zeros(240, dtype=bool)
        # Frames 60 and 61 are adjacent; merged window → single cut
        mask[60] = True
        mask[61] = True
        cuts = boundary_frames_to_seconds(mask, None, 24.0, 10.0, 0.35)
        assert len(cuts) == 1


# ---------------------------------------------------------------------------
# scenedetect_cut_frames — PySceneDetect ContentDetector driver
# ---------------------------------------------------------------------------


def _install_fake_scenedetect(cut_frame_numbers):
    """Build a fake `scenedetect` module whose ContentDetector reports a cut
    only at the given frame numbers, so the driver can be tested without the
    real (cv2-backed) package installed.

    Returns the patch.dict context manager for `sys.modules`.
    """
    class FakeFrameTimecode:
        def __init__(self, timecode, fps=None):
            self._frame = int(timecode)

        def __int__(self):
            return self._frame

    class FakeContentDetector:
        last_kwargs = None

        def __init__(self, threshold=27.0, min_scene_len=15, **kwargs):
            FakeContentDetector.last_kwargs = {
                "threshold": threshold,
                "min_scene_len": min_scene_len,
            }

        def process_frame(self, timecode, frame_img):
            if int(timecode) in cut_frame_numbers:
                # Return FrameTimecode-like objects, mirroring scenedetect 0.7
                return [FakeFrameTimecode(int(timecode))]
            return []

    fake_module = types.ModuleType("scenedetect")
    fake_module.ContentDetector = FakeContentDetector
    fake_module.FrameTimecode = FakeFrameTimecode
    return patch.dict("sys.modules", {"scenedetect": fake_module}), FakeContentDetector


class TestScenedetectCutFrames:
    def test_returns_cut_frame_for_detected_boundary(self):
        import numpy as np
        from clip_cli import scenedetect_cut_frames

        frames = np.zeros((72, 27, 48, 3), dtype=np.uint8)
        ctx, _det = _install_fake_scenedetect({36})
        with ctx:
            cuts = scenedetect_cut_frames(frames, 24.0, 27.0, 0.35, 0.0)
        assert cuts == [36]

    def test_no_detected_cuts_returns_empty(self):
        import numpy as np
        from clip_cli import scenedetect_cut_frames

        frames = np.zeros((48, 27, 48, 3), dtype=np.uint8)
        ctx, _det = _install_fake_scenedetect(set())
        with ctx:
            cuts = scenedetect_cut_frames(frames, 24.0, 27.0, 0.35, 0.0)
        assert cuts == []

    def test_empty_frames_returns_empty(self):
        import numpy as np
        from clip_cli import scenedetect_cut_frames

        frames = np.zeros((0, 27, 48, 3), dtype=np.uint8)
        ctx, _det = _install_fake_scenedetect({0})
        with ctx:
            cuts = scenedetect_cut_frames(frames, 24.0, 27.0, 0.35, 0.0)
        assert cuts == []

    def test_cpu_threshold_and_min_clip_passed_to_detector(self):
        import numpy as np
        from clip_cli import scenedetect_cut_frames

        frames = np.zeros((24, 27, 48, 3), dtype=np.uint8)
        ctx, FakeDetector = _install_fake_scenedetect(set())
        with ctx:
            scenedetect_cut_frames(frames, 24.0, 30.0, 0.5, 0.0)
        # threshold flows through verbatim; min_scene_len = round(0.5 * 24) = 12
        assert FakeDetector.last_kwargs["threshold"] == pytest.approx(30.0)
        assert FakeDetector.last_kwargs["min_scene_len"] == 12

    def test_cuts_returned_sorted_and_unique(self):
        import numpy as np
        from clip_cli import scenedetect_cut_frames

        frames = np.zeros((100, 27, 48, 3), dtype=np.uint8)
        ctx, _det = _install_fake_scenedetect({60, 30, 30})
        with ctx:
            cuts = scenedetect_cut_frames(frames, 24.0, 27.0, 0.35, 0.0)
        assert cuts == [30, 60]

    def test_real_scenedetect_finds_hard_cut(self):
        """Integration: drive the genuine PySceneDetect ContentDetector against
        a synthetic black->white cut. Skips cleanly where scenedetect isn't
        installed (e.g. the repo .venv)."""
        pytest.importorskip("scenedetect")
        import numpy as np
        from clip_cli import scenedetect_cut_frames, FRAME_W, FRAME_H

        # Decode-shaped RGB array: solid black for the first half, solid white
        # for the second — a single hard cut at the boundary frame.
        frame_count = 60
        boundary = 30
        frames = np.zeros((frame_count, FRAME_H, FRAME_W, 3), dtype=np.uint8)
        frames[boundary:] = 255

        # Low threshold + no min-scene floor so the obvious cut is reported.
        cuts = scenedetect_cut_frames(frames, 24.0, 1.0, 0.0, 0.0)

        assert cuts, "real ContentDetector reported no cut on a hard black/white boundary"
        assert any(abs(c - boundary) <= 1 for c in cuts), (
            f"expected a cut at/adjacent to frame {boundary}, got {cuts}"
        )


# ---------------------------------------------------------------------------
# extract_cpu — PySceneDetect CPU detection path
# ---------------------------------------------------------------------------


class TestExtractCpu:
    def _info(self, fps=24.0, duration=10.0, codec="h264"):
        from clip_cli import VideoInfo
        return VideoInfo(codec=codec, fps=fps, duration=duration)

    def test_returns_scenes_and_interior_cuts(self, tmp_path):
        import numpy as np
        import clip_cli

        info = self._info(fps=24.0, duration=10.0)
        frames = np.zeros((240, 27, 48, 3), dtype=np.uint8)

        # Cut at frame 120 -> 5.0 s (interior, passes min-clip edge filter).
        ctx, _det = _install_fake_scenedetect({120})
        with ctx:
            with patch("clip_cli.require_tool", return_value="ffmpeg"):
                with patch("clip_cli.decode_frames_cpu", return_value=frames):
                    scenes, cuts = clip_cli.extract_cpu(
                        tmp_path / "v.mp4", info, 27.0, 0.35, 0.0
                    )

        assert cuts == pytest.approx([5.0])
        # one interior cut -> two scenes; shape matches the GPU paths' contract.
        assert len(scenes) == 2
        for key in ("index", "label", "source", "start", "end"):
            assert key in scenes[0]
        assert scenes[0]["start"] == pytest.approx(0.0)
        assert scenes[0]["end"] == pytest.approx(5.0)
        assert scenes[1]["start"] == pytest.approx(5.0)
        assert scenes[1]["end"] == pytest.approx(10.0)

    def test_no_cuts_yields_single_scene(self, tmp_path):
        import numpy as np
        import clip_cli

        info = self._info(fps=24.0, duration=10.0)
        frames = np.zeros((240, 27, 48, 3), dtype=np.uint8)

        ctx, _det = _install_fake_scenedetect(set())
        with ctx:
            with patch("clip_cli.require_tool", return_value="ffmpeg"):
                with patch("clip_cli.decode_frames_cpu", return_value=frames):
                    scenes, cuts = clip_cli.extract_cpu(
                        tmp_path / "v.mp4", info, 27.0, 0.35, 0.0
                    )

        assert cuts == []
        assert len(scenes) == 1
        assert scenes[0]["start"] == pytest.approx(0.0)
        assert scenes[0]["end"] == pytest.approx(10.0)

    def test_cut_too_close_to_edge_dropped(self, tmp_path):
        import numpy as np
        import clip_cli

        info = self._info(fps=24.0, duration=10.0)
        frames = np.zeros((240, 27, 48, 3), dtype=np.uint8)

        # Cut at frame 2 -> ~0.083 s, below min_clip_seconds=0.35 -> dropped.
        ctx, _det = _install_fake_scenedetect({2})
        with ctx:
            with patch("clip_cli.require_tool", return_value="ffmpeg"):
                with patch("clip_cli.decode_frames_cpu", return_value=frames):
                    scenes, cuts = clip_cli.extract_cpu(
                        tmp_path / "v.mp4", info, 27.0, 0.35, 0.0
                    )

        assert cuts == []
        assert len(scenes) == 1


# ---------------------------------------------------------------------------
# progress() stage alias normalisation
# ---------------------------------------------------------------------------

class TestProgressStageAlias:
    def test_cpu_detect_aliased_to_analyze(self):
        from clip_cli import progress
        emitted = []
        with patch("clip_cli.emit", side_effect=lambda p: emitted.append(p)):
            import time
            progress("cpu-detect", 50, "msg", time.perf_counter())
        assert emitted[0]["stage"] == "analyze"

    def test_transnet_aliased_to_analyze(self):
        from clip_cli import progress
        emitted = []
        with patch("clip_cli.emit", side_effect=lambda p: emitted.append(p)):
            import time
            progress("transnet", 75, "msg", time.perf_counter())
        assert emitted[0]["stage"] == "analyze"

    def test_dependency_repair_aliased_to_dependencies(self):
        from clip_cli import progress
        emitted = []
        with patch("clip_cli.emit", side_effect=lambda p: emitted.append(p)):
            import time
            progress("dependency-repair", 10, "msg", time.perf_counter())
        assert emitted[0]["stage"] == "dependencies"

    def test_unknown_stage_passed_through(self):
        from clip_cli import progress
        emitted = []
        with patch("clip_cli.emit", side_effect=lambda p: emitted.append(p)):
            import time
            progress("scenes", 96, "msg", time.perf_counter())
        assert emitted[0]["stage"] == "scenes"

    def test_percent_clamped_0_100(self):
        from clip_cli import progress
        emitted = []
        with patch("clip_cli.emit", side_effect=lambda p: emitted.append(p)):
            import time
            progress("scenes", -5, "msg", time.perf_counter())
        assert emitted[0]["percent"] == pytest.approx(0.0)

    def test_elapsed_seconds_present(self):
        from clip_cli import progress
        emitted = []
        with patch("clip_cli.emit", side_effect=lambda p: emitted.append(p)):
            import time
            progress("decode", 10, "msg", time.perf_counter())
        assert "elapsedSeconds" in emitted[0]


# ---------------------------------------------------------------------------
# extract() — file-not-found error path
# ---------------------------------------------------------------------------

class TestExtractFileMissing:
    def test_missing_input_file_raises(self, tmp_path):
        from clip_cli import extract
        non_existent = tmp_path / "does_not_exist.mp4"
        with patch("clip_cli.ensure_feature_dependencies"):
            with pytest.raises(RuntimeError, match="does not exist"):
                extract(
                    str(non_existent), "cpu", 0.5, 27.0, 0.35, 100, 50
                )


# ---------------------------------------------------------------------------
# main() — no command / help branch
# ---------------------------------------------------------------------------

class TestMain:
    def test_no_command_returns_1(self, capsys):
        """Calling main() with no subcommand should print help and return 1."""
        from clip_cli import main
        with patch("sys.argv", ["clip_cli"]):
            result = main()
        assert result == 1

    def test_extract_missing_file_emits_error_and_returns_1(self, tmp_path, capsys):
        """main() extract command with non-existent file emits error JSON."""
        from clip_cli import main
        missing = str(tmp_path / "nope.mp4")
        with patch("sys.argv", ["clip_cli", "extract", missing, "--mode", "cpu"]):
            with patch("clip_cli.ensure_feature_dependencies"):
                with patch("clip_cli.require_tool", return_value="ffprobe"):
                    result = main()
        assert result == 1
        out = capsys.readouterr().out
        payload = json.loads(out.strip().split("\n")[-1])
        assert payload["type"] == "error"


# ---------------------------------------------------------------------------
# server() — quit command exits cleanly
# ---------------------------------------------------------------------------

class TestServer:
    def test_server_quit_command_returns_0(self, capsys):
        """Sending 'quit' command over stdin to server() must return 0."""
        import io
        from clip_cli import server

        fake_stdin = io.StringIO(json.dumps({"command": "quit"}) + "\n")

        # server() tries to import torch + nelux which aren't available in CI
        # Patch the warmup imports so it gets past them
        torch_mock = MagicMock()
        torch_mock.cuda.is_available.return_value = True
        torch_mock.cuda.get_device_name.return_value = "RTX Test"
        torch_mock.device.return_value = MagicMock()

        nelux_mock = MagicMock()
        transnet_mock = MagicMock()

        with (
            patch.dict("sys.modules", {
                "torch": torch_mock,
                "nelux": nelux_mock,
                "transnetv2_pytorch": transnet_mock,
            }),
            patch("sys.stdin", fake_stdin),
            patch("clip_cli.emit"),
        ):
            result = server()

        assert result == 0

    def test_server_unknown_command_emits_error(self, capsys):
        """An unknown server command must emit {type: error} and continue."""
        import io
        from clip_cli import server

        # Two commands: unknown then quit
        fake_stdin = io.StringIO(
            json.dumps({"command": "frobnicate"}) + "\n" +
            json.dumps({"command": "quit"}) + "\n"
        )

        torch_mock = MagicMock()
        torch_mock.cuda.is_available.return_value = True
        torch_mock.cuda.get_device_name.return_value = "RTX Test"
        nelux_mock = MagicMock()
        transnet_mock = MagicMock()

        emitted = []
        with (
            patch.dict("sys.modules", {
                "torch": torch_mock,
                "nelux": nelux_mock,
                "transnetv2_pytorch": transnet_mock,
            }),
            patch("sys.stdin", fake_stdin),
            patch("clip_cli.emit", side_effect=lambda p: emitted.append(p)),
        ):
            result = server()

        assert result == 0
        error_payloads = [p for p in emitted if p.get("type") == "error"]
        assert len(error_payloads) >= 1
        assert "frobnicate" in error_payloads[0]["message"]
