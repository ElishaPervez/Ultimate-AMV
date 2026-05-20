# Orchestrator Brief — Test Suite Bootstrap (Claude Code)

You are running in **Claude Code** as the orchestrator for a test suite bootstrap. Recommended setup: a **fresh session on Sonnet 4.6**. If you're on Opus, switch — Opus is overkill for mechanical test writing and burns the user's weekly quota ~5x faster.

## Your role

**You do not write test code yourself.** You dispatch **10 subagents** via the Agent tool and aggregate their reports. The only files you write directly are `TEST_FAILURES.md` and `TEST_SUMMARY.md`.

## Tool semantics you need to know

- **Agent tool** — `subagent_type: general-purpose`. Each subagent starts with a fresh context window and no memory of this conversation. Their prompts must be self-contained — copy the shared constraint sections verbatim into every subagent's prompt.
- **Parallel dispatch** — to run multiple subagents concurrently, make multiple Agent tool calls **in a single response**. The Claude Code runtime fans them out. Sequential Agent calls = sequential runs. One message with 9 Agent blocks = 9 in parallel.
- **Model inheritance** — subagents inherit your current model unless you pass `model: "sonnet"` explicitly. Confirm you're on Sonnet before dispatching.
- **No nested spawning** — subagents shouldn't call Agent themselves. Don't ask them to.
- **Progress tracking** — use TaskCreate to register the 10 agents as tasks at the start; TaskUpdate to mark each completed as its subagent returns. Helps the user see progress.
- **File ops** — Read / Write / Edit / Glob / Grep / Bash as needed. You only Write `TEST_FAILURES.md` and `TEST_SUMMARY.md`. Bash is for discovery + the final `npm test` verification.

## Before you start

1. Run `git status`. If files under `src/`, `backend/`, or `src-tauri/src/` show as **modified**, **STOP** and tell the user — tests should target a stable baseline, not a working tree mid-edit. They should commit pending app code changes first.
2. New `*.test.ts(x)`, `test_*.py`, or `src-tauri/tests/*.rs` files as untracked is fine — those are yours/the subagents' output.

## HARD CONSTRAINTS — apply to you and to every subagent

1. **DO NOT MODIFY APPLICATION SOURCE CODE.** No edits to existing files under `src/`, `backend/`, or `src-tauri/src/`. You may **add** new test files (`*.test.ts(x)`, `test_*.py`, `src-tauri/tests/*.rs`). You may NOT touch anything that already exists in those trees.
2. **If a test reveals a bug, leave it failing.** Encode the *correct* expected behavior. Do not water down assertions to match buggy reality. Do not patch app code to make a red test green.
3. **Report, don't fix.** Each failure goes to `TEST_FAILURES.md`. Move on.
4. **Tests must be deterministic.** No network, no real Tauri IPC, no real Python sidecar, no real ffmpeg, no real disk I/O outside `tempfile`. Mock every boundary. Fake timers for time-dependent code.
5. **CI-runnable on clean checkout** with only `npm install`, `pip install -r backend/requirements-dev.txt`, and `cargo` available. No GPU, no NVENC, no Tauri runtime.
6. **Project-specific git rules** (from `CLAUDE.md`, also applied): only `main` is ever pushed; never push or even create remote branches; never add `Co-Authored-By: Claude` trailers. You shouldn't be pushing anything anyway — just be aware.

## Test stack (use exactly these — no alternatives)

- **React/TS components**: vitest + @testing-library/react + @testing-library/user-event + jsdom
- **Pure helpers** (`src/lib`, `src/utils`): vitest, no DOM
- **Python backend**: pytest + pytest-mock (new `backend/requirements-dev.txt`)
- **Rust**: `cargo test`, with `tempfile` dev-dep (add to `[dev-dependencies]` in `src-tauri/Cargo.toml`)

Existing tests in the repo (pre-existing, keep them working):
- `backend/tests/*.py` — 4 files exist, extend the dir
- `src/utils/bridge.test.ts` — exists, migrate to vitest syntax if needed

