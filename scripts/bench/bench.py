"""Ultimate AMV optimization benchmark kit (Scene Splitter detection + grid previews).

One command:

    <bench python> -X utf8 scripts/bench/bench.py --tag baseline --mode quick

See scripts/bench/README.md for what each metric means and how to read it.
Results are appended as JSON lines to the run's bench-results.jsonl; the scene
boundary lists of every detection run are saved next to it so a later run can
be diffed for identical output (diff_boundaries.py).
"""

import argparse
import datetime as dt
import json
import os
import platform
import random
import statistics
import subprocess
import sys
import threading
import time
from pathlib import Path

# The embeddable Python's ._pth file does not put the script folder on sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from bench_env import BenchEnv  # noqa: E402

BUSY_FLAG = Path(r"C:\Users\PC\amv-optimize-machine-busy.txt")

MEDIA = {
    "h264_1080p": "ep_h264_1080p.mp4",
    "hevc10_1080p": "ep_hevc10_1080p.mkv",
    "h264_720p": "ep_h264_720p.mp4",
}

# The exact payload src-tauri/src/clips.rs (clip_extract) sends to the server.
SERVER_PAYLOAD = {
    "command": "extract",
    "threshold": 0.5,
    "cpu_threshold": 27.0,
    "min_clip_seconds": 0.35,
    "batch_frames": 100,
    "overlap": 50,
}

DETECT_TIMEOUT_S = 1200
PREVIEW_TIMEOUT_S = 600


# ---------------------------------------------------------------- statistics

def pct(values, q):
    data = sorted(values)
    if not data:
        return None
    if len(data) == 1:
        return data[0]
    pos = (len(data) - 1) * q
    low = int(pos)
    high = min(low + 1, len(data) - 1)
    return data[low] + (data[high] - data[low]) * (pos - low)


def summarize(values):
    values = [v for v in values if v is not None]
    if not values:
        return {"n": 0}
    return {
        "n": len(values),
        "median": round(statistics.median(values), 3),
        "p10": round(pct(values, 0.10), 3),
        "p90": round(pct(values, 0.90), 3),
        "min": round(min(values), 3),
        "max": round(max(values), 3),
        "values": [round(v, 3) for v in values],
    }


# ---------------------------------------------------------------- recording

class Recorder:
    def __init__(self, env, tag, mode, run_id):
        self.env = env
        self.tag = tag
        self.mode = mode
        self.run_id = run_id
        self.commit = env.git_commit()
        self.lines = []

    def record(self, metric, media, values, unit="s", extra=None):
        line = {
            "ts": dt.datetime.now().isoformat(timespec="seconds"),
            "tag": self.tag,
            "run": self.run_id,
            "commit": self.commit,
            "mode": self.mode,
            "host": platform.node(),
            "metric": metric,
            "media": media,
            "unit": unit,
            **summarize(values if isinstance(values, list) else [values]),
        }
        if extra:
            line["extra"] = extra
        self.env.results_file.parent.mkdir(parents=True, exist_ok=True)
        with open(self.env.results_file, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(line) + "\n")
        self.lines.append(line)
        med = line.get("median")
        print(f"  {metric:<44} {media:<14} median={med} p10={line.get('p10')} p90={line.get('p90')} n={line.get('n')} {unit}", flush=True)


# ---------------------------------------------------------------- machine state

def busy_processes():
    """Other heavy processes (ffmpeg/python/cargo/rustc) currently using CPU."""
    script = (
        "Get-Process ffmpeg,python,cargo,rustc,x264,x265 -ErrorAction SilentlyContinue | "
        "Select-Object Id,ProcessName,CPU | ConvertTo-Json -Compress"
    )
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-Command", script], capture_output=True, text=True,
                             timeout=30).stdout.strip()
        data = json.loads(out) if out else []
        return data if isinstance(data, list) else [data]
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return []


