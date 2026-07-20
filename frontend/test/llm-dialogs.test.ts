import { fireEvent, render, screen, waitFor } from '@testing-library/vue'
import { describe, expect, it, vi } from 'vitest'
import { defineComponent, ref } from 'vue'

import DevelopmentCallHistoryDialog from '../src/components/DevelopmentCallHistoryDialog.vue'
import DevelopmentCredentialDialog from '../src/components/DevelopmentCredentialDialog.vue'

const call = {
  id: 2,
  created_at: '2026-07-18T12:00:00Z',
  model: 'medium',
  input_tokens: 12,
  reasoning_tokens: 3,
  output_tokens: 8,
  usage_estimated: false,
  cost_weight: 2,
  budget_cost_units: 40,
  request: { messages: ['hello'] },
  completion: { choices: ['world'] },
}

describe('DevelopmentCallHistoryDialog', () => {
  it('shows the successful empty state when no error is supplied', async () => {
    render(DevelopmentCallHistoryDialog, {
      props: { open: true, calls: [], nextCursor: null },
    })

    expect(await screen.findByText('No successful calls.')).toBeInTheDocument()
  })

  it('supports list/detail/Back, cursor pagination, and restores list scroll', async () => {
    const { emitted, container } = render(DevelopmentCallHistoryDialog, {
      props: { open: true, calls: [call], nextCursor: 1 },
    })
    expect(await screen.findAllByRole('dialog')).toHaveLength(1)
    const viewport = container.ownerDocument.querySelector('.call-list-viewport') as HTMLElement
    viewport.scrollTop = 73
    await fireEvent.click(screen.getByRole('button', { name: /medium.*12 input/i }))
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Request' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Response' })).toBeInTheDocument()
    expect(screen.queryByText(/latency|estimate/i)).not.toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(viewport.scrollTop).toBe(73)
    await fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    expect(emitted()['load-more']).toEqual([[1]])
    await fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(emitted()['update:open']).toContainEqual([false])
  })
})

describe('DevelopmentCredentialDialog', () => {
  it('renders full read-only credentials, copies .env, and clears reactive state on close', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const cleared = vi.fn()
    const Harness = defineComponent({
      components: { DevelopmentCredentialDialog },
      setup() {
        const open = ref(true)
        const credential = ref({
          season_id: 'season-1',
          base_url: 'https://sandbox.example/api/llm/v1',
          api_key: 'sk-sandbox-dev-id.secret',
          models: ['small'] as const,
          cost_weights: { small: 1 },
          limits: { token_budget: 100, rate_limit_rpm: 10 },
        })
        return { open, credential, cleared }
      },
      template:
        '<DevelopmentCredentialDialog v-model:open="open" :credential="credential" @cleared="credential = null; cleared()" />',
    })
    render(Harness)

    const baseUrl = await screen.findByDisplayValue('https://sandbox.example/api/llm/v1')
    const apiKey = screen.getByDisplayValue('sk-sandbox-dev-id.secret')
    expect(baseUrl).toHaveAttribute('readonly')
    expect(apiKey).toHaveAttribute('readonly')
    await fireEvent.click(screen.getByRole('button', { name: 'Copy OPENAI_BASE_URL' }))
    expect(writeText).toHaveBeenCalledWith('https://sandbox.example/api/llm/v1')
    await fireEvent.click(screen.getByRole('button', { name: 'Copy OPENAI_API_KEY' }))
    expect(writeText).toHaveBeenCalledWith('sk-sandbox-dev-id.secret')
    await fireEvent.click(screen.getByRole('button', { name: 'Copy .env' }))
    expect(writeText).toHaveBeenCalledWith(
      'OPENAI_BASE_URL=https://sandbox.example/api/llm/v1\nOPENAI_API_KEY=sk-sandbox-dev-id.secret',
    )
    await fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(cleared).toHaveBeenCalledOnce()
    expect(screen.queryByDisplayValue('sk-sandbox-dev-id.secret')).not.toBeInTheDocument()
  })

  it('clears the one-time secret when Escape closes the dialog', async () => {
    const cleared = vi.fn()
    const Harness = defineComponent({
      components: { DevelopmentCredentialDialog },
      setup() {
        const open = ref(true)
        const credential = ref({
          season_id: 'season-1',
          base_url: 'https://sandbox.example/api/llm/v1',
          api_key: 'sk-sandbox-dev-id.secret',
          models: ['small'] as const,
          cost_weights: { small: 1 },
          limits: { token_budget: 100, rate_limit_rpm: 10 },
        })
        return { open, credential, cleared }
      },
      template:
        '<DevelopmentCredentialDialog v-model:open="open" :credential="credential" @cleared="credential = null; cleared()" />',
    })
    render(Harness)

    await fireEvent.keyDown(await screen.findByRole('dialog'), { key: 'Escape' })
    await waitFor(() => expect(cleared).toHaveBeenCalledOnce())
    expect(screen.queryByDisplayValue('sk-sandbox-dev-id.secret')).not.toBeInTheDocument()
  })

  it('announces clipboard failures without throwing', async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    render(DevelopmentCredentialDialog, {
      props: {
        open: true,
        credential: {
          season_id: 'season-1',
          base_url: 'https://sandbox.example/api/llm/v1',
          api_key: 'sk-sandbox-dev-id.secret',
          models: ['small'],
          cost_weights: { small: 1 },
          limits: { token_budget: 100, rate_limit_rpm: 10 },
        },
      },
    })

    await fireEvent.click(await screen.findByRole('button', { name: 'Copy OPENAI_API_KEY' }))
    expect(await screen.findByRole('status')).toHaveTextContent(
      'OPENAI_API_KEY could not be copied.',
    )
  })
})
