# Smart Cut export — implementation spec

Decision context: `docs/reports/smart-cut-export-2026-07-28.html` (approved 2026-07-28).
Approved shape: **CPU head encoder always** (identical behavior in CPU and GPU clip
mode), **audio stream-copied**, **MKV output**, pure-copy fast path when the cut
lands on a keyframe, clean refusal for sources we can't splice safely.

## What it is

A new clip-export preset `smart-cut` for the scene splitter (clip extractor).
Per exported clip:

1. **Probe** the source's video properties and the first keyframe at-or-after
   the requested start.
2. **Head segment** (requested start → that keyframe): re-encode at
   near-transparent quality with an encoder configured to match the source's
   codec family, bit depth, and pixel format.
3. **Body segment** (that keyframe → requested end): `-c copy`, byte-exact.
4. **Concat** head + body with the concat demuxer, `-c copy`, into one `.mkv`.

Result: first frame is exactly the requested frame; everything from the first
keyframe onward is the original bitstream.

## Files to touch

| File | Change |
| --- | --- |
| `src-tauri/src/clips.rs` | preset plumbing, probe helpers, smart-cut single-export branch, smart-cut merge branch, unit tests |
| `src/types/clip.ts` | add `"smart-cut"` to the `ClipExportFormat` union (line ~142) |
| `src/features/clips/ClipExtractorPanel.tsx` | extension map (~3771), quality spec → `null` (~3791), `formatSupportsRateControl` → `false` (~3878), progress-weight maps (~394 and ~406 — mirror what `lossless-cut` does there), dropdown entry in `clipExportOptions` (~3902, directly under Lossless cut) |
| `src/features/clips/ClipExtractorPanel.test.tsx` | mirror the existing `lossless-cut` test cases for the new preset |
| `scripts/devtools/verify-smart-cut.mjs` | dev-only verification script (below) — not referenced by app code, so it ships nowhere |

## Backend detail (`clips.rs`)

### Preset plumbing

- Add `"smart-cut"` to `VIDEO_PRESETS` and `VIDEO_PRESET_ERROR` (clips.rs:48–61).
- `preset_extension("smart-cut")` → `"mkv"` (same rationale as lossless-cut: MKV
  tolerates arbitrary source codecs).
- `preset_supports_rate_control("smart-cut")` → `false` (clips.rs:480). No
  quality/rate controls — head quality is fixed near-transparent.

### Probe helpers (new)

**Source video params** — one ffprobe call:
`-select_streams v:0 -show_entries stream=codec_name,pix_fmt,width,height,avg_frame_rate,r_frame_rate -of json`.

**Keyframe lookup** — one ffprobe call scanning a bounded window, not the whole file:
```
ffprobe -v error -select_streams v:0 \
  -show_entries packet=pts_time,flags \
  -read_intervals <start>%+40 -of csv=p=0 <input>
```
Parse lines, find the first packet whose flags contain `K` and whose `pts_time`
≥ requested start (use a half-frame tolerance: if a keyframe sits within
`0.5/fps` of the requested start, treat the cut as ON the keyframe). If no
keyframe exists in the 40 s window (start near EOF or absurd GOP), re-encode
the entire clip head-to-end — correctness over speed, and it only happens on
degenerate sources. Packets can arrive out of pts order (B-frames) — sort or
scan for the minimum qualifying pts, don't assume the first `K` line is the
earliest.

### Supported sources / clean refusal

Head encoder matrix (CPU only, deliberately — identical output in CPU and GPU
clip mode, and libx264/libx265 splice most reliably):

| Source codec + pix_fmt | Head encoder args |
| --- | --- |
| `h264` + 8-bit (`yuv420p` etc.) | `libx264 -preset medium -crf 12 -pix_fmt <source pix_fmt>` |
| `h264` + 10-bit (`yuv420p10le`) | `libx264 -preset medium -crf 12 -profile:v high10 -pix_fmt yuv420p10le` |
| `hevc` + 8-bit | `libx265 -preset medium -crf 14 -pix_fmt <source pix_fmt>` |
| `hevc` + 10-bit (`yuv420p10le`/`p010le`) | `libx265 -preset medium -crf 14 -pix_fmt yuv420p10le` |
| anything else (`av1`, `vp9`, `mpeg4`, …) | **refuse** |

