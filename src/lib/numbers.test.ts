import { clampNumber } from './numbers'

describe('clampNumber', () => {
  it('returns the value when within bounds', () => {
    expect(clampNumber(5, 0, 10)).toBe(5)
  })

  it('clamps to min when value is below min', () => {
    expect(clampNumber(-5, 0, 10)).toBe(0)
  })

  it('clamps to max when value is above max', () => {
    expect(clampNumber(15, 0, 10)).toBe(10)
  })

  it('returns min when value equals min', () => {
    expect(clampNumber(0, 0, 10)).toBe(0)
  })

  it('returns max when value equals max', () => {
    expect(clampNumber(10, 0, 10)).toBe(10)
  })

  it('handles negative range', () => {
    expect(clampNumber(-3, -10, -1)).toBe(-3)
  })

  it('clamps to min in negative range', () => {
    expect(clampNumber(-15, -10, -1)).toBe(-10)
  })

  it('clamps to max in negative range', () => {
    expect(clampNumber(0, -10, -1)).toBe(-1)
  })

  it('handles float values', () => {
    expect(clampNumber(0.5, 0.0, 1.0)).toBeCloseTo(0.5)
  })

  it('clamps float below min', () => {
    expect(clampNumber(-0.1, 0.0, 1.0)).toBeCloseTo(0.0)
  })

  it('clamps float above max', () => {
    expect(clampNumber(1.1, 0.0, 1.0)).toBeCloseTo(1.0)
  })

  it('returns min when min equals max and value is within', () => {
    expect(clampNumber(5, 5, 5)).toBe(5)
  })
})
