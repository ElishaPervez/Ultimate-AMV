/**
 * BackgroundLayer tests
 * Tests dim/blur prop plumbing, image presence class toggling.
 */

import React from 'react'
import { render, screen } from '@testing-library/react'
import { BackgroundLayer } from './BackgroundLayer'
import type { BackgroundState } from '../../types/app'

const emptyState: BackgroundState = {
  imagePath: '',
  scale: 1,
  offsetX: 50,
  offsetY: 50,
  dim: 55,
  blur: 0,
  videoPath: '',
  videoSource: '',
  videoFps: 30,
  brightText: false,
}

const withImageState: BackgroundState = {
  imagePath: '/path/to/image.jpg',
  scale: 1.5,
  offsetX: 30,
  offsetY: 70,
  dim: 40,
  blur: 10,
  videoPath: '',
  videoSource: '',
  videoFps: 30,
  brightText: false,
}

describe('BackgroundLayer', () => {
  it('renders without crashing with empty state', () => {
    const { container } = render(<BackgroundLayer state={emptyState} />)
    expect(container.querySelector('.app-bg')).toBeInTheDocument()
  })

  it('has aria-hidden=true (decorative element)', () => {
    const { container } = render(<BackgroundLayer state={emptyState} />)
    expect(container.querySelector('.app-bg')).toHaveAttribute('aria-hidden', 'true')
  })

  it('does NOT have has-image class when imagePath is empty', () => {
    const { container } = render(<BackgroundLayer state={emptyState} />)
    expect(container.querySelector('.app-bg')).not.toHaveClass('has-image')
  })

  it('has has-image class when imagePath is set', () => {
    const { container } = render(<BackgroundLayer state={withImageState} />)
    expect(container.querySelector('.app-bg')).toHaveClass('has-image')
  })

  it('renders image div only when imagePath is set', () => {
    const { container } = render(<BackgroundLayer state={withImageState} />)
    expect(container.querySelector('.app-bg-image')).toBeInTheDocument()
  })

  it('does NOT render image div when imagePath is empty', () => {
    const { container } = render(<BackgroundLayer state={emptyState} />)
    expect(container.querySelector('.app-bg-image')).toBeNull()
  })

  it('applies blur filter when blur > 0', () => {
    const { container } = render(<BackgroundLayer state={withImageState} />)
    const imgDiv = container.querySelector('.app-bg-image') as HTMLElement
    expect(imgDiv.style.filter).toContain('blur')
  })

  it('does NOT apply filter when blur = 0', () => {
    const { container } = render(
      <BackgroundLayer state={{ ...withImageState, blur: 0 }} />,
    )
    const imgDiv = container.querySelector('.app-bg-image') as HTMLElement
    // filter should be undefined or empty
    expect(imgDiv.style.filter || '').toBe('')
  })

  it('applies dim overlay when imagePath is set and dim > 0', () => {
    const { container } = render(<BackgroundLayer state={withImageState} />)
    const overlay = container.querySelector('.app-bg-overlay') as HTMLElement
    expect(overlay).toBeInTheDocument()
    expect(overlay.style.background).toContain('rgba')
  })

  it('applies correct scale transform', () => {
    const { container } = render(<BackgroundLayer state={{ ...withImageState, scale: 2 }} />)
    const imgDiv = container.querySelector('.app-bg-image') as HTMLElement
    expect(imgDiv.style.transform).toBe('scale(2)')
  })

  it('applies correct background-position from offsetX and offsetY', () => {
    const { container } = render(
      <BackgroundLayer state={{ ...withImageState, offsetX: 30, offsetY: 70 }} />,
    )
    const imgDiv = container.querySelector('.app-bg-image') as HTMLElement
    expect(imgDiv.style.backgroundPosition).toBe('30% 70%')
  })

  it('dim=0 produces rgba(5, 5, 7, 0) overlay', () => {
    const { container } = render(
      <BackgroundLayer state={{ ...withImageState, dim: 0 }} />,
    )
    const overlay = container.querySelector('.app-bg-overlay') as HTMLElement
    expect(overlay.style.background).toBe('rgba(5, 5, 7, 0)')
  })

  it('dim=100 produces an opaque overlay (dim/100 = 1)', () => {
    const { container } = render(
      <BackgroundLayer state={{ ...withImageState, dim: 100 }} />,
    )
    const overlay = container.querySelector('.app-bg-overlay') as HTMLElement
    // Browsers may normalize rgba(5,5,7,1) → rgb(5,5,7) in computed style.
    // Both representations represent a fully-opaque overlay; accept either.
    expect(overlay.style.background).toMatch(/rgba\(5,\s*5,\s*7,\s*1\)|rgb\(5,\s*5,\s*7\)/)
  })
})
