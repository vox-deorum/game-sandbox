import { fireEvent, render, screen } from '@testing-library/vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { SeasonSettings } from '../src/api/client.js'
import SetUpLocallyButton from '../src/components/SetUpLocallyButton.vue'
import { flappyMeta } from './helpers/fixtures.js'

const settings: SeasonSettings = {
  season_id: 'week-4',
  season_label: 'Week 4',
  template_repo: { url: 'https://example.test/template', branch: 'week-4' },
  values: { players: 1, pipe_gap: 100 },
  rules: {
    step_timeout_ms: 1000,
    episode_timeout_ms: 120_000,
    messaging_enabled: false,
    message_cap: null,
    llm_enabled: false,
  },
}

function renderButton(input = settings) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/docs/students/getting-started', component: { template: '<div />' } },
    ],
  })
  return render(SetUpLocallyButton, {
    props: { meta: flappyMeta(), settings: input },
    global: { plugins: [router] },
  })
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('SetUpLocallyButton', () => {
  it('opens two setup steps without a changed settings file', async () => {
    renderButton()
    await fireEvent.click(screen.getByRole('button', { name: 'Set Up Locally' }))

    const dialog = await screen.findByRole('dialog')
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(dialog).toHaveTextContent('git clone -b week-4 https://example.test/template')
    expect(dialog).toHaveTextContent('python -m sandbox play')
    expect(screen.queryByText('manifest.json')).toBeNull()
  })

  it('downloads season.json before opening three setup steps for changed settings', async () => {
    const createObjectURL = vi.fn(() => 'blob:season-settings')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    vi.useFakeTimers()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    renderButton({ ...settings, values: { players: 1, pipe_gap: 90 } })

    await fireEvent.click(screen.getByRole('button', { name: 'Set Up Locally' }))

    expect(createObjectURL).toHaveBeenCalledOnce()
    expect(click).toHaveBeenCalledOnce()
    expect(revokeObjectURL).not.toHaveBeenCalled()
    vi.advanceTimersByTime(0)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:season-settings')
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    expect(screen.getByText('manifest.json')).toBeInTheDocument()
  })
})
