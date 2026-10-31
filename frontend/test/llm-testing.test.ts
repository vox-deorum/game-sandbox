import { fireEvent, screen, waitFor } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AdminLlmInfo, LlmDevelopmentSeason } from '../src/api/client.js'
import { signedInMe } from './helpers/me.js'
import { memoryRouter, renderWithMe } from './helpers/render.js'

vi.mock('../src/api/client.js', () => ({
  getMe: vi.fn(),
  checkLlmDevelopmentKey: vi.fn(),
  runLlmDevelopmentChat: vi.fn(),
  getAdminLlm: vi.fn(),
  runAdminLlmChat: vi.fn(),
}))

import {
  checkLlmDevelopmentKey,
  getAdminLlm,
  getMe,
  runAdminLlmChat,
  runLlmDevelopmentChat,
} from '../src/api/client.js'
import AdminLlmPage from '../src/pages/AdminLlmPage.vue'
import LlmTestPage from '../src/pages/LlmTestPage.vue'

const KEY = 'sk-sandbox-dev-abc.secret'

const season: LlmDevelopmentSeason = {
  season_id: 's1',
  label: 'Season 5',
  environment: 'three_branches',
  models: ['small'],
  cost_weights: { small: 2 },
  limits: { token_budget: 1000, rate_limit_rpm: 30 },
  successful_calls: 0,
  usage_estimated: false,
  budget_cost_units_used: 100,
  budget_cost_units_remaining: 900,
  key_exists: true,
}

const completion = {
  choices: [{ message: { content: 'Morning! The rye is warm.' } }],
  usage: { prompt_tokens: 31, completion_tokens: 9, total_tokens: 40 },
}

async function renderAt(path: string, component: object) {
  const router = memoryRouter([{ path, component }])
  router.push(path)
  await router.isReady()
  return renderWithMe(router)
}

describe('LlmTestPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getMe).mockResolvedValue(signedInMe('student', 'normal'))
  })

  async function checkKey(): Promise<void> {
    await renderAt('/my/llm', LlmTestPage)
    await fireEvent.update(await screen.findByLabelText('API key'), KEY)
    await fireEvent.click(screen.getByRole('button', { name: 'Check' }))
  }

  it('confirms a working key with its season and remaining budget', async () => {
    vi.mocked(checkLlmDevelopmentKey).mockResolvedValue({ ok: true, season })
    await checkKey()

    expect(await screen.findByText('Key works')).toBeInTheDocument()
    expect(screen.getByText('Season 5 · three_branches')).toBeInTheDocument()
    expect(screen.getByText('900 units left of 1,000 units')).toBeInTheDocument()
    expect(checkLlmDevelopmentKey).toHaveBeenCalledWith(KEY)
  })

  it('explains a rejected key and hides the prompt tester', async () => {
    vi.mocked(checkLlmDevelopmentKey).mockResolvedValue({
      ok: false,
      status: 401,
      code: 'invalid_api_key',
      message: 'Invalid or revoked API key.',
    })
    await checkKey()

    expect(await screen.findByText(/Key not recognized/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Run' })).not.toBeInTheDocument()
  })

  it('runs a prompt with the checked key and shows the reply, usage, and cost', async () => {
    vi.mocked(checkLlmDevelopmentKey).mockResolvedValue({ ok: true, season })
    vi.mocked(runLlmDevelopmentChat).mockResolvedValue({ ok: true, completion, latencyMs: 640 })
    await checkKey()

    await fireEvent.update(await screen.findByLabelText('System'), 'You are the baker.')
    await fireEvent.update(screen.getByLabelText('User'), 'Good morning!')
    await fireEvent.click(screen.getByRole('button', { name: 'Run' }))

    expect(await screen.findByText('Morning! The rye is warm.')).toBeInTheDocument()
    expect(screen.getByText('31 in · 9 out · 80 units · 640 ms')).toBeInTheDocument()
    expect(runLlmDevelopmentChat).toHaveBeenCalledWith(KEY, {
      model: 'small',
      messages: [
        { role: 'system', content: 'You are the baker.' },
        { role: 'user', content: 'Good morning!' },
      ],
    })
    // The budget meter refreshes after a run.
    await waitFor(() => expect(checkLlmDevelopmentKey).toHaveBeenCalledTimes(2))
  })

  it('keeps the cost of a reply at the model it ran on', async () => {
    const twoModels: LlmDevelopmentSeason = {
      ...season,
      models: ['small', 'large'],
      cost_weights: { small: 2, large: 4 },
    }
    vi.mocked(checkLlmDevelopmentKey).mockResolvedValue({ ok: true, season: twoModels })
    vi.mocked(runLlmDevelopmentChat).mockResolvedValue({ ok: true, completion, latencyMs: 640 })
    await checkKey()

    await fireEvent.update(await screen.findByLabelText('Max tokens'), '50')
    await fireEvent.update(screen.getByLabelText('User'), 'hi')
    await fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect(await screen.findByText('31 in · 9 out · 80 units · 640 ms')).toBeInTheDocument()
    expect(runLlmDevelopmentChat).toHaveBeenCalledWith(
      KEY,
      expect.objectContaining({ max_completion_tokens: 50 }),
    )

    await fireEvent.update(screen.getByLabelText('Model'), 'large')
    expect(screen.getByText('31 in · 9 out · 80 units · 640 ms')).toBeInTheDocument()
  })

  it('ignores a late budget refresh for a key that was replaced', async () => {
    const OTHER = 'sk-sandbox-dev-other.secret'
    let finishRefresh: (value: { ok: true; season: LlmDevelopmentSeason }) => void = () => {}
    vi.mocked(checkLlmDevelopmentKey)
      .mockResolvedValueOnce({ ok: true, season })
      .mockImplementationOnce(() => new Promise((resolve) => (finishRefresh = resolve)))
      .mockResolvedValueOnce({ ok: true, season: { ...season, label: 'Season 6' } })
    vi.mocked(runLlmDevelopmentChat).mockResolvedValue({ ok: true, completion, latencyMs: 640 })
    await checkKey()
    await fireEvent.update(await screen.findByLabelText('User'), 'hi')
    await fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    await waitFor(() => expect(checkLlmDevelopmentKey).toHaveBeenCalledTimes(2))

    await fireEvent.update(screen.getByLabelText('API key'), OTHER)
    await fireEvent.click(screen.getByRole('button', { name: 'Check' }))
    expect(await screen.findByText('Season 6 · three_branches')).toBeInTheDocument()
    finishRefresh({ ok: true, season })
    await new Promise((resolve) => setTimeout(resolve))

    expect(screen.getByText('Season 6 · three_branches')).toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    await waitFor(() =>
      expect(runLlmDevelopmentChat).toHaveBeenLastCalledWith(OTHER, expect.anything()),
    )
  })

  it('explains a budget refusal', async () => {
    vi.mocked(checkLlmDevelopmentKey).mockResolvedValue({ ok: true, season })
    vi.mocked(runLlmDevelopmentChat).mockResolvedValue({
      ok: false,
      status: 400,
      code: 'budget_exceeded',
      message: 'over',
    })
    await checkKey()
    await fireEvent.update(await screen.findByLabelText('User'), 'hi')
    await fireEvent.click(screen.getByRole('button', { name: 'Run' }))

    expect(await screen.findByText(/could cost more than the budget left/)).toBeInTheDocument()
  })
})

