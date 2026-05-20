import {
  APP_THEMES,
  CLIP_AUDIO_SETTINGS_KEY,
  CLIP_COLUMN_OPTIONS,
  MAX_GRID_AUTOPLAYERS,
  CLIP_PREVIEW_BATCH_SIZE,
  CLIP_PREVIEW_CPU_BATCH_CONCURRENCY,
  CLIP_PREVIEW_GPU_BATCH_CONCURRENCY,
  BEST_FORMAT_ID,
  BEST_FORMAT_ENTRY,
  DEFAULT_BG_STATE,
} from './constants'

describe('constants', () => {
  // APP_THEMES
  it('APP_THEMES has 5 presets', () => {
    expect(APP_THEMES).toHaveLength(5)
  })

  it('APP_THEMES contains cyan, mint, violet, rose, amber in order', () => {
    expect(APP_THEMES.map((t) => t.id)).toEqual(['cyan', 'mint', 'violet', 'rose', 'amber'])
  })

  it('every APP_THEME preset has two valid hex colors', () => {
    for (const preset of APP_THEMES) {
      expect(preset.colors).toHaveLength(2)
      for (const color of preset.colors) {
        expect(color).toMatch(/^#[0-9a-fA-F]{6}$/)
      }
    }
  })

  // Keying constants
  it('CLIP_AUDIO_SETTINGS_KEY is a non-empty string', () => {
    expect(typeof CLIP_AUDIO_SETTINGS_KEY).toBe('string')
    expect(CLIP_AUDIO_SETTINGS_KEY.length).toBeGreaterThan(0)
  })

  it('CLIP_AUDIO_SETTINGS_KEY value is "ultimate-amv.clip-audio-settings"', () => {
    expect(CLIP_AUDIO_SETTINGS_KEY).toBe('ultimate-amv.clip-audio-settings')
  })

  // Column options
  it('CLIP_COLUMN_OPTIONS contains 1, 2, 3, 4', () => {
    expect(CLIP_COLUMN_OPTIONS).toEqual([1, 2, 3, 4])
  })

  // Numeric constants
  it('MAX_GRID_AUTOPLAYERS is 999999', () => {
    expect(MAX_GRID_AUTOPLAYERS).toBe(999999)
  })

  it('CLIP_PREVIEW_BATCH_SIZE is 8', () => {
    expect(CLIP_PREVIEW_BATCH_SIZE).toBe(8)
  })

  it('CLIP_PREVIEW_CPU_BATCH_CONCURRENCY is 2', () => {
    expect(CLIP_PREVIEW_CPU_BATCH_CONCURRENCY).toBe(2)
  })

  it('CLIP_PREVIEW_GPU_BATCH_CONCURRENCY is 3', () => {
    expect(CLIP_PREVIEW_GPU_BATCH_CONCURRENCY).toBe(3)
  })

  it('GPU batch concurrency is higher than CPU batch concurrency', () => {
    expect(CLIP_PREVIEW_GPU_BATCH_CONCURRENCY).toBeGreaterThan(CLIP_PREVIEW_CPU_BATCH_CONCURRENCY)
  })

  // Best format
  it('BEST_FORMAT_ID is "__best__"', () => {
    expect(BEST_FORMAT_ID).toBe('__best__')
  })

  it('BEST_FORMAT_ENTRY.id matches BEST_FORMAT_ID', () => {
    expect(BEST_FORMAT_ENTRY.id).toBe(BEST_FORMAT_ID)
  })

  it('BEST_FORMAT_ENTRY.audioOnly is false', () => {
    expect(BEST_FORMAT_ENTRY.audioOnly).toBe(false)
  })

  it('BEST_FORMAT_ENTRY.ext is "mp4"', () => {
    expect(BEST_FORMAT_ENTRY.ext).toBe('mp4')
  })

  // Default background state
  it('DEFAULT_BG_STATE.imagePath is an empty string', () => {
    expect(DEFAULT_BG_STATE.imagePath).toBe('')
  })

  it('DEFAULT_BG_STATE.scale is 1', () => {
    expect(DEFAULT_BG_STATE.scale).toBe(1)
  })

  it('DEFAULT_BG_STATE.offsetX is 50', () => {
    expect(DEFAULT_BG_STATE.offsetX).toBe(50)
  })

  it('DEFAULT_BG_STATE.offsetY is 50', () => {
    expect(DEFAULT_BG_STATE.offsetY).toBe(50)
  })

  it('DEFAULT_BG_STATE.dim is 55', () => {
    expect(DEFAULT_BG_STATE.dim).toBe(55)
  })

  it('DEFAULT_BG_STATE.blur is 0', () => {
    expect(DEFAULT_BG_STATE.blur).toBe(0)
  })
})
