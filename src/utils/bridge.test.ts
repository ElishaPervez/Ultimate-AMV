/**
 * bridge.test.ts — vitest rewrite of the original node:test version.
 *
 * The original file (deleted) used node:test / node:assert syntax which was
 * incompatible with vitest and was therefore excluded in vitest.config.ts.
 * This replacement uses vitest globals and covers all original cases plus
 * additional edge cases.
 */
import { parseBridgePayload, readBridgeError } from './bridge'

// ---------------------------------------------------------------------------
// parseBridgePayload
// ---------------------------------------------------------------------------
describe('parseBridgePayload', () => {
  it('parses a single-line JSON string', () => {
    const input = '{"success": true, "count": 42}'
    const result = parseBridgePayload<{ success: boolean; count: number }>(input)
    expect(result).toEqual({ success: true, count: 42 })
  })

  it('uses the last non-empty line when there are multiple lines', () => {
    const input = 'some log line\nanother log line\n{"type": "done", "value": 123}'
    const result = parseBridgePayload<{ type: string; value: number }>(input)
    expect(result).toEqual({ type: 'done', value: 123 })
  })

  it('skips trailing blank lines to find the last non-empty line', () => {
    const input = '{"status": "ok"}\n\n  \n'
    const result = parseBridgePayload<{ status: string }>(input)
    expect(result).toEqual({ status: 'ok' })
  })

  it('throws SyntaxError when input is not valid JSON on any line', () => {
    expect(() => parseBridgePayload('not a json string')).toThrow(SyntaxError)
  })

  it('parses a JSON array as the last line', () => {
    const input = 'preamble\n[1,2,3]'
    const result = parseBridgePayload<number[]>(input)
    expect(result).toEqual([1, 2, 3])
  })

  it('parses a bare JSON primitive (number)', () => {
    const result = parseBridgePayload<number>('42')
    expect(result).toBe(42)
  })

  it('parses a bare JSON primitive (boolean)', () => {
    const result = parseBridgePayload<boolean>('true')
    expect(result).toBe(true)
  })

  it('parses a bare JSON null', () => {
    const result = parseBridgePayload<null>('null')
    expect(result).toBeNull()
  })

  it('handles Windows-style \\r\\n line endings', () => {
    const input = 'preamble\r\n{"key": "value"}'
    const result = parseBridgePayload<{ key: string }>(input)
    expect(result).toEqual({ key: 'value' })
  })

  it('handles a single-line input with whitespace trimmed before parsing', () => {
    // The map(item => item.trim()) trims each line
    const input = '  {"padded": true}  '
    const result = parseBridgePayload<{ padded: boolean }>(input)
    expect(result).toEqual({ padded: true })
  })

  it('throws when only blank lines are present (empty payload)', () => {
    // line is '' (after filtering), so it falls back to raw which is also blank
    expect(() => parseBridgePayload('   \n  \n')).toThrow(SyntaxError)
  })

  it('handles a bridge ok-envelope pattern', () => {
    const input = '{"type": "ok", "data": {"clips": 5}}'
    const result = parseBridgePayload<{ type: string; data: { clips: number } }>(input)
    expect(result).toEqual({ type: 'ok', data: { clips: 5 } })
  })

  it('handles a bridge error-envelope pattern', () => {
    const input = '{"type": "error", "message": "file not found"}'
    const result = parseBridgePayload<{ type: string; message: string }>(input)
    expect(result).toEqual({ type: 'error', message: 'file not found' })
  })
})

// ---------------------------------------------------------------------------
// readBridgeError
// ---------------------------------------------------------------------------
describe('readBridgeError', () => {
  it('extracts message from an Error object', () => {
    const error = new Error('something went wrong')
    expect(readBridgeError(error)).toBe('something went wrong')
  })

  it('passes through a plain string', () => {
    expect(readBridgeError('simple error message')).toBe('simple error message')
  })

  it('extracts .message from a JSON string with a message field', () => {
    const input = '{"message": "error from backend", "code": 500}'
    expect(readBridgeError(input)).toBe('error from backend')
  })

  it('falls back to raw string when JSON has no .message field', () => {
    const input = '{"error_code": 500}'
    expect(readBridgeError(input)).toBe('{"error_code": 500}')
  })

  it('extracts message from a multi-line output where last line is JSON with message', () => {
    const input = 'traceback...\n{"message": "internal error"}'
    expect(readBridgeError(input)).toBe('internal error')
  })

  it('returns the raw string when JSON is invalid', () => {
    const input = 'invalid { json'
    expect(readBridgeError(input)).toBe('invalid { json')
  })

  it('handles Error with an empty message', () => {
    const error = new Error('')
    // message is '', parseBridgePayload('') will fail, so raw message '' is returned
    expect(readBridgeError(error)).toBe('')
  })

  it('converts non-Error, non-string values via String()', () => {
    expect(readBridgeError(42)).toBe('42')
    expect(readBridgeError(null)).toBe('null')
  })

  it('handles JSON with message field set to empty string — falls back to raw', () => {
    // parsed.message is '' which is falsy, so the || fallback kicks in
    const input = '{"message": ""}'
    expect(readBridgeError(input)).toBe('{"message": ""}')
  })

  it('handles JSON whose .message is a nested structure (non-string) — returns as-is', () => {
    // parsed.message would be an object (truthy), so it's returned as-is
    // but the function returns `parsed.message || message` so if message is an object it's truthy
    const input = '{"message": {"nested": true}}'
    const result = readBridgeError(input)
    // parsed.message is { nested: true } — truthy object, so it's returned
    expect(result).toEqual({ nested: true })
  })
})
