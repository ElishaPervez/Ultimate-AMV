/**
 * SceneViewerModal tests
 *
 * Covers:
 * - Invokes scene_clip_render with previewStart/previewEnd (NOT sourceStart/sourceEnd).
 * - Loading/error states.
 * - Closes on Escape and on backdrop click.
 * - Renders null when clip is null.
 * - Shows clip label and sourceName.
 */

import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockInvoke } from '../../../tests/setup/tauri'
import { SceneViewerModal } from './SceneViewerModal'
import type { ClipPreviewItem } from '../../types/clip'

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeClip(overrides: Partial<ClipPreviewItem> = {}): ClipPreviewItem {
  return {
    id: 'clip-scene-42',
    index: 2,
    label: 'Scene 42',
    range: '2:10 - 2:18',
    sourceName: 'episode05',
    sourceSrc: '/video/ep05.mp4',
    sourceStart: 130.0,    // raw TransNetV2 boundary — should NOT be passed
    sourceEnd: 138.0,
    previewStart: 130.125, // padded inward — this is what should be passed
    previewEnd: 137.792,
    fps: 24,
    path: '/video/ep05.mp4',
    ...overrides,
  }
}

const RENDER_OK = JSON.stringify({
  type: 'done',
  sceneId: 'clip-scene-42',
  path: '/cache/scene42.mp4',
  duration: 7.5,
  cached: false,
})

const RENDER_ERR = new Error(JSON.stringify({ message: 'GPU out of memory' }))

// ─── null clip ────────────────────────────────────────────────────────────────

describe('SceneViewerModal — null clip', () => {
  it('renders nothing when clip is null', () => {
    const { container } = render(
      <SceneViewerModal clip={null} onClose={vi.fn()} />
    )
    expect(container.firstChild).toBeNull()
  })
})

// ─── invoke semantics ─────────────────────────────────────────────────────────

describe('SceneViewerModal — invoke uses previewStart/previewEnd', () => {
  it('invokes scene_clip_render with previewStart and previewEnd (not sourceStart/sourceEnd)', async () => {
    const clip = makeClip()
    const handler = vi.fn((_args: unknown) => RENDER_OK)
    mockInvoke('scene_clip_render', handler)

    render(<SceneViewerModal clip={clip} onClose={vi.fn()} />)

    await waitFor(() => expect(handler).toHaveBeenCalled())

    const callArgs = handler.mock.calls[0][0] as Record<string, unknown>
    // Must use previewStart / previewEnd
    expect(callArgs.start).toBe(clip.previewStart)
    expect(callArgs.end).toBe(clip.previewEnd)
    // Must NOT use sourceStart / sourceEnd
    expect(callArgs.start).not.toBe(clip.sourceStart)
    expect(callArgs.end).not.toBe(clip.sourceEnd)
  })

  it('passes the correct sceneId and sourcePath to scene_clip_render', async () => {
    const clip = makeClip()
    const handler = vi.fn((_args: unknown) => RENDER_OK)
    mockInvoke('scene_clip_render', handler)

    render(<SceneViewerModal clip={clip} onClose={vi.fn()} />)
    await waitFor(() => expect(handler).toHaveBeenCalled())

    const callArgs = handler.mock.calls[0][0] as Record<string, unknown>
    expect(callArgs.sceneId).toBe(clip.id)
    expect(callArgs.sourcePath).toBe(clip.path)
  })
})

// ─── loading state ────────────────────────────────────────────────────────────

describe('SceneViewerModal — loading state', () => {
  it('shows loading text while render is in progress', () => {
    const clip = makeClip()
    // never resolves — keeps modal in loading state
    mockInvoke('scene_clip_render', () => new Promise(() => {}))

    render(<SceneViewerModal clip={clip} onClose={vi.fn()} />)
    expect(screen.getByText(/rendering scene preview/i)).toBeInTheDocument()
  })

  it('shows clip label in header during loading', () => {
    const clip = makeClip({ label: 'Scene 42' })
    mockInvoke('scene_clip_render', () => new Promise(() => {}))

    render(<SceneViewerModal clip={clip} onClose={vi.fn()} />)
    expect(screen.getByText('Scene 42')).toBeInTheDocument()
  })

  it('shows sourceName in header during loading', () => {
    const clip = makeClip({ sourceName: 'episode05' })
    mockInvoke('scene_clip_render', () => new Promise(() => {}))

    render(<SceneViewerModal clip={clip} onClose={vi.fn()} />)
    expect(screen.getByText(/episode05/)).toBeInTheDocument()
  })
})

// ─── error state ──────────────────────────────────────────────────────────────

describe('SceneViewerModal — error state', () => {
  it('shows error message when scene_clip_render rejects', async () => {
    const clip = makeClip()
    mockInvoke('scene_clip_render', () => { throw RENDER_ERR })

    render(<SceneViewerModal clip={clip} onClose={vi.fn()} />)
    await waitFor(() =>
      expect(screen.queryByText(/rendering scene preview/i)).not.toBeInTheDocument()
    )
    // The error message from the bridge error parser
    expect(screen.getByText(/GPU out of memory/i)).toBeInTheDocument()
  })
})

// ─── keyboard / backdrop close ────────────────────────────────────────────────

describe('SceneViewerModal — close behaviour', () => {
  it('calls onClose when Escape is pressed', async () => {
    const onClose = vi.fn()
    const clip = makeClip()
    mockInvoke('scene_clip_render', () => new Promise(() => {}))

    render(<SceneViewerModal clip={clip} onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when backdrop is clicked', () => {
    const onClose = vi.fn()
    const clip = makeClip()
    mockInvoke('scene_clip_render', () => new Promise(() => {}))

    render(<SceneViewerModal clip={clip} onClose={onClose} />)
    const backdrop = document.querySelector('.scene-viewer-backdrop') as HTMLElement
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when the actions-area Close button is clicked', () => {
    const onClose = vi.fn()
    const clip = makeClip()
    mockInvoke('scene_clip_render', () => new Promise(() => {}))

    render(<SceneViewerModal clip={clip} onClose={onClose} />)
    // Modal is a createPortal into document.body — container.querySelector misses it.
    // The actions-area "Close" button (episode-label-confirm) is distinct from
    // the header X button (episode-label-close aria-label="Close").
    const actionsClose = document.body.querySelector(
      '.episode-label-actions .episode-label-confirm'
    ) as HTMLElement
    fireEvent.click(actionsClose)
    expect(onClose).toHaveBeenCalled()
  })
})
