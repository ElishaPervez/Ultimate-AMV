# Spec: CBR for every re-encoding export format + grid preview speed multiplier

Target implementer: GPT (Codex). Two independent features, no shared code.
Ship them as two separate commits. Do not touch the frame-interpolation area —
that is a separate, later workstream.

Repo conventions that apply:
- Local commit per feature, no push, no build unless explicitly asked.
- No `Co-Authored-By` trailer.
- Every feature must work in both CPU and GPU clip modes.
- Tests: `npx vitest run` (frontend), `cargo test` in `src-tauri` (Rust),
  `pytest` from repo root with `.venv\Scripts` on PATH (backend).

---

# FEATURE 1 — Rate control (Quality / VBR / CBR) for every re-encoding preset

## 1.1 Current state (verified, do not re-derive)

Rate control already exists end-to-end, but it is reachable from only two of the
ten export presets.

The frontend gate — `src/features/clips/ClipExtractorPanel.tsx:3667-3669`:

```ts
export function isH264TenBitFormat(format: ClipExportFormat): boolean {
  return format === "h264-10bit-nvenc" || format === "h264-10bit-cpu";
}
```

Used at `ClipExtractorPanel.tsx:2927` to mount `<ClipRateControl>` and at
`:2936` to hide the quality slider when a bitrate mode is active.

The Rust side — `src-tauri/src/clips.rs`:
- `H264RateMode` enum + `h264_rate_mode()` parser: `:211-225`
- `h264_bitrate_arg()` / `h264_buffer_arg()` (bufsize = 2x bitrate): `:227-241`
- `h264_10bit_nvenc_video_args()`: `:245-285`
- `h264_10bit_cpu_video_args()`: `:287-321`

Everything else (`gpu-intra`, `h264-nvenc`, `av1-nvenc`, `h264-cpu`, `hevc-cpu`)
is hard-wired to constant quality inside the per-preset `match` blocks and never
receives `rate_mode` / `bitrate_mbps` at all.

Why the user only ever sees CBR on "H.264 10-bit CPU": `h264-10bit-nvenc` is
`disabled` unless clip mode is GPU **and** `gpuStatus.hasH264Nvenc`
(`ClipExtractorPanel.tsx:3730-3736`), so on a CPU-mode session the 10-bit CPU
preset is the only selectable format that satisfies `isH264TenBitFormat`.

## 1.2 Goal

Rate control (Quality / VBR / CBR) available on every preset that re-encodes with
a rate-controllable encoder. CBR here means **practical CBR**: a target bitrate
with `minrate == maxrate == target` and a fixed VBV buffer, which is what the
existing 10-bit implementation already emits. Do not add strict per-second
padding beyond the `-cbr_padding` flag already in use.

### Preset support matrix (this is the contract)

| Preset | Encoder | Rate control | Notes |
|---|---|---|---|
| `h264-cpu` | libx264 | **ADD** | 8-bit sibling of an already-working path |
| `h264-10bit-cpu` | libx264 | exists | no behaviour change |
| `hevc-cpu` | libx265 | **ADD** | see x265 flag note below |
| `h264-nvenc` | h264_nvenc | **ADD** | |
| `h264-10bit-nvenc` | h264_nvenc | exists | no behaviour change |
| `av1-nvenc` | av1_nvenc | **ADD** | see `-cbr_padding` probe note |
| `gpu-intra` | hevc_nvenc | **ADD** | all-intra; CBR is valid but unusual |
| `prores-lt` / `prores-hq` | prores_ks | **NO** | fixed-profile intra, no bitrate target exists |
| `lossless-cut` | `-c copy` | **NO** | no encode happens |

Out of scope: the Video→Video transcoder (`src-tauri/src/video_cmds.rs`), all
preview/proxy/compat encoders (`render_scene_clip_job`, `run_source_proxy_job`,
`preview_merge_encode_args`, `run_clip_compat_convert`). Those stay hard-coded.

## 1.3 Rust changes — `src-tauri/src/clips.rs`