Refusal is a normal `Err(String)` surfaced by the existing error path, worded
for the user, e.g.: `Smart cut can't splice this source's video format (av1).
Use "Lossless cut" for a byte-exact export (cuts snap to keyframes) or any
re-encode preset for frame-accurate output.`

VFR guard: if `avg_frame_rate` and `r_frame_rate` disagree by more than ~1%
the source is variable-frame-rate; refuse with the same style of message
(timing across the splice is not predictable). Compute fps for tolerances from
`avg_frame_rate`.

The head re-encode gets the existing color treatment: `-vf setparams_filter(&color)`
plus `color_tag_args(&color)` (clips.rs:86, and see how run_clip_export applies
them at ~840–851). The body copy and the final concat get **no** color flags —
`-c copy` carries the original tags (same rule as lossless-cut).

### Single-clip export (`run_clip_export`, clips.rs:640)

Add a `"smart-cut"` match arm. Unlike the other arms it can't share the single
ffmpeg invocation, so structure it as a helper
`run_smart_cut_clip(window, ffmpeg, ffprobe, input, start, duration, output) -> Result<(), String>`
called from the arm (mind the shared `run_ffmpeg_with_progress` /
`CLIP_CHILD_PID` plumbing so cancel still kills the active child — same as
lossless merge does today).

Timing comes from `padded_clip_range` like every other preset. Let
`start`/`end` be the padded values, `kf` the found keyframe time:

- **Cut on keyframe** (|kf − start| < 0.5/fps): single ffmpeg run, identical
  to today's lossless-cut args (`-ss` before `-i`, `-t`, `-map 0:v:0 -map 0:a:0?`,
  `-c copy -avoid_negative_ts make_zero`) except with the exact kf timestamp —
  no temp files, done.
- **Normal case**: temp dir next to the output (pattern: lossless merge's
  `.losslesscut_tmp_<pid>` + `TempDirGuard`, clips.rs:1353–1364).
  - Head: `-ss <start> -i <input> -t <kf − start> -c:v <matrix above>
    -c:a copy` + color args, `-avoid_negative_ts make_zero`, → `head.mkv`.
    (`-ss` before `-i` **with re-encode** is frame-accurate — ffmpeg decodes
    forward from the prior keyframe and discards; only `-c copy` snaps.)
  - Body: `-ss <kf> -i <input> -t <end − kf> -map 0:v:0 -map 0:a:0?
    -c copy -avoid_negative_ts make_zero` → `body.mkv`.
  - Concat: concat-demuxer list (single-quote escaping per clips.rs:1416) with
    `-c copy` → final output. Reuse/extract the list-writing + concat logic
    from `run_lossless_cut_merge` rather than duplicating it.
- Progress: reuse `emit_conversion_progress` staging like the lossless merge
  (segment cuts up to ~90%, concat 92%+). Head/body/concat all run through
  `run_ffmpeg_with_progress` with `Some(&CLIP_CHILD_PID)` so cancel works.

### Merge export (`run_clip_merge` area, clips.rs:1063)

`preset == "smart-cut"` routes to a `run_smart_cut_merge` that is
`run_lossless_cut_merge` with one change: each segment is produced by the
head+body+concat procedure above (or the pure-copy fast path) instead of a
single keyframe-snapped copy. Factor the shared concat/list/progress code so
the two merges don't diverge. Audio-less inputs: same tolerance as today
(`-map 0:a:0?` on every segment).

### Rust tests (`rate_control_tests` mod + new mod)

- `preset_extension("smart-cut") == "mkv"`; rate-control rejection mirrors
  lossless-cut's existing test (clips.rs:615).
- Unit-test the pure functions: keyframe-line parsing (flags `K__`, out-of-order
  pts, empty result), the encoder matrix (each row + refusal cases + VFR
  refusal), and the on-keyframe tolerance. Design them as pure functions taking
  strings/values so no ffprobe binary is needed in tests.

