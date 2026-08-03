# Smart Cut export — adversarial technical review

**Reviewed commit:** `5d8666d`  
**Review date:** 2026-07-29  
**Verdict:** **Do not merge as-is.**

Smart Cut can currently produce a successful-looking file with the wrong opening frame, missing audio, or an undecodable later section. Three release blockers were reproduced with generated media. Four additional defects affect cancellation, incomplete output cleanup, the wrong-footage fallback, and the verification script.

No application source was changed during this review.

## Decision summary

### Release blockers

1. A source whose timestamps begin above zero can take the direct-copy shortcut at the wrong moment. The result can begin on the wrong frame and run too long.
2. A merge containing H.264 and HEVC clips can finish successfully, but the later section is interpreted as the wrong codec and does not decode.
3. A merge whose first clip is silent drops audio from every later clip while still reporting success.

### Should-fix defects

4. A Cancel click can be forgotten if it lands between two processing stages.
5. A failed or cancelled final write can leave a broken `.mkv` at the user-facing destination.
6. The wrong-footage fallback accepts up to ten percent frame-count drift and treats an unavailable count as a match.
7. The verification script compares packet lengths rather than packet contents, so it can approve wrong media and reject a valid copy.

## Scope and method

The review covered:

- The approved implementation brief and its as-built deviations.
- The Smart Cut changes in the Rust export backend.
- The Smart Cut type and frontend preset wiring.
- The frontend tests added for the preset.
- The development-only verification script.
- The lossless merge before and after its shared-helper refactor.

Checks performed:

- Diffed the lossless merge before and after the refactor.
- Traced single export, merge export, timestamp probing, audio cutting, final writing, cancellation, and cleanup.
- Generated H.264, HEVC, silent, audio, and non-zero-timestamp samples with FFmpeg.
- Exercised the same joins and cuts used by Smart Cut.
- Ran the Rust, TypeScript, and frontend test suites.

## Findings

### 1. Blocker — non-zero source timestamps can produce the wrong cut

**What the user observes**

A requested four-second clip can begin on the wrong image and contain about five seconds of video. The export reports a normal completion because the direct-copy process itself succeeds.

**Reproduced input and result**

- H.264 video at 24 fps.
- The video stream began at timestamp `1.000`.
- Keyframes occurred every two seconds.
- Requested content range: `3.000` through `7.000`.
- Expected video frames: `96`.
- Produced video frames: `122`.
- Produced duration: about `5.08` seconds.
- The first-frame comparison failed.

**Why it happens**

The keyframe scan returns timestamps from the source’s original timeline. Clip ranges are measured from the beginning of visible content. Those values are compared without subtracting the stream’s start timestamp.

Source timestamp `3.000` was therefore treated as content time `3.000`. The export incorrectly concluded that the requested start already sat on a keyframe and used direct copy. In the content-relative timeline, that keyframe was actually at two seconds.

**Smallest safe fix**

1. Include the video stream’s start timestamp in the source probe.
2. Convert every keyframe timestamp to the same zero-based timeline used by clip ranges.
3. Use that normalized time for the keyframe comparison, head duration, and body seek.
4. Add a media test using a `+1.000` second stream offset. Assert the first frame and exact frame count.

**Code references**

- `src-tauri/src/clips.rs:644` — the video probe does not retain a start timestamp.
- `src-tauri/src/clips.rs:686` — returned packet timestamps remain on the source timeline.
- `src-tauri/src/clips.rs:1882` — the direct-copy decision compares the unnormalized timestamp with a zero-based clip start.

---

### 2. Blocker — mixed H.264 and HEVC merges can create an undecodable result

**What the user observes**

The merge finishes and creates an `.mkv`, but playback breaks when it reaches the clip that uses the other codec. The file looks valid in the export folder and is identified as H.264 even though its later packets contain HEVC video.

**Reproduced input and result**

- Segment 1: one-second H.264 video.
- Segment 2: one-second HEVC video.
- The final join exited successfully.
- The result advertised one H.264 video stream.
- Decoding the second section produced invalid-data errors and no usable frames.

**Why it happens**

Every selected clip is cut independently, then the temporary files are joined without confirming that their video descriptions match. The first temporary file defines the codec for the entire output. Later packets are copied under that first description even when they use another codec.

The color information is also taken from only the first input. That does not cause the reproduced codec failure, but it confirms that the merge assumes compatible sources without enforcing the assumption.

**Smallest safe fix**

Inspect all unique input sources before creating temporary or final files. Refuse the merge unless the relevant video properties are compatible:

- Codec family.
- Pixel layout and bit depth.
- Width and height.
- Frame rate and timing base.
- Profile and other stream parameters required by the final container.

The refusal must happen before any final output is opened.

**Code references**

- `src-tauri/src/clips.rs:1455` — only the first source supplies shared color information.
- `src-tauri/src/clips.rs:1478` — the Smart Cut merge starts without a compatibility preflight.
- `src-tauri/src/clips.rs:2186` — clips are processed independently.
- `src-tauri/src/clips.rs:2226` — all completed segments are copied into one final stream without validation.