### Step 1: generalize the naming

Rename with no behaviour change:
- `H264RateMode` → `RateMode`
- `h264_rate_mode()` → `parse_rate_mode()`
- `h264_bitrate_arg()` → `bitrate_arg()`
- `h264_buffer_arg()` → `buffer_arg()`

Keep the `"bitrate"` alias for `"vbr"` at `:221` — old payloads may still send it.
Keep the error strings byte-identical; tests and UI copy depend on them.

### Step 2: two shared rate-control emitters

Add next to the existing helpers:

```rust
/// NVENC family rate-control block. `quality_flag` is "-qp" or "-cq" depending
/// on the encoder's convention. `cbr_padding` gates the `-cbr_padding 1` flag,
/// which is only known-good on h264_nvenc in the bundled FFmpeg.
fn nvenc_rate_args(
    rate_mode: Option<&str>,
    quality: i32,
    quality_flag: &str,
    bitrate_mbps: Option<f64>,
    cbr_padding: bool,
) -> Result<Vec<String>, String>

/// libx264 / libx265 rate-control block. `cbr_params` is the encoder-specific
/// HRD argument pair, e.g. ("-x264-params", "nal-hrd=cbr"); pass None to omit.
fn x26x_rate_args(
    rate_mode: Option<&str>,
    quality: i32,
    bitrate_mbps: Option<f64>,
    cbr_params: Option<(&str, &str)>,
) -> Result<Vec<String>, String>
```

Emitted flags, exactly:

**`nvenc_rate_args`**
- Quality: `-rc constqp {quality_flag} {quality}`
- VBR: `-rc vbr -b:v {N}M`
- CBR: `-rc cbr -b:v {N}M -minrate {N}M -maxrate {N}M -bufsize {2N}M`
  plus `-cbr_padding 1` when `cbr_padding == true`

**`x26x_rate_args`**
- Quality: `-crf {quality}`
- VBR: `-b:v {N}M`
- CBR: `-b:v {N}M -minrate {N}M -maxrate {N}M -bufsize {2N}M`
  plus the `cbr_params` pair when `Some`

Then rewrite `h264_10bit_nvenc_video_args` and `h264_10bit_cpu_video_args` to
call these. **The argv they produce must be byte-identical to today** — the
existing tests at `clips.rs:323-396` must pass unmodified. Verify this before
moving on; it is the safety net for the whole refactor.

### Step 3: `-cbr_padding` support probe

`-cbr_padding` is a private NVENC option. It is proven on `h264_nvenc` in the
bundled FFmpeg (shipped and tested). It is **not** verified on `hevc_nvenc` or
`av1_nvenc`, and FFmpeg hard-errors on an unrecognized private option — the
export would fail outright rather than degrade.

Do this: pass `cbr_padding: true` only for the two `h264_nvenc` presets. For
`gpu-intra` (hevc_nvenc) and `av1-nvenc`, pass `false`. Before finishing, run
`ffmpeg -h encoder=hevc_nvenc` and `ffmpeg -h encoder=av1_nvenc` against the
bundled binary; if `cbr_padding` is listed for either, flip it on for that
preset and note it in the commit message. Do not guess.

### Step 4: thread `rate_mode` / `bitrate_mbps` into the five new presets

Both export workers already carry the two values as parameters:
- `run_clip_export()` — per-preset `match` at `clips.rs:466-649`
- `run_clip_export_merged()` — per-preset `match` at `clips.rs:944-1071`

For each of `h264-cpu`, `hevc-cpu`, `h264-nvenc`, `av1-nvenc`, `gpu-intra`,
replace the hard-coded quality flags with a call to the matching emitter.
Preserve every non-rate flag exactly as it is today (preset level, profile,
`-pix_fmt`, `-tag:v hvc1` on `hevc-cpu`, `-g`/intra flags on `gpu-intra`,
`-spatial-aq`/`-temporal-aq`, `-movflags +faststart`).

