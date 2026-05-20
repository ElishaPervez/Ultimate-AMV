# Test Failures

Two tests are deliberately left failing — each one encodes the *correct* expected behavior and reveals a real bug in the source. Per the orchestration brief, assertions were not watered down to match buggy reality; the failures are the signal.

Several additional behaviors were documented by subagents as passing tests with a `NOTE:` prefix because the right fix is a design call. Those are listed below the hard failures so they aren't lost.

---

## Hard failures (test runner exits non-zero)

### src/features/setup/ToolsGate.test.tsx :: shows error state when tools_status rejects

- **Expected**: when the initial `tools_status` invoke throws (network down, sidecar crash, malformed payload, etc.) the gate switches to the error UI with "Tools install failed" so the user knows something went wrong.
- **Actual**: the "Checking media tools..." spinner stays visible forever. `phase` flips to `"error"` inside `refreshStatus`, but `status` remains `null`, and the early-return guard on the render branch unconditionally returns the spinner whenever `status` is null.
- **Suspected root cause**: `src/features/setup/ToolsGate.tsx:244` — the guard `if (phase === "checking" || !status)` swallows the error state. The `!status` clause needs to be gated on `phase !== "error"`, or the error branch must populate `status` with a sentinel before returning.
- **Repro**: launch the app with no network connectivity (or stub `tools_status` to throw). The setup gate spins indefinitely with no message — the user can't proceed and can't see why.

### src/features/video/VideoOutputControl.test.tsx :: calls onChange with fallback defaultValue when input is cleared and blurred

- **Expected**: clearing a number input and tabbing away calls `onChange(spec.defaultValue)` (e.g. `360` for ProRes density), because an empty field is not a valid entry and should snap back to the preset's default.
- **Actual**: `onChange(0)` is called. `commitDraft` parses the empty string with `Number("")` which returns `0`; `Number.isFinite(0)` is `true`, so the guard never falls back to `spec.defaultValue`. The parent's `clampNumber` then snaps `0` up to the `min` bound (`180`), so the user ends up at `180` instead of the preset's intended `360`.
- **Suspected root cause**: `src/features/video/VideoOutputControl.tsx:23` — `commitDraft` needs to short-circuit on `draftValue.trim() === ""` (or treat `0` as fallback when `spec.min > 0`) before the finite check.
- **Repro**: focus the density input on any ProRes preset, select-all and delete, then Tab out. The committed value is `180`, not the preset's `360`.

---

## Marginal-UX behaviors documented (currently encoded as passing tests, not failures)

These were flagged by A3 as bugs but written as passing tests that pin current behavior with a `NOTE:` prefix. They're real bugs by the brief's standards — re-encoding them as failing assertions is recommended when you're ready to act on them.

### src/features/audio/AudioExtractionPanel.tsx :: setResultMessage text is never rendered (cancel-with-N-done and normal-completion branches)

- **Expected**: after a cancelled-with-partial-saves batch, the user sees "Extraction cancelled. N file(s) saved before cancel." After a successful batch, the user sees "N/total files extracted. M stems saved."
- **Actual**: `setResultMessage(...)` runs in both branches, but the component's render logic immediately transitions to `<StemMixerCard>` because `selectedFiles.length > 0 && resultMessage` is truthy. `StemMixerCard` doesn't receive or render `resultMessage`. The text exists in state but is never visible.
- **Suspected root cause**: `src/features/audio/AudioExtractionPanel.tsx:155–171` — the message-rendering site is missing; either pass `resultMessage` into `StemMixerCard` or render it next to the mixer card.
- **Repro**: run a 2-file batch, let the first complete, cancel before the second — no "Extraction cancelled..." message anywhere; user has to infer from the partial mixer that they cancelled.
- **Test location**: tests are written with `NOTE:` prefix in `src/features/audio/AudioExtractionPanel.test.tsx`; flip the assertions to `expect(screen.getByText(...)).toBeInTheDocument()` when ready.

### src/features/audio/SetupRunningCard.tsx :: empty progress.message falls through to "Starting..." instead of "Working..."

- **Expected**: when `progress.message === ""`, the card calls `friendlySetupMessage("")` which returns "Working...".
- **Actual**: `const detail = progress?.message ? friendlySetupMessage(progress.message) : "Starting..."` treats the empty string as falsy, so "Starting..." renders. The "Working..." fallback inside `friendlySetupMessage` is dead code for this path.
- **Suspected root cause**: `src/features/audio/SetupRunningCard.tsx:25` — replace `progress?.message ?` with `progress?.message !== undefined ?` (or pass through to `friendlySetupMessage` unconditionally).
- **Repro**: backend emits a setup-progress event with no message — card flashes "Starting..." mid-run.
- **Test location**: `src/features/audio/SetupRunningCard.test.tsx`.

---

## Behavioral notes from subagent reports (not bugs, current behavior pinned by tests)

These are documented in test files as the *current* behavior because the right fix is a design call, not a clear-cut correctness issue. Surfacing here so the assumptions are visible.

### `src/lib/background.ts::clampBgValue(null, min, max, fallback)` returns clamped `0`, not `fallback`

`Number(null) === 0`, which is finite, so the `null` input bypasses the fallback branch and gets clamped to `min`. For `background_scale` (min `1`) the practical result equals the default. For `background_dim` (min `0`, default `55`) a stored `null` becomes `0` instead of `55`. Harmless on a fresh config but matters if a config file contains literal nulls.

### `backend/audio_cli.py::set_config` silently accepts unknown keys

No catch-all else branch — unknown keys fall through every elif, `save_config` is called with the unchanged dict, and `_config_payload` is emitted as a normal response. Return value is `None` (not `1`). A frontend typo like `key: "audio_output_forma"` gets no feedback and the value isn't persisted. Tested as actual behavior in `backend/tests/test_audio_cli_set_config.py`.

### `ClearCacheReport` is the only Tauri response struct without `rename_all = "camelCase"`

`files_removed` / `bytes_freed` ship as snake_case. Every other serialized struct in `src-tauri/src/lib.rs` is camelCase. The frontend consumer must use `report.files_removed`, not `report.filesRemoved`. Pinned in `src-tauri/tests/serialize_test.rs::clear_cache_report_serializes_with_snake_case_keys`.

### Test-infra concern (not user-facing): `cachedAudioStatus` module-level cache leaks across tests

`src/features/audio/AudioExtractionPanel.tsx:28–29` declares `cachedAudioStatus` and `pendingAudioStatus` as module-level lets. Vitest reuses module instances within a worker, so any test that renders the panel with a `ready=true` status poisons subsequent tests trying to mock `audio_status` as `ready=false`. A3 worked around this by soft-skipping the not-ready integration path. Real fix: convert to React context or a ref-backed singleton that resets per-test.

---

## Resolved during this bootstrap (no longer failing)

For history — A1's initial draft flagged these; both were addressed during the parallel A2–A10 pass:

- **`backend/tests/test_audio_cli.py`** — 8 stale-baseline failures (DEFAULT_CONFIG gained `audio_output_format` + `clip_hover_preview`). Fixed by A9 under the narrow exception: the test helper's expected baseline was updated to match current source. No source behavior changed.
- **`src/utils/bridge.test.ts`** — `node:test` syntax incompatible with vitest. Rewritten in vitest syntax by A7; vitest exclude entry removed.
