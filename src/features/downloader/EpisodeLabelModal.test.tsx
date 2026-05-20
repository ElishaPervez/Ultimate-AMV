/**
 * Tests for EpisodeLabelModal component.
 * Covers: rendering, pre-fill from props, suggestions, submit/cancel,
 * custom-dir flow, keyboard interactions.
 */

import React from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EpisodeLabelModal } from './EpisodeLabelModal'
import { mockInvoke } from '../../../tests/setup/tauri'
import { mockDialogOpen } from '../../../tests/setup/dialog'

const noop = () => {}

function renderModal(overrides: Partial<Parameters<typeof EpisodeLabelModal>[0]> = {}) {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  const result = render(
    <EpisodeLabelModal
      open={true}
      initialAnime="Attack on Titan"
      initialEpisode="12"
      downloadDir="/downloads"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...overrides}
    />
  )
  return { ...result, onConfirm, onCancel }
}

describe('EpisodeLabelModal', () => {
  beforeEach(() => {
    // Default: no existing folders
    mockInvoke('list_anime_folders', () => [])
  })

  it('does not render when open is false', () => {
    render(
      <EpisodeLabelModal
        open={false}
        initialAnime="My Show"
        initialEpisode="5"
        onConfirm={noop}
        onCancel={noop}
      />
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('renders dialog when open is true', () => {
    renderModal()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('pre-fills anime title from initialAnime prop', () => {
    renderModal({ initialAnime: 'Demon Slayer' })
    const input = screen.getByPlaceholderText('e.g. Attack on Titan') as HTMLInputElement
    expect(input.value).toBe('Demon Slayer')
  })

  it('pre-fills episode number from initialEpisode prop', () => {
    renderModal({ initialEpisode: '7' })
    const input = screen.getByPlaceholderText('e.g. 12') as HTMLInputElement
    expect(input.value).toBe('7')
  })

  it('calls onCancel when the text Cancel button is clicked', async () => {
    // There are two cancel triggers: the X icon button (aria-label="Cancel")
    // and the text "Cancel" button (.episode-label-cancel). Use document.body
    // because EpisodeLabelModal renders via createPortal into document.body.
    const { onCancel } = renderModal()
    const cancelBtn = document.body.querySelector('.episode-label-cancel') as HTMLButtonElement
    fireEvent.click(cancelBtn)
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('calls onCancel when the X close button (aria-label=Cancel) is clicked', () => {
    const { onCancel } = renderModal()
    const xBtn = document.body.querySelector('.episode-label-close') as HTMLButtonElement
    fireEvent.click(xBtn)
    expect(onCancel).toHaveBeenCalled()
  })

  it('calls onCancel on Escape key', () => {
    const { onCancel } = renderModal()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('does not call onConfirm when text Cancel button is clicked', () => {
    const { onConfirm, onCancel } = renderModal()
    // Modal renders via createPortal into document.body
    const cancelBtn = document.body.querySelector('.episode-label-cancel') as HTMLButtonElement
    fireEvent.click(cancelBtn)
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('calls onConfirm with anime-folder mode when both fields are filled', () => {
    const { onConfirm } = renderModal({ initialAnime: 'One Piece', initialEpisode: '999' })
    fireEvent.click(screen.getByRole('button', { name: 'Start download' }))
    expect(onConfirm).toHaveBeenCalledWith({
      mode: 'anime-folder',
      animeTitle: 'One Piece',
      episodeNumber: '999',
      isNewFolder: true, // no existing folders in mock
    })
  })

  it('Start download button is disabled when anime field is empty', async () => {
    renderModal({ initialAnime: '' })
    const btn = screen.getByRole('button', { name: 'Start download' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('Start download button is disabled when episode field is empty', () => {
    renderModal({ initialEpisode: '' })
    const btn = screen.getByRole('button', { name: 'Start download' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('enables Start download when both fields are filled', () => {
    renderModal({ initialAnime: 'Naruto', initialEpisode: '1' })
    const btn = screen.getByRole('button', { name: 'Start download' }) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
  })

  it('lists anime folder suggestions from invoke', async () => {
    mockInvoke('list_anime_folders', () => ['Attack on Titan', 'Bleach', 'One Piece'])
    renderModal({ initialAnime: '' })
    const animeInput = screen.getByPlaceholderText('e.g. Attack on Titan')
    fireEvent.focus(animeInput)
    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument()
    })
    expect(screen.getByText('Attack on Titan')).toBeInTheDocument()
    expect(screen.getByText('Bleach')).toBeInTheDocument()
  })

  it('picks a suggestion and closes the dropdown', async () => {
    mockInvoke('list_anime_folders', () => ['Bleach', 'Naruto'])
    renderModal({ initialAnime: '' })
    const animeInput = screen.getByPlaceholderText('e.g. Attack on Titan')
    fireEvent.focus(animeInput)
    await waitFor(() => screen.getByText('Bleach'))
    fireEvent.click(screen.getByText('Bleach'))
    expect((animeInput as HTMLInputElement).value).toBe('Bleach')
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    })
  })

  it('shows "New folder will be created" when name does not match any existing folder', async () => {
    mockInvoke('list_anime_folders', () => ['Bleach'])
    renderModal({ initialAnime: 'Brand New Show' })
    await waitFor(() => {
      expect(screen.getByText('New folder will be created')).toBeInTheDocument()
    })
  })

  it('shows "Existing folder" when name matches an existing folder', async () => {
    mockInvoke('list_anime_folders', () => ['Attack on Titan'])
    renderModal({ initialAnime: 'Attack on Titan' })
    await waitFor(() => {
      expect(screen.getByText('Existing folder')).toBeInTheDocument()
    })
  })

  it('submits on Enter key in episode field when form is valid', async () => {
    const { onConfirm } = renderModal({ initialAnime: 'Jujutsu Kaisen', initialEpisode: '3' })
    const episodeInput = screen.getByPlaceholderText('e.g. 12')
    fireEvent.keyDown(episodeInput, { key: 'Enter' })
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('picks custom directory via dialog and switches mode', async () => {
    mockDialogOpen.mockResolvedValueOnce('/my/custom/path')
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: /Save somewhere else/i }))
    await waitFor(() => {
      expect(screen.getByText('/my/custom/path')).toBeInTheDocument()
    })
  })

  it('confirms with custom-dir mode when custom dir is selected', async () => {
    mockDialogOpen.mockResolvedValueOnce('/custom/dir')
    const { onConfirm } = renderModal({ initialAnime: 'Vinland Saga', initialEpisode: '8' })
    fireEvent.click(screen.getByRole('button', { name: /Save somewhere else/i }))
    await waitFor(() => screen.getByText('/custom/dir'))
    fireEvent.click(screen.getByRole('button', { name: 'Start download' }))
    expect(onConfirm).toHaveBeenCalledWith({
      mode: 'custom-dir',
      customDir: '/custom/dir',
      animeTitle: 'Vinland Saga',
      episodeNumber: '8',
    })
  })

  it('custom-dir mode: only episode number required (anime field hidden)', async () => {
    mockDialogOpen.mockResolvedValueOnce('/some/dir')
    // Open modal with empty anime
    const { onConfirm } = renderModal({ initialAnime: '', initialEpisode: '5' })
    fireEvent.click(screen.getByRole('button', { name: /Save somewhere else/i }))
    await waitFor(() => screen.getByText('/some/dir'))
    // With custom dir, anime title is not required
    const btn = screen.getByRole('button', { name: 'Start download' }) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'custom-dir', customDir: '/some/dir' })
    )
  })

  it('allows reverting from custom dir to anime-folder mode', async () => {
    mockDialogOpen.mockResolvedValueOnce('/custom/dir')
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: /Save somewhere else/i }))
    await waitFor(() => screen.getByText('/custom/dir'))
    fireEvent.click(screen.getByText('Use anime folder instead'))
    // Anime input should be visible again
    expect(screen.getByPlaceholderText('e.g. Attack on Titan')).toBeInTheDocument()
  })

  it('resets inputs when open transitions from false to true', () => {
    const { rerender } = render(
      <EpisodeLabelModal
        open={false}
        initialAnime="Old Show"
        initialEpisode="1"
        onConfirm={noop}
        onCancel={noop}
      />
    )
    rerender(
      <EpisodeLabelModal
        open={true}
        initialAnime="New Show"
        initialEpisode="42"
        onConfirm={noop}
        onCancel={noop}
      />
    )
    const animeInput = screen.getByPlaceholderText('e.g. Attack on Titan') as HTMLInputElement
    const episodeInput = screen.getByPlaceholderText('e.g. 12') as HTMLInputElement
    expect(animeInput.value).toBe('New Show')
    expect(episodeInput.value).toBe('42')
  })
})
