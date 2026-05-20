/**
 * Tests for ConversionRunCard component.
 * Depth from root: src/features/video/ -> depth 3 -> ../../../tests/setup/tauri
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConversionRunCard } from './ConversionRunCard'
import '../../../tests/setup/tauri'

// BatchStatusList uses a separate component -- mock it to avoid nested deps
vi.mock('../audio/BatchStatusList', () => ({
  BatchStatusList: ({ items }: { items: Array<{ input: string; status: string }> }) => (
    <div data-testid="batch-status-list">{items.length} items</div>
  ),
}))

describe('ConversionRunCard', () => {
  it('renders title and subtitle', () => {
    render(
      <ConversionRunCard
        title="ProRes 422 LT"
        subtitle="10-bit 4:2:2 ProRes LT MOV"
        canRun={false}
        running={false}
        progress={null}
        result={null}
        error={null}
        onRun={vi.fn()}
      />,
    )
    expect(screen.getByText('ProRes 422 LT')).toBeInTheDocument()
    expect(screen.getByText('10-bit 4:2:2 ProRes LT MOV')).toBeInTheDocument()
  })

  it('renders Start button when not running', () => {
    render(
      <ConversionRunCard
        title="ProRes LT"
        subtitle=""
        canRun={true}
        running={false}
        progress={null}
        result={null}
        error={null}
        onRun={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: /start/i })).toBeInTheDocument()
  })

  it('Start button is disabled when canRun is false', () => {
    render(
      <ConversionRunCard
        title="ProRes LT"
        subtitle=""
        canRun={false}
        running={false}
        progress={null}
        result={null}
        error={null}
        onRun={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: /start/i })).toBeDisabled()
  })

  it('Start button calls onRun when clicked', async () => {
    const user = userEvent.setup()
    const onRun = vi.fn()
    render(
      <ConversionRunCard
        title="ProRes LT"
        subtitle=""
        canRun={true}
        running={false}
        progress={null}
        result={null}
        error={null}
        onRun={onRun}
      />,
    )
    await user.click(screen.getByRole('button', { name: /start/i }))
    expect(onRun).toHaveBeenCalledTimes(1)
  })

  it('renders Cancel button when running and onCancel provided', () => {
    render(
      <ConversionRunCard
        title="ProRes LT"
        subtitle=""
        canRun={false}
        running={true}
        progress={null}
        result={null}
        error={null}
        onRun={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument()
  })

  it('Cancel button calls onCancel when clicked', async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    render(
      <ConversionRunCard
        title="ProRes LT"
        subtitle=""
        canRun={false}
        running={true}
        progress={null}
        result={null}
        error={null}
        onRun={vi.fn()}
        onCancel={onCancel}
      />,
    )
    await user.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('renders progress message', () => {
    render(
      <ConversionRunCard
        title="ProRes LT"
        subtitle=""
        canRun={false}
        running={true}
        progress={{ stage: 'encoding', percent: 45, message: 'Encoding frame 450/1000' }}
        result={null}
        error={null}
        onRun={vi.fn()}
      />,
    )
    expect(screen.getByText('Encoding frame 450/1000')).toBeInTheDocument()
  })

  it('renders progress bar with correct width', () => {
    const { container } = render(
      <ConversionRunCard
        title="ProRes LT"
        subtitle=""
        canRun={false}
        running={true}
        progress={{ stage: 'encoding', percent: 60, message: 'Encoding...' }}
        result={null}
        error={null}
        onRun={vi.fn()}
      />,
    )
    const bar = container.querySelector('[role="progressbar"] span') as HTMLElement
    expect(bar?.style.width).toBe('60%')
  })

  it('renders error message when error is set', () => {
    render(
      <ConversionRunCard
        title="ProRes LT"
        subtitle=""
        canRun={false}
        running={false}
        progress={null}
        result={null}
        error="ffmpeg exited with code 1"
        onRun={vi.fn()}
      />,
    )
    expect(screen.getByText('ffmpeg exited with code 1')).toBeInTheDocument()
  })

  it('renders result filename on completion', () => {
    render(
      <ConversionRunCard
        title="ProRes LT"
        subtitle=""
        canRun={false}
        running={false}
        progress={null}
        result={{
          type: 'done',
          input: 'C:\\in.mp4',
          output: 'C:\\out.mov',
          preset: 'prores-lt',
        }}
        error={null}
        onRun={vi.fn()}
      />,
    )
    expect(screen.getByText('out.mov')).toBeInTheDocument()
  })
})
