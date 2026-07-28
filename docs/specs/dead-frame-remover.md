# Spec: Dead Frame Remover

Repo conventions: local commit per phase, no push, no build unless asked, no
`Co-Authored-By` trailer, feature must work in both CPU and GPU modes.

Companion document for the user: `docs/reports/dead-frame-remover-2026-07-27.html`
(plain-language walkthrough with an interactive sensitivity demo).

---

## 1. What it is

A seventh tool in the **Media** group, sitting after Frame Interpolation in the
sidebar. It removes duplicate frames from anime clips.

Anime is drawn "on twos" or "on threes": one drawing is held for two or three
frames of a 24fps timeline, so roughly 10 of every 24 frames are genuinely new
and the rest are copies. This tool detects the copies and drops them.

**The output is a shorter, faster clip.** Frames are removed, nothing is
inserted or stretched to compensate. A 30s clip that is two-thirds duplicates
comes out around 12s. That is the intended behaviour, not a bug — what the user
does with the result afterwards is out of scope for this feature.

### Non-goals

- No interpolation, retiming, slow-motion, or duration preservation.
- No black-frame / fade / logo trimming (a different meaning of "dead frame").
- No per-frame manual veto UI, no per-clip sensitivity overrides.
- No output-folder picker and no naming-mode picker (see §5.4).

---

## 2. User flow

1. Drop clips or a folder onto the panel, or use **Add clips** / **Add folder**.
   Same acceptance rules and folder expansion as `InterpolatePanel`
   (`acceptsDroppedPath`, `interpolate_list_folder`).
2. Each queued clip is **measured** as it arrives — decoded once at thumbnail
   size, producing one change-score per frame. A 30s clip takes ~2s.
3. The queue row shows `720 → 291` (source frames → kept frames) as soon as its
   measurement lands, recomputed instantly whenever the dial moves.
4. The user drags **Sensitivity**. The live count updates from the cached
   scores — no re-decode.
5. The user presses **Preview**. A fast low-resolution render of the *selected*
   clip at the current setting appears in the right-hand player.
6. Repeat 4–5 as many times as wanted. Each preview replaces the previous one.
7. **Export** at the bottom of the panel processes **the entire queue** at the
   previewed setting. Each output lands beside its own source file with a
   suffix.

### The export gate

`Export` is disabled unless a preview exists that matches the current state.

| Event | Effect on the gate |
| --- | --- |
| App opens / queue changes | Locked — no preview yet |
| Preview completes | Unlocked |
| Sensitivity dial moves | Re-locked, preview marked stale |
| Selected queue clip changes | Re-locked, preview cleared |
| Format / rate / audio / suffix changes | **No effect** — the preview is low-res and only ever attested to the dial |
| Clip added to or removed from the queue | No effect on the gate |

A status line sits beside the buttons and always states the current gate state
verbatim: `no preview yet` / `preview matches the dial — ready to export N clips`
/ `dial moved — preview again`.

Rationale for re-locking on clip change: the two players must always show the
same clip. Letting a preview of clip A sit beside the original of clip B is the
one way this panel could lie to the user.

---

## 3. Detection

### 3.1 Measurement pass

Decode the clip once through ffmpeg to raw grayscale at a fixed small width
(160px, height by aspect, `-vf "scale=160:-2,format=gray" -f rawvideo -pix_fmt gray`).
For each frame *n* > 0 compute the mean absolute difference against frame *n-1*,
divided by 255 to normalise into `0.0 … 1.0`.

Frame 0 has no predecessor and is assigned score `1.0` — it is never removable.

Emit the score array plus `frameCount`, `fps`, `width`, `height`, `duration`.

Cost: 160px grayscale is ~14 KB per frame, so the arithmetic is negligible and
the pass is bound by decode speed. Runs identically on CPU-only machines; no
CUDA path, no model, no new dependency.

### 3.2 Sensitivity → threshold

The dial is `0 … 100` and maps to an **absolute** threshold:

```
threshold = 0.001 + (sensitivity / 100) * 0.029     # 0.001 … 0.030
```

A frame is removed when `score[n] < threshold` and `n > 0`.