Quality clamps stay per-preset as they are now (`clamp_quality`, `clips.rs:204`):
gpu-intra 10-28/16, h264-nvenc 14-28/18, av1-nvenc 18-34/24, h264-cpu 14-28/18,
hevc-cpu 14-28/18. The clamp only applies in Quality mode.

`hevc-cpu` CBR flags: use `cbr_params: None`. FFmpeg already maps `-maxrate` and
`-bufsize` onto x265's VBV. Do **not** add `-x265-params vbv-maxrate=...` — it
duplicates and can conflict with the mapped values.

### Step 5: NVENC → CPU fallback must carry the rate settings

`clips.rs:683-746` (single) and `clips.rs:1107-1131` (merged) retry on CPU when
NVENC fails. Today only the 10-bit path forwards `rate_mode`/`bitrate_mbps`
(`:707`, `:1122`); the `gpu-intra` fallback hard-codes `libx264 -crf`.

Every fallback must now forward the user's rate mode and bitrate to the CPU
encoder. A user who picked CBR 20 Mbps must get CBR 20 Mbps from the fallback,
not a silent switch to constant quality. Map:
- `h264-nvenc` → libx264, same rate args
- `h264-10bit-nvenc` → libx264 10-bit, same rate args (unchanged)
- `av1-nvenc` → existing CPU fallback encoder, same rate args
- `gpu-intra` → libx264, same rate args

## 1.4 Frontend changes — `src/features/clips/`

### Step 1: replace the gate predicate

In `ClipExtractorPanel.tsx`, replace `isH264TenBitFormat` (`:3667-3669`) with:

```ts
export function formatSupportsRateControl(format: ClipExportFormat): boolean {
  switch (format) {
    case "prores-lt":
    case "prores-hq":
    case "lossless-cut":
      return false;
    default:
      return true;
  }
}
```

Keep `isH264TenBitFormat` exported as-is if anything else uses it; otherwise
delete it and update `ClipExtractorPanel.test.tsx:257-262`.

Update the two call sites:
- `:2927` — `{supportsRateControl && (<ClipRateControl ... />)}`
- `:2936` — `{qualitySpec && rateMode === "quality" && (<VideoOutputControl ... />)}`

Note the second condition simplifies: once every rate-controllable format shows
the mode switch, the quality slider is visible exactly when the mode is Quality.

### Step 2: per-format bitrate memory + sane defaults

Today `h264BitrateMbps` is a single `useState(20)` (`:383`). 20 Mbps is right for
H.264 and wasteful for AV1. Mirror the existing per-format quality memory
(`exportQuality`, `:384-395`) with a `exportBitrate: Record<ClipExportFormat, number>`:

| Preset | Default Mbps |
|---|---|
| `h264-cpu`, `h264-10bit-cpu`, `h264-nvenc`, `h264-10bit-nvenc` | 20 |
| `hevc-cpu` | 12 |
| `av1-nvenc` | 8 |
| `gpu-intra` | 60 |

Add a `clipBitrateDefault(format): number` helper next to `clipQualitySpec`
(`:3580`) and export it for tests.

Rate mode stays a single piece of state across formats (`h264RateMode`, rename to
`rateMode`), but reset it to `"quality"` whenever the selected format does not
support rate control, so switching to ProRes and back does not resurrect a stale
CBR selection. Put that in the existing format-change effect near `:1076-1093`.

### Step 3: payload build

`startExport()` at `ClipExtractorPanel.tsx:2601-2605` currently reads:

```ts
const rateMode = isH264TenBit ? h264RateMode : null;
const bitrateMbps = isH264TenBit && h264RateMode !== "quality" ? h264BitrateMbps : null;
const qualityValue = qualitySpec && (!isH264TenBit || h264RateMode === "quality")
  ? exportQuality[exportFormat] : null;
```

Becomes:

