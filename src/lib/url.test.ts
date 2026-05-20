import { normalizeUrl } from './url'

describe('normalizeUrl', () => {
  it('returns empty string for empty input', () => {
    expect(normalizeUrl('')).toBe('')
  })

  it('leaves an https:// URL untouched', () => {
    expect(normalizeUrl('https://example.com')).toBe('https://example.com')
  })

  it('leaves an http:// URL untouched', () => {
    expect(normalizeUrl('http://example.com')).toBe('http://example.com')
  })

  it('prepends https:// to a bare domain', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com')
  })

  it('prepends https:// to a domain with path', () => {
    expect(normalizeUrl('example.com/path/to/page')).toBe('https://example.com/path/to/page')
  })

  it('prepends https:// to a domain with query params', () => {
    expect(normalizeUrl('example.com?foo=bar')).toBe('https://example.com?foo=bar')
  })

  it('is case-insensitive for the protocol check — HTTPS:// passes through', () => {
    expect(normalizeUrl('HTTPS://example.com')).toBe('HTTPS://example.com')
  })

  it('is case-insensitive for the protocol check — HTTP:// passes through', () => {
    expect(normalizeUrl('HTTP://example.com')).toBe('HTTP://example.com')
  })

  it('prepends https:// to a bare IP address', () => {
    expect(normalizeUrl('192.168.1.1')).toBe('https://192.168.1.1')
  })

  it('prepends https:// to a localhost address', () => {
    expect(normalizeUrl('localhost:3000')).toBe('https://localhost:3000')
  })

  it('does not double-prepend when already normalized', () => {
    expect(normalizeUrl(normalizeUrl('example.com'))).toBe('https://example.com')
  })
})
