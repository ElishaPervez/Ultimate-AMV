# Spec: Frame interpolation section

Target implementer: GPT (Codex). This is the big one — build it in phases, commit
locally after each phase, and stop for review between phases.

Repo conventions: local commit per phase, no push, no build unless asked, no
`Co-Authored-By` trailer, feature must work in both CPU and GPU modes.

---

## 0. DECISION — do not integrate TheAnimeScripter. Build native.

**TheAnimeScripter is AGPL-3.0** (`temporary codebase for reference/LICENSE:1-2`).
**This app is MIT** (`LICENSE:1`). Copying any TAS source into this tree forces
the whole app to AGPL. That is not the plan.

**RIFE itself — the actual interpolation model TAS wraps — is MIT**, both the
code and the pretrained weights (hzwer/Practical-RIFE; the README states the
model download links are "under the same MIT license as this project").

So: take RIFE from **upstream hzwer/Practical-RIFE**, and use the TAS tree only
as a worked reference for *how* to drive it correctly.

> **HARD RULE FOR THE IMPLEMENTER:** do not copy, paste, adapt, or translate any
> file from `temporary codebase for reference/`. TAS's `src/rifearches/*.py` are
> modified derivatives sitting inside an AGPL work — lifting them is exactly the
> thing that contaminates this repo. Every line of model code must come from the
> upstream MIT repository, with its MIT notice retained in a `THIRD_PARTY.md` or
> a header comment. Read TAS to understand behaviour; write your own code.

### Why native beats bundling TAS

| | Bundle TAS as a subprocess | Native in this app's backend |
|---|---|---|
| Python runtime | TAS bundles **3.14** (`python314._pth`); this app bundles **3.13** (`python/python313._pth`, `release.yml:37`). Two full interpreters ship. | Reuses the existing 3.13 |
| ML runtime | TAS needs `torch 2.12+cu132` + `tensorrt 11.1` + `triton-windows` — a second multi-GB stack alongside the app's own | **Already installed.** The app provisions `torch 2.11.0+cu128` + `torchvision` + `onnxruntime-gpu` today (`backend/amv_audio/runtime_versions.py`, `dependencies.py:393-398`) |
| Added download | Several GB on top of the existing ~3 GB GPU setup | **Model weights only — tens of MB** |
| Progress | TAS prints an ANSI progress bar, not parseable. Machine-readable progress exists only over a Socket.IO channel behind `--ae host:port` (`src/server/aeComms.py:57-58`) | Reuses the app's existing one-JSON-object-per-line protocol |
| Cancel | **None.** TAS's cancel handler is an explicit no-op (`src/server/aeComms.py:178-184`); only a process-tree kill works | Reuses `kill_child_pid` like every other job |
| Scene cuts | TAS cannot accept an external cut list — detection is always internal (`--scenechange*` flags only) | This app already knows every cut |
| License | Requires a defensible "separate program" argument and AGPL source-offer obligations | Stays MIT outright |

The bundling route is defensible (it is exactly how ffmpeg is handled — GPL,
fetched post-install via `tools.json`, never in the MIT installer, see
`docs/CLAUDE-NOTES.md:123-151`). It is simply worse on every axis here, because
**the heavy runtime is already installed** and the AGPL program brings a second
copy of it.

---

## 1. What gets built

A new top-level **Frame interpolation** section, mirroring the background-removal
feature end to end. Standalone: pick video files, choose a factor and model, run,
get output files. Clip-export integration is Phase 5 and optional.

### Scope decision — this is for AMV CLIPS, not whole episodes

Confirmed with the app owner. The input is a batch of short, already-cut clips
from the scene grid — typically 1 to 15 seconds each, one continuous shot per
file. This changes three things versus a general-purpose tool:

1. **Scene cuts are a near-non-issue.** Clips are cut *at* scene boundaries, so
   there is no cut inside them. The guard in §2.4 stays as a cheap safety net for
   the case where someone drags in an arbitrary file, but it is not load-bearing
   and gets no UI surface.
