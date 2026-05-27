/**
 * Tests for SidebarButton component
 * Depth from root: src/shell/ -> depth 2 -> ../../tests/setup/tauri
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AudioLines } from 'lucide-react'
import { SidebarButton } from './SidebarButton'
import '../../tests/setup/tauri'

const testItem = {
  id: 'audio-extraction' as const,
  label: 'Vocal Separation',
  short: 'Vocals',
  icon: AudioLines,
}

describe('SidebarButton', () => {
  it('renders the label text', () => {
    render(
      <SidebarButton
        item={testItem}
        active={false}
        expanded={true}
        onClick={vi.fn()}
      />,
    )
    expect(screen.getByText('Vocal Separation')).toBeInTheDocument()
  })

  it('applies is-active class when active prop is true', () => {
    render(
      <SidebarButton
        item={testItem}
        active={true}
        expanded={true}
        onClick={vi.fn()}
      />,
    )
    const button = screen.getByRole('button', { name: 'Vocal Separation' })
    expect(button).toHaveClass('is-active')
  })

  it('does not apply is-active class when active prop is false', () => {
    render(
      <SidebarButton
        item={testItem}
        active={false}
        expanded={true}
        onClick={vi.fn()}
      />,
    )
    const button = screen.getByRole('button', { name: 'Vocal Separation' })
    expect(button).not.toHaveClass('is-active')
  })

  it('calls onClick when clicked', async () => {
    const user = userEvent.setup()
    const handleClick = vi.fn()
    render(
      <SidebarButton
        item={testItem}
        active={false}
        expanded={true}
        onClick={handleClick}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Vocal Separation' }))
    expect(handleClick).toHaveBeenCalledTimes(1)
  })

  it('sets aria-label from item.label', () => {
    render(
      <SidebarButton
        item={testItem}
        active={false}
        expanded={true}
        onClick={vi.fn()}
      />,
    )
    expect(
      screen.getByRole('button', { name: 'Vocal Separation' }),
    ).toBeInTheDocument()
  })

  it('sets title when not expanded (compact mode)', () => {
    render(
      <SidebarButton
        item={testItem}
        active={false}
        expanded={false}
        onClick={vi.fn()}
      />,
    )
    const button = screen.getByRole('button', { name: 'Vocal Separation' })
    expect(button).toHaveAttribute('title', 'Vocal Separation')
  })

  it('has no title attribute when expanded', () => {
    render(
      <SidebarButton
        item={testItem}
        active={false}
        expanded={true}
        onClick={vi.fn()}
      />,
    )
    const button = screen.getByRole('button', { name: 'Vocal Separation' })
    expect(button).not.toHaveAttribute('title')
  })
})
