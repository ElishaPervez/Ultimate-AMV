"""Scroll / hover benchmark of the REAL Scene Splitter grid (React panel), in Edge.

    python -X utf8 scripts/bench/grid_app_bench.py --tag w6-ab --variants off,on --repeats 3
    python -X utf8 scripts/bench/grid_app_bench.py --tag w6-prof --dist prof --variants off,on

Unlike grid_bench.py (a plain-DOM stand-in), this loads the production build of
the app's own ClipExtractorPanel (scripts/bench/grid-app, built with
`npx vite build --config scripts/bench/grid-app/vite.config.ts`) with the Tauri
backend mocked: a real 501-scene list and the real 240p preview file. Per run
it loads N episodes (all scenes in one grid, like a batch), then:
- scrolls the grid steadily (800 px/s, a wheel-like pace) and fast (3000 px/s),
- hovers 24 tiles one after another and toggles selection on 12,
recording every animation-frame interval, long tasks, live <video> count, DOM
tile count, JS heap, and (with --dist prof, React's profiling build) every
React commit with its render time.

Variants are the grid A/B switches in src/dev/gridPerfSwitches.ts: `off` turns
every switch off (old behaviour), `on` leaves them on (new behaviour), or name
switches like `on-memoTiles` (all on except memoTiles). Runs are interleaved
(A B A B ...) so background noise hits both sides.
"""

import argparse
import datetime as dt
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bench_env import BenchEnv  # noqa: E402
import bench  # noqa: E402

SWITCHES = ["quietDiagnostics", "memoTiles"]

SCROLL_JS = r"""
async (cfg) => {
  const scroller = document.querySelector('.clip-preview-grid-scroller');
  if (!scroller) throw new Error('no scroller');
  const commits = window.__gridCommits || [];
  const commitStart = commits.length;
  const longTasks = [];
  const obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) longTasks.push(e.duration); });
  try { obs.observe({ type: 'longtask', buffered: false }); } catch (e) {}
  const intervals = [];
  const samples = [];
  let last = performance.now();
  const t0 = last;
  let lastSample = 0;
  const maxTop = scroller.scrollHeight - scroller.clientHeight;
  let pos = scroller.scrollTop;
  await new Promise((resolve) => {
    function step(now) {
      const dtMs = now - last;
      intervals.push(dtMs);
      last = now;
      pos = Math.min(maxTop, pos + cfg.pxPerSecond * dtMs / 1000);
      scroller.scrollTop = pos;
      if (now - lastSample > 250) {
        lastSample = now;
        const vids = Array.from(document.querySelectorAll('video'));
        samples.push({
          t: now - t0,
          tiles: document.querySelectorAll('.clip-preview-tile-wrapper').length,
          videos: vids.filter((v) => v.getAttribute('src')).length,
          playing: vids.filter((v) => !v.paused && v.readyState >= 2).length,
          heapMB: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null,
        });
      }
      if (now - t0 < cfg.durationMs && pos < maxTop) requestAnimationFrame(step);
      else resolve();
    }
    requestAnimationFrame(step);
  });
  obs.disconnect();
  const c = commits.slice(commitStart);
  return {
    intervals, samples, longTasks,
    scrolledPx: pos, maxTop, elapsedMs: performance.now() - t0,
    commits: c.length, commitMs: c.map((x) => x.actualMs),
  };
}
"""

REC_START_JS = r"""
() => {
  const scroller = document.querySelector('.clip-preview-grid-scroller');
  const rec = { intervals: [], samples: [], longTasks: [], on: true, last: performance.now(),
                commitStart: (window.__gridCommits || []).length, top0: scroller.scrollTop };
  rec.t0 = rec.last;
  window.__rec = rec;
  rec.obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) rec.longTasks.push(e.duration); });
  try { rec.obs.observe({ type: 'longtask', buffered: false }); } catch (e) {}
  let lastSample = 0;
  function step(now) {
    if (!rec.on) return;
    rec.intervals.push(now - rec.last); rec.last = now;
    if (now - lastSample > 250) {
      lastSample = now;
      const vids = Array.from(document.querySelectorAll('video'));
      rec.samples.push({
        t: now - rec.t0,
        tiles: document.querySelectorAll('.clip-preview-tile-wrapper').length,
        videos: vids.filter((v) => v.getAttribute('src')).length,
        playing: vids.filter((v) => !v.paused && v.readyState >= 2).length,
        heapMB: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null,
      });
    }
    requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}
"""

REC_STOP_JS = r"""
() => {
  const rec = window.__rec; rec.on = false; rec.obs.disconnect();
  const scroller = document.querySelector('.clip-preview-grid-scroller');
  const c = (window.__gridCommits || []).slice(rec.commitStart);
  return { intervals: rec.intervals, samples: rec.samples, longTasks: rec.longTasks,
           scrolledPx: Math.abs(scroller.scrollTop - rec.top0), elapsedMs: performance.now() - rec.t0,
           commits: c.length, commitMs: c.map((x) => x.actualMs) };
}
"""


