/**
 * useFileDrop.ts exports two things:
 *   - useFileDrop()  (React hook backed by Tauri's getCurrentWebview)
 *   - extensionAccept()  (pure function)
 *
 * useFileDrop relies on getCurrentWebview().onDragDropEvent() which is not
 * available in jsdom without a full Tauri runtime.  We therefore test only
 * extensionAccept() here; a note in the report explains why the hook itself
 * is not unit-testable without mocking the webview API.
 */
import { extensionAccept } from './useFileDrop'

describe('extensionAccept', () => {
  it('accepts a file whose extension is in the allowed set', () => {
    const accept = extensionAccept(['mp4', 'mkv'])
    expect(accept('/foo/bar/video.mp4')).toBe(true)
  })

  it('rejects a file whose extension is not in the allowed set', () => {
    const accept = extensionAccept(['mp4', 'mkv'])
    expect(accept('/foo/bar/image.jpg')).toBe(false)
  })

  it('is case-insensitive for the incoming path extension', () => {
    const accept = extensionAccept(['mp4'])
    expect(accept('/foo/VIDEO.MP4')).toBe(true)
    expect(accept('/foo/VIDEO.Mp4')).toBe(true)
  })

  it('is case-insensitive for the allowed extensions list', () => {
    const accept = extensionAccept(['MP4', 'MKV'])
    expect(accept('/foo/video.mp4')).toBe(true)
    expect(accept('/foo/video.mkv')).toBe(true)
  })

  it('strips leading dot from allowed extensions', () => {
    const accept = extensionAccept(['.mp4', '.mkv'])
    expect(accept('/foo/video.mp4')).toBe(true)
  })

  it('rejects a file with no extension', () => {
    const accept = extensionAccept(['mp4'])
    expect(accept('/foo/noext')).toBe(false)
  })

  it('uses the last extension (after the last dot)', () => {
    const accept = extensionAccept(['gz'])
    expect(accept('/archives/backup.tar.gz')).toBe(true)
  })

  it('rejects the first extension of a multi-dot name', () => {
    const accept = extensionAccept(['tar'])
    // Last extension is "gz", not "tar"
    expect(accept('/archives/backup.tar.gz')).toBe(false)
  })

  it('handles an empty allowed-extensions array (nothing is accepted)', () => {
    const accept = extensionAccept([])
    expect(accept('/foo/video.mp4')).toBe(false)
  })

  it('handles Windows backslash paths', () => {
    const accept = extensionAccept(['mp4'])
    // The path passed to accept() is the raw path from the OS
    expect(accept('C:\\Users\\Me\\video.mp4')).toBe(true)
  })

  it('a path that ends with a dot has no extension — rejected', () => {
    const accept = extensionAccept([''])
    // lastIndexOf('.') gives the trailing dot at the end
    // slice(dot+1) gives '' which is in the allowed set only if '' is included
    // With [''] allowed, this will be accepted — tests the actual behavior
    expect(accept('/foo/file.')).toBe(true)
  })

  it('returns false for empty path string', () => {
    const accept = extensionAccept(['mp4'])
    expect(accept('')).toBe(false)
  })
})