def machine_quiet_or_exit(allow_busy):
    if BUSY_FLAG.exists() and not allow_busy:
        raise SystemExit(f"Machine busy flag present ({BUSY_FLAG}); refusing to time. Use --allow-busy to override.")
    others = [p for p in busy_processes() if p.get("Id") != os.getpid()]
    if others:
        print(f"WARNING: other ffmpeg/python/cargo processes are running: {others}", flush=True)
    return others


def gpu_name():
    try:
        return subprocess.run(["nvidia-smi", "--query-gpu=name,driver_version", "--format=csv,noheader"],
                              capture_output=True, text=True, timeout=20).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return "none"


# ---------------------------------------------------------------- detection

def _read_events(process, sink, t0):
    for raw in process.stdout:
        line = raw.strip()
        if not line:
            continue
        now = time.perf_counter() - t0
        try:
            event = json.loads(line)
        except ValueError:
            event = {"type": "text", "message": line}
        sink.append((now, event))


def stage_split(events, t_end):
    """Wall-clock stage split from the progress events' arrival times."""
    def first(pred):
        for at, ev in events:
            if pred(ev):
                return at
        return None

    progress = lambda stage: (lambda ev: ev.get("type") == "progress" and ev.get("stage") == stage)
    t_first = events[0][0] if events else None
    t_decode = first(progress("decode"))
    t_analyze = first(progress("analyze"))
    t_scenes = first(progress("scenes"))
    t_done = first(lambda ev: ev.get("type") == "done") or t_end
    split = {
        "startup_s": t_first,
        "pre_decode_s": (t_decode - t_first) if (t_decode is not None and t_first is not None) else None,
        "decode_s": (t_analyze - t_decode) if (t_analyze is not None and t_decode is not None) else None,
        "analyze_s": (t_scenes - t_analyze) if (t_scenes is not None and t_analyze is not None) else None,
        "finish_s": (t_done - t_scenes) if (t_scenes is not None) else None,
    }
    return split


def save_boundaries(env, rec, media_key, mode, done, label):
    target = env.boundaries_dir / rec.tag / rec.run_id
    target.mkdir(parents=True, exist_ok=True)
    payload = {
        "media": media_key,
        "mode": mode,
        "commit": rec.commit,
        "sceneCount": done.get("sceneCount"),
        "fps": done.get("fps"),
        "duration": done.get("duration"),
        "cuts": done.get("cuts"),
    }
    path = target / f"{media_key}.{mode}.{label}.json"
    path.write_text(json.dumps(payload, indent=1), encoding="utf-8")
    return path


