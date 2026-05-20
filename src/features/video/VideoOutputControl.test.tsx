/**
 * Tests for VideoOutputControl component.
 * Depth from root: src/features/video/ -> depth 3 -> ../../../tests/setup/tauri
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { VideoOutputControl } from './VideoOutputControl'
import '../../../tests/setup/tauri'

const proresLtSpec = {
  label: 'Bitrate density',
  valueLabel: 'Density',
  help: 'Higher density raises ProRes LT file size and headroom.',
  min: 180,
  max: 700,
  step: 10,
  defaultValue: 360,
  suffix: '',
}

describe('VideoOutputControl', () => {
  it('renders the label text', () => {
    render(<VideoOutputControl spec={proresLtSpec} value={360} disabled={false} onChange={vi.fn()} />)
    expect(screen.getByText('Bitrate density')).toBeInTheDocument()
  })

  it('renders the help text', () => {
    render(<VideoOutputControl spec={proresLtSpec} value={360} disabled={false} onChange={vi.fn()} />)
    expect(screen.getByText('Higher density raises ProRes LT file size and headroom.')).toBeInTheDocument()
  })

  it('number input shows current value', () => {
    render(<VideoOutputControl spec={proresLtSpec} value={400} disabled={false} onChange={vi.fn()} />)
    const input = screen.getByRole('spinbutton', { name: 'Bitrate density' })
    expect(input).toHaveValue(400)
  })

  it('slider shows current value', () => {
    render(<VideoOutputControl spec={proresLtSpec} value={400} disabled={false} onChange={vi.fn()} />)
    const slider = screen.getByRole('slider', { name: 'Bitrate density' })
    expect(slider).toHaveValue('400')
  })

  it('calls onChange when slider is moved', async () => {
    const onChange = vi.fn()
    const { container } = render(
      <VideoOutputControl spec={proresLtSpec} value={360} disabled={false} onChange={onChange} />,
    )
    const slider = container.querySelector('input[type="range"]') as HTMLInputElement
    // fireEvent directly triggers the onChange handler on the range input
    const { fireEvent } = await import('@testing-library/react')
    fireEvent.change(slider, { target: { value: '370' } })
    expect(onChange).toHaveBeenCalledWith(370)
  })

  it('inputs are disabled when disabled=true', () => {
    render(<VideoOutputControl spec={proresLtSpec} value={360} disabled={true} onChange={vi.fn()} />)
    const spinbutton = screen.getByRole('spinbutton', { name: 'Bitrate density' })
    const slider = screen.getByRole('slider', { name: 'Bitrate density' })
    expect(spinbutton).toBeDisabled()
    expect(slider).toBeDisabled()
  })

  it('renders the valueLabel', () => {
    render(<VideoOutputControl spec={proresLtSpec} value={360} disabled={false} onChange={vi.fn()} />)
    expect(screen.getByText('Density')).toBeInTheDocument()
  })

  it('calls onChange with fallback defaultValue when input is cleared and blurred', async () => {
    // BUG: VideoOutputControl.commitDraft() calls Number(draftValue). When the
    // field is cleared, draftValue is "", Number("") is 0, and
    // Number.isFinite(0) is true, so onChange(0) is called instead of
    // onChange(defaultValue=360). The guard should be
    //   `Number.isFinite(next) && next !== 0 ? next : spec.defaultValue`
    // or equivalently check `draftValue.trim() !== ""`.
    // Leave this test failing to document the bug.
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<VideoOutputControl spec={proresLtSpec} value={360} disabled={false} onChange={onChange} />)
    const input = screen.getByRole('spinbutton', { name: 'Bitrate density' })
    await user.clear(input)
    await user.tab() // blur
    expect(onChange).toHaveBeenCalledWith(proresLtSpec.defaultValue)
  })
})
