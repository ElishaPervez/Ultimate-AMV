import { clampBgValue, readBackgroundState } from './background'
import { DEFAULT_BG_STATE } from './constants'

// ---------------------------------------------------------------------------
// clampBgValue
// ---------------------------------------------------------------------------
describe('clampBgValue', () => {
  it('returns the value when within bounds', () => {
    expect(clampBgValue(3, 1, 5, 1)).toBe(3)
  })

  it('clamps to min when below', () => {
    expect(clampBgValue(0, 1, 5, 1)).toBe(1)
  })

  it('clamps to max when above', () => {
    expect(clampBgValue(10, 1, 5, 1)).toBe(5)
  })

  it('returns fallback for non-numeric input', () => {
    expect(clampBgValue('not-a-number', 0, 100, 42)).toBe(42)
  })

  it('returns fallback for undefined', () => {
    expect(clampBgValue(undefined, 0, 100, 55)).toBe(55)
  })

  it('null is coerced to 0 via Number(null) — does NOT use the fallback', () => {
    // Number(null) === 0, which is finite, so clampBgValue returns clamp(0, 0, 100) === 0
    // This is a known behavioral edge-case: null is not treated as "missing" the way
    // undefined or non-numeric strings are.
    expect(clampBgValue(null, 0, 100, 50)).toBe(0)
  })

  it('coerces numeric strings to numbers', () => {
    expect(clampBgValue('3', 1, 5, 1)).toBe(3)
  })

  it('returns fallback for NaN string', () => {
    expect(clampBgValue('abc', 0, 100, 50)).toBe(50)
  })

  it('returns value when equal to min', () => {
    expect(clampBgValue(1, 1, 5, 3)).toBe(1)
  })

  it('returns value when equal to max', () => {
    expect(clampBgValue(5, 1, 5, 3)).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// readBackgroundState
// ---------------------------------------------------------------------------
describe('readBackgroundState', () => {
  it('returns default state for null config', () => {
    const state = readBackgroundState(null)
    expect(state.imagePath).toBe('')
    expect(state.scale).toBe(DEFAULT_BG_STATE.scale)
    expect(state.offsetX).toBe(DEFAULT_BG_STATE.offsetX)
    expect(state.offsetY).toBe(DEFAULT_BG_STATE.offsetY)
    expect(state.dim).toBe(DEFAULT_BG_STATE.dim)
    expect(state.blur).toBe(DEFAULT_BG_STATE.blur)
  })

  it('returns default state for undefined config', () => {
    const state = readBackgroundState(undefined)
    expect(state.scale).toBe(DEFAULT_BG_STATE.scale)
  })

  it('reads imagePath from config', () => {
    const state = readBackgroundState({ background_image: '/path/to/bg.jpg' })
    expect(state.imagePath).toBe('/path/to/bg.jpg')
  })

  it('falls back to empty imagePath when not a string', () => {
    const state = readBackgroundState({ background_image: 42 as unknown as string })
    expect(state.imagePath).toBe('')
  })

  it('reads and clamps scale within [1, 5]', () => {
    expect(readBackgroundState({ background_scale: 3 }).scale).toBe(3)
    expect(readBackgroundState({ background_scale: 0 }).scale).toBe(1) // clamped to min
    expect(readBackgroundState({ background_scale: 10 }).scale).toBe(5) // clamped to max
  })

  it('reads and clamps offsetX within [0, 100]', () => {
    expect(readBackgroundState({ background_offset_x: 50 }).offsetX).toBe(50)
    expect(readBackgroundState({ background_offset_x: -10 }).offsetX).toBe(0)
    expect(readBackgroundState({ background_offset_x: 110 }).offsetX).toBe(100)
  })

  it('reads and clamps dim within [0, 100]', () => {
    expect(readBackgroundState({ background_dim: 55 }).dim).toBe(55)
    expect(readBackgroundState({ background_dim: -1 }).dim).toBe(0)
    expect(readBackgroundState({ background_dim: 200 }).dim).toBe(100)
  })

  it('reads and clamps blur within [0, 40]', () => {
    expect(readBackgroundState({ background_blur: 20 }).blur).toBe(20)
    expect(readBackgroundState({ background_blur: -5 }).blur).toBe(0)
    expect(readBackgroundState({ background_blur: 50 }).blur).toBe(40)
  })

  it('parses brightText from "1"/"true"/true', () => {
    expect(readBackgroundState({ background_bright_text: '1' }).brightText).toBe(true)
    expect(readBackgroundState({ background_bright_text: 'true' }).brightText).toBe(true)
    expect(readBackgroundState({ background_bright_text: true }).brightText).toBe(true)
  })

  it('brightText defaults to false for "0", garbage and missing values', () => {
    expect(readBackgroundState({ background_bright_text: '0' }).brightText).toBe(false)
    expect(readBackgroundState({ background_bright_text: 'yes' }).brightText).toBe(false)
    expect(readBackgroundState({}).brightText).toBe(false)
    expect(readBackgroundState(null).brightText).toBe(false)
  })
})
