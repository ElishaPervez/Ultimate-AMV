"""Paths shared by every benchmark script.

Everything heavy lives in a scratch folder OUTSIDE the repo (default
C:\\tmp\\amv-optimize-bench, override with AMV_BENCH_ROOT):

  runtime\\python\\python.exe   embeddable Python 3.13.2 with the app's pinned
                               clip stack (torch 2.11.0 cu128, nelux 0.11.0,
                               transnetv2-pytorch, scenedetect <0.8, numpy 2.4.4)
  runtime\\tools\\              ffmpeg/ffprobe 8.1.1 + ffmpeg-shared DLLs, the
                               same layout the app's tools gate downloads
  media\\                       synthetic test episodes (make_media.py)
  out\\                         per-run scratch output (proxies, previews, logs)

ULTIMATE_AMV_TOOLS_DIR is honoured first, exactly like the app.
"""

import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ROOT = Path(r"C:\tmp\amv-optimize-bench")
DEFAULT_RESULTS = Path(r"C:\projects (code)\13. Ultimate AMV script\docs\optimize-2026-10-30\bench-results.jsonl")
DEFAULT_BOUNDARIES = Path(r"C:\projects (code)\13. Ultimate AMV script\docs\optimize-2026-10-30\boundaries")


@dataclass
class BenchEnv:
    root: Path
    python: Path
    tools_dir: Path
    ffmpeg: str
    ffprobe: str
    media_dir: Path
    out_dir: Path
    results_file: Path
    boundaries_dir: Path
    repo_root: Path

    @classmethod
    def load(cls):
        root = Path(os.environ.get("AMV_BENCH_ROOT") or DEFAULT_ROOT)
        tools = os.environ.get("ULTIMATE_AMV_TOOLS_DIR")
        tools_dir = Path(tools) if tools else root / "runtime" / "tools"
        return cls(
            root=root,
            python=Path(os.environ.get("AMV_BENCH_PYTHON") or root / "runtime" / "python" / "python.exe"),
            tools_dir=tools_dir,
            ffmpeg=str(tools_dir / "ffmpeg.exe"),
            ffprobe=str(tools_dir / "ffprobe.exe"),
            media_dir=root / "media",
            out_dir=root / "out",
            results_file=Path(os.environ.get("AMV_BENCH_RESULTS") or DEFAULT_RESULTS),
            boundaries_dir=Path(os.environ.get("AMV_BENCH_BOUNDARIES") or DEFAULT_BOUNDARIES),
            repo_root=REPO_ROOT,
        )

    def sidecar_env(self, force_cpu=False):
        """Environment the Rust shell gives a Python sidecar, pointed at scratch."""
        env = dict(os.environ)
        env["ULTIMATE_AMV_TOOLS_DIR"] = str(self.tools_dir)
        env["ULTIMATE_AMV_STATE_DIR"] = str(self.out_dir / "state")
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUTF8"] = "1"
        if force_cpu:
            # CPU mode must not touch the GPU at all.
            env["CUDA_VISIBLE_DEVICES"] = "-1"
        return env

    def git_commit(self):
        try:
            head = subprocess.run(["git", "-C", str(self.repo_root), "rev-parse", "--short", "HEAD"],
                                  capture_output=True, text=True).stdout.strip()
            dirty = subprocess.run(["git", "-C", str(self.repo_root), "status", "--porcelain", "--untracked-files=no"],
                                   capture_output=True, text=True).stdout.strip()
            return head + ("-dirty" if dirty else "")
        except OSError:
            return "unknown"