The current `"test": "node --experimental-strip-types --test src/**/*.test.ts"` script in `package.json` gets replaced with the vitest version below.

**Out of scope**: Playwright, Cypress, E2E, visual regression, large-markup snapshots.

## Shared mocking conventions (`tests/setup/`)

A1 sets these up; everyone else uses them. Wired via vitest's `setupFiles`:

- `@tauri-apps/api/core::invoke` → per-test handler registry. Unmocked calls reject loudly.
- `@tauri-apps/api/event::listen, emit` → mock; expose `dispatchTauriEvent(name, payload)` helper for synchronous event dispatch in tests.
- `@tauri-apps/plugin-dialog::open, save` → mock.
- `convertFileSrc` → identity.
- `HTMLCanvasElement.prototype.getContext`, `toDataURL`, `Image` → polyfills so `useWebpThumbnail` in `ClipPreviewTile` can fire `onload` and produce a stable data URL.
- `wavesurfer.js` → mock default export with stub methods (`create`, `on`, `play`, `pause`, `destroy`).
- `localStorage` → jsdom built-in; `beforeEach` reset.

Do **not** mock React, React DOM, or `lucide-react`.

## Subagent split — 10 agents

Dispatch **A1 alone first**, wait for return. Then dispatch **A2–A10 in a single response** (9 Agent calls in parallel).

| Agent | Scope | Min tests |
|---|---|---|
| **A1 — Infra** | vitest config, RTL setup, jsdom polyfills, pytest config, pre-push hook, `package.json` scripts, shared mocks in `tests/setup/`. **Only A1 may edit root config files**: `package.json`, `tsconfig.json` (only if strictly required), new `vitest.config.ts`, new `backend/requirements-dev.txt`, new `.git/hooks/pre-push`, new `src-tauri/Cargo.toml` `[dev-dependencies]` block. | 10 smoke tests proving the mocks return correct shapes |
| **A2 — Clips** | `src/features/clips/*` — ClipExtractorPanel state machine, ClipPreviewTile hover/thumbnail layering, ClipExportProgressModal phases (running/complete/error/cancelled), ClipCompatConvertModal, SceneViewerModal, ClipPreviewScroller, DirectStreamPlayer | 30 |
| **A3 — Audio** | `src/features/audio/*` — AudioExtractionPanel batch + cancel flow, StemMixerCard fallback when stems missing, SelectFileButton, BatchStatusList, DepInstallCard, ExtractionProgressCard, SetupRunningCard, MediaToAudioPanel | 25 |
| **A4 — Settings** | `src/features/settings/*` — SettingsPanel tab switching + confirm-modal wiring, EngineSettings GPU/CPU disable logic, FeatureSettings hover-preview toggle, AppearanceSettings, SettingsConfirmModal, UpdateCard | 25 |
| **A5 — Downloader** | `src/features/downloader/*` — DownloaderPanel, AnikaiBrowser stubbed routes, EpisodeLabelModal, YoutubeDownloaderPanel, YoutubeTrimEditor, DownloadQueuePanel | 25 |
| **A6 — Shell & misc UI** | `src/shell/*` (App, Root, WindowChrome, SidebarButton, BackgroundLayer, BackgroundCustomizer), `src/features/logs/LogsPanel`, `src/features/video/VideoToVideoPanel` | 20 |
| **A7 — Lib helpers** | `src/lib/*` (constants, log, paths, time, url, numbers, theme, format, background, episode, useFileDrop), `src/utils/bridge` | 30 |
| **A8 — Python amv_audio** | `backend/amv_audio/*` — config defaults + persistence, dependencies probe, GPU detection branches, separator wrappers, setup helpers. Mock disk + subprocess. | 20 |
| **A9 — Python CLIs** | `backend/audio_cli.py`, `backend/clip_cli.py`, other `backend/*.py` top-level command branches. Every `set_config` branch, success + error paths. Mock IO + subprocess. | 20 |
| **A10 — Tauri Rust** | New file: `src-tauri/tests/lib_tests.rs`. Test `clear_app_cache` (3-dir loop, missing-dir tolerance, error propagation), `dir_file_stats`, `sanitize_path_segment`, `short_stable_id`, Serialize struct shape checks. **DO NOT add `#[cfg(test)] mod tests {}` inside `src-tauri/src/lib.rs` — that's an edit to existing source. Use external integration test files only.** | 15 |