def wheel_scroll(page, px_per_second, duration_ms, notch=100):
    """Real mouse-wheel input (goes through the browser's own smooth scrolling,
    like a user's wheel), one 100 px notch at a steady cadence."""
    box = page.evaluate("() => { const r = document.querySelector('.clip-preview-grid-scroller').getBoundingClientRect();"
                        " return [r.x + r.width / 2, r.y + r.height / 2]; }")
    page.mouse.move(box[0], box[1])
    gap = notch / px_per_second
    t0 = time.perf_counter()
    n = 0
    while (time.perf_counter() - t0) * 1000 < duration_ms:
        page.mouse.wheel(0, notch)
        n += 1
        target = t0 + n * gap
        delay = target - time.perf_counter()
        if delay > 0:
            time.sleep(delay)


FRAMES_START_JS = r"""
() => {
  window.__frameRec = { intervals: [], last: performance.now(), on: true, commitStart: (window.__gridCommits || []).length, longTasks: [] };
  const rec = window.__frameRec;
  rec.obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) rec.longTasks.push(e.duration); });
  try { rec.obs.observe({ type: 'longtask', buffered: false }); } catch (e) {}
  function step(now) { if (!rec.on) return; rec.intervals.push(now - rec.last); rec.last = now; requestAnimationFrame(step); }
  requestAnimationFrame(step);
}
"""

FRAMES_STOP_JS = r"""
() => {
  const rec = window.__frameRec; rec.on = false; rec.obs.disconnect();
  const c = (window.__gridCommits || []).slice(rec.commitStart);
  return { intervals: rec.intervals, longTasks: rec.longTasks, commits: c.length, commitMs: c.map((x) => x.actualMs) };
}
"""


def frame_stats(intervals):
    data = sorted(intervals[2:])
    if not data:
        return {}
    return {
        "frames": len(data),
        "p50_ms": round(bench.pct(data, 0.5), 2),
        "p90_ms": round(bench.pct(data, 0.9), 2),
        "p99_ms": round(bench.pct(data, 0.99), 2),
        "max_ms": round(max(data), 1),
        "over50": sum(1 for v in data if v > 50),
        "over33": sum(1 for v in data if v > 33.4),
    }


def variant_switches(variant):
    if variant == "off":
        return {s: False for s in SWITCHES}
    parts = variant.split("-")
    base = parts[0]
    flags = {s: base == "on" for s in SWITCHES}
    for name in parts[1:]:
        flags[name] = not flags[name]
    return flags


def run_once(browser, url, variant, eps, scroll_ms, viewport, driver="wheel", shell=True, cpu_throttle=1.0):
    ctx = browser.new_context(viewport=viewport)
    ctx.add_init_script("localStorage.setItem('amv.gridPerf', %s);" % json.dumps(json.dumps(variant_switches(variant))))
    page = ctx.new_page()
    if cpu_throttle > 1:
        # Slows the page's main thread N times, standing in for a weaker CPU.
        ctx.new_cdp_session(page).send("Emulation.setCPUThrottlingRate", {"rate": cpu_throttle})
    page.goto(f"{url}/?eps={eps}&shell={1 if shell else 0}")
    page.get_by_role("button", name="Select episodes").click()
    page.locator(".clip-primary-action").click()
    page.wait_for_selector(".clip-preview-tile-wrapper", timeout=60000)
    time.sleep(4.0)  # first screen of videos loads
    out = {"variant": variant, "eps": eps}
    out["tilesTotalHint"] = page.evaluate("() => document.querySelector('.clip-preview-grid-scroller').scrollHeight")
    for mode, speed in (("steady", 800), ("fast", 3000)):
        page.evaluate("() => { document.querySelector('.clip-preview-grid-scroller').scrollTop = 0; }")
        time.sleep(1.5)
        if driver == "script":
            out[mode] = page.evaluate(SCROLL_JS, {"pxPerSecond": speed, "durationMs": scroll_ms})
        else:
            page.evaluate(REC_START_JS)
            wheel_scroll(page, speed, scroll_ms)
            time.sleep(0.3)
            out[mode] = page.evaluate(REC_STOP_JS)
    # Hover and select: back to the top, let tiles load, then sweep the mouse.
    page.evaluate("() => { document.querySelector('.clip-preview-grid-scroller').scrollTop = 0; }")
    time.sleep(2.0)
    boxes = page.evaluate("""() => Array.from(document.querySelectorAll('.clip-preview-tile-wrapper')).map((el) => {
        const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2, r.y, r.bottom];
      }).filter((b) => b[2] >= 0 && b[3] <= window.innerHeight).slice(0, 24)""")
    page.evaluate(FRAMES_START_JS)
    for x, y, _top, _bottom in boxes:
        page.mouse.move(x, y, steps=4)
        time.sleep(0.12)
    corners = page.locator(".clip-corner-select")
    for i in range(min(12, corners.count())):
        try:
            corners.nth(i).click(timeout=2000)
        except Exception:
            pass
        time.sleep(0.08)
    out["hover"] = page.evaluate(FRAMES_STOP_JS)
    ctx.close()
    return out


