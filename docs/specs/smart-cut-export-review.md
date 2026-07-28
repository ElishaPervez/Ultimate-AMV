# Smart Cut export — review brief (for Codex)

You are reviewing a freshly implemented feature in this repo (Tauri app:
Rust backend `src-tauri/`, React/TS frontend `src/`, bundled ffmpeg/ffprobe).
The feature was implemented by another agent from the spec in
`docs/specs/smart-cut-export.md`; read that spec first (including its
"As-built deviations" section), then review the implementation adversarially.
Your job is to find real defects, not to restyle code.

## What the feature does

New clip-export preset `smart-cut`: frame-accurate clip exports that stream-copy
almost everything. Per clip: probe the first keyframe at-or-after the requested
start → re-encode only [start, keyframe) at near-transparent quality (CPU
x264/x265, matched to source codec family + bit depth) → stream-copy
[keyframe, end) → join → mux with separately-cut audio into MKV. Cuts landing
on a keyframe take a pure-copy fast path. Unsupported sources (AV1, VP9, VFR,
odd bit depths) refuse with a friendly error instead of producing broken files.

## Scope of the diff

All feature code is in the working tree as one commit
(`feat: smart cut export preset...`). Files:

- `src-tauri/src/clips.rs` — ~975 lines added: preset plumbing, pure parsing
  helpers, ffprobe wrappers, `run_smart_cut_clip`, `run_smart_cut_merge`,
  shared `TempDirGuard`/`concat_copy_segments` factored out of
  `run_lossless_cut_merge`, `smart_cut_tests` module.
- `src/types/clip.ts` — union member.
- `src/features/clips/ClipExtractorPanel.tsx` — dropdown entry, extension map,
  quality/rate-control exclusions, progress-weight maps.
- `src/features/clips/ClipExtractorPanel.test.tsx` — mirrored + new tests.
- `scripts/devtools/verify-smart-cut.mjs` — dev-only verification script
  (nothing imports it). Review it too: a wrong verifier is worse than none.

## Hard invariants — try to refute each

1. **Lossless-cut is byte-identical in behavior.** The refactor extracted
   temp-dir + concat logic that `run_lossless_cut_merge` now shares. Diff the
   before/after argument vectors and progress events for the lossless path;
   any drift (flag order changes are fine, flag *set* changes are not) is a bug.
2. **Frame accuracy of the head.** `-ss` before `-i` with re-encode must be
   frame-accurate; check the exact seek/duration arithmetic (padded start from
   `padded_clip_range`, half-frame keyframe tolerance, `kf − start` duration).
   Off-by-one-frame reasoning errors are the most likely defect class here.
3. **Body packets are untouched source bytes.** The join path runs
   `-bsf:v h264_metadata=aud=remove` / `hevc_metadata=aud=remove` (to strip
   AUDs that the MPEG-TS intermediates add). Verify this bitstream filter runs
   only where intended and cannot alter non-AUD NALs; verify the h264 vs hevc
   selection matches the source codec everywhere (including merge mode with
   multiple inputs).
4. **A/V sync of the final mux.** Audio is cut in a separate ffmpeg run
   (two-stage seek: `-ss start−15 -i src -ss 15`) and muxed with the joined
   video at the end. Scrutinize: the 15 s pre-roll constant (what if
   start < 15 s? what if the file starts at a nonzero timestamp?), rounding of
   the audio cut vs the video head start, and whether the final mux can drift
   when the video ends up frames longer than requested (open-GOP tail case).
5. **No `-avoid_negative_ts make_zero` on copied pieces** was a deliberate
   choice (it shifted packets and dragged pre-keyframe frames into the body).
   Check the consequence: do the TS intermediates and final concat produce a
   file starting at t≈0 with monotonic timestamps for every path (head+body,
   pure-copy, full-re-encode fallback, merge)? Negative or gapped initial
   timestamps in the MKV output would be a real defect.
6. **MPEG-TS intermediate limits.** TS only carries certain audio codecs — the
   design routes audio around TS, so confirm no path ever puts audio into a TS
   segment. Also check pure-copy fast path and merge segments: which container
   do they use, and are H.264/HEVC the only codecs that can reach the TS path
   (they should be, given the refusal matrix)?
7. **Refusal paths are clean.** AV1/VP9/VFR/9-12-16-bit refusals must happen
   before anything is written; any early-return after temp-dir creation must
   still clean up (TempDirGuard held across every exit). No partial output file
   may remain on error or cancel.
8. **Cancel safety.** Every spawned ffmpeg (probes excluded, they're
   short-lived `cmd()` calls — confirm) runs through
   `run_ffmpeg_with_progress(..., Some(&CLIP_CHILD_PID))`. A cancel between
   two sequential runs must not orphan the next child.
9. **Frame-count fallback guard.** After the body copy, the frame count is
   compared with the expected count; mismatch → full re-encode fallback
   (protects against sources whose keyframe index is broken, where a copy
   silently yields footage from the wrong part of the file). Check the
   expected-count arithmetic (fps rounding, VFR guard interplay) and that the
   fallback encodes with the same quality/color treatment as other presets —
   a false-positive fallback is acceptable, a false-negative is not.
10. **VFR guard + fps math.** `avg_frame_rate` vs `r_frame_rate` ~1% rule:
    check rational parsing (0/0, "N/A", missing fields) and that anime-standard
    24000/1001 vs 24 doesn't get misclassified.
11. **Keyframe probe.** `-read_intervals <start>%+40` window: packets arrive in
    DTS order, code must select the minimum qualifying PTS (B-frame reorder);
    "no keyframe in window" → whole-clip re-encode. Check the parse against
    flags like `K__`, `K_`, and csv edge cases; check `start` formatting with
    locales/precision.
12. **Merge mode.** Mixed audio/no-audio inputs, per-input codec differences
    (input A h264, input B hevc — is that refused or mishandled?), and the
    concat list escaping for paths with quotes.
13. **Frontend parity.** Preset visible + enabled in CPU and GPU mode, no
    quality/rate controls, progress weights sane, extension label mkv — and
    nothing else in the dropdown regressed.

## Known accepted limitations (do NOT report these as findings)

- Open-GOP HEVC sources can carry a few undecodable leading pictures at the
  seam; players drop them; clip can run a few frames long.
- Devtool duration tolerance is 0.25 s (packet-boundary reality).
- AV1/VP9/VFR/odd-bit-depth sources are refused by design.
- Real anime MKV sources were NOT tested end-to-end (only MP4 samples —
  ffmpeg-generated MKVs had broken keyframe indexes). If you can reason about
  an MKV-source-specific failure mode the frame-count guard would NOT catch,
  that IS a finding, and a valuable one.

## How to verify

- `cd src-tauri && cargo test` (unit tests only, no media needed).
- Repo root: `npx tsc --noEmit`, `npx vitest run` (full suite ~913 tests).
- Optional real-media check: `node scripts/devtools/verify-smart-cut.mjs
  <source.mp4> <start> <end>` with the bundled ffmpeg (see `--ffmpeg`/
  `--ffprobe` flags); `--expect-refusal` for AV1/VFR samples.

## Report format

For each finding: file:line, severity (blocker / should-fix / nit), the
concrete failure scenario (inputs/state → wrong observable output), and the
smallest fix you'd suggest. Verify each finding against the actual code before
reporting — no speculative findings. If an invariant survives your attack,
say so in one line; don't pad. End with a verdict: mergeable as-is, or list
of blockers.