2. **Batch throughput matters more than single-file speed.** A user will queue 30
   clips, not one 24-minute video. Model load time is paid once per *batch*, not
   once per clip — see §2.3.
3. **Per-file overhead is the dominant cost.** On a 4-second clip, spinning up
   Python, importing torch, loading the model and initialising CUDA can easily
   exceed the actual interpolation time. Design around that.

### New files

```
backend/interpolate_cli.py              # status | interpolate subcommands
backend/amv_interpolate/__init__.py
backend/amv_interpolate/arch.py         # RIFE IFNet — MIT, from upstream
backend/amv_interpolate/warp.py         # warp layer — MIT, from upstream
backend/amv_interpolate/models.py       # weight resolution + download
backend/amv_interpolate/processor.py    # ffmpeg <-> torch frame pump
src-tauri/src/interpolate_cmds.rs
src/features/interpolate/InterpolatePanel.tsx
src/features/interpolate/InterpolateProgressCard.tsx
```

### Edited files

```
src/types/app.ts                        # SectionId union
src/shell/App.tsx                       # rail entry, panelMeta, subnav, panel mount, fallback guard
src-tauri/src/lib.rs                    # command registration (~:499-503 pattern)
backend/amv_audio/dependencies.py       # FEATURES entries
tools.json                              # RIFE weight files
```

---

## 2. Phase 1 — Python core, headless

Build and prove the interpolation engine before any UI exists.

### 2.1 Model

Ship **RIFE 4.25** as the default and **RIFE 4.6** as a "compatibility / lower
VRAM" alternate. Both from upstream Practical-RIFE.

Weights are fetched, not bundled. Add them to `tools.json` as `kind: "single"`
entries with a pinned `sha256` and `size`, matching the existing schema:

```jsonc
{ "name": "rife-4.25", "url": "<pinned upstream release asset>",
  "sha256": "...", "size": ..., "kind": "single", "dest": "models/rife425.pth" }
```

Two constraints:
1. **Pin a permanent URL.** The repo already learned this the hard way with
   ffmpeg — rotating autobuild URLs get deleted and 404. Use a tagged release
   asset, or mirror the file to a release in this repo.
2. **Do not add it to the startup `ToolsGate` requirement set.** It must download
   on first use of the interpolation feature, not gate app launch. Check how
   `tools_install` (`src-tauri/src/tools.rs:492-631`) selects which binaries to
   install and add an opt-in subset rather than extending the startup list.

`models.py` resolves the weight path under the tools dir, and if absent, triggers
the download through the existing `tools.rs` path (which already gives
SHA verification, throttled progress events and a cancel flag).

### 2.2 Dependency entries

Add to the `FEATURES` map in `backend/amv_audio/dependencies.py` (the map ending
at `:68`), following the `bgremove_cpu` / `bgremove_gpu` shape:

```python
"interpolate_cpu": {
    "modules": [
        ("typing_extensions", "typing_extensions"),
        ("numpy", NUMPY_PACKAGE),
        ("torch", "torch"),
        ("torchvision", "torchvision"),
    ],
    "packages": [],
},
"interpolate_gpu": { ... same list ... },
```

Torch is already pinned and provisioned by `_install_torch` (`:393-398`) with the
right CUDA index, so this should be a no-op on a machine that has run GPU setup.
Call `ensure_feature_dependencies("interpolate_gpu" | "interpolate_cpu", gpu=...)`
at job start, exactly as `bgremove_cli.py:96-100` does.

### 2.3 The frame pump — `processor.py`

```
ffmpeg decode  ->  raw rgb24 on stdout pipe
               ->  numpy frame  ->  torch tensor (fp16 on CUDA, fp32 on CPU)
               ->  RIFE: (frameA, frameB, t) -> intermediate frame
               ->  back to numpy
               ->  raw rgb24 into ffmpeg stdin  ->  encoded output
```