The mapping must be absolute, not relative to each clip's own distribution.
The user tunes on one clip and exports the whole queue, so setting `18` has to
mean the same physical amount of change on every file. A percentile-based
mapping would silently mean something different per clip and break that promise.

Reference points for the implementer, useful as test anchors:

| Content | Typical score | Behaviour |
| --- | --- | --- |
| Held duplicate, clean digital source | 0.001 – 0.004 | Removed from ~`10` upward |
| Held duplicate, grainy source | 0.008 – 0.020 | Needs a high dial; may never be caught |
| Slow pan, one frame of drift | 0.010 – 0.018 | **Wrongly removed above ~`35`** |
| New drawing, dialogue | 0.05 – 0.12 | Kept |
| New drawing, action | 0.15 – 0.35 | Kept |
| Hard scene cut | > 0.5 | Kept |

Default dial value: `18`.

No additional guards (minimum-hold, maximum-run, noise floor). One control only
— that was an explicit product decision, and adding a second control silently
changes what the live count means.

---

## 4. Rendering

Preview and export run **the same code path** with different encoder settings.
This is load-bearing: it is what makes the preview an honest attestation of the
export. Do not implement two removal routines.

| | Preview | Export |
| --- | --- | --- |
| Scope | Selected clip only | Every clip in the queue |
| Resolution | Longest edge capped at 640px | Source resolution |
| Encoder | `libx264 -preset ultrafast -crf 30`, MP4 | User's format + rate settings |
| Destination | App temp dir, one file, overwritten each time | Beside each source file |
| Audio | Always dropped | Per the audio toggle |

Frame removal itself: decode, drop frames whose index is in the removal set,
pipe the survivors to the encoder at the source fps. The clip's fps metadata is
unchanged — fewer frames at the same fps is exactly what produces the shorter,
faster output.

Previous preview files are deleted when a new preview starts. Any preview left
behind by a crash is garbage-collected silently on panel mount — never surface a
"you have leftover files" prompt.

---

## 5. Components

### 5.1 `backend/amv_video/encode.py` — new shared module

Lift the encoder plumbing out of `backend/amv_interpolate/processor.py`:
`OUTPUT_FORMATS`, `OUTPUT_FORMAT_KEYS`, `format_extension`, `_rate_args`,
`_video_args`, and the ffmpeg command assembly around them.

`amv_interpolate/processor.py` imports from the new module and keeps its public
surface unchanged. **Frame Interpolation must be re-verified after this move** —
it is the only regression risk in the feature.

Reason for sharing rather than copying: the export settings must behave
identically to the ones the user already knows, and a second copy will drift.

`_video_args` already selects the encoder from hardware rather than from user
choice — `h264` becomes `h264_nvenc` on GPU and `libx264` on CPU, `hevc` becomes
`hevc_nvenc` or `libx265`. Keep that. The format picker offers **one entry per
format, not per encoder**; the user never chooses between the card and the
processor. This is also what keeps the feature CPU/GPU-parity compliant.

### 5.1b `src/features/video/outputFormats.ts` — new shared frontend module

Move the `OUTPUT_FORMATS` array and `outputFormatExtension` out of
`InterpolatePanel.tsx` (currently `:42-57`) into their own module and import
from both panels. Verified: nothing else in `src/` imports either symbol today,
so this move is contained.

The four entries and their `rateControl` flags are unchanged:

| Key | Label | Hint | Ext | Rate control |
| --- | --- | --- | --- | --- |
| `h264-mp4` | H.264 · MP4 | Plays on everything | mp4 | yes |
| `hevc-mp4` | HEVC · MP4 | Same look, smaller file | mp4 | yes |
| `h264-mkv` | H.264 · MKV | Keeps any audio track | mkv | yes |
| `prores-mov` | ProRes · MOV | Near-lossless, very large | mov | **no** |

### 5.2 `backend/amv_deadframe/`

- `analyzer.py` — the measurement pass (§3.1) and the threshold→removal-set
  function (§3.2). Pure functions over an ffmpeg pipe; the threshold function
  takes a score list and returns indices, with no I/O, so it is directly
  unit-testable.
- `processor.py` — removal + encode for one clip and for a batch, calling
  `amv_video.encode`. Emits progress through the same callback shape
  `process_batch` uses today.

