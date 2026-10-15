import type { RecordingHeader } from '@game-sandbox/schema'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'

import type {
  AgentRefWire,
  RateableAgent,
  RatingSource,
  SessionRatings as Ratings,
} from '../src/api/client.js'
import { MeProvider } from '../src/me.js'
import { signedInMe } from './helpers/me.js'

vi.mock('../src/api/client.js', () => ({
  getMe: vi.fn(),
  getSessionRatings: vi.fn(),
  submitRatings: vi.fn(),
}))

import { getMe, getSessionRatings, submitRatings } from '../src/api/client.js'
import SessionRatings from '../src/components/SessionRatings.vue'
import { useToast } from '../src/toast.js'

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
    season_id: 'iter-1',
    read_only: false,
    season_prompt: null,
    agents,
    ...overrides,
  }
}

const SUBMISSION: AgentRefWire = { kind: 'submission', submission_id: 'sub-eve' }
const NAIVE: AgentRefWire = { kind: 'builtin', name: 'naive' }

function renderPanel(
  attribution: Partial<Pick<RecordingHeader, 'players' | 'seats'>> = {},
  source: RatingSource = { kind: 'session', id: 's1' },
) {
  return render(MeProvider, {
    slots: {
      default: () => h(SessionRatings, { source, ...attribution }),
    },
  })
}

