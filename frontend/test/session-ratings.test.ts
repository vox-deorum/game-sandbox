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
  const fallback = overrides.agent.kind === 'builtin' ? 'Naive baseline' : 'Agent 1'
  return {
    display_name: fallback,
    is_own: false,
    author_prompt: null,
    your_rating: null,
    your_feedback: null,
    ...overrides,
  }
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
const NAIVE: AgentRefWire = { kind: 'builtin', name: 'naive' }

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
    expect(screen.queryByText('Rate the Agents')).toBeNull()
  })

  it('renders nothing when the backend returns no participant agents', async () => {
    vi.mocked(getSessionRatings).mockResolvedValue({ ok: true, ratings: view([]) })
    renderPanel()
    await waitFor(() => expect(vi.mocked(getSessionRatings)).toHaveBeenCalled())
    expect(screen.queryByText('Rate the Agents')).toBeNull()
  })

  it('renders a control per rateable agent, including Naive and none for the own agent', async () => {
    vi.mocked(getSessionRatings).mockResolvedValue({
      ok: true,
      ratings: view([
        agent({ agent: SUBMISSION, display_name: 'Your agent', is_own: true }),
        agent({
          agent: { kind: 'submission', submission_id: 'sub-bob' },
          display_name: 'Agent 2',
        }),
        agent({ agent: NAIVE }),
      ]),
    })
    renderPanel()

    await screen.findByText('Rate the Agents')
    expect(screen.getByTestId('ratings-reveal')).toHaveClass('ratings-reveal')
    // The own agent is shown but has no rating control.
    expect(screen.getByText('Your agent')).toBeInTheDocument()
    expect(screen.getByText(/can't rate your own agent/)).toBeInTheDocument()
    // The other submitted agent and the Naive baseline each get a 1-5 radiogroup.
    expect(screen.getByRole('radiogroup', { name: /Rate Agent 2/ })).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: /Rate Naive baseline/ })).toBeInTheDocument()
  })

  it('renders a rating control per agent in a shared multi-agent (Hearts) session', async () => {
    // A four-seat Hearts session shared by three submitted agents and the Naive baseline. Each agent
    // is attributed and rated independently — the new per-agent-in-a-shared-session behavior.
    vi.mocked(getSessionRatings).mockResolvedValue({
      ok: true,
      ratings: view([
        agent({
          agent: { kind: 'submission', submission_id: 'sub-a' },
          display_name: 'Agent 1',
        }),
        agent({
          agent: { kind: 'submission', submission_id: 'sub-b' },
          display_name: 'Agent 2',
        }),
        agent({
          agent: { kind: 'submission', submission_id: 'sub-c' },
          display_name: 'Your agent',
          is_own: true,
        }),
        agent({ agent: NAIVE }),
      ]),
    })
    renderPanel()

    await screen.findByText('Rate the Agents')
    // Each non-own seat gets its own 1-5 control, attributed to the right agent.
    expect(screen.getByRole('radiogroup', { name: /Rate Agent 1/ })).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: /Rate Agent 2/ })).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: /Rate Naive baseline/ })).toBeInTheDocument()
    // The caller's own seat in the shared session is shown but carries no rating control.
    expect(screen.getByText('Your agent')).toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: /Rate Your agent/ })).toBeNull()
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
    await screen.findByText('Rate the Agents')
    expect(screen.getAllByText('Judge overall skill.')).toHaveLength(1)
    expect(screen.getByText('The instructor wants you to rate by:')).toBeInTheDocument()

    const list = screen.getByRole('list')
    const items = within(list).getAllByRole('listitem')
    const submissionItem = items[0] as HTMLElement
    const naiveItem = items[1] as HTMLElement
    // The author prompt shows only next to its own agent; the season prompt is not repeated per item.
    expect(within(submissionItem).getByText('Did it dodge cleanly?')).toBeInTheDocument()
    expect(within(submissionItem).getByText('The author wants you to rate by:')).toBeInTheDocument()
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
    expect(within(group).getByRole('button', { name: '3' })).toHaveAttribute('aria-pressed', 'true')

    // Change to 5, add the now-required comment, and save.
    await fireEvent.click(within(group).getByRole('button', { name: '5' }))
    await fireEvent.update(
      screen.getByPlaceholderText('Tell the author what you thought'),
      'Still strong',
    )
    await fireEvent.click(screen.getByRole('button', { name: 'Save ratings' }))

    expect(vi.mocked(submitRatings)).toHaveBeenCalledWith('s1', [
      { agent: NAIVE, score: 5, feedback: 'Still strong' },
    ])
    await screen.findByText('Saved ✓')
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
      ratings: view(
        [agent({ agent: NAIVE, your_rating: 4, your_feedback: 'Steady under pressure' })],
        { read_only: true },
      ),
    })
    renderPanel()

    await screen.findByText(/Rating for this round has closed/)
    // The prior rating and comment render as text, with no controls and no save button.
    expect(screen.getByText('★ 4')).toBeInTheDocument()
    expect(screen.getByText('Steady under pressure')).toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: /Rate Naive baseline/ })).toBeNull()
    expect(screen.queryByPlaceholderText('Tell the author what you thought')).toBeNull()
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
    await fireEvent.update(screen.getByPlaceholderText('Tell the author what you thought'), 'Meh')
    await fireEvent.click(screen.getByRole('button', { name: 'Save ratings' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/closed/)
  })

  it('keeps Save ratings disabled until every scored agent has a comment', async () => {
    vi.mocked(getSessionRatings).mockResolvedValue({
      ok: true,
      ratings: view([
        agent({
          agent: { kind: 'submission', submission_id: 'sub-a' },
          display_name: 'Agent 1',
        }),
        agent({
          agent: { kind: 'submission', submission_id: 'sub-b' },
          display_name: 'Agent 2',
        }),
      ]),
    })
    renderPanel()

    await screen.findByText('Rate the Agents')
    const save = screen.getByRole('button', { name: 'Save ratings' })
    expect(save).toBeDisabled()

    // Agent 1 gets a score and its comment, so it is complete on its own...
    const firstGroup = screen.getByRole('radiogroup', { name: /Rate Agent 1/ })
    await fireEvent.click(within(firstGroup).getByRole('button', { name: '5' }))
    const textareas = screen.getAllByPlaceholderText('Tell the author what you thought')
    await fireEvent.update(textareas[0] as HTMLElement, 'Steady under pressure')

    // ...but Agent 2 has a score with no comment, so the batch still cannot save.
    const secondGroup = screen.getByRole('radiogroup', { name: /Rate Agent 2/ })
    await fireEvent.click(within(secondGroup).getByRole('button', { name: '4' }))
    expect(save).toBeDisabled()
    expect(screen.getByText('Add a comment before saving.')).toBeInTheDocument()

    await fireEvent.update(textareas[1] as HTMLElement, 'Leaves the gap open')
    expect(save).toBeEnabled()
  })

  it('submits the typed comment with its score in the batch', async () => {
    vi.mocked(getSessionRatings).mockResolvedValue({
      ok: true,
      ratings: view([agent({ agent: NAIVE })]),
    })
    vi.mocked(submitRatings).mockResolvedValue({
      ok: true,
      ratings: view([agent({ agent: NAIVE, your_rating: 5 })]),
    })
    renderPanel()

    const group = await screen.findByRole('radiogroup', { name: /Rate Naive baseline/ })
    await fireEvent.click(within(group).getByRole('button', { name: '5' }))
    await fireEvent.update(
      screen.getByPlaceholderText('Tell the author what you thought'),
      'Steady under pressure',
    )
    await fireEvent.click(screen.getByRole('button', { name: 'Save ratings' }))

    expect(vi.mocked(submitRatings)).toHaveBeenCalledWith('s1', [
      { agent: NAIVE, score: 5, feedback: 'Steady under pressure' },
    ])
    await screen.findByText('Saved ✓')
  })

  it('tracks the comment length live and flags an overlong comment', async () => {
    vi.mocked(getSessionRatings).mockResolvedValue({
      ok: true,
      ratings: view([agent({ agent: NAIVE })]),
    })
    renderPanel()

    await screen.findByText('Rate the Agents')
    const textarea = screen.getByPlaceholderText('Tell the author what you thought')
    await fireEvent.update(textarea, 'twelve chars')
    const counter = screen.getByText('12 / 1000')
    expect(counter).toBeInTheDocument()
    expect(counter).not.toHaveClass('over')

    await fireEvent.update(textarea, 'x'.repeat(1001))
    expect(screen.getByText('1001 / 1000')).toHaveClass('over')
    expect(screen.getByText('Too long by 1 characters.')).toBeInTheDocument()
  })

  it('reopens with a prior comment prefilled in the textarea', async () => {
    vi.mocked(getSessionRatings).mockResolvedValue({
      ok: true,
      ratings: view([agent({ agent: NAIVE, your_rating: 3, your_feedback: 'prior comment' })]),
    })
    renderPanel()

    await screen.findByText('Rate the Agents')
    expect(screen.getByPlaceholderText('Tell the author what you thought')).toHaveValue(
      'prior comment',
    )
  })
})