**Total minimum: 220 tests.** When you dispatch each subagent, **include its quota verbatim in the prompt** — that's the only mechanism preventing under-delivery.

## Priority test areas (route to whichever subagent owns the area)

1. **AudioExtractionPanel cancel flow** (A3):
   - cancel before any file completes → picker returns, no `resultMessage`
   - cancel mid-batch with N done → `resultMessage` = `"Extraction cancelled. N file(s) saved before cancel."`, mixer renders partial outputs
   - normal completion → `"N/total files extracted"`

2. **Hover preview sync** (A2 + A4):
   - Toolbar toggle (ClipExtractorPanel) and Settings toggle (FeatureSettings) both dispatch `clip-hover-preview-changed` with `{enabled: boolean}` detail AND call `set_config({key: "clip_hover_preview", value})`
   - Both listeners update from the event detail payload (not by re-reading anywhere)
   - `ClipPreviewTile` gates `shouldPlay` on the `clipHoverPreview` prop
   - Fresh-install default is `false` (Python `DEFAULT_CONFIG`, `_config_payload` fallback, and React `useState` inits)

3. **ClipPreviewTile thumbnail layering** (A2):
   - `useWebpThumbnail` caches by src in a module-level Map
   - Thumbnail `<img>` stays mounted as base layer across `shouldPlay` toggles (no remount during hover — that was the "ghost morph" bug)
   - Animated overlay `<img class="clip-animated-overlay">` only renders when `shouldPlay && previewRange`
   - `isReady` flips false on src change, true on `onLoad`

4. **SettingsConfirmModal** (A4):
   - Clear cache button → modal opens → confirm calls `clear_app_cache`, cancel doesn't
   - GPU/CPU switch button → modal opens → confirm calls `audio_setup` + `set_config({key: "clip_extraction_mode", ...})`, cancel doesn't
   - Escape key closes
   - `isDanger` prop propagates the class

5. **`clear_app_cache` Rust** (A10):
   - Clears all three of `clip_previews`, `scene_clips`, `clip_compat_cache`
   - Missing dirs are tolerated (return `Ok`)
   - Cumulative `files_removed` + `bytes_freed` across the three
   - NEVER touches `backgrounds/`, `logs/`, `*.json`, or any sibling dir
   - Per-dir errors are logged but the loop continues; first error is what bubbles up

6. **Backend config defaults** (A8):
   - Every key in `_config_payload` has a default fallback via `cfg.get(...)`
   - `clip_hover_preview` default = `False`
   - `audio_output_format` default = `"wav"`

7. **`set_config` branch coverage** (A9):
   - Each accepted key updates the right field with the right type coercion
   - Invalid values emit `{"type": "error", ...}` and return 1
   - Unknown keys — encode current behavior as a test (whatever it is)

8. **TransNetV2 boundary padding** (A2) — if `previewClipRange` or equivalent inward-pad helper is reachable as a pure function:
   - First scene (`index === 0`) → zero start pad
   - Middle scenes → ~3 frame inward start pad, ~5 frame inward end pad
   - Pads cap so they don't exceed scene duration

9. **CPU/GPU parity** (A10) — Rust `scene_clip_render` retry-with-libx264 fallback when NVENC absent. Mock command exec.

## File layout

- React/TS tests: collocate as `*.test.ts(x)` next to source.
- Python tests: extend `backend/tests/` (dir already exists). Add `backend/tests/conftest.py` for fixtures.
- Rust tests: `src-tauri/tests/*.rs` (integration). **Do NOT add `#[cfg(test)] mod tests {}` inside existing `src-tauri/src/*.rs` files — that violates the no-edit rule.**
- Shared TS mocks: `tests/setup/*.ts` at repo root.