describe('SessionRatings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getMe).mockResolvedValue(signedInMe('rater', 'normal'))
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

  it('prefixes agent names with their recorded seats, once per wide seat and in numeric order', async () => {
    vi.mocked(getSessionRatings).mockResolvedValue({
      ok: true,
      ratings: view([
        agent({ agent: SUBMISSION, display_name: "Eve's agent" }),
        agent({ agent: NAIVE, display_name: 'Naive' }),
        agent({ agent: { kind: 'builtin', name: 'hero' }, display_name: 'Hero' }),
      ]),
    })
    renderPanel({
      players: {
        player_0: { kind: 'human', label: 'Eve' },
        player_1: { kind: 'agent', submission_id: 'sub-eve', label: "Eve's agent" },
        player_2: { kind: 'agent', submission_id: 'sub-eve', label: "Eve's agent" },
        player_3: { kind: 'agent', submission_id: 'sub-eve', label: "Eve's agent" },
        player_4: { kind: 'agent', builtin_name: 'naive', label: 'Naive' },
        player_5: { kind: 'agent', builtin_name: 'hero', label: 'Hero' },
      },
      seats: {
        seat_10: ['player_3'],
        seat_2: ['player_5'],
        seat_1: ['player_4'],
        seat_0: ['player_0', 'player_1', 'player_2'],
      },
    })
    expect(await screen.findByText("S0, S10: Eve's agent")).toBeInTheDocument()
    expect(screen.getByText('S1: Naive')).toBeInTheDocument()
    expect(screen.getByText('S2: Hero')).toBeInTheDocument()
    expect(screen.getAllByRole('radiogroup')).toHaveLength(3)
    expect(
      screen.getByRole('radiogroup', { name: "Rate S0, S10: Eve's agent from 1 to 5" }),
    ).toBeInTheDocument()
  })

  it('keeps blind rating names when the header contains an identified agent', async () => {
    vi.mocked(getSessionRatings).mockResolvedValue({
      ok: true,
      ratings: view([agent({ agent: SUBMISSION, display_name: 'Agent 7' })]),
    })
    renderPanel({
      players: {
        player_0: { kind: 'agent', submission_id: 'sub-eve', label: "Eve's agent" },
      },
      seats: { seat_0: ['player_0'] },
    })
    expect(await screen.findByText('S0: Agent 7')).toBeInTheDocument()
    expect(screen.queryByText(/Eve/)).toBeNull()
  })

  it('renders nothing when the backend returns no participant agents', async () => {
    vi.mocked(getSessionRatings).mockResolvedValue({ ok: true, ratings: view([]) })
    renderPanel()
    await waitFor(() => expect(vi.mocked(getSessionRatings)).toHaveBeenCalled())
    expect(screen.queryByText('Rate the Agents')).toBeNull()
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
    const ownAgent = screen.getByText('Your agent').closest('li') as HTMLElement
    expect(screen.queryByRole('radiogroup', { name: /Rate Your agent/ })).toBeNull()
    expect(within(ownAgent).queryByPlaceholderText('Tell the author what you thought')).toBeNull()
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
    expect(within(naiveItem).queryByText('The author wants you to rate by:')).toBeNull()
    expect(within(naiveItem).queryByText('Judge overall skill.')).toBeNull()
  })

  it.each([
    ['session', { kind: 'session', id: 's1' }],
    ['recording', { kind: 'recording', id: 'rec-1' }],
  ] as const)('pre-fills and saves a changed rating and comment for a %s source', async (_kind, source) => {
    vi.mocked(getSessionRatings).mockResolvedValue({
      ok: true,
      ratings: view([
        agent({ agent: NAIVE, your_rating: 3, your_feedback: 'A useful prior note' }),
      ]),
    })
    vi.mocked(submitRatings).mockResolvedValue({
      ok: true,
      ratings: view([agent({ agent: NAIVE, your_rating: 5, your_feedback: 'Still strong' })]),
    })
    renderPanel({}, source)

    const group = await screen.findByRole('radiogroup', { name: /Rate Naive baseline/ })
    expect(within(group).getByRole('button', { name: '3' })).toHaveAttribute('aria-pressed', 'true')
    const comment = screen.getByPlaceholderText('Tell the author what you thought')
    expect(comment).toHaveValue('A useful prior note')

    // Change to 5, update the existing comment, and save.
    await fireEvent.click(within(group).getByRole('button', { name: '5' }))
    await fireEvent.update(comment, 'Still strong')
    await fireEvent.click(screen.getByRole('button', { name: 'Save ratings' }))

    expect(vi.mocked(submitRatings)).toHaveBeenCalledWith(source, [
      { agent: NAIVE, score: 5, feedback: 'Still strong' },
    ])
    await screen.findByText('Saved ✓')
    await waitFor(() =>
      expect(within(group).getByRole('button', { name: '5' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    )
    expect(comment).toHaveValue('Still strong')
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

  it('does not save a scored rating with a whitespace-only comment', async () => {
    vi.mocked(getSessionRatings).mockResolvedValue({
      ok: true,
      ratings: view([agent({ agent: NAIVE })]),
    })
    renderPanel()

    const group = await screen.findByRole('radiogroup', { name: /Rate Naive baseline/ })
    await fireEvent.click(within(group).getByRole('button', { name: '4' }))
    const comment = screen.getByPlaceholderText('Tell the author what you thought')
    await fireEvent.update(comment, '  \n  ')

    expect(screen.getByRole('button', { name: 'Save ratings' })).toBeDisabled()
    expect(screen.getByText('Add a comment before saving.')).toBeInTheDocument()
    expect(submitRatings).not.toHaveBeenCalled()
  })

  it('waits for a save, retains a refused draft, and lets the user retry', async () => {
    vi.mocked(getSessionRatings).mockResolvedValue({
      ok: true,
      ratings: view([agent({ agent: NAIVE })]),
    })
    let resolveSave: ((result: Awaited<ReturnType<typeof submitRatings>>) => void) | undefined
    vi.mocked(submitRatings).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve
        }),
    )
    renderPanel()

    const group = await screen.findByRole('radiogroup', { name: /Rate Naive baseline/ })
    await fireEvent.click(within(group).getByRole('button', { name: '5' }))
    const comment = screen.getByPlaceholderText('Tell the author what you thought')
    const longDraft = '😀'.repeat(1001)
    await fireEvent.update(comment, longDraft)
    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save ratings' })

    await fireEvent.click(save)
    await waitFor(() => expect(submitRatings).toHaveBeenCalledTimes(1))
    expect(save).toBeDisabled()
    save.click()
    expect(submitRatings).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Saved ✓')).toBeNull()

    resolveSave?.({ ok: false, reason: 'feedback_too_long' })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'One comment is too long. Trim it and save again.',
    )
    expect(comment).toHaveValue(longDraft)
    expect(screen.queryByText('Saved ✓')).toBeNull()

    vi.mocked(submitRatings).mockResolvedValueOnce({
      ok: true,
      ratings: view([agent({ agent: NAIVE, your_rating: 5, your_feedback: 'Trimmed note' })]),
    })
    await fireEvent.update(comment, 'Trimmed note')
    await fireEvent.click(save)

    expect(submitRatings).toHaveBeenCalledTimes(2)
    expect(submitRatings).toHaveBeenLastCalledWith({ kind: 'session', id: 's1' }, [
      { agent: NAIVE, score: 5, feedback: 'Trimmed note' },
    ])
    await screen.findByText('Saved ✓')
    expect(comment).toHaveValue('Trimmed note')
  })

  it('tracks the comment length live and flags an overlong comment', async () => {
    vi.mocked(getSessionRatings).mockResolvedValue({
      ok: true,
      ratings: view([agent({ agent: NAIVE })]),
    })
    renderPanel()

    await screen.findByText('Rate the Agents')
    const textarea = screen.getByPlaceholderText('Tell the author what you thought')
    await fireEvent.update(textarea, '😀'.repeat(1000))
    const counter = screen.getByText('1000 / 1000')
    expect(counter).toBeInTheDocument()
    expect(counter).not.toHaveClass('over')
    expect(textarea).not.toHaveAttribute('aria-invalid', 'true')

    await fireEvent.update(textarea, '😀'.repeat(1001))
    expect(screen.getByText('1001 / 1000')).toHaveClass('over')
    expect(screen.getByText('Too long by 1 character.')).toBeInTheDocument()
    expect(textarea).toHaveAttribute('aria-invalid', 'true')

    await fireEvent.update(textarea, '😀'.repeat(1002))
    expect(screen.getByText('Too long by 2 characters.')).toBeInTheDocument()
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

  it('keeps the panel interactive for a guest but blocks Save with a toast, sending nothing', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('guest-one', 'guest'))
    vi.mocked(getSessionRatings).mockResolvedValue({
      ok: true,
      ratings: view([agent({ agent: NAIVE })]),
    })
    renderPanel()

    // The controls stay interactive: a score and a comment can be chosen.
    const group = await screen.findByRole('radiogroup', { name: /Rate Naive baseline/ })
    await fireEvent.click(within(group).getByRole('button', { name: '5' }))
    await fireEvent.update(
      screen.getByPlaceholderText('Tell the author what you thought'),
      'Looks steady',
    )

    // Saving shows the blocked toast and never reaches the API. The toast message is read from the
    // shared queue (the UiToast host, which lives in AppShell, is not mounted here).
    await fireEvent.click(screen.getByRole('button', { name: 'Save ratings' }))
    expect(useToast().toasts.map((toast) => toast.message)).toContain(
      "Guest accounts can't rate agents.",
    )
    expect(vi.mocked(submitRatings)).not.toHaveBeenCalled()
  })
})