**Batch shape — do this from the start, retrofitting it is painful.** The CLI
takes a *list* of input/output pairs, not one file. One Python process, one torch
import, one CUDA init, one model load, then loop over the clips. Emit per-clip
progress plus overall queue progress.

On a 4-second clip the fixed startup cost (Python launch + torch import + model
load + CUDA context) is comparable to or larger than the interpolation itself.
Spawning a process per clip would make a 30-clip batch several times slower than
it needs to be, and would show the user a stuttering progress bar that resets.

Requirements:
- Resolve `ffmpeg` from the app's tools dir the same way `clips.rs:683-687` does.
  Do not assume a PATH ffmpeg.
- **Pad to a multiple of 64** before inference, crop back after. RIFE's network
  requires it; unpadded odd resolutions produce a shifted or corrupted output.
- Run inference under `torch.inference_mode()`.
- fp16 on CUDA, fp32 on CPU. Expose as a `--half` flag defaulting to true on GPU.
- Process in a streaming fashion, two frames in memory at a time plus the output
  queue. Do **not** decode the whole video to a list — a 3-minute 1080p clip is
  ~13 GB of raw frames.
- Output fps = `source_fps * factor`. Support integer factors 2, 3, 4 in Phase 1;
  fractional factors are Phase 4.
- **Preserve audio.** Feed the original file as a second ffmpeg input and map its
  audio stream with `-c:a copy`, exactly the shape TAS uses
  (`src/io/ffmpegSettings.py:670-671`, `:846-868`) — that is a technique, not
  code, so it is fine to mirror. Handle the no-audio-stream case.

### 2.4 Scene-cut safety — a cheap safety net, not a feature

Interpolating across a hard cut makes the model invent motion between two
unrelated images; the visible result is a smeared morph at the cut.

**For this app's actual input this barely applies** — clips come out of the scene
grid already cut *at* the boundaries, so a clip contains one continuous shot and
there is no internal cut to trip over. Build the guard anyway, because a user can
drag in any file, but keep it small:

- For each consecutive pair, compute a cheap similarity score on downscaled
  grayscale frames. Use MSE — it is cheaper than SSIM and adequate here.
- Above the difference threshold, **emit N duplicates of the earlier frame**
  instead of interpolating, and reset any cached model state.
- Hardcode a sensible threshold. **No UI control, no sensitivity setting.** It
  fires approximately never on real input; a knob for it is noise.
- Count how many times it fired and include the number in the `done` payload, so
  a genuinely cut-heavy input is visible in the logs rather than silent.

This mirrors the behaviour TAS implements at `main.py:443-446` and
`src/sceneChange/detector.py:47-56`. Reimplement it; do not copy it.

Leave a comment saying why the gate exists, so nobody later removes it as dead
code after observing it never triggers.

### 2.5 CLI contract

`backend/interpolate_cli.py`, mirroring `backend/bgremove_cli.py`:

```
python -I backend/interpolate_cli.py status
python -I backend/interpolate_cli.py interpolate \
    --jobs <path-to-json> --factor 2 --model rife4.25 \
    --gpu true --half true
```

`--jobs` points at a JSON file holding the batch:
`[{"input": "...", "output": "..."}, ...]`. A file rather than argv because a
30-clip batch of long Windows paths will blow the command-line length limit.

stdout is **one JSON object per line**, using the existing `emit()` /
`progress()` helpers copied in shape from `bgremove_cli.py:43-53`:

- `{"type":"progress","stage":...,"percent":0-100,"message":...,"elapsedSeconds":...}`
- `percent: -1` for indeterminate steps (dependency install, model download)
- `{"type":"done", ...}` / `{"type":"error","message":...}`

Stages: `dependencies`, `model-init`, `interpolate`, `encode`.

Progress events carry both levels so the UI can show a queue and a current file:
`{"type":"progress","stage":"interpolate","percent":42,"clipIndex":3,
"clipCount":30,"clipName":"Scene 004.mp4", ...}`.