## Pre-push hook (A1)

Plain `.git/hooks/pre-push` (the repo doesn't use husky):

```sh
#!/usr/bin/env sh
set -e
npm run test:js
cargo test --manifest-path src-tauri/Cargo.toml --quiet
pytest backend/ -q
```

`package.json` scripts (A1 sets these, **replacing** the existing `"test"` script):
```json
"test": "npm run test:js && npm run test:rust && npm run test:py",
"test:js": "vitest run",
"test:js:watch": "vitest",
"test:rust": "cargo test --manifest-path src-tauri/Cargo.toml",
"test:py": "pytest backend/"
```

Document the hook location in `TEST_SUMMARY.md` so contributors know to install on fresh clones (Git hooks aren't versioned by default).

## Deliverables

`TEST_FAILURES.md` (repo root) — one entry per red test:
```md
### <test file>::<test name>
- **Expected**: <what the assertion says should happen>
- **Actual**: <what currently happens>
- **Suspected root cause**: <file:line or "unknown">
- **Repro**: <how a user would observe this>
```

`TEST_SUMMARY.md` (repo root):
```md
- Total tests written: N
- Passing: P
- Failing (real bugs, see TEST_FAILURES.md): F
- Runtime: T seconds
- Coverage by area: <breakdown per subagent>
- Files added: <list>
- Config files modified: <list with one-line reason each>
- Pre-push hook location: .git/hooks/pre-push
```

## Workflow (your literal turn-by-turn)

1. **Read this brief.**
2. **Run `git status`** to confirm clean baseline on app source. If dirty, stop and tell the user.
3. **Discovery pass** (~5 min, you do this yourself): read `package.json`, `CLAUDE.md`, `tsconfig.json`, `vite.config.ts`, list `src/features/*`, `backend/`, `src-tauri/src/`. Note conventions and the existing `backend/tests/` + `src/utils/bridge.test.ts`.
4. **TaskCreate** 10 tasks (A1 through A10) so the user can see progress.
5. **Dispatch A1 alone.** One Agent tool call. Wait for return. TaskUpdate to completed when done.
6. **Dispatch A2–A10 in parallel.** Single response with **9 Agent tool calls**. Each subagent's prompt must contain:
   - HARD CONSTRAINTS (verbatim)
   - Test stack (verbatim)
   - Shared mocking conventions (verbatim)
   - **Only that subagent's row** from the table, including its quota
   - The priority test areas relevant to that subagent (from the list above)
   - File layout section
   - A relay of A1's setup details (paths to mocks, vitest config location, etc.) — you'll need to pull these from A1's return message and paste into each prompt
   - Final instruction: "Report back with: count of tests written, count passing, count failing, and a list of failing test entries in the TEST_FAILURES.md format. Do not spawn further agents. Do not fix failing tests."
7. **As each subagent returns**, TaskUpdate to completed and accumulate counts + failure entries in your context.
8. **Run `npm test`** once to verify aggregate counts.
9. **Write `TEST_FAILURES.md` and `TEST_SUMMARY.md`** yourself (the only files you Write directly).
10. **Report to the user**: total counts, the failing-test list, files added. Do not propose fixes.

If a subagent fails (errors, returns empty, misunderstands scope), respawn it once with a clarified prompt. Don't retry indefinitely — escalate to the user.

## What you may NOT do

- **Write test files yourself.** Subagents write tests. You orchestrate.
- Edit any existing file under `src/`, `backend/`, `src-tauri/src/` (this rule applies to subagents too — restate it in every subagent prompt)
- Add Playwright, Cypress, snapshot tests, visual regression
- Water down assertions to match buggy reality
- Patch app code to make tests pass
- Push to git, open PRs, modify branch history
- Add `Co-Authored-By: Claude` trailers to any commit
- Install Tauri runtime in CI (mock it)
- Spawn fewer than 10 subagents (the parallelism is the point — collapsing into fewer = failure)
- Use `--no-verify` or otherwise bypass hooks
