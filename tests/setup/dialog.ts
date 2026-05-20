/**
 * tests/setup/dialog.ts
 *
 * Mock for @tauri-apps/plugin-dialog open / save.
 *
 * By default:
 *   - open()  resolves to null  (user cancelled)
 *   - save()  resolves to null  (user cancelled)
 *
 * Override in individual tests:
 *   mockDialogOpen.mockResolvedValueOnce('/path/to/file.mp3')
 *   mockDialogSave.mockResolvedValueOnce('/path/to/out.mp3')
 */

import { vi, beforeEach } from 'vitest'

export const mockDialogOpen = vi.fn(async (): Promise<string | string[] | null> => null)
export const mockDialogSave = vi.fn(async (): Promise<string | null> => null)

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: mockDialogOpen,
  save: mockDialogSave,
}))

export function installDialogResets(): void {
  beforeEach(() => {
    mockDialogOpen.mockReset()
    mockDialogOpen.mockResolvedValue(null)
    mockDialogSave.mockReset()
    mockDialogSave.mockResolvedValue(null)
  })
}