One clip failing must **not** abort the batch. Record the failure, continue, and
report the per-clip outcomes in the `done` payload.

Exit 0 if any clip succeeded, 1 only if the batch failed outright.

### 2.6 Phase 1 acceptance

A batch of 5 real clips from the scene grid interpolates 2x on GPU and on CPU.
Outputs play, audio is in sync, no visible artifacts on fast pans or line art.
The model loads once for the batch, not five times — verify by timing, the second
clip must start noticeably faster than the first. A deliberately cut-spanning
test file shows a clean hold with no morph. Verify by watching the output, not by
reading logs.

---

## 3. Phase 2 — Rust bridge

`src-tauri/src/interpolate_cmds.rs`, copying `bgremove_cmds.rs` structurally:

- `static INTERPOLATE_CHILD_PID`
- `run_streaming_interpolate_cli` — modelled on `bgremove_cmds.rs:246-350`:
  spawn via `cmd(python_exe(&root))` with `-I`, `apply_python_env`,
  `store_child_pid`, read stdout line-by-line, `serde_json::from_str`, forward
  `progress` events to `window.emit("interpolate-progress", value)`, stash
  `done`/`error` as the returned payload, drain stderr on its own thread with a
  rolling tail for error text.
- Commands: `interpolate_status`, `interpolate_run`, `cancel_interpolate`.
- `cancel_interpolate` → `kill_child_pid(&INTERPOLATE_CHILD_PID)` (process-tree
  kill, `python_env.rs:117-125`).
- Register in `src-tauri/src/lib.rs` alongside the bgremove commands (~`:499-503`).