```ts
const supportsRc = formatSupportsRateControl(exportFormat);
const rateModeArg = supportsRc ? rateMode : null;
const bitrateMbps = supportsRc && rateMode !== "quality"
  ? (exportBitrate[exportFormat] ?? clipBitrateDefault(exportFormat))
  : null;
const qualityValue = qualitySpec && rateMode === "quality"
  ? exportQuality[exportFormat] : null;
```

Both invoke sites (`:2632-2639` merged, `:2641-2656` single) keep their existing
argument names — the Rust signature does not change.

### Step 4: copy

`ClipRateControl.tsx` labels stay Quality / VBR / CBR. Update the help text under
the bitrate field so it does not say "H.264". Describe what the modes do in plain
terms:
- Quality — "Picks the bitrate per scene to hit a consistent look. File size varies."
- VBR — "Aims for this average bitrate; busy scenes may go over."
- CBR — "Holds this bitrate throughout. Predictable file size, safe for streaming."

## 1.5 Tests

**Rust** — extend `mod h264_10bit_tests` at `clips.rs:323-396` (rename to
`rate_control_tests`):
1. The existing six tests must pass **unmodified**. Do not edit them.
2. New: for each of the five newly-enabled presets, assert the argv in all three
   modes — Quality emits the correct quality flag and no `-b:v`; VBR emits
   `-b:v` and no `-crf`/`-qp`/`-cq`; CBR emits `-b:v`, `-minrate`, `-maxrate`
   equal to each other and `-bufsize` at 2x.
3. New: assert `-cbr_padding` is present for h264_nvenc presets and **absent**
   for `av1-nvenc` and `gpu-intra` (unless the Step 3 probe says otherwise).
4. New: assert the NVENC→CPU fallback argv preserves rate mode and bitrate for
   all four GPU presets.
5. New: assert `prores-lt`, `prores-hq`, `lossless-cut` reject or ignore a
   `rate_mode` argument without emitting bitrate flags.

**Frontend** — `ClipExtractorPanel.test.tsx` / `ClipRateControl.test.tsx`:
1. `formatSupportsRateControl` matrix over all ten presets.
2. The rate-mode switch renders for `h264-cpu` (this is the regression that
   proves the feature — it does not render today).
3. Quality slider hidden in VBR/CBR mode, shown in Quality mode.
4. `clipBitrateDefault` returns the table values.
5. Switching format to `prores-lt` and back leaves the mode at Quality.
6. The invoke payload carries `rateMode: "cbr"` + `bitrateMbps` and
   `qualityValue: null` for a non-10-bit CBR export.

## 1.6 Known gap, do NOT fix in this commit

Export format, rate mode, bitrate and quality are plain `useState` in
`ClipExtractorPanel` (`:381-395`) with no persistence — they reset to
ProRes LT / Quality / 20 on every remount. Persisting them is a separate
decision (which config keys, and whether they belong in the backend config at
all). Leave it alone; mention it in the commit body as a follow-up.

---

# FEATURE 2 — Grid preview speed multiplier

## 2.1 Scope (confirmed with the user)

- Affects **grid tiles only**. The big scene viewer modal and exported files are
  untouched.
- The control appears in **two places**: the left tool column on the clip page
  (next to Columns) and the app Settings panel. Both write the same setting.
- Persisted in the backend config, immediate-save on change (no Save button).

## 2.2 How grid tiles play today (verified)

Two playback modes, chosen by the existing config flag `featherweight_previews`
(default **true**):

- **Featherweight (default):** a real `<video>` element per tile looping a
  sub-range of the source or a proxy file. Loop engine is
  `requestVideoFrameCallback`. `video.playbackRate` works here.
- **Legacy (flag off):** an animated WebP `<img>` baked at `fps=12` by FFmpeg
  (`src-tauri/src/preview.rs:470-472`). Browsers expose no API to change an
  animated image's rate. **Speed cannot be honoured in this mode.**

`playbackRate` appears nowhere in the repo today. There is no existing speed
feature — the "rate control" in commit 1bea915 is the export bitrate feature
covered by Feature 1 above.

## 2.3 Config plumbing — three backend edits

