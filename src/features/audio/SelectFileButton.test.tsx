/**
 * src/features/audio/SelectFileButton.test.tsx
 *
 * Tests for SelectFileButton — click triggers the onClick callback.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SelectFileButton } from './SelectFileButton'
import '../../../tests/setup/tauri'

describe('SelectFileButton', () => {
  it('renders "Select files" text', () => {
    render(<SelectFileButton onClick={() => {}} />)
    expect(screen.getByText('Select files')).toBeInTheDocument()
  })

  it('renders the hint text about audio / video extraction', () => {
    render(<SelectFileButton onClick={() => {}} />)
    expect(screen.getByText(/each file gets vocals and instrumental/i)).toBeInTheDocument()
  })

  it('calls onClick when the button is clicked', async () => {
    const onClick = vi.fn()
    render(<SelectFileButton onClick={onClick} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button'))
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('renders a single button element', () => {
    render(<SelectFileButton onClick={() => {}} />)
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })
})