**Cancellation must actually stop ffmpeg too.** The Python process spawns ffmpeg
children; the existing `taskkill /F /T` kills the tree, but verify it on a real
run — a stranded ffmpeg holding the output file is the failure mode to watch for.
Clean up the partial output file on cancel (silently — no "you have leftover
files" prompt).

---

## 4. Phase 3 — UI section

### 4.1 Nav wiring — five edits

1. `src/types/app.ts:1-11` — add `interpolation` to the `SectionId` union.
2. `src/shell/App.tsx:103-121` — add `{ id, label, Icon }` to `RAIL_ENTRIES`,
   Media group. Icon from `lucide-react`.
3. `src/shell/App.tsx:162-206` — add the `panelMeta` entry (exhaustive record,
   TS fails the build until you do).
4. `src/shell/App.tsx:~509-580` — add the expanded-sidebar subnav button.
5. `src/shell/App.tsx:~700-715` — import and mount the panel. Panels stay mounted
   and toggle `is-active`/`is-hidden`; extend the `!isClipHunting && ...`
   fallback guard at `~:714`.

### 4.2 Panel

`InterpolatePanel.tsx`, following `BgRemovePanel.tsx`. **The queue is the primary
UI**, not an afterthought — the expected use is 10-40 short clips at once.

- File picker that accepts a multi-select, plus a folder pick that takes every
  video in it. A visible list with per-clip status (queued / running / done /
  failed) and a per-clip remove.
- Controls, kept to four: **Speed factor** (2x / 3x / 4x), **Model** (RIFE 4.25
  default, RIFE 4.6 as the lower-memory alternate), **Output folder**, and an
  **overwrite vs. suffix** choice for naming.
- No scene-cut control. See §2.4.
- GPU status badge reusing the existing pattern; a blunt warning on CPU mode with
  a realistic time estimate.
- Progress via `listen<InterpolateProgress>("interpolate-progress", ...)`
  (`BgRemovePanel.tsx:163-176` is the template, including the module-global busy
  owner gate). Show two bars: current clip, and N of M for the queue.
- Cancel button wired to `invoke("cancel_interpolate")`. Clips already finished
  stay on disk; the in-flight one is cleaned up.

Follow the established UI taste: compact purpose-built controls, labels adjacent,
no duplicate stat cards, wallpaper shows through the workspace page.

### 4.3 Time estimate

Show a running estimate for the whole queue. Derive it from measured throughput
after the first clip rather than guessing up front — the first clip pays the
model-load cost and is not representative of the rest.

---

## 5. Phase 4 — refinements (only after 1-3 land)

- **Target-fps mode.** For AMV work "make this 60 fps" is the real intent, not
  "multiply by 2.5". Offer a target output fps (30 / 60 / 120) and derive the
  fractional factor from the clip's source fps. Requires per-frame timestep
  handling rather than fixed midpoints.
- Output encoder settings reusing the Feature-1 rate-control work rather than a
  separate hard-coded encoder.
- Resolution cap for sources large enough to exhaust VRAM. Low priority — AMV
  clips are typically 1080p, which is comfortable.

Explicitly dropped from the earlier draft: feeding the app's stored scene-cut
list into the interpolator. That only mattered for whole-episode input, which is
out of scope.

## 6. Phase 5 — clip-export integration (worth doing)

Given the input is always clips from the scene grid, the natural end state is a
checkbox in the clip extractor: export smoothed clips directly, no separate trip
through the new section.

Hook point: the end of the per-clip loop body in `run_clip_export`
(`src-tauri/src/clips.rs`, after the ffmpeg call succeeds, before the loop closes
at `~:1001`): `output: PathBuf`, `duration` and `clip.fps` are all in scope.
Interpolate to a temp file, then rename over the output. Progress can reuse
`emit_conversion_progress` (`clips.rs:~:937`) so `ClipExportProgressModal` needs
no protocol change.

The merged-export equivalent is after the single ffmpeg invocation in
`run_clip_export_merged` (`clips.rs:1068+`).

**Reuse the batch process from Phase 1** — do not spawn a fresh Python per clip
inside the export loop. Interpolate after the export loop completes, feeding it
the whole list of just-written files.

Do not start this until Phases 1-3 are proven.

---

## 7. Tests

**Python** (`backend/tests/`):
- Scene gate: two visually distinct frames trigger a hold; two near-identical
  frames do not.
- Padding: a 1080x1920 and a 1234x567 input both round-trip to the exact input
  dimensions after pad/crop.
- Output fps math for factors 2, 3, 4.
- Batch: a job list with one bad path still processes the good entries and
  reports the failure per clip.
- Batch: the model is constructed exactly once for a multi-clip job list.
- `_config_payload`-style safety: the CLI never raises on a missing optional arg.
- Event protocol: every emitted line is valid JSON with a known `type`, and
  carries `clipIndex`/`clipCount`.

**Rust** (`src-tauri`):
- Event demux: a `progress` line forwards, a `done` line becomes the return
  payload, a malformed line does not crash the reader.
- `cancel_interpolate` with no running job is a no-op, not an error.

**Frontend**:
- Panel renders, factor/model controls update state.
- Progress events drive the progress card.
- Cancel invokes the command and resets the busy state.

---

## 8. Things that will bite — read before starting

1. **Do not copy from the TAS tree.** Stated at the top; restating because it is
   the single irreversible mistake available here.
2. **Torch is already installed at a pinned version** (`torch==2.11.0+cu128`).
   Do not upgrade it, do not add a second index URL, do not `--force-reinstall`.
   Audio separation and scene detection both depend on that exact stack.
3. **The bundled Python is 3.13**, not 3.11 as `README.md:102` claims — that line
   is stale. Confirm against `python/python313._pth` and `release.yml:37`.
4. **Raw frame memory.** 1080p rgb24 is ~6 MB per frame. Stream, never collect.
5. **CPU mode is genuinely slow** but must work — every feature in this app works
   in both modes. Be honest in the UI rather than hiding the option.
6. **Model URLs must be permanently pinned.** Rotating release assets get deleted
   and 404 later; the repo has already been burned by this with ffmpeg.
7. **Attribution.** RIFE is MIT, which requires retaining the copyright and
   permission notice. Add a `THIRD_PARTY.md` naming RIFE / hzwer with the MIT
   text before the first release that ships it.