def detect_one_shot(env, media_path, mode):
    """Exactly what clips.rs run_streaming_clip_cli does: one python process per episode."""
    cmd = [str(env.python), "-I", str(env.repo_root / "backend" / "clip_cli.py"), "extract", str(media_path),
           "--mode", mode]
    events = []
    t0 = time.perf_counter()
    process = subprocess.Popen(cmd, cwd=str(env.repo_root), env=env.sidecar_env(force_cpu=(mode == "cpu")),
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
                               errors="replace")
    reader = threading.Thread(target=_read_events, args=(process, events, t0), daemon=True)
    reader.start()
    stderr_chunks = []
    err_reader = threading.Thread(target=lambda: stderr_chunks.append(process.stderr.read()), daemon=True)
    err_reader.start()
    try:
        process.wait(timeout=DETECT_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
        raise RuntimeError(f"detection timed out after {DETECT_TIMEOUT_S}s on {media_path}")
    reader.join(timeout=10)
    err_reader.join(timeout=10)
    wall = time.perf_counter() - t0
    done = next((ev for _at, ev in events if ev.get("type") == "done"), None)
    if done is None:
        errors = [ev for _at, ev in events if ev.get("type") == "error"]
        raise RuntimeError(f"detection failed: {errors} {''.join(stderr_chunks)[-2000:]}")
    logs = [ev.get("message") for _at, ev in events if ev.get("type") == "log"]
    return wall, stage_split(events, wall), done, logs


class ClipServer:
    """clip_cli.py --server, driven the way clips.rs drives it."""

    def __init__(self, env):
        self.env = env
        self.events = []
        self.t0 = time.perf_counter()
        self.process = subprocess.Popen(
            [str(env.python), "-I", str(env.repo_root / "backend" / "clip_cli.py"), "--server"],
            cwd=str(env.repo_root), env=env.sidecar_env(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, encoding="utf-8", errors="replace")
        self.cond = threading.Condition()
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        for raw in self.process.stdout:
            line = raw.strip()
            if not line:
                continue
            now = time.perf_counter() - self.t0
            if line == "READY":
                event = {"type": "ready"}
            else:
                try:
                    event = json.loads(line)
                except ValueError:
                    event = {"type": "text", "message": line}
            with self.cond:
                self.events.append((now, event))
                self.cond.notify_all()
        with self.cond:
            self.events.append((time.perf_counter() - self.t0, {"type": "eof"}))
            self.cond.notify_all()

    def wait_for(self, kinds, start_index, timeout):
        deadline = time.perf_counter() + timeout
        with self.cond:
            while True:
                for index in range(start_index, len(self.events)):
                    at, ev = self.events[index]
                    if ev.get("type") in kinds:
                        return index, at, ev
                left = deadline - time.perf_counter()
                if left <= 0:
                    raise RuntimeError(f"clip server: timed out waiting for {kinds}")
                self.cond.wait(left)

    def warmup(self):
        _i, at, ev = self.wait_for({"ready", "error", "eof"}, 0, 300)
        if ev.get("type") != "ready":
            raise RuntimeError(f"clip server failed to warm up: {ev}")
        return at

    def extract(self, media_path, mode="gpu"):
        start_index = len(self.events)
        sent = time.perf_counter() - self.t0
        payload = dict(SERVER_PAYLOAD, input_file=str(media_path), mode=mode)
        self.process.stdin.write(json.dumps(payload) + "\n")
        self.process.stdin.flush()
        index, at, ev = self.wait_for({"done", "error", "eof"}, start_index, DETECT_TIMEOUT_S)
        if ev.get("type") != "done":
            raise RuntimeError(f"server extract failed: {ev}")
        window = [(t - sent, e) for t, e in self.events[start_index:index + 1]]
        return at - sent, stage_split(window, at - sent), ev

    def close(self):
        try:
            self.process.stdin.write(json.dumps({"command": "quit"}) + "\n")
            self.process.stdin.flush()
            self.process.wait(timeout=20)
        except (OSError, subprocess.TimeoutExpired, ValueError):
            self.process.kill()
            self.process.wait()


def bench_detection_single(env, rec, media_keys, modes, repeats):
    for mode in modes:
        for key in media_keys:
            media = env.media_dir / MEDIA[key]
            walls, splits, inner = [], [], []
            last = None
            for _ in range(repeats):
                wall, split, done, logs = detect_one_shot(env, media, mode)
                walls.append(wall)
                splits.append(split)
                inner.append(done.get("totalSeconds"))
                last = (done, logs)
            done, logs = last
            path = save_boundaries(env, rec, key, mode, done, "oneshot")
            extra = {"scenes": done.get("sceneCount"), "boundaries": str(path),
                     "logs": [m for m in logs if m][:5]}
            rec.record(f"detect.{mode}.oneshot.wall", key, walls, extra=extra)
            for stage in ("startup_s", "pre_decode_s", "decode_s", "analyze_s", "finish_s"):
                rec.record(f"detect.{mode}.oneshot.{stage[:-2]}", key, [s[stage] for s in splits])
            rec.record(f"detect.{mode}.oneshot.inner_total", key, inner)


def bench_detection_batch_cpu(env, rec, media_keys, count):
    order = [media_keys[i % len(media_keys)] for i in range(count)]
    t0 = time.perf_counter()
    per = []
    for key in order:
        wall, _split, _done, _logs = detect_one_shot(env, env.media_dir / MEDIA[key], "cpu")
        per.append(wall)
    total = time.perf_counter() - t0
    rec.record(f"detect.cpu.batch{count}.total", "+".join(sorted(set(order))), total,
               extra={"order": order, "per_episode": [round(v, 2) for v in per]})
    rec.record(f"detect.cpu.batch{count}.per_episode", "mixed", per)


def bench_detection_batch_gpu(env, rec, media_keys, count):
    order = [media_keys[i % len(media_keys)] for i in range(count)]
    server = ClipServer(env)
    try:
        warm = server.warmup()
        per, splits = [], []
        t0 = time.perf_counter()
        for index, key in enumerate(order):
            wall, split, done = server.extract(env.media_dir / MEDIA[key], "gpu")
            per.append(wall)
            splits.append(split)
            if index < len(media_keys):
                save_boundaries(env, rec, key, "gpu", done, "server")
        total = time.perf_counter() - t0
    finally:
        server.close()
    rec.record("detect.gpu.server.warmup", "-", warm)
    rec.record(f"detect.gpu.batch{count}.total_after_warm", "+".join(sorted(set(order))), total,
               extra={"order": order, "per_episode": [round(v, 2) for v in per]})
    rec.record(f"detect.gpu.batch{count}.per_episode", "mixed", per)
    for stage in ("pre_decode_s", "decode_s", "analyze_s", "finish_s"):
        rec.record(f"detect.gpu.batch{count}.{stage[:-2]}", "mixed", [s[stage] for s in splits])


def bench_decode_floor(env, rec, media_keys, repeats):
    """How fast can ffmpeg alone produce the 48x27 detection frames? (the decode ceiling)"""
    variants = {
        # What decode_frames_cpu pipes, discarded instead of piped.
        "cpu_sw_scale48": ["-i", "{in}", "-an", "-vf", "scale=48:27,format=rgb24", "-f", "null", "-"],
        # Hardware decode + GPU resize (what decode_frames_nvdec does).
        "nvdec_scale_cuda48": ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda", "-i", "{in}", "-an", "-vf",
                               "scale_cuda=48:27:format=nv12,hwdownload,format=nv12,format=rgb24", "-f", "null", "-"],
    }
    for key in media_keys:
        media = str(env.media_dir / MEDIA[key])
        for name, args in variants.items():
            times = []
            for _ in range(repeats):
                cmd = [env.ffmpeg, "-hide_banner", "-loglevel", "error", *[a.replace("{in}", media) for a in args]]
                t0 = time.perf_counter()
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=DETECT_TIMEOUT_S)
                if result.returncode != 0:
                    times.append(None)
                    print(f"    {name} failed: {result.stderr[-300:]}")
                    continue
                times.append(time.perf_counter() - t0)
            rec.record(f"decode_floor.{name}", key, times)


