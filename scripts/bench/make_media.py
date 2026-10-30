"""Build the synthetic test episodes the benchmark kit runs on.

There were no complete anime episodes on the benchmark PC (the only episode
files were unfinished torrent downloads, ~95% zero bytes), so the kit builds
24-minute "episodes" out of short real anime clips:

1. A ~89 s reel is cut into 4-second pieces and shuffled (every join is a hard
   cut, so scenes average ~3-4 s like real anime).
2. The reel is looped to 23.7 minutes with a slow hue drift (so repeats do not
   look identical) and a quiet tone as the audio track.
3. It is encoded three ways with NVENC: 1080p H.264 8-bit (.mp4),
   1080p HEVC 10-bit (.mkv, like BD rips) and 720p H.264 (.mp4).

NVENC is used only to build the files quickly. Real releases are usually x264 /
x265 encodes, which cost about the same to decode per frame at this size.

Idempotent: existing outputs are kept unless --force is given.
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

# The embeddable Python's ._pth file does not put the script folder on sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from bench_env import BenchEnv  # noqa: E402

SOURCES = [
    r"D:\AE project\36. AE replacement\spikes\decode-mf\media\id_master.mkv",
    r"D:\Recordings\Videos\Wallpaper Plus\mahoraga-sukuna.1920x1080.mp4",
    r"D:\Recordings\Videos\Wallpaper Plus\yuji-itadori-rage.1920x1080.mp4",
    r"D:\AE project\36. AE replacement\test-media\jjk_op.mp4",
]

EPISODE_SECONDS = 1422.0  # 23 min 42 s, a typical TV episode
PIECE_SECONDS = 4.0

EPISODES = {
    "ep_h264_1080p": {
        "file": "ep_h264_1080p.mp4",
        "vf": "",
        "video": ["-c:v", "h264_nvenc", "-preset", "p5", "-profile:v", "high", "-pix_fmt", "yuv420p",
                  "-b:v", "6M", "-maxrate", "10M", "-bufsize", "12M", "-bf", "3", "-g", "240"],
    },
    "ep_hevc10_1080p": {
        "file": "ep_hevc10_1080p.mkv",
        "vf": "",
        "video": ["-c:v", "hevc_nvenc", "-preset", "p5", "-profile:v", "main10", "-pix_fmt", "p010le",
                  "-b:v", "4M", "-maxrate", "8M", "-bufsize", "10M", "-bf", "3", "-g", "240"],
    },
    "ep_h264_720p": {
        "file": "ep_h264_720p.mp4",
        "vf": ",scale=1280:720",
        "video": ["-c:v", "h264_nvenc", "-preset", "p5", "-profile:v", "high", "-pix_fmt", "yuv420p",
                  "-b:v", "3M", "-maxrate", "6M", "-bufsize", "8M", "-bf", "3", "-g", "240"],
    },
}


def run(cmd):
    print("+", " ".join(str(c) for c in cmd[:6]), "...", flush=True)
    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode != 0:
        raise SystemExit(f"ffmpeg failed ({result.returncode}):\n{result.stderr[-3000:]}")


def build_reel(env, reel):
    inputs = []
    norm = []
    for index, source in enumerate(SOURCES):
        if not Path(source).exists():
            raise SystemExit(f"Missing source clip: {source}")
        inputs += ["-i", source]
        norm.append(
            f"[{index}:v:0]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,"
            f"fps=24000/1001,format=yuv420p,setsar=1,setpts=PTS-STARTPTS[n{index}]"
        )
    joined = "".join(f"[n{i}]" for i in range(len(SOURCES)))
    graph = ";".join(norm) + f";{joined}concat=n={len(SOURCES)}:v=1:a=0[cat]"
    tmp = reel.with_suffix(".cat.mkv")
    run([env.ffmpeg, "-y", "-hide_banner", "-loglevel", "error", *inputs, "-filter_complex", graph,
         "-map", "[cat]", "-c:v", "h264_nvenc", "-preset", "p6", "-qp", "14", "-g", "24", "-bf", "0", str(tmp)])

    # Shuffle 4-second pieces so every join is a hard cut.
    probe = subprocess.run([env.ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "json", str(tmp)],
                           capture_output=True, text=True)
    total = float(json.loads(probe.stdout)["format"]["duration"])
    pieces = int(total // PIECE_SECONDS)
    order = [(i * 7) % pieces for i in range(pieces)]  # fixed permutation (7 is coprime with typical piece counts)
    if len(set(order)) != pieces:
        order = list(range(pieces))[::-1]
    parts = []
    for out_index, piece in enumerate(order):
        start = piece * PIECE_SECONDS
        parts.append(f"[0:v]trim=start={start:.3f}:duration={PIECE_SECONDS:.3f},setpts=PTS-STARTPTS[p{out_index}]")
    graph = ";".join(parts) + ";" + "".join(f"[p{i}]" for i in range(pieces)) + f"concat=n={pieces}:v=1:a=0[out]"
    run([env.ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", str(tmp), "-filter_complex", graph,
         "-map", "[out]", "-c:v", "h264_nvenc", "-preset", "p6", "-qp", "14", "-g", "24", "-bf", "0", str(reel)])
    tmp.unlink(missing_ok=True)


def build_episode(env, reel, spec, output):
    vf = "hue=H=2*PI*t/97" + spec["vf"]
    run([env.ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
         "-stream_loop", "-1", "-i", str(reel),
         "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000,volume=0.05",
         "-t", f"{EPISODE_SECONDS:.3f}", "-map", "0:v:0", "-map", "1:a:0",
         "-vf", vf, *spec["video"], "-c:a", "aac", "-b:a", "128k", "-ac", "2", str(output)])


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    env = BenchEnv.load()
    env.media_dir.mkdir(parents=True, exist_ok=True)
    reel = env.media_dir / "reel_shuffled.mkv"
    if args.force or not reel.exists():
        build_reel(env, reel)
    for name, spec in EPISODES.items():
        output = env.media_dir / spec["file"]
        if args.force or not output.exists():
            print(f"building {name} -> {output}", flush=True)
            build_episode(env, reel, spec, output)
        else:
            print(f"keeping {output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
