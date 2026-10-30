"""Scroll-smoothness benchmark for the default preview grid, in real Edge.

    python -X utf8 scripts/bench/grid_bench.py --tag baseline [--repeats 3] [--headless]

Loads grid_harness.html (a stand-in for the featherweight grid, see the comment
at its top) in Microsoft Edge through Playwright, mounts live <video> tiles on
the episode's 240p proxy for the detected scenes, scrolls the grid, and records:
- every animation-frame interval during the scroll (jank = frames over 50 ms),
- how long a newly mounted tile takes to show its first video frame.

Needs Playwright in the bench-only folder runtime\\benchlib (see README). Uses
the installed Edge, no browser download. Runs headed by default because a
headless browser may skip GPU video decode and compositing.
"""

import argparse
import datetime as dt
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bench_env import BenchEnv  # noqa: E402
import bench  # noqa: E402


def frame_stats(intervals):
    data = sorted(intervals[1:])  # first interval includes setup
    return {
        "frames": len(data),
        "p50_ms": round(bench.pct(data, 0.5), 2),
        "p90_ms": round(bench.pct(data, 0.9), 2),
        "p99_ms": round(bench.pct(data, 0.99), 2),
        "max_ms": round(max(data), 1),
        "over50": sum(1 for v in data if v > 50),
        "over33": sum(1 for v in data if v > 33.4),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tag", required=True)
    parser.add_argument("--media", default="h264_1080p")
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--allow-busy", action="store_true")
    args = parser.parse_args()

    env = BenchEnv.load()
    sys.path.insert(0, str(env.root / "runtime" / "benchlib"))
    from playwright.sync_api import sync_playwright

    others = bench.machine_quiet_or_exit(args.allow_busy)
    proxy = env.out_dir / "previews" / f"{args.media}.proxy.nvenc.mp4"
    if not proxy.exists():
        proxy.parent.mkdir(parents=True, exist_ok=True)
        bench.timed(bench.proxy_args(env, env.media_dir / bench.MEDIA[args.media], proxy, "nvenc"), timeout=1200)
    candidates = sorted(env.boundaries_dir.glob(f"*/*/{args.media}.gpu.*.json"))
    if not candidates:
        raise SystemExit("no boundary file for this media yet; run bench.py --only detect first")
    data = json.loads(candidates[-1].read_text(encoding="utf-8"))
    cuts = [0.0, *data["cuts"], data["duration"]]
    scenes = [[cuts[i], cuts[i + 1]] for i in range(len(cuts) - 1)]

    run_id = dt.datetime.now().strftime("%Y%m%d-%H%M%S") + "-grid"
    rec = bench.Recorder(env, args.tag, "grid", run_id)
    rec.record("meta.other_heavy_processes_at_start", "-", len(others), unit="count")
    results = {"wheel": [], "fling": []}
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="msedge", headless=args.headless,
                                     args=["--autoplay-policy=no-user-gesture-required", "--window-position=0,0"])
        for repeat in range(args.repeats):
            for mode, speed in (("wheel", 800), ("fling", 3000)):
                page = browser.new_page(viewport={"width": 1366, "height": 860})
                page.goto((Path(__file__).resolve().parent / "grid_harness.html").as_uri())
                result = page.evaluate("cfg => window.runGrid(cfg)", {
                    "src": proxy.as_uri(), "scenes": scenes, "fps": data.get("fps") or 23.976,
                    "scrollPxPerSecond": speed, "durationMs": 20000, "mode": mode})
                page.close()
                results[mode].append(result)
                stats = frame_stats(result["intervals"])
                print(f"  repeat {repeat} {mode}: {stats} mounts={result['mountCount']} maxLive={result['maxLive']}",
                      flush=True)
        browser.close()

    for mode, runs in results.items():
        per_run = [frame_stats(r["intervals"]) for r in runs]
        rec.record(f"grid.{mode}.frame_p90", args.media, [s["p90_ms"] for s in per_run], unit="ms")
        rec.record(f"grid.{mode}.frame_p99", args.media, [s["p99_ms"] for s in per_run], unit="ms")
        rec.record(f"grid.{mode}.frame_max", args.media, [s["max_ms"] for s in per_run], unit="ms")
        rec.record(f"grid.{mode}.frames_over_50ms", args.media, [s["over50"] for s in per_run], unit="count",
                   extra={"frames": [s["frames"] for s in per_run]})
        first = [v for r in runs for v in r["firstFrameMs"]]
        rec.record(f"grid.{mode}.tile_first_frame", args.media, first, unit="ms",
                   extra={"mounts": [r["mountCount"] for r in runs], "maxLive": [r["maxLive"] for r in runs]})
    settle = [v for runs in results.values() for r in runs for v in r["settleFirstFrames"]]
    rec.record("grid.initial_screen_first_frame", args.media, settle, unit="ms")
    return 0


if __name__ == "__main__":
    sys.exit(main())