# ---------------------------------------------------------------- previews

def probe_json(env, path, entries):
    out = subprocess.run([env.ffprobe, "-v", "error", "-show_entries", entries, "-of", "json", str(path)],
                         capture_output=True, text=True, timeout=120).stdout
    return json.loads(out or "{}")


def proxy_args(env, source, output, encoder, height=240):
    """Mirror of clips.rs run_source_proxy_job (untagged source -> bt709 setparams)."""
    setparams = "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv"
    args = [env.ffmpeg, "-y", "-hide_banner", "-nostdin", "-loglevel", "error"]
    if encoder == "nvenc":
        args += ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"]
    else:
        args += ["-hwaccel", "auto"]
    args += ["-i", str(source), "-map", "0:v:0", "-map", "0:a:0?", "-vf"]
    if encoder == "nvenc":
        args += [f"{setparams},scale_cuda=-2:'min({height},ih)':format=yuv420p",
                 "-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "30", "-g", "12",
                 "-no-scenecut", "1", "-forced-idr", "1", "-bf", "0"]
    else:
        args += [f"scale=-2:'min({height},ih)',{setparams}",
                 "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-g", "12", "-keyint_min", "12",
                 "-sc_threshold", "0", "-bf", "0", "-pix_fmt", "yuv420p"]
    args += ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
             "-c:a", "aac", "-b:a", "96k", "-ac", "2", "-movflags", "+faststart", str(output)]
    return args