---

### 3. Blocker — a silent first clip removes later audio

**What the user observes**

The merge reports success, but the result is silent even though later selected clips contain sound. Changing the selection order changes the result: placing the clip with audio first retains an audio stream.

**Reproduced input and result**

- Segment 1: one-second silent H.264 video.
- Segment 2: one-second H.264 video with AAC audio.
- The final join exited successfully.
- The resulting file contained video only.

**Why it happens**

The first temporary file defines which streams exist in the joined result. When that first file has no audio, later audio is discovered during the join but is not added to the already-established output layout.

The backend checks which source files contain audio before choosing the Smart Cut merge path, but that information is not used to normalize the temporary files or build a separate audio timeline.

**Smallest safe fix**

Build video and audio separately:

1. Join the Smart Cut video segments.
2. Build a matching audio timeline.
3. Insert correctly timed silence for clips without audio.
4. Join or encode the audio timeline into one consistent stream.
5. Combine the finished video and audio.

If that work is deferred, reject mixed silent/sound merges with a clear message. Silent deletion is not an acceptable fallback.

**Required tests**

- Silent clip followed by an audio clip.
- Audio clip followed by a silent clip.
- Audio, silent, then audio.
- All-silent merge.

**Code references**

- `src-tauri/src/clips.rs:1447` — audio presence is inspected.
- `src-tauri/src/clips.rs:1478` — the Smart Cut merge does not receive or use the inspected layout.
- `src-tauri/src/clips.rs:2204` — each temporary segment keeps its original presence or absence of audio.
- `src-tauri/src/clips.rs:2226` — the final join trusts the first segment’s stream layout.

---

### 4. Should-fix — Cancel can be ignored between processing stages

**What the user observes**

The user clicks Cancel, but the next stage starts and the export continues. This happens only when the click lands after one FFmpeg process exits and before the following process starts.

**Why it happens**

Cancellation terminates only the process whose identifier is stored at that moment. A completed process clears that identifier. If Cancel runs during the resulting gap, it has nothing to terminate and records no lasting cancellation state. The next stage then starts normally.

Smart Cut introduces several sequential stages per clip:

- Opening-frame re-encode.
- Body copy.
- Video join.
- Audio copy.
- Final audio/video write.

The number of gaps makes this race more likely than it is for a single-process preset.

**Smallest safe fix**

- Record a cancellation generation or flag for the complete export.
- Check it before every new process starts.
- Check it again after every process returns.
- Reset it only when a new top-level export begins.

**Code references**

- `src-tauri/src/video_cmds.rs:664` — a finished process clears the stored identifier.
- `src-tauri/src/clips.rs:1987` — the next Smart Cut process can start immediately afterward.
- `src-tauri/src/clips.rs:3958` — Cancel terminates current processes but does not persist a request for the whole export.

---

### 5. Should-fix — cancellation or failure can leave a broken final file

**What the user observes**

The export folder contains a file with the requested final name even though the export failed or was cancelled. A forced cancellation reproduced a zero-byte `.mkv`.

**Why it happens**

Three Smart Cut operations write directly to the final destination:

- The direct-copy shortcut.
- The final audio/video write for a normal single clip.
- The final join for a merge.

Temporary working folders are guarded and cleaned, but the user-facing destination is not. Once FFmpeg opens it, an error or forced termination can leave it behind.

**Smallest safe fix**

Write each final operation to a sibling temporary filename. Rename it to the requested destination only after FFmpeg succeeds. Remove the temporary file on every error and cancellation path.

**Code references**

- `src-tauri/src/clips.rs:1895` — direct copy writes to the final path.
- `src-tauri/src/clips.rs:2152` — the final audio/video write uses the final path.
- `src-tauri/src/clips.rs:2226` — the merge join uses the final path.

---

### 6. Should-fix — the wrong-footage fallback accepts excessive drift

**What the user observes**

A copied body can be visibly short or long without triggering the full re-encode fallback. If the frame inspection fails entirely, the export assumes the body is correct.

**Concrete arithmetic**

For a 20-second body at 24 fps:

- Expected: `480` frames.
- Allowed difference: `48` frames.
- Accepted range: `432` through `528` frames.
- Visible error still accepted: up to two seconds.

The review contract explicitly prefers an unnecessary fallback over accepting wrong footage, so a ten-percent allowance is opposite to the required risk tradeoff.

**Why it happens**

The allowance grows with the requested body length. The inspection failure path also substitutes the expected count, turning an unknown result into a successful match.

Length alone cannot prove that the body came from the intended moment, but the present threshold also fails at its narrower job of detecting a clearly wrong length.

**Smallest safe fix**

- Use a small fixed allowance measured in frames.
- Treat an unavailable count as a reason to re-encode.
- For stronger protection, confirm that the first copied picture matches the intended source picture.

**Code reference**

- `src-tauri/src/clips.rs:2037`

---

### 7. Should-fix — the verification script can pass wrong content and fail a valid copy