### 5.3 `backend/deadframe_cli.py`

Mirrors `interpolate_cli.py`: one JSON object per line on stdout, `emit()` /
`progress()` helpers, `add_log` on completion and failure.

Subcommands:

| Command | Arguments | Emits |
| --- | --- | --- |
| `analyze` | `--input` | `{"type":"analysis", "input", "frameCount", "fps", "duration", "scores":[...]}` |
| `preview` | `--input --sensitivity --output` | progress, then `{"type":"done", "output", "sourceFrames", "keptFrames"}` |
| `export` | `--jobs --sensitivity --rate-mode --quality --bitrate-mbps --output-format --keep-audio` | per-clip progress, then a `done` payload shaped like `InterpolateDone` |

`--jobs` is a JSON file of `{input, output}` pairs, written by Rust, same as
interpolation.

No `ensure_feature_dependencies` call is needed — this feature adds no packages.
Do not add a dependency gate it does not require.

### 5.4 `src-tauri/src/deadframe_cmds.rs`

Commands: `deadframe_analyze`, `deadframe_preview`, `deadframe_export`,
`deadframe_list_folder`, `cancel_deadframe`. Register in `lib.rs` alongside the
interpolate commands and add to `src-tauri/capabilities/default.json` if the
existing entries are enumerated rather than wildcarded.

Reuse `run_streaming_interpolate_cli`'s pattern for the streaming child process,
`store_child_pid` / `kill_child_pid` for cancellation.

**Output path construction** happens in Rust, not the frontend:
`<source_dir>/<stem><suffix><ext>`, where `ext` comes from the chosen output
format. If the target exists it is overwritten — the user was told this in the
design doc and there is no recovery prompt (house rule).

### 5.5 `src/features/deadframe/DeadFramePanel.tsx`

Layout, left to right: queue column (identical structure to
`interpolate-queue-pane`), then the main column holding the two players, the
control grid, and the bottom bar.

- Two `<video>` elements side by side, **independent** — no shared transport, no
  wipe slider, no synced scrub. The clips have different durations so there is
  nothing to synchronise. Do not reuse `VideoComparisonCard`; it is built on a
  sync-master model that is wrong here.
- Sensitivity: slider plus live count, the only detection control.
- **Output controls — reuse the existing components, do not rebuild them.**
- Audio: keep/drop toggle, defaults to drop.
- Suffix: text field, defaults to `_nodead`.
- Bottom bar: gate status line, `Preview`, `Export queue`.

#### Output controls in detail

Reproduce `InterpolatePanel.tsx:531-570` against the new shared format module:

1. **Format picker** — the four entries from §5.1b, rendered with the
   `interpolate-formats` markup (label + hint per button). Reuse the class or
   add a shared one; do not write a second style.
2. **Rate mode** — a three-way segmented control in a
   `.conversion-segment` wrapper, exactly the existing markup, with buttons
   labelled `Quality`, `VBR`, `CBR` in that order. State type is the existing
   `"quality" | "vbr" | "cbr"` union; add `DeadFrameRateMode` in the new types
   file as an alias rather than inventing a fourth value.
3. **Value control** — `<VideoOutputControl>` from `src/features/video/`, driven
   by a `VideoControlSpec` built the same way `outputSpec` is built at
   `InterpolatePanel.tsx:425-445`:
   - `quality` mode → label `Constant quality`, valueLabel `CQ` when encoding on
     the GPU and `CRF` when on CPU, default `18`.
   - `vbr` mode → label `Target bitrate`, help "The encoder averages around this
     bitrate."
   - `cbr` mode → label `Constant bitrate`, help "The encoder holds this bitrate
     throughout the clip."

**ProRes hides the whole rate row.** Its profile fixes the quality, so both the
segmented control and the value slider are unmounted when
`prores-mov` is selected — not disabled, unmounted, matching the existing
behaviour. `rateControl: false` on the format entry is the flag to branch on.

These controls affect the **export only**. The preview is always a fixed fast
low-resolution H.264 render regardless of what is selected here, which is why
changing any of them leaves the export gate open (§2).

Types in `src/types/deadframe.ts` following `src/types/interpolate.ts`.