def webp_args(env, source, output, start, duration):
    """Mirror of preview.rs run_preview_ffmpeg (use_gpu is hard-coded false there)."""
    return [env.ffmpeg, "-y", "-hide_banner", "-nostdin", "-loglevel", "error", "-ss", f"{max(0.0, start):.3f}",
            "-i", str(source), "-t", f"{duration:.3f}", "-an", "-sn", "-dn", "-vf",
            "fps=12,scale=426:240:force_original_aspect_ratio=increase,crop=426:240",
            "-vcodec", "libwebp", "-threads", "2", "-lossless", "0", "-q:v", "80", "-loop", "0", str(output)]


def timed(cmd, timeout=PREVIEW_TIMEOUT_S):
    t0 = time.perf_counter()
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    elapsed = time.perf_counter() - t0
    if result.returncode != 0:
        raise RuntimeError(f"command failed: {' '.join(cmd[:8])} ... {result.stderr[-500:]}")
    return elapsed


def scene_windows(env, media_key, count, seed=7):
    """Real detected scenes if a boundary file exists, else 3 s windows spread over the episode."""
    candidates = sorted(env.boundaries_dir.glob(f"*/*/{media_key}.gpu.*.json"))
    rng = random.Random(seed)
    if candidates:
        data = json.loads(candidates[-1].read_text(encoding="utf-8"))
        cuts = [0.0, *data["cuts"], data["duration"]]
        scenes = [(cuts[i], cuts[i + 1]) for i in range(len(cuts) - 1) if cuts[i + 1] - cuts[i] > 0.5]
        rng.shuffle(scenes)
        return scenes[:count]
    return [(t, t + 3.0) for t in sorted(rng.uniform(30, 1380) for _ in range(count))]


