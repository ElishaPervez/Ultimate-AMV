# Test Suite Bootstrap — Summary

Initial bootstrap of the test suite via the 10-subagent orchestration described in `TEST_AGENT_PROMPT.md`.

## Headline numbers

- **Total tests written**: 1032
- **Passing**: 1028
- **Failing (real bugs — see [TEST_FAILURES.md](./TEST_FAILURES.md))**: 2
- **Skipped (documentation entries, jsdom limitations)**: 2
- **Runtime**: ~12s total
  - JS (vitest, 53 files): 11.21s
  - Python (pytest, 266 collected): 0.65s
  - Rust (cargo test, 7 binaries): ~0.05s

## Coverage by area

| Subagent | Scope | Tests | Pass | Fail |
|---|---|---:|---:|---:|
| A1 | Test infrastructure + smoke tests | 20 | 20 | 0 |
| A2 | `src/features/clips/*` | 91 | 91 | 0 |
| A3 | `src/features/audio/*` | 94 | 94 | 0 |
| A4 | `src/features/settings/*` | 102 | 102 | 0 |
| A5 | `src/features/downloader/*` | 107 | 107 | 0 |
| A6 | `src/shell/*` + logs/video/setup panels | 68 | 66 | **2** |
| A7 | `src/lib/*` + `src/utils/bridge` | 233 | 233 | 0 |
| A8 | `backend/amv_audio/*` | 110 | 110 | 0 |
| A9 | `backend/audio_cli.py`, `backend/clip_cli.py` | 113 | 113 | 0 |
| A10 | `src-tauri/tests/*` (integration) | 43 | 43 | 0 |
| Existing | `backend/tests/test_audio_cli.py`, `test_config.py`, `test_models.py`, `bridge.test.ts` (rewritten by A7) | 51 | 51 | 0 |
| **Total** | | **1032** | **1028** | **2** |

The two failing tests are deliberate — each encodes a real bug rather than the buggy current behavior. Details in `TEST_FAILURES.md`.

## Files added

**Test infrastructure (A1):**

- `vitest.config.ts`
- `tests/setup/index.ts`
- `tests/setup/tauri.ts` — invoke registry + `dispatchTauriEvent` + event listen mock
- `tests/setup/dialog.ts`
- `tests/setup/canvas.ts` — `getContext` / `toDataURL` / `Image` polyfills
- `tests/setup/wavesurfer.ts`
- `tests/setup/__smoke__.test.ts`
- `backend/requirements-dev.txt`
- `backend/pytest.ini`
- `backend/tests/conftest.py`
- `backend/tests/test_infra.py`
- `src-tauri/tests/infra_smoke.rs`

**React/TS feature tests (A2–A7):**

- `src/features/clips/{ClipPreviewTile,ClipExportProgressModal,SceneViewerModal,ClipCompatConvertModal,ClipPreviewScroller,DirectStreamPlayer,ClipExtractorPanel}.test.tsx`
- `src/features/audio/{AudioExtractionPanel,BatchStatusList,DepInstallCard,ExtractionProgressCard,MediaToAudioPanel,ResultCard,SelectFileButton,SetupRunningCard,StemMixerCard}.test.tsx`
- `src/features/settings/{SettingsConfirmModal,SettingsPanel,FeatureSettings,EngineSettings,UpdateCard,UpdateToast,AppearanceSettings,BackgroundLayer,BackgroundCustomizer}.test.tsx`
- `src/features/downloader/{DownloadQueuePanel,EpisodeLabelModal,YoutubeDownloaderPanel,YoutubeTrimEditor,DownloaderPanel,AnikaiBrowser}.test.tsx`
- `src/shell/{SidebarButton,WindowChrome,Root}.test.tsx`
- `src/features/logs/LogsPanel.test.tsx`
- `src/features/setup/ToolsGate.test.tsx`
- `src/features/video/{ConversionSourceCard,ConversionRunCard,VideoOutputControl}.test.tsx`
- `src/lib/{paths,time,url,numbers,format,episode,theme,background,log,discord,useFileDrop,constants}.test.ts`
- `src/utils/bridge.test.ts` (deleted `node:test` version, recreated in vitest syntax)

**Python tests (A8–A9):**

- `backend/tests/test_amv_audio_{config,gpu,logs,dependencies,setup,hardware}.py`
- `backend/tests/test_audio_cli_set_config.py`
- `backend/tests/test_clip_cli.py`

**Rust integration tests (A10):**

- `src-tauri/tests/cache_clear_test.rs`
- `src-tauri/tests/helpers_test.rs`
- `src-tauri/tests/serialize_test.rs`

## Config files modified