New key: `clip_preview_speed`, float, default `1.0`, clamped to `[0.25, 4.0]`.

1. **`backend/amv_audio/config.py:25-42`** — add to `DEFAULT_CONFIG`:
   `"clip_preview_speed": 1.0,`
2. **`backend/audio_cli.py:82-109`** — add to the `_config_payload` allow-list:
   `"clip_preview_speed": float(cfg.get("clip_preview_speed", 1.0)),`
3. **`backend/audio_cli.py:154-252`** — add a `set_config` branch, copying the
   clamped-float pattern already used for `background_scale` (`:192-202`):

```python
elif key == "clip_preview_speed":
    try:
        number = float(value)
    except ValueError:
        emit({"type": "error", "message": "clip_preview_speed must be a number"})
        return 1
    cfg["clip_preview_speed"] = max(0.25, min(4.0, number))
```

A key missing from any of the three silently never reaches the UI. Rust
`set_config` (`src-tauri/src/config.rs:147-172`) is a generic passthrough — no
edit needed there.

Also add the key to the required-keys assertion in
`backend/tests/test_amv_audio_config.py:51-68`.

TS type: add `clip_preview_speed: number;` to `AppConfig` in `src/types/app.ts`
(next to `scene_preview_height` at `:48`).

## 2.4 Playback implementation

### `src/features/clips/useOffsetLoop.ts`

Add `rate?: number` to `UseOffsetLoopOptions` (default `1`).

Two things must happen, and the order matters:

1. **Apply on metadata-ready.** `video.load()` resets `playbackRate` to 1, and
   the tile's imperative-src effect calls `load()`
   (`ClipPreviewTile.tsx:534`, `:698`). So the rate must be applied inside
   `onLoadedMeta` (`useOffsetLoop.ts:116-121`), not once at mount:

```ts
const onLoadedMeta = () => {
  video.playbackRate = rate;
  snapToStart();
  void video.play().catch(() => { /* autoplay can reject; caller mutes */ });
};
```

2. **Apply live without re-arming the loop.** Add a separate small effect that
   sets `video.playbackRate = rate` whenever `rate` changes, so dragging the
   slider updates playing tiles instantly instead of tearing down and
   re-seeking every visible `<video>`. Do **not** add `rate` to the main
   effect's dependency array at `:149` — that would restart the loop (and
   re-seek to `startSec`) on every slider tick.

3. **Fix the wall-clock timer.** `useOffsetLoop.ts:104-111` computes
   `remainingMs = (endSec - currentTime) * 1000`, which assumes rate 1.0. At
   0.5x the real remaining time is double, so the snap-back fires early and the
   preview loops before reaching the end of the scene. Divide by the rate:

```ts
const remainingMs = ((endSec - video.currentTime) * 1000) / Math.max(rate, 0.01);
```

Note this path only runs when `requestVideoFrameCallback` is unavailable or the
dev `forceFallback` tunable is on — but it must still be correct.

### `src/features/clips/usePlaylistLoop.ts`

This is a deliberate duplicate of the same engine (see its header comment at
line 14) used for non-contiguous merged clips. Apply the identical three
changes. Its wall-clock spots are `:264-269` and the seek watchdog at `:166` —
both need the same rate division.

### `src/features/clips/ClipPreviewTile.tsx`

Thread the rate from a prop down into both `OffsetVideoLayer` (`:463`) and
`OffsetPlaylistLayer` (`:609`), then into their `useOffsetLoop` /
`usePlaylistLoop` calls.

### `src/features/clips/SceneViewerModal.tsx`

Leave it alone. It calls `useOffsetLoop` at `:224-229`; with `rate` defaulting to
1 it keeps today's behaviour. Do not pass the setting in — the modal has a
transport bar and time readout whose meaning would change.

### Legacy WebP mode