def bench_previews(env, rec, media_keys, repeats, tiles):
    out = env.out_dir / "previews"
    out.mkdir(parents=True, exist_ok=True)
    for key in media_keys:
        source = env.media_dir / MEDIA[key]
        # 1) Featherweight grid (the default): a whole-episode 240p proxy must exist before
        #    tiles for a non-friendly / taller-than-240p source can play.
        for encoder in ("nvenc", "x264"):
            times = []
            proxy = out / f"{key}.proxy.{encoder}.mp4"
            for _ in range(repeats):
                proxy.unlink(missing_ok=True)
                times.append(timed(proxy_args(env, source, proxy, encoder), timeout=PREVIEW_TIMEOUT_S * 2))
            info = probe_json(env, proxy, "format=size,bit_rate,duration:stream=codec_name,width,height")
            fmt = info.get("format", {})
            rec.record(f"preview.proxy_build.{encoder}", key, times,
                       extra={"size_mb": round(int(fmt.get("size", 0)) / 1e6, 1),
                              "kbps": round(int(fmt.get("bit_rate", 0)) / 1000)})
        proxy = out / f"{key}.proxy.nvenc.mp4"
        # 2) What a newly mounted <video> tile must decode before its first frame: seek + decode
        #    one frame, on the proxy (featherweight) vs the original file (direct play).
        scenes = scene_windows(env, key, tiles)
        for label, target in (("proxy240", proxy), ("source", source)):
            times = []
            for start, _end in scenes:
                cmd = [env.ffmpeg, "-hide_banner", "-loglevel", "error", "-ss", f"{start:.3f}", "-i", str(target),
                       "-an", "-frames:v", "1", "-f", "null", "-"]
                times.append(timed(cmd))
            rec.record(f"preview.first_frame_seek.{label}", key, times)
        # 3) Legacy animated-WebP tile (featherweight_previews=false), one tile and a screenful
        #    rendered the way preview.rs batches them (2 ffmpeg at a time).
        tile_times = []
        for index, (start, end) in enumerate(scenes[:max(3, repeats)]):
            target = out / f"{key}.tile{index}.webp"
            tile_times.append(timed(webp_args(env, source, target, start, max(0.18, min(end - start, 6.0) - 0.08))))
        rec.record("preview.webp_tile", key, tile_times)
        t0 = time.perf_counter()
        for chunk_start in range(0, len(scenes), 2):
            chunk = scenes[chunk_start:chunk_start + 2]
            procs = []
            for index, (start, end) in enumerate(chunk):
                target = out / f"{key}.screen{chunk_start + index}.webp"
                procs.append(subprocess.Popen(webp_args(env, source, target, start,
                                                        max(0.18, min(end - start, 6.0) - 0.08)),
                                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
            for proc in procs:
                proc.wait(timeout=PREVIEW_TIMEOUT_S)
        rec.record(f"preview.webp_screenful{len(scenes)}", key, time.perf_counter() - t0)
        sizes = [p.stat().st_size / 1e3 for p in out.glob(f"{key}.screen*.webp")]
        rec.record("preview.webp_tile_size", key, sizes, unit="kB")


# ---------------------------------------------------------------- main

def main():
    parser = argparse.ArgumentParser(description="Ultimate AMV detection + preview benchmark")
    parser.add_argument("--tag", required=True, help="label stored with every result line, e.g. baseline")
    parser.add_argument("--mode", choices=["quick", "full"], default="quick")
    parser.add_argument("--only", choices=["detect", "batch", "decode", "preview"], action="append",
                        help="run only these sections (repeatable)")
    parser.add_argument("--repeats", type=int, default=None)
    parser.add_argument("--allow-busy", action="store_true", help="time even if the busy flag exists")
    args = parser.parse_args()

    env = BenchEnv.load()
    for required in (env.python, Path(env.ffmpeg), Path(env.ffprobe)):
        if not Path(required).exists():
            raise SystemExit(f"missing {required}; see scripts/bench/README.md setup")
    missing = [name for name in MEDIA.values() if not (env.media_dir / name).exists()]
    if missing:
        raise SystemExit(f"missing test media {missing}; run make_media.py first")

    others = machine_quiet_or_exit(args.allow_busy)
    run_id = dt.datetime.now().strftime("%Y%m%d-%H%M%S") + f"-{args.mode}"
    rec = Recorder(env, args.tag, args.mode, run_id)
    sections = set(args.only or ["detect", "batch", "decode", "preview"])
    quick = args.mode == "quick"
    repeats = args.repeats or (1 if quick else 3)
    print(f"run {run_id} tag={args.tag} commit={rec.commit} gpu={gpu_name()} sections={sorted(sections)}", flush=True)
    rec.record("meta.other_heavy_processes_at_start", "-", len(others), unit="count",
               extra={"processes": others[:10], "gpu": gpu_name()})

    t_all = time.perf_counter()
    if "detect" in sections:
        keys = ["h264_1080p"] if quick else list(MEDIA)
        bench_detection_single(env, rec, keys, ["gpu", "cpu"], repeats)
        if quick:
            bench_detection_single(env, rec, ["hevc10_1080p"], ["gpu"], repeats)
    if "batch" in sections:
        keys = list(MEDIA)
        bench_detection_batch_gpu(env, rec, keys, 3 if quick else 12)
        if not quick:
            bench_detection_batch_cpu(env, rec, keys, 3)
    if "decode" in sections:
        bench_decode_floor(env, rec, ["h264_1080p"] if quick else list(MEDIA), repeats)
    if "preview" in sections:
        bench_previews(env, rec, ["h264_1080p"] if quick else ["h264_1080p", "hevc10_1080p"], repeats,
                       12)
    rec.record("meta.bench_wall", "-", time.perf_counter() - t_all)
    print(f"done; results appended to {env.results_file}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
