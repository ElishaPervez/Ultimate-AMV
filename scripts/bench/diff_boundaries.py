"""Compare scene boundary lists saved by bench.py between two runs.

    python -X utf8 scripts/bench/diff_boundaries.py <run dir A> <run dir B>

A run dir is <boundaries>\\<tag>\\<run id>\\ holding <media>.<mode>.<label>.json.
Files are matched by media + mode (the label oneshot/server is ignored, both
paths must give the same cuts). Exit code 0 = identical everywhere, 1 = any
difference (each one printed with the cut times that moved, appeared or vanished).
"""

import json
import sys
from pathlib import Path

TOLERANCE = 1e-6  # cuts are frame_index / fps, so identical frames give identical floats


def load(run_dir):
    found = {}
    for path in sorted(Path(run_dir).glob("*.json")):
        media, mode = path.name.split(".")[:2]
        found.setdefault((media, mode), json.loads(path.read_text(encoding="utf-8")))
    return found


def compare(a_cuts, b_cuts):
    only_a = [c for c in a_cuts if not any(abs(c - d) <= TOLERANCE for d in b_cuts)]
    only_b = [c for c in b_cuts if not any(abs(c - d) <= TOLERANCE for d in a_cuts)]
    return only_a, only_b


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    a, b = load(sys.argv[1]), load(sys.argv[2])
    status = 0
    for key in sorted(set(a) | set(b)):
        if key not in a or key not in b:
            print(f"{key}: only in {'A' if key in a else 'B'}")
            continue
        only_a, only_b = compare(a[key]["cuts"], b[key]["cuts"])
        if only_a or only_b:
            status = 1
            print(f"{key}: DIFFERENT  A={len(a[key]['cuts'])} cuts  B={len(b[key]['cuts'])} cuts")
            print(f"   only in A: {[round(c, 3) for c in only_a][:40]}")
            print(f"   only in B: {[round(c, 3) for c in only_b][:40]}")
        else:
            print(f"{key}: identical ({len(a[key]['cuts'])} cuts)")
    return status


if __name__ == "__main__":
    sys.exit(main())
