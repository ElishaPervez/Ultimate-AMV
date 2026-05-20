import { extractEpisodeNumber } from './episode'

describe('extractEpisodeNumber', () => {
  it('matches "Episode N" pattern', () => {
    expect(extractEpisodeNumber('My Show Episode 5')).toBe('5')
  })

  it('matches "episode N" case-insensitively', () => {
    expect(extractEpisodeNumber('EPISODE 12')).toBe('12')
  })

  it('matches "ep N" abbreviated form', () => {
    expect(extractEpisodeNumber('Show Ep 3')).toBe('3')
  })

  it('matches "EP N" abbreviated form case-insensitively', () => {
    expect(extractEpisodeNumber('EP 7')).toBe('7')
  })

  it('matches episode with decimal number', () => {
    expect(extractEpisodeNumber('Episode 5.5')).toBe('5.5')
  })

  it('returns the first/only match in a string with one episode ref', () => {
    expect(extractEpisodeNumber('Some Show Episode 10 HD')).toBe('10')
  })

  it('returns null when no episode pattern is present', () => {
    expect(extractEpisodeNumber('My Show S01E05')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(extractEpisodeNumber('')).toBeNull()
  })

  it('returns null for plain title with no episode marker', () => {
    expect(extractEpisodeNumber('Dragon Ball Z')).toBeNull()
  })

  it('requires a word boundary — does not match mid-word "episode"', () => {
    // "episodes" — no word boundary after "episode" before the number
    expect(extractEpisodeNumber('episodes 5')).toBeNull()
  })

  it('handles episode number zero', () => {
    expect(extractEpisodeNumber('Episode 0')).toBe('0')
  })

  it('handles large episode numbers', () => {
    expect(extractEpisodeNumber('Episode 1000')).toBe('1000')
  })

  it('matches "ep" with no space via "\\s*" pattern', () => {
    // The regex has \s* (zero or more spaces) between ep and the number
    expect(extractEpisodeNumber('ep5')).toBe('5')
  })

  it('does not match S01E05 style SxEx patterns (not in scope for this helper)', () => {
    expect(extractEpisodeNumber('[SubGroup] Show - S01E05 [720p]')).toBeNull()
  })
})