| File | Reason |
|---|---|
| `package.json` | Added vitest devDeps (vitest, @testing-library/react, @testing-library/user-event, @testing-library/jest-dom, jsdom) and replaced the `"test"` script with `"test"`, `"test:js"`, `"test:js:watch"`, `"test:rust"`, `"test:py"` |
| `tsconfig.json` | Added `"types": ["vitest/globals", "@testing-library/jest-dom"]` so test files can use `describe`/`it`/`expect`/`vi` without imports |
| `src-tauri/Cargo.toml` | Added `[dev-dependencies]` block with `tempfile = "3"` for Rust integration tests |
| `vitest.config.ts` | Created by A1; A7 later removed the `src/utils/bridge.test.ts` exclude entry after rewriting it in vitest syntax |
| `backend/tests/test_audio_cli.py` | A9 applied the narrow exception: added the two new keys (`audio_output_format: "wav"`, `clip_hover_preview: False`) to the `assert_config_emitted` baseline so the 8 pre-existing tests stop reporting stale-expectation failures. No source behavior changed. |

## Pre-push hook

Location: `.git/hooks/pre-push`

Contents:
```sh
#!/usr/bin/env sh
set -e
npm run test:js
cargo test --manifest-path src-tauri/Cargo.toml --quiet
pytest backend/ -q
```

Git hooks aren't versioned by default. On a fresh clone, run:

```sh
cp .git/hooks/pre-push.sample .git/hooks/pre-push  # if absent — or copy from a teammate
chmod +x .git/hooks/pre-push
```

## How to run

- `npm test` — full suite (JS + Rust + Python)
- `npm run test:js` — vitest only (collocated `*.test.{ts,tsx}` files)
- `npm run test:js:watch` — vitest watch mode for TDD
- `npm run test:rust` — cargo integration tests under `src-tauri/tests/`
- `npm run test:py` — pytest under `backend/`

## How to add new tests

The cheat-sheet from A1 covers the React/TS pattern:

```tsx
// src/features/<area>/<Component>.test.tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockInvoke, dispatchTauriEvent } from '../../../tests/setup/tauri'
// No need to import describe/it/expect/vi — they are vitest globals

import { Component } from './Component'

describe('Component', () => {
  it('does the thing', async () => {
    mockInvoke('some_command', () => ({ result: 'ok' }))
    render(<Component />)
    await userEvent.setup().click(screen.getByRole('button', { name: /go/i }))
    await waitFor(() => { expect(screen.getByText('ok')).toBeInTheDocument() })
  })
})
```

Key conventions:

- `mockInvoke(name, handler)` before `render()`. Unmocked invoke calls reject loudly so missing mocks fail visibly.
- `dispatchTauriEvent(name, payload)` synchronously fires any `listen()` subscribers.
- `resetInvokeMocks()` and localStorage clear run automatically in `beforeEach` via the setup files — no manual cleanup needed.
- `@tauri-apps/api/webview` is NOT pre-mocked. Any component using `useFileDrop` needs a file-local `vi.mock('@tauri-apps/api/webview', ...)`. Worth adding to `tests/setup/tauri.ts` next time the shared setup is touched.
- Modals using `createPortal` mount to `document.body`. Use `screen.getBy*` (not `container.querySelector`).

## Known limitations

- **`@tauri-apps/api/webview` is not in shared setup** — affects `useFileDrop` integration tests (A3, A7).
- **`<video>` / `<audio>` element behavior in jsdom is stubbed** — SceneViewerModal scrub/play/mute, WaveSurfer `ready` event firing, video-role queries cannot be exercised without a real browser.
- **`scene_clip_render` Rust function** — can't be tested without ffmpeg + Tauri runtime; the structural NVENC → libx264 fallback was verified by code review only.
- **`backend/amv_audio/separator.py::run_separation`** — requires real `pydub` + `audio_separator` libs not installed in dev; skipped.
- **`pytest` collects `backend/amv_audio/test_gpu.py` and `backend/test_clip_cli.py`** because the npm script passes `backend/` on the CLI (which overrides the `testpaths` in `pytest.ini`). These files are app utilities, not tests, but they happen to pass as smoke tests. Tightening this requires either dropping the `backend/` arg from `npm run test:py` (relying on `testpaths`), or renaming the utility files.

## Cross-cutting observations

- `createPortal` usage in modals means tests must query `document.body`, not the render container. A3/A5 both hit this.
- Two Tauri command response structs use inconsistent serde casing — `ClearCacheReport` is snake_case, everything else camelCase. Verified intentional; pinned in tests.
- `set_config` in `audio_cli.py` silently accepts unknown keys (no catch-all). Documented as current behavior; hardening is a future call.
- Two real UI bugs surfaced: ToolsGate error-state swallowing, VideoOutputControl empty-input fallback. See `TEST_FAILURES.md` for the fix targets.