def summarize(r):
    s = {}
    for mode in ("steady", "fast", "hover"):
        m = r[mode]
        st = frame_stats(m["intervals"])
        st["longtasks"] = len(m["longTasks"])
        st["longtask_ms_total"] = round(sum(m["longTasks"]), 1)
        st["commits"] = m["commits"]
        cm = sorted(m["commitMs"])
        st["commit_ms_total"] = round(sum(cm), 1)
        st["commit_ms_p90"] = round(bench.pct(cm, 0.9), 2) if cm else None
        st["commit_ms_max"] = round(max(cm), 1) if cm else None
        if mode != "hover":
            st["px"] = round(m["scrolledPx"])
            st["commits_per_1000px"] = round(m["commits"] * 1000 / max(1, m["scrolledPx"]), 1)
            smp = m["samples"]
            st["max_videos_with_src"] = max((x["videos"] for x in smp), default=0)
            st["max_playing"] = max((x["playing"] for x in smp), default=0)
            st["max_tiles_in_dom"] = max((x["tiles"] for x in smp), default=0)
            heap = [x["heapMB"] for x in smp if x["heapMB"] is not None]
            st["heap_mb_start_end_max"] = [round(heap[0], 1), round(heap[-1], 1), round(max(heap), 1)] if heap else None
        s[mode] = st
    return s


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--tag", required=True)
    p.add_argument("--variants", default="off,on")
    p.add_argument("--repeats", type=int, default=3)
    p.add_argument("--eps", type=int, default=1)
    p.add_argument("--scroll-ms", type=int, default=20000)
    p.add_argument("--dist", choices=["prod", "prof"], default="prod")
    p.add_argument("--port", type=int, default=4178)
    p.add_argument("--allow-busy", action="store_true")
    p.add_argument("--driver", choices=["wheel", "script"], default="wheel",
                   help="wheel: real mouse-wheel input (default); script: set scrollTop every animation frame")
    p.add_argument("--bare", action="store_true",
                   help="mount only the Scene Splitter panel instead of the whole desktop shell")
    p.add_argument("--cpu-throttle", type=float, default=1.0,
                   help="slow the page's main thread N times (Chromium CPU throttling) to stand in for a weaker CPU")
    p.add_argument("--width", type=int, default=1366)
    p.add_argument("--height", type=int, default=860)
    args = p.parse_args()

    env = BenchEnv.load()
    sys.path.insert(0, str(env.root / "runtime" / "benchlib"))
    from playwright.sync_api import sync_playwright

    others = bench.machine_quiet_or_exit(args.allow_busy)
    w6 = env.root / "w6"
    dist = w6 / ("dist" if args.dist == "prod" else "dist-prof")
    proxy = env.out_dir / "previews" / "h264_1080p.proxy.nvenc.mp4"
    server = subprocess.Popen(["node", str(Path(__file__).resolve().parent / "grid-app" / "serve.mjs"),
                               str(args.port), str(dist), str(proxy), str(w6 / "scenes.json")])
    run_id = dt.datetime.now().strftime("%Y%m%d-%H%M%S") + "-gridapp"
    rec = bench.Recorder(env, args.tag, "gridapp", run_id)
    rec.record("meta.other_heavy_processes_at_start", "-", len(others), unit="count")
    variants = args.variants.split(",")
    raw_path = w6 / f"{run_id}.raw.json"
    results = {v: [] for v in variants}
    try:
        time.sleep(0.8)
        with sync_playwright() as pw:
            browser = pw.chromium.launch(channel="msedge", headless=False,
                                         args=["--autoplay-policy=no-user-gesture-required", "--window-position=0,0",
                                               "--enable-precise-memory-info"])
            try:
                for rep in range(args.repeats):
                    order = variants if rep % 2 == 0 else list(reversed(variants))
                    for v in order:
                        r = run_once(browser, f"http://127.0.0.1:{args.port}", v, args.eps, args.scroll_ms,
                                     {"width": args.width, "height": args.height}, args.driver, not args.bare,
                                     args.cpu_throttle)
                        s = summarize(r)
                        results[v].append(s)
                        print(json.dumps({"rep": rep, "variant": v, **s}), flush=True)
            finally:
                browser.close()
    finally:
        server.terminate()
    raw_path.write_text(json.dumps(results, indent=1), encoding="utf-8")
    media = f"{args.eps}ep-{args.dist}-{args.driver}-{'bare' if args.bare else 'shell'}-cpu{args.cpu_throttle:g}x"
    for v, runs in results.items():
        for mode in ("steady", "fast", "hover"):
            for key in ("p50_ms", "p90_ms", "p99_ms", "max_ms", "over50", "longtasks", "commits", "commit_ms_total"):
                vals = [r[mode].get(key) for r in runs if r[mode].get(key) is not None]
                if vals:
                    rec.record(f"gridapp.{v}.{mode}.{key}", media, vals,
                               unit="count" if key in ("over50", "longtasks", "commits") else "ms")
    print("raw:", raw_path)


if __name__ == "__main__":
    main()