Sidebar entry in `src/shell/App.tsx`: add `"dead-frames"` to the Media group's
active-tab list and render the panel. Reuse an existing lucide icon; `Scissors`
or `Rows3` fit.

Styles in `src/styles/` following the interpolate panel's file, respecting the
existing wallpaper-shows-through rule for workspace pages.

---

## 6. Error handling

| Situation | Behaviour |
| --- | --- |
| Measurement fails on a clip | That row shows `couldn't read this file`; the clip is skipped by export; the rest of the queue is unaffected |
| Preview render fails | Gate stays locked, error shown beside the buttons, previous preview cleared |
| One clip fails during export | Recorded in its outcome, batch continues, `done` reports succeeded/failed counts |
| Nothing removed at the current dial | Not an error. The live count reads `0 removed` and the status line says so. Preview and export still work |
| Everything removed except frame 0 | Not blocked, but the queue row is flagged — a clip collapsing to a single frame is almost certainly a wrong setting |
| Cancel mid-export | Kill the child process; already-written outputs stay, the current partial file is deleted |

10-bit HEVC sources: this feature does no `scale_cuda`, so the known 10-bit
p010 hwdownload failure does not apply. CPU scaling only.

---

## 7. Testing

### Python (`backend/tests/test_deadframe.py`)

Threshold function, on synthetic score arrays — no video needed:

- A clean on-2s pattern removes exactly half.
- A clean on-3s pattern removes exactly two thirds.
- An all-unique sequence removes nothing at any dial value.
- Frame 0 is never in the removal set, including when its score is forced low.
- A score exactly equal to the threshold is **kept** (strict `<`).
- Dial 0 and dial 100 both produce valid sets and do not throw.

Measurement pass, on a generated fixture written into `backend/tests/data/`:

- A 24-frame clip built by duplicating each of 12 drawings measures 12 low
  scores at the expected indices.
- Frame count and fps in the analysis payload match the source.

### Frontend (`src/features/deadframe/DeadFramePanel.test.tsx`)

- Export is disabled with an empty queue.
- Export is disabled after clips are added but before any preview.
- Export becomes enabled after a preview resolves.
- Moving the sensitivity slider after a preview disables Export again.
- Selecting a different queue row after a preview disables Export again.
- Changing the output format after a preview leaves Export enabled.
- The live count updates on slider input without issuing a new analyze call.
- Selecting ProRes unmounts both the rate-mode segment and the value slider;
  selecting any other format brings them back.
- Switching rate mode from Quality to CBR swaps the value control's label and
  carries the bitrate value, not the quality value.
- The export call receives the selected format, rate mode, and value verbatim.

### Regression

Run the existing `backend/tests/test_interpolate.py` and
`src/features/interpolate/InterpolatePanel.test.tsx` after the §5.1 module move.

---

## 8. Build order

Each phase ends with a local commit and a stop for review.

1. **Shared modules** — §5.1 (Python encoder) and §5.1b (frontend format list).
   Pure moves, no behaviour change. Frame Interpolation's Python and frontend
   tests must both pass unchanged before anything else is written.
2. **Detection** — `analyzer.py` plus its unit tests. No UI, no rendering.
3. **CLI** — `deadframe_cli.py` with all three subcommands, driven from a
   terminal against a real clip. Verify the frame counts by hand before wiring
   anything to the app.
4. **Rust bridge** — commands, registration, capabilities, cancellation.
5. **Panel** — queue, players, controls, the export gate and its tests.
6. **Sidebar + styles** — the tab entry and visual pass.

---

## 9. Known sharp edges

These are accepted, not open questions. They are written down so nobody
"fixes" them by adding controls the product decision excluded.

- **One setting exports the whole queue.** The user previews one clip and ships
  forty. The per-clip counts in the queue are the only warning system. This is
  deliberate; do not add per-clip sensitivity.
- **Grainy sources may be uncleanable.** Film grain changes every frame enough
  to look like motion. The live count will read near zero and that is the
  correct, honest answer.
- **Every output is a re-encode.** Frames cannot be removed without one. The
  quality-based rate mode keeps the loss negligible.
- **Re-exporting overwrites.** Same suffix, same destination. The user changes
  the suffix if they want to keep both.
