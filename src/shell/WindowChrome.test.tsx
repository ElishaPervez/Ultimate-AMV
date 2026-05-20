/**
 * Tests for WindowChrome component.
 * The component uses getCurrentWindow() from @tauri-apps/api/window.
 * In jsdom __TAURI_INTERNALS__ is not defined, so isDesktop is false
 * and window actions become no-ops — we just verify buttons render and
 * that the component renders the drag zone and controls.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '../../tests/setup/tauri'

// Mock @tauri-apps/api/window so getCurrentWindow is injectable
const mockMinimize = vi.fn().mockResolvedValue(undefined)
const mockToggleMaximize = vi.fn().mockResolvedValue(undefined)
const mockClose = vi.fn().mockResolvedValue(undefined)
const mockStartDragging = vi.fn().mockResolvedValue(undefined)

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    minimize: mockMinimize,
    toggleMaximize: mockToggleMaximize,
    close: mockClose,
    startDragging: mockStartDragging,
  }),
}))

// Import after mock so it picks up the mock
import { WindowChrome } from './WindowChrome'

describe('WindowChrome', () => {
  beforeEach(() => {
    mockMinimize.mockClear()
    mockToggleMaximize.mockClear()
    mockClose.mockClear()
    mockStartDragging.mockClear()
  })

  it('renders minimize button', () => {
    render(<WindowChrome />)
    expect(screen.getByRole('button', { name: 'Minimize' })).toBeInTheDocument()
  })

  it('renders maximize button', () => {
    render(<WindowChrome />)
    expect(screen.getByRole('button', { name: 'Maximize' })).toBeInTheDocument()
  })

  it('renders close button', () => {
    render(<WindowChrome />)
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
  })

  it('renders the drag zone', () => {
    const { container } = render(<WindowChrome />)
    expect(container.querySelector('.drag-zone')).toBeInTheDocument()
  })

  it('renders window-chrome container', () => {
    const { container } = render(<WindowChrome />)
    expect(container.querySelector('.window-chrome')).toBeInTheDocument()
  })

  it('renders window-controls container', () => {
    const { container } = render(<WindowChrome />)
    expect(container.querySelector('.window-controls')).toBeInTheDocument()
  })
})
