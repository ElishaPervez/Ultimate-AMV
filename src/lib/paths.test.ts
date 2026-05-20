import { fileName, fileStem, normalizeSelectedPaths } from './paths'

// ---------------------------------------------------------------------------
// fileName
// ---------------------------------------------------------------------------
describe('fileName', () => {
  it('extracts filename from Windows backslash path', () => {
    expect(fileName('C:\\foo\\bar\\video.mp4')).toBe('video.mp4')
  })

  it('extracts filename from POSIX forward-slash path', () => {
    expect(fileName('/home/user/clips/video.mp4')).toBe('video.mp4')
  })

  it('extracts filename from mixed-separator path', () => {
    expect(fileName('C:\\foo/bar/video.mp4')).toBe('video.mp4')
  })

  it('returns just the filename when there is no directory component', () => {
    expect(fileName('video.mp4')).toBe('video.mp4')
  })

  it('handles file with no extension', () => {
    expect(fileName('/some/path/noext')).toBe('noext')
  })

  it('handles trailing slash by returning empty-string fallback to original', () => {
    // split('/foo/').pop() => '' which is falsy, so it returns the original
    expect(fileName('/foo/')).toBe('/foo/')
  })

  it('handles a plain filename with multiple dots', () => {
    expect(fileName('archive.tar.gz')).toBe('archive.tar.gz')
  })

  it('handles Windows UNC path', () => {
    expect(fileName('\\\\server\\share\\file.mkv')).toBe('file.mkv')
  })
})

// ---------------------------------------------------------------------------
// fileStem
// ---------------------------------------------------------------------------
describe('fileStem', () => {
  it('removes single extension', () => {
    expect(fileStem('/foo/bar/video.mp4')).toBe('video')
  })

  it('removes only the last extension from a multi-dot filename', () => {
    // Uses lastIndexOf-style replace of last extension
    expect(fileStem('/path/foo.bar.baz.mp4')).toBe('foo.bar.baz')
  })

  it('returns full name when there is no extension', () => {
    expect(fileStem('/path/noext')).toBe('noext')
  })

  it('handles Windows path with backslashes', () => {
    expect(fileStem('C:\\Users\\Me\\clip.mkv')).toBe('clip')
  })

  it('handles dotfile (hidden file) — name starts with dot, no other extension', () => {
    // ".gitignore" → the regex replaces the trailing ".gitignore" extension portion
    // fileName returns ".gitignore", then replace(/\.[^.]+$/, '') => ""
    // Current implementation would return "" for ".gitignore"
    expect(fileStem('/home/.gitignore')).toBe('')
  })

  it('handles double extension like .tar.gz', () => {
    // Only the last extension (.gz) is stripped
    expect(fileStem('/archives/backup.tar.gz')).toBe('backup.tar')
  })
})

// ---------------------------------------------------------------------------
// normalizeSelectedPaths
// ---------------------------------------------------------------------------
describe('normalizeSelectedPaths', () => {
  it('wraps a single string into a one-element array', () => {
    expect(normalizeSelectedPaths('/foo/bar.mp4')).toEqual(['/foo/bar.mp4'])
  })

  it('returns the array unchanged when input is already an array', () => {
    const input = ['/a/b.mp4', '/c/d.mkv']
    expect(normalizeSelectedPaths(input)).toEqual(input)
  })

  it('returns empty array for null', () => {
    expect(normalizeSelectedPaths(null)).toEqual([])
  })

  it('returns empty array for empty string (falsy)', () => {
    expect(normalizeSelectedPaths('')).toEqual([])
  })

  it('returns empty array for empty array', () => {
    // An empty array is truthy, so it passes through as-is
    expect(normalizeSelectedPaths([])).toEqual([])
  })

  it('preserves Windows backslash paths inside the array', () => {
    expect(normalizeSelectedPaths(['C:\\foo\\bar.mp4', 'C:\\baz.mkv'])).toEqual([
      'C:\\foo\\bar.mp4',
      'C:\\baz.mkv',
    ])
  })

  it('wraps a Windows path string', () => {
    expect(normalizeSelectedPaths('C:\\Users\\Me\\clip.mp4')).toEqual(['C:\\Users\\Me\\clip.mp4'])
  })
})
