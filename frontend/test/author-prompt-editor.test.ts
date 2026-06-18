import { fireEvent, render, screen, waitFor } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/api/client.js', () => ({
  getAuthorPrompt: vi.fn(),
  setAuthorPrompt: vi.fn(),
}))

import { getAuthorPrompt, setAuthorPrompt } from '../src/api/client.js'
import AuthorPromptEditor from '../src/components/AuthorPromptEditor.vue'

function renderEditor() {
  return render(AuthorPromptEditor, { props: { iterationId: 'iter-1' } })
}

describe('AuthorPromptEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('pre-fills the saved prompt and saves an edited value', async () => {
    vi.mocked(getAuthorPrompt).mockResolvedValue({ iteration_id: 'iter-1', prompt: 'Old prompt' })
    vi.mocked(setAuthorPrompt).mockResolvedValue({ ok: true, prompt: 'New prompt' })
    renderEditor()

    const textarea = (await screen.findByLabelText('Rating prompt')) as HTMLTextAreaElement
    expect(textarea.value).toBe('Old prompt')

    await fireEvent.update(textarea, 'New prompt')
    await fireEvent.click(screen.getByRole('button', { name: 'Save prompt' }))

    expect(vi.mocked(setAuthorPrompt)).toHaveBeenCalledWith('iter-1', 'New prompt')
    expect(await screen.findByText('Saved ✓')).toBeInTheDocument()
  })

  it('keeps Save disabled until the prompt is actually edited', async () => {
    vi.mocked(getAuthorPrompt).mockResolvedValue({ iteration_id: 'iter-1', prompt: 'Same' })
    renderEditor()

    await screen.findByLabelText('Rating prompt')
    expect(screen.getByRole('button', { name: 'Save prompt' })).toBeDisabled()

    await fireEvent.update(screen.getByLabelText('Rating prompt'), 'Changed')
    expect(screen.getByRole('button', { name: 'Save prompt' })).toBeEnabled()
  })

  it('clears the prompt by saving an empty value as null', async () => {
    vi.mocked(getAuthorPrompt).mockResolvedValue({ iteration_id: 'iter-1', prompt: 'Remove me' })
    vi.mocked(setAuthorPrompt).mockResolvedValue({ ok: true, prompt: null })
    renderEditor()

    await fireEvent.update(await screen.findByLabelText('Rating prompt'), '   ')
    await fireEvent.click(screen.getByRole('button', { name: 'Save prompt' }))

    expect(vi.mocked(setAuthorPrompt)).toHaveBeenCalledWith('iter-1', null)
  })

  it('surfaces the no-agent refusal', async () => {
    vi.mocked(getAuthorPrompt).mockResolvedValue({ iteration_id: 'iter-1', prompt: null })
    vi.mocked(setAuthorPrompt).mockResolvedValue({ ok: false, reason: 'no_agent_in_iteration' })
    renderEditor()

    await fireEvent.update(await screen.findByLabelText('Rating prompt'), 'Anything')
    await fireEvent.click(screen.getByRole('button', { name: 'Save prompt' }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/no agent/i))
  })
})
