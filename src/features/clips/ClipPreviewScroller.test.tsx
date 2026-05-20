/**
 * ClipPreviewScroller tests
 *
 * Covers:
 * - Renders children inside the scroller div.
 * - Adds clip-preview-grid-scroller class.
 * - Merges additional className props.
 * - Forwards ref to the underlying div.
 */

import React from 'react'
import { render, screen } from '@testing-library/react'
import { ClipPreviewScroller } from './ClipPreviewScroller'

describe('ClipPreviewScroller', () => {
  it('renders children', () => {
    render(
      <ClipPreviewScroller>
        <span data-testid="child">hello</span>
      </ClipPreviewScroller>
    )
    expect(screen.getByTestId('child')).toBeInTheDocument()
  })

  it('has clip-preview-grid-scroller class', () => {
    const { container } = render(<ClipPreviewScroller />)
    expect(container.firstElementChild).toHaveClass('clip-preview-grid-scroller')
  })

  it('merges extra className prop', () => {
    const { container } = render(<ClipPreviewScroller className="extra-class" />)
    expect(container.firstElementChild).toHaveClass('clip-preview-grid-scroller')
    expect(container.firstElementChild).toHaveClass('extra-class')
  })

  it('forwards ref to the div element', () => {
    const ref = React.createRef<HTMLDivElement>()
    render(<ClipPreviewScroller ref={ref} />)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
    expect(ref.current).toHaveClass('clip-preview-grid-scroller')
  })

  it('passes through arbitrary HTML attributes (e.g. data-testid)', () => {
    render(<ClipPreviewScroller data-testid="scroller" />)
    expect(screen.getByTestId('scroller')).toBeInTheDocument()
  })
})
