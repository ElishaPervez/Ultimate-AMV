import { safeLogValue, logFrontend } from './log'
import { mockInvoke, mockInvokeFn } from '../../tests/setup/tauri'

// ---------------------------------------------------------------------------
// safeLogValue
// ---------------------------------------------------------------------------
describe('safeLogValue', () => {
  it('passes through strings unchanged', () => {
    expect(safeLogValue('hello')).toBe('hello')
  })

  it('passes through numbers unchanged', () => {
    expect(safeLogValue(42)).toBe(42)
  })

  it('passes through booleans unchanged', () => {
    expect(safeLogValue(true)).toBe(true)
    expect(safeLogValue(false)).toBe(false)
  })

  it('passes through null unchanged', () => {
    expect(safeLogValue(null)).toBeNull()
  })

  it('passes through undefined unchanged', () => {
    expect(safeLogValue(undefined)).toBeUndefined()
  })

  it('serializes a plain object via JSON round-trip', () => {
    const obj = { a: 1, b: 'two' }
    expect(safeLogValue(obj)).toEqual({ a: 1, b: 'two' })
  })

  it('serializes an array via JSON round-trip', () => {
    expect(safeLogValue([1, 2, 3])).toEqual([1, 2, 3])
  })

  it('converts Error to {name, message, stack} shape', () => {
    const err = new Error('boom')
    const result = safeLogValue(err) as { name: string; message: string; stack?: string }
    expect(result.name).toBe('Error')
    expect(result.message).toBe('boom')
    expect(typeof result.stack).toBe('string')
  })

  it('handles Error subclasses', () => {
    const err = new TypeError('type mismatch')
    const result = safeLogValue(err) as { name: string; message: string }
    expect(result.name).toBe('TypeError')
    expect(result.message).toBe('type mismatch')
  })

  it('does not throw on circular references — falls back to String()', () => {
    const obj: Record<string, unknown> = {}
    obj.self = obj
    // JSON.stringify will throw; the catch block returns String(obj)
    expect(() => safeLogValue(obj)).not.toThrow()
    const result = safeLogValue(obj)
    expect(typeof result).toBe('string')
  })

  it('returns string representation for circular ref', () => {
    const obj: Record<string, unknown> = {}
    obj.self = obj
    const result = safeLogValue(obj)
    expect(result).toBe(String(obj))
  })
})

// ---------------------------------------------------------------------------
// logFrontend
// ---------------------------------------------------------------------------
describe('logFrontend', () => {
  it('calls invoke("frontend_log") with the right arguments', async () => {
    mockInvoke('frontend_log', () => undefined)
    logFrontend('info', 'test-event', 'hello from test')
    // logFrontend is fire-and-forget (void invoke); flush microtasks
    await vi.waitFor(() => expect(mockInvokeFn).toHaveBeenCalledWith('frontend_log', {
      level: 'info',
      event: 'test-event',
      message: 'hello from test',
      details: null,
    }))
  })

  it('passes details when provided', async () => {
    mockInvoke('frontend_log', () => undefined)
    logFrontend('warn', 'some-event', 'msg', { key: 'value' })
    await vi.waitFor(() => {
      const [, args] = mockInvokeFn.mock.calls[0]
      expect((args as Record<string, unknown>).details).toEqual({ key: 'value' })
    })
  })

  it('passes null for details when not provided', async () => {
    mockInvoke('frontend_log', () => undefined)
    logFrontend('error', 'ev', 'msg')
    await vi.waitFor(() => {
      const [, args] = mockInvokeFn.mock.calls[0]
      expect((args as Record<string, unknown>).details).toBeNull()
    })
  })

  it('does not throw even when invoke rejects', () => {
    // No mock registered — invoke will throw from the mock registry
    // logFrontend swallows errors via .catch(() => undefined)
    expect(() => logFrontend('error', 'ev', 'msg')).not.toThrow()
  })
})
