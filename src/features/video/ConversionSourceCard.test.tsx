/**
 * Tests for ConversionSourceCard component.
 * Depth from root: src/features/video/ -> depth 3 -> ../../../tests/setup/tauri
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FileVideo } from 'lucide-react'
import { ConversionSourceCard } from './ConversionSourceCard'
import '../../../tests/setup/tauri'

describe('ConversionSourceCard', () => {
  it('shows "No file selected" when no files are selected', () => {
    render(
      <ConversionSourceCard
        icon={<FileVideo size={24} />}
        label="Source video"
        selectedFiles={[]}
        pickLabel="Select videos"
        onPick={vi.fn()}
        disabled={false}
      />,
    )
    expect(screen.getByText('No file selected')).toBeInTheDocument()
  })

  it('shows filename when one file is selected', () => {
    render(
      <ConversionSourceCard
        icon={<FileVideo size={24} />}
        label="Source video"
        selectedFiles={['C:\\Videos\\clip.mp4']}
        pickLabel="Select videos"
        onPick={vi.fn()}
        disabled={false}
      />,
    )
    expect(screen.getByText('clip.mp4')).toBeInTheDocument()
  })

  it('shows file count when multiple files are selected', () => {
    render(
      <ConversionSourceCard
        icon={<FileVideo size={24} />}
        label="Source video"
        selectedFiles={['C:\\a.mp4', 'C:\\b.mp4', 'C:\\c.mp4']}
        pickLabel="Select videos"
        onPick={vi.fn()}
        disabled={false}
      />,
    )
    expect(screen.getByText('3 files selected')).toBeInTheDocument()
  })

  it('renders the pick label on the button', () => {
    render(
      <ConversionSourceCard
        icon={<FileVideo size={24} />}
        label="Source video"
        selectedFiles={[]}
        pickLabel="Select videos"
        onPick={vi.fn()}
        disabled={false}
      />,
    )
    expect(screen.getByRole('button', { name: /select videos/i })).toBeInTheDocument()
  })

  it('calls onPick when the pick button is clicked', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    render(
      <ConversionSourceCard
        icon={<FileVideo size={24} />}
        label="Source video"
        selectedFiles={[]}
        pickLabel="Select videos"
        onPick={onPick}
        disabled={false}
      />,
    )
    await user.click(screen.getByRole('button', { name: /select videos/i }))
    expect(onPick).toHaveBeenCalledTimes(1)
  })

  it('disables pick button when disabled prop is true', () => {
    render(
      <ConversionSourceCard
        icon={<FileVideo size={24} />}
        label="Source video"
        selectedFiles={[]}
        pickLabel="Select videos"
        onPick={vi.fn()}
        disabled={true}
      />,
    )
    expect(screen.getByRole('button', { name: /select videos/i })).toBeDisabled()
  })

  it('renders the label text', () => {
    render(
      <ConversionSourceCard
        icon={<FileVideo size={24} />}
        label="Source video"
        selectedFiles={[]}
        pickLabel="Select videos"
        onPick={vi.fn()}
        disabled={false}
      />,
    )
    expect(screen.getByText('Source video')).toBeInTheDocument()
  })
})
