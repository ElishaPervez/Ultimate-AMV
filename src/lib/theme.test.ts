import { isHexColor, hexToRgbParts, getReadableContrast, getThemePreset, readThemeColors } from './theme'

// ---------------------------------------------------------------------------
// isHexColor
// ---------------------------------------------------------------------------
describe('isHexColor', () => {
  it('accepts a valid 6-digit lowercase hex color', () => {
    expect(isHexColor('#48d7ff')).toBe(true)
  })

  it('accepts a valid 6-digit uppercase hex color', () => {
    expect(isHexColor('#FFFFFF')).toBe(true)
  })

  it('accepts a valid mixed-case hex color', () => {
    expect(isHexColor('#aAbBcC')).toBe(true)
  })

  it('rejects a 3-digit hex color', () => {
    expect(isHexColor('#fff')).toBe(false)
  })

  it('rejects hex without hash prefix', () => {
    expect(isHexColor('48d7ff')).toBe(false)
  })

  it('rejects empty string', () => {
    expect(isHexColor('')).toBe(false)
  })

  it('rejects non-string values', () => {
    expect(isHexColor(123456)).toBe(false)
    expect(isHexColor(null)).toBe(false)
    expect(isHexColor(undefined)).toBe(false)
  })

  it('rejects color with invalid hex characters', () => {
    expect(isHexColor('#gggggg')).toBe(false)
  })

  it('rejects color longer than 7 characters', () => {
    expect(isHexColor('#1234567')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// hexToRgbParts
// ---------------------------------------------------------------------------
describe('hexToRgbParts', () => {
  it('converts #000000 to "0 0 0"', () => {
    expect(hexToRgbParts('#000000')).toBe('0 0 0')
  })

  it('converts #ffffff to "255 255 255"', () => {
    expect(hexToRgbParts('#ffffff')).toBe('255 255 255')
  })

  it('converts #ff0000 to "255 0 0"', () => {
    expect(hexToRgbParts('#ff0000')).toBe('255 0 0')
  })

  it('converts #00ff00 to "0 255 0"', () => {
    expect(hexToRgbParts('#00ff00')).toBe('0 255 0')
  })

  it('converts #0000ff to "0 0 255"', () => {
    expect(hexToRgbParts('#0000ff')).toBe('0 0 255')
  })

  it('falls back to the default color (#48d7ff) when input is invalid', () => {
    // #48d7ff = 0x48=72, 0xd7=215, 0xff=255
    expect(hexToRgbParts('not-a-color')).toBe('72 215 255')
  })

  it('is case-insensitive', () => {
    expect(hexToRgbParts('#FF0000')).toBe('255 0 0')
  })
})

// ---------------------------------------------------------------------------
// getReadableContrast
// ---------------------------------------------------------------------------
describe('getReadableContrast', () => {
  it('returns dark text for white background (high luminance)', () => {
    expect(getReadableContrast('#ffffff')).toBe('#061116')
  })

  it('returns light text for black background (low luminance)', () => {
    expect(getReadableContrast('#000000')).toBe('#f7fbff')
  })

  it('returns light text for a dark blue', () => {
    expect(getReadableContrast('#0000ff')).toBe('#f7fbff')
  })

  it('falls back to default color for invalid hex and still returns a valid contrast value', () => {
    const result = getReadableContrast('invalid')
    expect(['#061116', '#f7fbff']).toContain(result)
  })
})

// ---------------------------------------------------------------------------
// getThemePreset
// ---------------------------------------------------------------------------
describe('getThemePreset', () => {
  it('returns the cyan preset for "cyan"', () => {
    const preset = getThemePreset('cyan')
    expect(preset.id).toBe('cyan')
  })

  it('returns the mint preset for "mint"', () => {
    const preset = getThemePreset('mint')
    expect(preset.id).toBe('mint')
  })

  it('falls back to the first preset (cyan) for unknown theme', () => {
    const preset = getThemePreset('nonexistent')
    expect(preset.id).toBe('cyan')
  })

  it('falls back to first preset for null', () => {
    const preset = getThemePreset(null)
    expect(preset.id).toBe('cyan')
  })

  it('falls back to first preset for undefined', () => {
    const preset = getThemePreset(undefined)
    expect(preset.id).toBe('cyan')
  })

  it('returns a preset with a two-element colors array', () => {
    const preset = getThemePreset('violet')
    expect(preset.colors).toHaveLength(2)
    expect(isHexColor(preset.colors[0])).toBe(true)
    expect(isHexColor(preset.colors[1])).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// readThemeColors
// ---------------------------------------------------------------------------
describe('readThemeColors', () => {
  it('returns preset colors when no overrides are set', () => {
    const result = readThemeColors({ theme: 'cyan' })
    expect(result.primary).toBe('#48d7ff')
    expect(result.secondary).toBe('#63e6a2')
  })

  it('uses custom color_a override when valid', () => {
    const result = readThemeColors({ theme: 'cyan', theme_color_a: '#ff0000' })
    expect(result.primary).toBe('#ff0000')
    expect(result.secondary).toBe('#63e6a2') // still preset secondary
  })

  it('uses custom color_b override when valid', () => {
    const result = readThemeColors({ theme: 'cyan', theme_color_b: '#00ff00' })
    expect(result.primary).toBe('#48d7ff') // still preset primary
    expect(result.secondary).toBe('#00ff00')
  })

  it('ignores invalid color_a and falls back to preset', () => {
    const result = readThemeColors({ theme: 'cyan', theme_color_a: 'not-a-color' })
    expect(result.primary).toBe('#48d7ff')
  })

  it('handles null config by using first preset defaults', () => {
    const result = readThemeColors(null)
    // Fallback to first preset (cyan)
    expect(result.primary).toBe('#48d7ff')
    expect(result.secondary).toBe('#63e6a2')
  })

  it('handles undefined config', () => {
    const result = readThemeColors(undefined)
    expect(result.primary).toBe('#48d7ff')
  })
})
