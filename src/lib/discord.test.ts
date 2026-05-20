/**
 * discord.ts is a stateful module (module-level variables: currentPanel,
 * activeJobs, lastPushed, enabled). Each test that mutates state must
 * reset it.  We achieve this by re-importing the module in beforeEach via
 * vi.resetModules(), which gives each test a fresh module instance.
 */
import { mockInvoke, mockInvokeFn } from '../../tests/setup/tauri'

// We need to re-import after resetting modules so each describe block gets
// fresh state. Use dynamic import to avoid hoisting issues.

describe('discord module', () => {
  // We always register the discord_set_state and discord_clear handlers
  // so the module's fire-and-forget invocations don't fail.
  beforeEach(() => {
    mockInvoke('discord_set_state', () => undefined)
    mockInvoke('discord_clear', () => undefined)
    mockInvoke('frontend_log', () => undefined)
  })

  it('isDiscordEnabled returns true by default (nothing in localStorage)', async () => {
    // localStorage is cleared by setup/index.ts beforeEach
    const { isDiscordEnabled } = await import('./discord')
    expect(isDiscordEnabled()).toBe(true)
  })

  it('isDiscordEnabled returns false when localStorage says "false"', async () => {
    localStorage.setItem('discord_presence_enabled', 'false')
    vi.resetModules()
    const { isDiscordEnabled } = await import('./discord')
    expect(isDiscordEnabled()).toBe(false)
  })

  it('setDiscordEnabled(false) calls discord_clear invoke', async () => {
    vi.resetModules()
    const { setDiscordEnabled } = await import('./discord')
    setDiscordEnabled(false)
    // discord_clear is invoked with no second argument (invoke(cmd) — no args object)
    await vi.waitFor(() =>
      expect(mockInvokeFn).toHaveBeenCalledWith('discord_clear')
    )
  })

  it('setDiscordEnabled(true) after false triggers a push (discord_set_state)', async () => {
    vi.resetModules()
    const { setDiscordEnabled } = await import('./discord')
    setDiscordEnabled(false)
    mockInvokeFn.mockClear()
    setDiscordEnabled(true)
    await vi.waitFor(() =>
      expect(mockInvokeFn).toHaveBeenCalledWith('discord_set_state', { state: 'Idle' })
    )
  })

  it('setDiscordEnabled is a no-op when called with the same value', async () => {
    vi.resetModules()
    const { setDiscordEnabled, isDiscordEnabled } = await import('./discord')
    // enabled starts as true
    expect(isDiscordEnabled()).toBe(true)
    setDiscordEnabled(true) // same value — no change
    expect(isDiscordEnabled()).toBe(true)
    // No invoke should have been fired
    await new Promise((r) => setTimeout(r, 20))
    expect(mockInvokeFn).not.toHaveBeenCalled()
  })

  it('setDiscordPanel changes current panel and pushes state', async () => {
    vi.resetModules()
    const { setDiscordPanel } = await import('./discord')
    setDiscordPanel('Clip Extractor')
    await vi.waitFor(() =>
      expect(mockInvokeFn).toHaveBeenCalledWith('discord_set_state', { state: 'Clip Extractor' })
    )
  })

  it('setDiscordPanel trims and defaults empty string to "Idle"', async () => {
    vi.resetModules()
    const { setDiscordPanel } = await import('./discord')
    setDiscordPanel('   ')
    await vi.waitFor(() =>
      expect(mockInvokeFn).toHaveBeenCalledWith('discord_set_state', { state: 'Idle' })
    )
  })

  it('setDiscordJob(label, true) adds a job and pushes it as active state', async () => {
    vi.resetModules()
    const { setDiscordJob } = await import('./discord')
    setDiscordJob('Extracting', true)
    await vi.waitFor(() =>
      expect(mockInvokeFn).toHaveBeenCalledWith('discord_set_state', { state: 'Extracting' })
    )
  })

  it('setDiscordJob(label, false) removes the job; state falls back to panel', async () => {
    vi.resetModules()
    const { setDiscordJob, setDiscordPanel } = await import('./discord')
    setDiscordPanel('Home')
    mockInvokeFn.mockClear()
    setDiscordJob('Extracting', true)
    mockInvokeFn.mockClear()
    setDiscordJob('Extracting', false)
    await vi.waitFor(() =>
      expect(mockInvokeFn).toHaveBeenCalledWith('discord_set_state', { state: 'Home' })
    )
  })

  it('ignores blank job label in setDiscordJob', async () => {
    vi.resetModules()
    const { setDiscordJob } = await import('./discord')
    setDiscordJob('  ', true) // blank after trim — should be ignored
    await new Promise((r) => setTimeout(r, 20))
    expect(mockInvokeFn).not.toHaveBeenCalled()
  })

  it('does not push duplicate state if already pushed', async () => {
    vi.resetModules()
    const { setDiscordPanel } = await import('./discord')
    setDiscordPanel('Clip Extractor')
    await vi.waitFor(() => expect(mockInvokeFn).toHaveBeenCalledTimes(1))
    mockInvokeFn.mockClear()
    setDiscordPanel('Clip Extractor') // same — no new push
    await new Promise((r) => setTimeout(r, 20))
    expect(mockInvokeFn).not.toHaveBeenCalled()
  })

  it('does not invoke discord_set_state when disabled', async () => {
    vi.resetModules()
    const { setDiscordEnabled, setDiscordPanel } = await import('./discord')
    setDiscordEnabled(false)
    mockInvokeFn.mockClear()
    setDiscordPanel('Downloads')
    await new Promise((r) => setTimeout(r, 20))
    expect(mockInvokeFn).not.toHaveBeenCalledWith('discord_set_state', expect.anything())
  })

  it('setDiscordEnabled persists to localStorage', async () => {
    vi.resetModules()
    const { setDiscordEnabled } = await import('./discord')
    setDiscordEnabled(false)
    expect(localStorage.getItem('discord_presence_enabled')).toBe('false')
    setDiscordEnabled(true)
    expect(localStorage.getItem('discord_presence_enabled')).toBe('true')
  })

  it('last active job wins over earlier jobs as the pushed state', async () => {
    vi.resetModules()
    const { setDiscordJob } = await import('./discord')
    setDiscordJob('Job A', true)
    mockInvokeFn.mockClear()
    setDiscordJob('Job B', true)
    await vi.waitFor(() =>
      expect(mockInvokeFn).toHaveBeenCalledWith('discord_set_state', { state: 'Job B' })
    )
  })
})