When `featherweight_previews` is false, the speed control must be **visibly
disabled** in both places with the tooltip: "Preview speed needs the
featherweight preview engine. Turn it on in Settings." Do not silently show a
control that does nothing, and do not bake `setpts` into `preview.rs` — that
would invalidate the entire preview cache per speed value.

## 2.5 UI

### Left tool column — `ClipExtractorPanel.tsx`

Add a control inside `.clip-tool-stack`, directly under the Columns block
(`:2888-2914`). Reuse that block's exact markup pattern — `.clip-cols-control`
wrapper, `.clip-cols-label` with the live value, a `type="range"`, and
`.clip-cols-tick` snap buttons:

- Label: `Preview speed` with the current value as `1.0x`
- Range: `min={0.25} max={4} step={0.25}`
- Ticks: `0.5x`, `1x`, `2x`
- `aria-label="Grid preview playback speed"`

On change: update local state immediately (so the slider is smooth), then
`invoke("set_config", { key: "clip_preview_speed", value: String(next) })` and
dispatch `new CustomEvent("clip-preview-speed-changed", { detail: { speed: next } })`.
This mirrors the `clip_hover_preview` toggle at `:2874-2881`.

Debounce the `set_config` write by ~200 ms so a slider drag does not fire a
Python round-trip per tick. The local state and the playing videos must update
with no debounce.

### Settings panel — `src/features/settings/FeatureSettings.tsx`

Add a `.setting-row` in the same group as the existing preview settings
(`scene_preview_height` at `:236-263` is the template). Use `VideoOutputControl`
(`src/features/video/VideoOutputControl.tsx`) with:

```ts
{ label: "Grid preview speed", valueLabel: "Speed",
  help: "How fast scene tiles play on the clip grid. Does not affect exports.",
  min: 0.25, max: 4, step: 0.25, defaultValue: 1, suffix: "x" }
```

On change: `void persistConfigField("clip_preview_speed", String(val))` **and**
dispatch the same `clip-preview-speed-changed` event, so an open grid updates
without a remount.

### Live sync

In `ClipExtractorPanel`, add a listener for `clip-preview-speed-changed` next to
the existing `scene-preview-height-changed` listener (`:604-610`), and read the
initial value in `refreshClipMode` (`:612-634`, alongside
`setScenePreviewHeight` at `:621`).

Both controls must stay in sync in both directions: changing the slider on the
clip page updates the Settings control when the user opens it, and vice versa.

## 2.6 Tests

**Backend** — `backend/tests/test_audio_cli_set_config.py`, copying the
`scene_preview_height` tests at `:106-113` and `:727-789`:
1. Default `1.0` appears in the payload.
2. `set_config` clamps `0.1` → `0.25` and `10` → `4.0`.
3. Non-numeric input returns exit code 1 with an error message.
4. `_config_payload` never raises on a config file missing the key (`:73-77`).

**Frontend** — `src/features/clips/useOffsetLoop.test.tsx` (259 lines, existing
patterns at `:73`, `:132`, `:214`):
1. `playbackRate` is set on the video after `loadedmetadata`.
2. Changing `rate` updates `playbackRate` **without** re-seeking to `startSec`
   (assert `currentTime` is not reassigned).
3. In the `timeupdate` fallback path, the safety timeout is scheduled at
   `remaining / rate` ms — assert with fake timers at 0.5x.
4. Default `rate` (option omitted) leaves `playbackRate` at 1.

Also add a first test file for `usePlaylistLoop` — none exists today — covering
at minimum items 1 and 3 above.

`FeatureSettings.test.tsx:190-203` is the template for asserting the Settings
control calls `persistConfigField('clip_preview_speed', '2')`.

## 2.7 Explicitly out of scope

- Changing export speed or generating sped-up files.
- The scene viewer modal.
- Any change to proxy generation (`run_source_proxy_job`) — the proxy is
  deliberately a whole-file, no-`-ss` transcode so proxy time maps 1:1 onto
  source scene timecodes (`clips.rs:1930-1933`). Baking speed in would break
  every scene boundary, and `mode: "direct"` sources have no encode step at all.
