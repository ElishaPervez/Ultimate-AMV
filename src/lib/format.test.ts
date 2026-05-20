import { formatBytes } from './format'

describe('formatBytes', () => {
  it('returns empty string for zero', () => {
    expect(formatBytes(0)).toBe('')
  })

  it('returns empty string for negative values', () => {
    expect(formatBytes(-1)).toBe('')
  })

  it('returns empty string for NaN', () => {
    expect(formatBytes(NaN)).toBe('')
  })

  it('returns empty string for Infinity', () => {
    expect(formatBytes(Infinity)).toBe('')
  })

  it('formats bytes below 1KB', () => {
    expect(formatBytes(500)).toBe('500 B')
  })

  it('formats exactly 1 KB', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
  })

  it('formats values >= 10 KB without decimal', () => {
    expect(formatBytes(10 * 1024)).toBe('10 KB')
  })

  it('formats values < 10 KB with one decimal', () => {
    // 5 * 1024 = 5120 bytes → 5.0 KB
    expect(formatBytes(5 * 1024)).toBe('5.0 KB')
  })

  it('formats exactly 1 MB', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
  })

  it('formats values >= 10 MB without decimal', () => {
    expect(formatBytes(50 * 1024 * 1024)).toBe('50 MB')
  })

  it('formats exactly 1 GB', () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB')
  })

  it('formats large GB value without decimal when >= 10 GB', () => {
    expect(formatBytes(10 * 1024 * 1024 * 1024)).toBe('10 GB')
  })

  it('stays at GB and does not go to TB', () => {
    // Units array is ["B", "KB", "MB", "GB"] — stops at GB
    const twoTB = 2 * 1024 * 1024 * 1024 * 1024
    const result = formatBytes(twoTB)
    expect(result).toContain('GB')
  })

  it('formats 1 byte', () => {
    expect(formatBytes(1)).toBe('1 B')
  })
})