## Frontend detail

Dropdown entry (directly under Lossless cut):

- label: `Smart cut (frame-accurate, no quality loss)`
- description: `Copies the original like Lossless cut, but re-encodes only the
  first fraction of a second so the clip starts on the exact frame. H.264/HEVC
  sources only. Saved as MKV.`
- `disabled: false` in both CPU and GPU mode.

No quality slider, no rate control (both already follow from the function
changes above). Persistence: the preset value flows through the existing
export-format config field — verify no allow-list needs a new key (memory says
config keys need three touch points; the preset reuses an existing key, so
expect zero config changes — but check).

## Verification devtool (`scripts/devtools/verify-smart-cut.mjs`)

Node script, run manually in dev only (nothing imports it, so real builds are
unaffected). Usage:
`node scripts/devtools/verify-smart-cut.mjs <source> <start> <end> [--keep]`.

1. Runs the same probe + head/body/concat steps with the repo's bundled
   ffmpeg/ffprobe (`tools/…` — locate the same way `find_tool` resolves, or
   accept `--ffmpeg`/`--ffprobe` flags).
2. Verifies, printing PASS/FAIL per check:
   - **Frame accuracy**: extract output frame 0 and source frame at `<start>`
     (re-encode extraction), compare with ffmpeg SSIM ≥ 0.98.
   - **Joint integrity**: decode ~10 frames around the head/body boundary
     (`-ss kf−5×frame -t 10×frame`) to PNGs; assert decode succeeds and
     consecutive-frame SSIM shows no outlier (no gray/glitch frame at the splice).
   - **Duration**: output duration within one frame of `end − start`.
   - **Stream copy proof**: `ffprobe -show_packets` on the output body region
     — packet count/sizes match the source's for the same interval.
3. Exit code 0 only if all pass — usable in a loop across an H.264 8-bit, an
   HEVC 10-bit, and (expected-refusal) an AV1/VFR sample.

## Acceptance checklist

- [ ] `smart-cut` appears in the dropdown in CPU **and** GPU clip mode; no quality/rate controls shown.
- [ ] Export of an H.264 8-bit source: starts on the exact frame; body is byte-identical packets; plays cleanly across the joint.
- [ ] Same for HEVC 10-bit (this is the `p010` family that broke GPU preview before — memory `project_10bit_scale_cuda_bug`; smart cut never touches CUDA so it must simply work).
- [ ] Cut on an existing keyframe produces a pure copy (no temp files, single ffmpeg run).
- [ ] AV1 and VFR sources refuse with the friendly message; nothing half-written is left on disk (TempDirGuard).
- [ ] Cancel mid-export kills the active ffmpeg child; temp dir is cleaned.
- [ ] Merge-mode export works with mixed audio/no-audio inputs.
- [ ] `cargo test` and the frontend test suite pass; new unit tests cover the parsing/matrix/tolerance functions.
- [ ] Devtool passes on H.264 + HEVC samples.

## As-built deviations (2026-07-28)

The implementation kept the user-facing behavior above but restructured the
pipeline after real-media testing showed the literal design produced broken
files. Authoritative as-built description + review targets:
`docs/specs/smart-cut-export-review.md`. Headlines: head/body segments are
video-only with audio cut separately and muxed at the end (copied audio next
to re-encoded video stretched clips seconds too long); the join goes through
MPEG-TS intermediates instead of MKV (MKV's single header-level parameter set
rejected the body's packets — hard failure on HEVC); no `-avoid_negative_ts
make_zero` on copied pieces (it dragged pre-keyframe frames into the body);
audio uses a two-stage seek so its cut doesn't snap to a video keyframe; a
post-copy frame-count guard falls back to full re-encode for sources whose
keyframe index is broken.

## Non-goals (explicitly out of scope)

- NVENC head encoding, AV1 source support, audio re-encode toggle, MP4 output,
  VFR support — all future work, listed in the report.
