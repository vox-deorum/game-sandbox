import { fireEvent, render, screen, waitFor, within } from '@testing-library/vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentRefWire, RateableAgent, SessionRatings as Ratings } from '../src/api/client.js'

vi.mock('../src/api/client.js', () => ({
  getSessionRatings: vi.fn(),
  submitRatings: vi.fn(),
}))

import { getSessionRatings, submitRatings } from '../src/api/client.js'
import SessionRatings from '../src/components/SessionRatings.vue'

function agent(overrides: Partial<RateableAgent> & { agent: AgentRefWire }): RateableAgent {
  return { is_own: false, author_prompt: null, your_rating: null, ...overrides }
}

function view(agents: RateableAgent[], overrides: Partial<Ratings> = {}): Ratings {
  return {
    session_id: 's1',
    season_id: 'iter-1',
    read_only: false,
    season_prompt: null,
    agents,
    ...overrides,
  }
}

const SUBMISSION: AgentRefWire = { kind: 'submission', submission_id: 'sub-eve' }
const NAIVE: AgentRefWire = { kind: 'builtin-naive' }

function renderPanel() {
  return render(SessionRatings, { props: { sessionId: 's1' } })
}

describe('SessionRatings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders nothing when the session is not rateable', async () => {
    vi.mocked(getSessionRatings).mockResolvedValue({ ok: false, reason: 'not_rateable' })
    renderPanel()
    // No card heading appears for an unrateable session.
    await waitFor(() => expect(vi.mocked(getSessionRatings)).toHaveBeenCalled())
    expect(screen.queryByText('Rate the agents')).toBeNull()
  })

  it('renders nothing when the backend returns no participant agents', async () => {
    vi.mocked(getSessionRatings).mockResolvedValue({ ok: true, ratings: view([]) })
    renderPanel()
    await waitFor(() => expect(vi.mocked(getSessionRatings)).toHaveBeenCalled())
    expect(screen.queryByText('Rate the agents')).toBeNull()
  })

  it('renders a control per rateable agent, including Naive and none for the own agent', async () => {
    vi.mocked(getSessionRatings).mockResolvedValue({
      ok: true,
      ratings: view([
        agent({ agent: SUBMISSION, is_own: true }),
        agent({ agent: { kind: 'submission', submission_id: 'sub-bob' } }),
        agent({ agent: NAIVE }),
      ]),
    })
    renderPanel()

    expect(await screen.findByText('Rate the agents')).toBeInTheDocument()
    // The own agent is shown but has no rating control.
    expect(screen.getByText('Your agent')).toBeInTheDocument()
    expect(screen.getByText(/can't rate your own agent/)).toBeInTheDocument()
    // The other submitted agent and the Naive baseline each get a 1-5 radiogroup.
    expect(screen.getByRole('radiogroup', { name: /Rate Submitted agent/ })).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: /Rate Naive baseline/ })).toBeInTheDocument()
  })

  it('shows the season prompt once for the panel and the author prompt next to its own agent', async () => {
    vi.mocked(getSessionRatings).mockResolvedValue({
      ok: true,
      ratings: view(
        [
          agent({ agent: SUBMISSION, author_prompt: 'Did it dodge cleanly?' }),
          agent({ agent: NAIVE }),
        ],
        { season_prompt: 'Judge overall skill.' },
      ),
    })
    renderPanel()

    // The operator's season prompt applies to every agent, so it shows exactly once, above the list.
    await screen.findByText('Rate the agents')
    expect(screen.getAllByText('Judge overall skill.')).toHaveLength(1)

    const list = screen.getByRole('list')
    const items = within(list).getAllByRole('listitem')
    const submissionItem = items[0] as HTMLElement
    const naiveItem = items[1] as HTMLElement
    // The author prompt shows only next to its own agent; the season prompt is not repeated per item.
    expect(within(submissionItem).getByText('Did it dodge cleanly?')).toBeInTheDocument()
    expect(within(submissionItem).queryByText('Judge overall skill.')).toBeNull()
    // Naive has no author, so it carries no per-agent prompt at all.
    expect(within(naiveItem).queryByText(/From the author/)).toBeNull()
    expect(within(naiveItem).queryByText('Judge overall skill.')).toBeNull()
  })

  it('pre-fills a prior rating and submits a changed score, reflecting the saved state', async () => {
    vi.mocked(getSessionRatings).mockResolvedValue({
      ok: true,
      ratings: view([agent({ agent: NAIVE, your_rating: 3 })]),
    })
    vi.mocked(submitRatings).mockResolvedValue({
      ok: true,
      ratings: view([agent({ agent: NAIVE, your_rating: 5 })]),
    })
    renderPanel()

    const group = await screen.findByRole('radiogroup', { name: /Rate Naive baseline/ })
    // The prior rating (3) pre-fills, marked pressed.
    expect(within(group).getByRole('button', { name: '3' })).toHaveAttribute('aria-pressed', 'true')

    // Change to 5 and save.
    await fireEvent.click(within(group).getByRole('button', { name: '5' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Save ratings' }))

    expect(vi.mocked(submitRatings)).toHaveBeenCalledWith('s1', [{ agent: NAIVE, score: 5 }])
    expect(await screen.findByText('Saved ✓')).toBeInTheDocument()
    // The reflected saved state marks 5 as pressed.
    await waitFor(() =>
      expect(within(group).getByRole('button', { name: '5' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    )
  })

  it('keeps the panel read-only with no save control when the play window is closed', async () => {
    vi.mocked(getSessionRatings).mockResolvedValue({
      ok: true,
      ratings: view([agent({ agent: NAIVE, your_rating: 4 })], { read_only: true }),
    })
    renderPanel()

    expect(await screen.findByText(/Rating for this round has closed/)).toBeInTheDocument()
    // The prior rating still shows, but the controls are disabled and there is no save button.
    const group = screen.getByRole('radiogroup', { name: /Rate Naive baseline/ })
    expect(within(group).getByRole('button', { name: '4' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Save ratings' })).toBeNull()
  })

  it('surfaces a play-closed refusal that happens between read and submit', async () => {
    vi.mocked(getSessionRatings).mockResolvedValue({
      ok: true,
      ratings: view([agent({ agent: NAIVE })]),
    })
    vi.mocked(submitRatings).mockResolvedValue({ ok: false, reason: 'play_closed' })
    renderPanel()

    const group = await screen.findByRole('radiogroup', { name: /Rate Naive baseline/ })
    await fireEvent.click(within(group).getByRole('button', { name: '2' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Save ratings' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/closed/)
  })
})