**What the reviewer observes**

The script can call two packets identical when only their byte lengths match. Constant-size audio can therefore appear aligned even when it came from the wrong moment. The script can also reject a valid copied body after harmless container-level packet changes.

**Reproduced false failure**

- Generated H.264 source with a normal zero-based timeline.
- The intended head/body copy path completed.
- First-frame, seam, duration, and audio checks passed.
- Nineteen of twenty-one inspected video packet lengths matched.
- The script required twenty and returned an overall failure.

**Why it happens**

Packet length is not packet identity. Different compressed data can have the same size, while the same underlying video can gain or lose a small amount of container framing during conversion.

The audio check has the same weakness. A codec that emits equal-size packets can make a shifted audio segment look correctly aligned.

The script also omits the backend’s post-copy fallback. A source that makes the app re-encode can still be tested as a splice by the script, so the script and app may validate different outputs.

**Smallest safe fix**

- Compare hashes of normalized video packet contents rather than sizes.
- Explicitly remove only the documented access-unit and container framing differences before comparison.
- Compare decoded audio fingerprints at the requested source time.
- Apply the same fallback decision as the application before running output checks.

**Code references**

- `scripts/devtools/verify-smart-cut.mjs:191` — packet length is treated as proof of identity.
- `scripts/devtools/verify-smart-cut.mjs:328` — the script builds its own pipeline.
- `scripts/devtools/verify-smart-cut.mjs:520` — the body proof compares sizes.
- `scripts/devtools/verify-smart-cut.mjs:544` — audio alignment also relies on packet sizes.

## Invariant results

| # | Review target | Result | Technical conclusion |
|---:|---|---|---|
| 1 | Lossless-cut behavior stayed identical | Pass | The extracted helper preserves the previous FFmpeg flags, values, segment order, and progress events. |
| 2 | Opening-frame accuracy | Partial | The ordinary zero-start sample passed. A non-zero stream start defeats the direct-copy decision. |
| 3 | Copied body remains original video | Partial | The cleanup filter is limited to Smart Cut and selected by codec, but the verifier does not prove byte identity. |
| 4 | Audio/video alignment | Partial | A normal cut below the 15-second backoff aligned. Silent-first merges delete later audio. |
| 5 | Joined timestamps begin cleanly | Partial | The zero-start sample begins near zero. Offset source timelines are not normalized. |
| 6 | Transport intermediates carry only supported video | Pass | Audio never enters the transport segments, and only accepted H.264/HEVC sources reach them. |
| 7 | Refusals and failures leave no debris | Partial | Unsupported formats refuse before temporary work, but interrupted final writes can leave a destination file. |
| 8 | Cancel stops the complete export | Fail | A request between child processes is forgotten. |
| 9 | Wrong-body fallback cannot miss | Fail | Ten-percent drift is accepted, and an unavailable count is treated as correct. |
| 10 | Frame-rate guard and rational parsing | Pass | Missing and zero rates refuse. `24000/1001` versus `24/1` remains inside the intended tolerance. |
| 11 | Keyframe lookup | Partial | Flags, malformed rows, packet ordering, and decimal formatting are handled. Source start timestamps are not. |
| 12 | Merge mode | Fail | Mixed codecs corrupt later video; a silent first clip removes later sound. |
| 13 | Frontend parity | Pass | The preset is enabled in CPU and GPU modes, uses MKV, hides quality controls, and appears below Lossless cut. |

## Verification results

### Automated checks

| Check | Result |
|---|---:|
| Rust tests | 125 passed |
| TypeScript compilation | Passed |
| Frontend test files | 65 passed |
| Frontend tests | 913 passed, 2 skipped |

The existing suites do not cover non-zero source timestamps, mixed-codec Smart Cut merges, silent-first merges, cancellation between stages, or incomplete final-file cleanup.

### Generated-media checks

| Scenario | Result |
|---|---|
| Ordinary zero-start H.264 cut | First frame and audio alignment passed |
| H.264 source with `+1.000` second start timestamp | Wrong first frame; 122 frames produced instead of 96 |
| H.264 followed by HEVC | Join succeeded; later section did not decode correctly |
| Silent H.264 followed by H.264/AAC | Join succeeded; output contained no audio stream |
| Interrupted final write | Final destination remained as a zero-byte file |
| Verification script on ordinary H.264 copy | Four of five checks passed; size-based copy proof returned a false failure |

## Required merge gate

Do not merge until all three blocker outcomes are prevented:

1. A source with a non-zero start timestamp exports the requested first frame and frame count on the zero-based clip timeline.
2. A merge rejects incompatible video before writing, or produces a result that decodes completely.
3. Mixed silent/sound selections retain a correct audio timeline regardless of order.

The next validation pass should also include:

- Cancellation during every gap between Smart Cut stages.
- Failure during each final-write path with confirmation that no destination remains.
- A body-count inspection failure that forces re-encode.
- A long body whose frame count differs by less than ten percent but more than a few frames.
- Packet-content and audio-fingerprint verification rather than packet-size matching.
