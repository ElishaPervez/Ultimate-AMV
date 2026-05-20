/**
 * tests/setup/tauri.ts
 *
 * Mock registry for @tauri-apps/api/core::invoke and @tauri-apps/api/event.
 *
 * Usage in tests (collocated with src/features/**):
 *   import { mockInvoke, resetInvokeMocks } from '../../../tests/setup/tauri'
 *   import { dispatchTauriEvent }            from '../../../tests/setup/tauri'
 *
 * Usage in tests under tests/setup/ itself:
 *   import { mockInvoke, resetInvokeMocks, dispatchTauriEvent } from './tauri'
 *
 * The module also installs vi.mock() calls at import time, so it must be
 * imported (directly or via tests/setup/index.ts setupFiles) before any
 * component that calls invoke/listen/emit is rendered.
 */

import { vi } from 'vitest'

// ---------------------------------------------------------------------------
// Invoke registry
// ---------------------------------------------------------------------------

type InvokeHandler<TArgs = unknown> = (args: TArgs) => unknown | Promise<unknown>

const _invokeRegistry = new Map<string, InvokeHandler>()

/**
 * Register a handler for a Tauri invoke command.
 * Call this in a test's beforeEach / it block before rendering the component.
 */
export function mockInvoke<TArgs = unknown, _TResult = unknown>(
  command: string,
  handler: InvokeHandler<TArgs>,
): void {
  _invokeRegistry.set(command, handler as InvokeHandler)
}

/**
 * Clear all registered invoke handlers.
 * Called automatically in beforeEach via setupFiles.
 */
export function resetInvokeMocks(): void {
  _invokeRegistry.clear()
}

/** The actual mock function exposed so tests can inspect call counts etc. */
export const mockInvokeFn = vi.fn(async (command: string, args?: unknown): Promise<unknown> => {
  const handler = _invokeRegistry.get(command)
  if (!handler) {
    throw new Error(
      `[test] invoke("${command}") called but no mock registered. ` +
      `Use mockInvoke("${command}", handler) in your test's beforeEach.`
    )
  }
  return handler(args)
})

// ---------------------------------------------------------------------------
// Event system (listen / emit / dispatchTauriEvent)
// ---------------------------------------------------------------------------

type EventHandler = (event: { payload: unknown }) => void

const _listenRegistry = new Map<string, Set<EventHandler>>()

export const mockListenFn = vi.fn(
  async (event: string, handler: EventHandler): Promise<() => void> => {
    if (!_listenRegistry.has(event)) {
      _listenRegistry.set(event, new Set())
    }
    _listenRegistry.get(event)!.add(handler)
    // Return an unlisten function
    return () => {
      _listenRegistry.get(event)?.delete(handler)
    }
  }
)

export const mockEmitFn = vi.fn(async (_event: string, _payload?: unknown): Promise<void> => {
  // no-op by default; tests can inspect mockEmitFn.mock.calls
})

/**
 * Synchronously dispatch a Tauri event to all registered listen() handlers.
 * Use this instead of actually emitting events through Tauri's runtime.
 *
 * Example:
 *   dispatchTauriEvent('tools-progress', { percent: 50 })
 */
export function dispatchTauriEvent(name: string, payload: unknown): void {
  const handlers = _listenRegistry.get(name)
  if (!handlers) return
  for (const handler of handlers) {
    handler({ payload })
  }
}

function resetEventMocks(): void {
  _listenRegistry.clear()
  mockListenFn.mockClear()
  mockEmitFn.mockClear()
}

// ---------------------------------------------------------------------------
// convertFileSrc — identity transform (no tauri protocol rewriting in tests)
// ---------------------------------------------------------------------------

export const mockConvertFileSrc = vi.fn((src: string): string => src)

// ---------------------------------------------------------------------------
// vi.mock() registrations — these run at module evaluation time
// ---------------------------------------------------------------------------

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvokeFn,
  convertFileSrc: mockConvertFileSrc,
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: mockListenFn,
  emit: mockEmitFn,
}))

// ---------------------------------------------------------------------------
// Auto-reset in beforeEach (called from tests/setup/index.ts)
// ---------------------------------------------------------------------------

export function installTauriResets(): void {
  beforeEach(() => {
    resetInvokeMocks()
    resetEventMocks()
    mockInvokeFn.mockClear()
    mockConvertFileSrc.mockClear()
  })
}
