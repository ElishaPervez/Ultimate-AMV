/**
 * tests/setup/__smoke__.test.ts
 *
 * 10 smoke tests that verify the test infrastructure itself works correctly.
 * These must all pass before any feature tests are written.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  mockInvoke,
  resetInvokeMocks,
  mockInvokeFn,
  dispatchTauriEvent,
  mockListenFn,
  mockConvertFileSrc,
} from './tauri'
import { fakeCanvasCtx } from './canvas'
import { mockWaveSurferCreate, mockWaveSurferInstance } from './wavesurfer'

// ---------------------------------------------------------------------------
// 1. Invoke registry: unmocked call rejects loudly
// ---------------------------------------------------------------------------
describe('invoke registry', () => {
  it('rejects with a descriptive error when no handler is registered', async () => {
    resetInvokeMocks()
    await expect(mockInvokeFn('some_unregistered_command', {})).rejects.toThrow(
      'some_unregistered_command'
    )
  })

  // 2. Mocked call returns the handler's value
  it('returns the handler value when a mock is registered', async () => {
    mockInvoke('get_version', () => ({ version: '0.10.0' }))
    const result = await mockInvokeFn('get_version', {})
    expect(result).toEqual({ version: '0.10.0' })
  })

  // 3. resetInvokeMocks clears all registrations
  it('clears all handlers after resetInvokeMocks()', async () => {
    mockInvoke('temp_command', () => 'hello')
    resetInvokeMocks()
    await expect(mockInvokeFn('temp_command', {})).rejects.toThrow('temp_command')
  })
})

// ---------------------------------------------------------------------------
// 4. dispatchTauriEvent: registered listen() handler fires with payload
// ---------------------------------------------------------------------------
describe('dispatchTauriEvent', () => {
  it('synchronously calls listen() handlers with the correct payload', async () => {
    const received: unknown[] = []

    // Simulate what a component does: call listen() to register a handler
    await mockListenFn('tools-progress', (event) => {
      received.push(event.payload)
    })

    dispatchTauriEvent('tools-progress', { percent: 42 })

    expect(received).toHaveLength(1)
    expect(received[0]).toEqual({ percent: 42 })
  })

  it('is a no-op when no handler is registered for the event', () => {
    // Should not throw even with no registered listeners
    expect(() => dispatchTauriEvent('non-existent-event', {})).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 5. convertFileSrc identity
// ---------------------------------------------------------------------------
describe('convertFileSrc', () => {
  it('returns the src string unchanged', () => {
    expect(mockConvertFileSrc('/absolute/path/to/file.mp4')).toBe('/absolute/path/to/file.mp4')
    expect(mockConvertFileSrc('relative/path.png')).toBe('relative/path.png')
  })
})

// ---------------------------------------------------------------------------
// 6. Canvas polyfill: getContext('2d') returns a non-null object
// ---------------------------------------------------------------------------
describe('canvas polyfill', () => {
  it("getContext('2d') returns a non-null object with drawImage", () => {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    expect(ctx).not.toBeNull()
    expect(typeof (ctx as CanvasRenderingContext2D & typeof fakeCanvasCtx).drawImage).toBe(
      'function'
    )
  })

  it('toDataURL returns a data: URI string', () => {
    const canvas = document.createElement('canvas')
    const url = canvas.toDataURL('image/webp')
    expect(url).toMatch(/^data:/)
  })
})

// ---------------------------------------------------------------------------
// 7. Image polyfill: setting .src triggers onload on the next microtask
// ---------------------------------------------------------------------------
describe('Image polyfill', () => {
  it('fires onload asynchronously after src is set', async () => {
    const img = new Image()
    let loaded = false
    img.onload = () => {
      loaded = true
    }
    img.src = 'fake://image.webp'
    expect(loaded).toBe(false) // not yet — still in microtask queue
    await Promise.resolve() // flush the microtask
    expect(loaded).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 8. WaveSurfer mock: create() returns object with vi.fn() methods
// ---------------------------------------------------------------------------
describe('wavesurfer mock', () => {
  it('WaveSurfer.create() returns an object whose methods are vi.fn()', () => {
    // Dynamic import is not needed; the mock is already wired via vi.mock()
    const instance = mockWaveSurferCreate({ container: '#waveform' })
    expect(instance).toBe(mockWaveSurferInstance)
    expect(typeof instance.on).toBe('function')
    expect(typeof instance.play).toBe('function')
    expect(typeof instance.pause).toBe('function')
    expect(typeof instance.destroy).toBe('function')
    // Confirm they are vi.fn() (have .mock property)
    expect(instance.play).toHaveProperty('mock')
  })
})

// ---------------------------------------------------------------------------
// 9. localStorage reset between tests
// ---------------------------------------------------------------------------
describe('localStorage isolation', () => {
  it('can write to localStorage', () => {
    localStorage.setItem('test-key', 'test-value')
    expect(localStorage.getItem('test-key')).toBe('test-value')
  })

  it('localStorage is cleared between tests (previous key must be gone)', () => {
    // The previous test set 'test-key'; beforeEach clears localStorage.
    // If these tests run in order, this verifies isolation.
    expect(localStorage.getItem('test-key')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 10. Invoke handler can be async (Promise-returning handler)
// ---------------------------------------------------------------------------
describe('invoke registry — async handler', () => {
  it('resolves a promise returned by the handler', async () => {
    mockInvoke('async_command', async () => {
      return { data: 'async-result' }
    })
    const result = await mockInvokeFn('async_command', {})
    expect(result).toEqual({ data: 'async-result' })
  })
})