describe('AdminLlmPage', () => {
  const info: AdminLlmInfo = {
    configured: true,
    upstream_url: 'https://provider.test/v1',
    key_set: true,
    models: [
      { alias: 'large', upstream_model: 'provider-large', cost_weight: 4 },
      { alias: 'small', upstream_model: 'provider-small', cost_weight: 1 },
    ],
    default_max_output_tokens: 256,
    max_output_tokens: 2048,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getMe).mockResolvedValue(signedInMe('operator', 'admin'))
    vi.mocked(getAdminLlm).mockResolvedValue(info)
  })

  it('is limited to operators', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('student', 'normal'))
    await renderAt('/admin/llm', AdminLlmPage)

    expect(await screen.findByText(/limited to operators/)).toBeInTheDocument()
    expect(getAdminLlm).not.toHaveBeenCalled()
  })

  it('names the missing settings when no upstream is configured', async () => {
    vi.mocked(getAdminLlm).mockResolvedValue({ ...info, configured: false, models: [] })
    await renderAt('/admin/llm', AdminLlmPage)

    expect(await screen.findByText(/LLM_UPSTREAM_URL/)).toBeInTheDocument()
  })

  it('tests every alias and shows each outcome', async () => {
    vi.mocked(runAdminLlmChat).mockImplementation(async (request) =>
      request.model === 'large'
        ? { ok: true, completion, latencyMs: 820 }
        : { ok: false, status: 401, code: 'invalid_api_key', message: 'Incorrect API key' },
    )
    await renderAt('/admin/llm', AdminLlmPage)

    expect(await screen.findByText('provider-large')).toBeInTheDocument()
    expect(screen.getByText('Key set')).toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'Test all' }))

    expect(await screen.findByText('OK · 820 ms')).toBeInTheDocument()
    expect(screen.getByText('401 invalid_api_key')).toBeInTheDocument()
    expect(screen.getByText('Incorrect API key')).toBeInTheDocument()
    expect(runAdminLlmChat).toHaveBeenCalledWith({
      model: 'small',
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      max_completion_tokens: 16,
    })
  })

  it('keeps alias checks within a small output limit', async () => {
    vi.mocked(getAdminLlm).mockResolvedValue({ ...info, max_output_tokens: 8 })
    vi.mocked(runAdminLlmChat).mockResolvedValue({ ok: true, completion, latencyMs: 5 })
    await renderAt('/admin/llm', AdminLlmPage)
    await fireEvent.click(await screen.findByRole('button', { name: 'Test small' }))

    expect(runAdminLlmChat).toHaveBeenCalledWith(
      expect.objectContaining({ max_completion_tokens: 8 }),
    )
  })

  it('shows raw upstream errors in the prompt tester', async () => {
    vi.mocked(runAdminLlmChat).mockResolvedValue({
      ok: false,
      status: 404,
      code: 'model_not_found',
      message: 'No such model',
    })
    await renderAt('/admin/llm', AdminLlmPage)
    await fireEvent.update(await screen.findByLabelText('User'), 'hi')
    await fireEvent.click(screen.getByRole('button', { name: 'Run' }))

    expect(await screen.findByText('404 model_not_found: No such model')).toBeInTheDocument()
  })
})
