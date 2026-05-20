/**
 * tests/setup/index.ts
 *
 * Vitest setupFiles entry point.  Imported before every test file.
 * Order matters: vi.mock() hoisting works per-file, but side-effects
 * (polyfills, beforeEach registrations) execute in import order.
 */

import '@testing-library/jest-dom'

// Install all mocks — vi.mock() calls inside these modules are hoisted
// automatically by Vitest's module system.
import { installTauriResets } from './tauri'
import { installDialogResets } from './dialog'
import { installWaveSurferResets } from './wavesurfer'

// Canvas / Image polyfills (side-effects only, no reset needed)
import './canvas'

// Register beforeEach auto-resets for stateful mocks
installTauriResets()
installDialogResets()
installWaveSurferResets()

// localStorage — jsdom provides it; clear between tests so no test leaks state
beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})
