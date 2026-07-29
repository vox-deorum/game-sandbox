import { fireEvent, render, screen, within } from '@testing-library/vue'
import { describe, expect, it } from 'vitest'

import type {
  AgentAssignmentInput,
  SeatAssignmentInput,
  WatchAgentSummary,
} from '../src/api/client.js'
import SeatAssignmentDialog from '../src/components/SeatAssignmentDialog.vue'
import { flappyMeta, heartsMeta, spadesMeta } from './helpers/fixtures.js'

function agent(overrides: Partial<WatchAgentSummary> = {}): WatchAgentSummary {
  return { submission_id: 'sub1', anonymous_number: 1, rating_status: 'unrated', ...overrides }
}

const AGENTS: WatchAgentSummary[] = [
  agent({ submission_id: 'sub1', anonymous_number: 1 }),
  agent({ submission_id: 'sub2', anonymous_number: 2 }),
]
const START_CONTEXT = { seasonId: 'season-1', parameters: { players: 4 } }

interface StartPayload {
  seats: Record<string, SeatAssignmentInput>
  parameters?: Record<string, unknown>
  seed?: number
  humanTimeoutMs?: number
}

/** The combobox for a seat row, addressed by its visible "Seat N" label. */
function seat(name: string): HTMLSelectElement {
  return screen.getByRole('combobox', { name }) as HTMLSelectElement
}

/** The most recent `start` payload the dialog emitted. */
function lastStart(emitted: () => Record<string, unknown[]>): StartPayload {
  const calls = emitted().start as StartPayload[][] | undefined
  if (calls === undefined || calls.length === 0) {
    throw new Error('the dialog emitted no start event')
  }
  return calls[calls.length - 1]?.[0] as StartPayload
}

function restrictedMeta() {
  return spadesMeta({
    layout: {
      kind: 'seat_plans',
      plans: [
        {
          key: 'restricted',
          title: 'Restricted',
          seats: [{ players: [0, 2], restricted_builtin: 'cautious' }, { players: [1, 3] }],
        },
      ],
    },
    parameters: [
      {
        name: 'seat_plan',
        title: 'Seat plan',
        description: 'Seat-to-player layout.',
        type: 'choice',
        default: 'restricted',
        choices: [{ value: 'restricted', label: 'Restricted' }],
      },
    ],
  })
}

const RESTRICTED_CONTEXT = { seasonId: 'season-1', parameters: { seat_plan: 'restricted' } }

describe('SeatAssignmentDialog', () => {
  it('watch: preselects the clicked agent into every seat and enables Start', async () => {
    const { emitted } = render(SeatAssignmentDialog, {
      props: {
        ...START_CONTEXT,
        meta: heartsMeta(),
        agents: AGENTS,
        mode: 'watch',
        preselect: { kind: 'submission', submissionId: 'sub2' } satisfies AgentAssignmentInput,
      },
    })
    // Every seat starts preselected to the clicked agent (prefill-all), so Start is enabled at once.
    for (const name of ['Seat 1', 'Seat 2', 'Seat 3', 'Seat 4']) {
      expect(seat(name).value).toBe('submission:sub2')
    }
    const start = screen.getByRole('button', { name: 'Start watching' })
    expect(start).not.toBeDisabled()

    await fireEvent.click(start)
    const payload = lastStart(emitted)
    // The payload covers exactly the environment's required seats, each a valid assignment.
    expect(Object.keys(payload.seats).sort()).toEqual(['seat_0', 'seat_1', 'seat_2', 'seat_3'])
    expect(payload).toEqual({
      seasonId: 'season-1',
      parameters: { players: 4 },
      seats: {
        seat_0: { kind: 'submission', submissionId: 'sub2' },
        seat_1: { kind: 'submission', submissionId: 'sub2' },
        seat_2: { kind: 'submission', submissionId: 'sub2' },
        seat_3: { kind: 'submission', submissionId: 'sub2' },
      },
      seed: undefined,
      humanTimeoutMs: undefined,
    })
  })

  it('rate: locks the intended agent, season parameters, and seed while keeping Start enabled', async () => {
    const { emitted } = render(SeatAssignmentDialog, {
      props: {
        seasonId: 'season-1',
        parameters: { players: 1, pipe_gap: 90 },
        meta: flappyMeta(),
        agents: AGENTS,
        mode: 'rate',
        preselect: { kind: 'submission', submissionId: 'sub1' } satisfies AgentAssignmentInput,
      },
    })

    expect(
      screen.getByText('This rating run uses the selected agent and season settings.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'Pipe gap' })).toBeDisabled()
    expect(seat('Seat 1')).toBeDisabled()
    expect(seat('Seat 1')).toHaveValue('submission:sub1')
    expect(screen.getByRole('spinbutton', { name: 'Seed (optional)' })).toBeDisabled()
    const start = screen.getByRole('button', { name: 'Start watching' })
    expect(start).not.toBeDisabled()

    await fireEvent.click(start)
    expect(lastStart(emitted)).toEqual({
      seasonId: 'season-1',
      parameters: { players: 1, pipe_gap: 90 },
      seats: { seat_0: { kind: 'submission', submissionId: 'sub1' } },
      seed: undefined,
      humanTimeoutMs: undefined,
    })
  })

  it('uses compact masked labels for regular viewers', () => {
    render(SeatAssignmentDialog, {
      props: { ...START_CONTEXT, meta: heartsMeta(), agents: AGENTS, mode: 'watch' },
    })

    const firstSeat = seat('Seat 1')
    expect(within(firstSeat).getByRole('option', { name: 'Agent 1' })).toBeInTheDocument()
    expect(within(firstSeat).getByRole('option', { name: 'Agent 2' })).toBeInTheDocument()
  })

  it('offers every declared builtin by stable value and label in unrestricted seats', () => {
    render(SeatAssignmentDialog, {
      props: { ...RESTRICTED_CONTEXT, meta: restrictedMeta(), agents: AGENTS, mode: 'watch' },
    })

    const unrestricted = seat('Seat 2')
    expect(within(unrestricted).getByRole('option', { name: 'Naive agent' })).toHaveValue(
      'builtin:naive',
    )
    expect(within(unrestricted).getByRole('option', { name: 'Cautious bidder' })).toHaveValue(
      'builtin:cautious',
    )
  })

  it('shows operator names or short submission ids while retaining the complete selected id', async () => {
    const namedSubmissionId = 'named-submission-1234567890'
    const namedOwnerId = 'named-owner-0987654321'
    const fallbackSubmissionId = 'fallback-submission-abcdefghij'
    const fallbackOwnerId = 'fallback-owner-jihgfedcba'
    const operatorAgents = [
      agent({
        submission_id: namedSubmissionId,
        owner_id: namedOwnerId,
        owner_name: 'Eve Adler',
        rating_status: 'own',
        source_kind: 'git',
        commit_sha: 'abcdef1234567890',
      }),
      agent({
        submission_id: fallbackSubmissionId,
        anonymous_number: 2,
        owner_id: fallbackOwnerId,
        source_kind: 'local',
      }),
    ]
    const { emitted } = render(SeatAssignmentDialog, {
      props: {
        ...START_CONTEXT,
        meta: heartsMeta(),
        agents: operatorAgents,
        mode: 'watch',
        isOperator: true,
        preselect: {
          kind: 'submission',
          submissionId: fallbackSubmissionId,
        } satisfies AgentAssignmentInput,
      },
    })

    const firstSeat = seat('Seat 1')
    const namedOption = within(firstSeat).getByRole('option', {
      name: 'Eve Adler · abcdef1234',
    }) as HTMLOptionElement
    const fallbackOption = within(firstSeat).getByRole('option', {
      name: 'fallback · local folder',
    }) as HTMLOptionElement

    // Operator-owned submissions still use the operator label branch, not the regular "Your agent"
    // label. The missing-name fallback comes from the submission id, never the owner's stable id.
    expect(namedOption).toHaveTextContent(/^Eve Adler · abcdef1234$/)
    expect(fallbackOption).toHaveTextContent(/^fallback · local folder$/)
    expect(within(firstSeat).queryByRole('option', { name: 'Your agent' })).toBeNull()

    // Full owner and submission identifiers are absent from visible and accessible option labels.
    for (const identifier of [
      namedSubmissionId,
      namedOwnerId,
      fallbackSubmissionId,
      fallbackOwnerId,
    ]) {
      expect(namedOption.textContent).not.toContain(identifier)
      expect(fallbackOption.textContent).not.toContain(identifier)
      expect(within(firstSeat).queryByRole('option', { name: new RegExp(identifier) })).toBeNull()
    }

    // Only the label is shortened. Native values, preselection, decoding, and the emitted session
    // payload all retain the complete submission id.
    expect(fallbackOption.value).toBe(`submission:${fallbackSubmissionId}`)
    expect(firstSeat.value).toBe(`submission:${fallbackSubmissionId}`)

    await fireEvent.click(screen.getByRole('button', { name: 'Start watching' }))
    expect(lastStart(emitted).seats).toEqual({
      seat_0: { kind: 'submission', submissionId: fallbackSubmissionId },
      seat_1: { kind: 'submission', submissionId: fallbackSubmissionId },
      seat_2: { kind: 'submission', submissionId: fallbackSubmissionId },
      seat_3: { kind: 'submission', submissionId: fallbackSubmissionId },
    })
  })

  it('watch: changing a preselected assignment before Start is reflected in the payload', async () => {
    const { emitted } = render(SeatAssignmentDialog, {
      props: {
        ...START_CONTEXT,
        meta: heartsMeta(),
        agents: AGENTS,
        mode: 'watch',
        preselect: { kind: 'submission', submissionId: 'sub1' } satisfies AgentAssignmentInput,
      },
    })
    // Reassign seat 2 to the Naive baseline and seat 3 to the other submission; the rest stay sub1.
    await fireEvent.update(seat('Seat 2'), 'builtin:naive')
    await fireEvent.update(seat('Seat 3'), 'submission:sub2')
    await fireEvent.click(screen.getByRole('button', { name: 'Start watching' }))

    expect(lastStart(emitted).seats).toEqual({
      seat_0: { kind: 'submission', submissionId: 'sub1' },
      seat_1: { kind: 'builtin-agent', name: 'naive' },
      seat_2: { kind: 'submission', submissionId: 'sub2' },
      seat_3: { kind: 'submission', submissionId: 'sub1' },
    })
  })

  it('play: seats the human at seat 0, fills the rest with Naive, and sends one human seat', async () => {
    const { emitted } = render(SeatAssignmentDialog, {
      props: { ...START_CONTEXT, meta: heartsMeta(), agents: AGENTS, mode: 'play' },
    })
    // Seat 1 is the connected human (no dropdown); the other seats default to the Naive baseline.
    expect(screen.getByText('You')).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Seat 1' })).toBeNull()
    expect(seat('Seat 2').value).toBe('builtin:naive')

    await fireEvent.click(screen.getByRole('button', { name: 'Start playing' }))
    const payload = lastStart(emitted)
    expect(payload.seats).toEqual({
      seat_0: { kind: 'human' },
      seat_1: { kind: 'builtin-agent', name: 'naive' },
      seat_2: { kind: 'builtin-agent', name: 'naive' },
      seat_3: { kind: 'builtin-agent', name: 'naive' },
    })
    // Exactly one human seat, and the unpaced move clock is prefilled from the metadata.
    expect(Object.values(payload.seats).filter((s) => s.kind === 'human')).toHaveLength(1)
    expect(payload.humanTimeoutMs).toBe(60_000)
  })

  it('play: "Sit here" moves the human and resets the vacated seat to the Naive baseline', async () => {
    const { emitted } = render(SeatAssignmentDialog, {
      props: { ...START_CONTEXT, meta: heartsMeta(), agents: AGENTS, mode: 'play' },
    })
    const rows = screen.getAllByRole('listitem')
    // Claim seat 3 for the human (rows are zero-indexed: rows[2] is "Seat 3").
    await fireEvent.click(within(rows[2] as HTMLElement).getByRole('button', { name: 'Sit here' }))

    // Seat 3 is now the human; the vacated seat 1 falls back to a Naive dropdown (never blank).
    expect(screen.queryByRole('combobox', { name: 'Seat 3' })).toBeNull()
    expect(seat('Seat 1').value).toBe('builtin:naive')

    await fireEvent.click(screen.getByRole('button', { name: 'Start playing' }))
    const payload = lastStart(emitted)
    expect(payload.seats).toEqual({
      seat_0: { kind: 'builtin-agent', name: 'naive' },
      seat_1: { kind: 'builtin-agent', name: 'naive' },
      seat_2: { kind: 'human' },
      seat_3: { kind: 'builtin-agent', name: 'naive' },
    })
    expect(Object.values(payload.seats).filter((s) => s.kind === 'human')).toHaveLength(1)
  })

  it('play: offers "Sit here" only on human-capable seats and seats the human at the first one', async () => {
    // A restricted environment marks only some seats human-capable. The human must default to the first
    // such seat, and "Sit here" must appear only on the other human-capable seats — never on a seat the
    // metadata forbids a human from taking.
    render(SeatAssignmentDialog, {
      props: {
        ...START_CONTEXT,
        meta: heartsMeta({ human_players: ['player_1', 'player_2'] }),
        agents: AGENTS,
        mode: 'play',
      },
    })
    const rows = screen.getAllByRole('listitem')
    // The human defaults to player_1 ("Seat 2"), the first human-capable seat, not seat 1.
    expect(within(rows[1] as HTMLElement).getByText('You')).toBeInTheDocument()
    // Exactly one "Sit here", on the other human-capable seat (player_2 = "Seat 3"); none on the
    // non-human-capable seats 1 and 4.
    expect(screen.getAllByRole('button', { name: 'Sit here' })).toHaveLength(1)
    expect(
      within(rows[2] as HTMLElement).getByRole('button', { name: 'Sit here' }),
    ).toBeInTheDocument()
    expect(within(rows[0] as HTMLElement).queryByRole('button', { name: 'Sit here' })).toBeNull()
    expect(within(rows[3] as HTMLElement).queryByRole('button', { name: 'Sit here' })).toBeNull()
  })

  it('play: a submission can be assigned to a non-human seat', async () => {
    const { emitted } = render(SeatAssignmentDialog, {
      props: { ...START_CONTEXT, meta: heartsMeta(), agents: AGENTS, mode: 'play' },
    })
    await fireEvent.update(seat('Seat 2'), 'submission:sub1')
    await fireEvent.update(seat('Seat 3'), 'submission:sub2')
    await fireEvent.click(screen.getByRole('button', { name: 'Start playing' }))

    expect(lastStart(emitted).seats).toEqual({
      seat_0: { kind: 'human' },
      seat_1: { kind: 'submission', submissionId: 'sub1' },
      seat_2: { kind: 'submission', submissionId: 'sub2' },
      seat_3: { kind: 'builtin-agent', name: 'naive' },
    })
  })

  it('derives human-capable seats from the resolved seat membership', async () => {
    const meta = heartsMeta({
      layout: {
        kind: 'seat_plans',
        plans: [
          {
            key: 'uneven',
            title: 'Uneven',
            seats: [{ players: [0] }, { players: [1, 2, 3] }],
          },
        ],
      },
      human_players: ['player_2'],
      parameters: [
        {
          name: 'seat_plan',
          title: 'Seat plan',
          description: 'Assignment layout.',
          type: 'choice',
          default: 'uneven',
          choices: [{ value: 'uneven', label: 'Uneven' }],
        },
      ],
    })
    const { emitted } = render(SeatAssignmentDialog, {
      props: {
        seasonId: 'season-1',
        parameters: { seat_plan: 'uneven' },
        meta,
        agents: AGENTS,
        mode: 'play',
      },
    })

    expect(screen.getByText('You').closest('li')).toHaveTextContent('Seat 2')
    expect(screen.getByText('3 players')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sit here' })).toBeNull()
    const start = screen.getByRole('button', { name: 'Start playing' })
    expect(start).toBeDisabled()
    await fireEvent.update(
      screen.getByRole('combobox', { name: 'Companion agent for Seat 2' }),
      'submission:sub1',
    )
    await fireEvent.click(start)
    expect(lastStart(emitted).seats).toEqual({
      seat_0: { kind: 'builtin-agent', name: 'naive' },
      seat_1: { kind: 'human', companion: { kind: 'submission', submissionId: 'sub1' } },
    })
  })

  it('shows resolved player counts and requires an explicit companion for a wide human seat', async () => {
    const { emitted } = render(SeatAssignmentDialog, {
      props: {
        seasonId: 'season-1',
        parameters: { seat_plan: 'partnership' },
        meta: spadesMeta(),
        agents: AGENTS,
        mode: 'play',
      },
    })

    expect(screen.getAllByText('2 players')).toHaveLength(2)
    const start = screen.getByRole('button', { name: 'Start playing' })
    expect(start).toBeDisabled()
    const companion = screen.getByRole('combobox', { name: 'Companion agent for Seat 1' })
    expect(companion).toHaveValue('')
    await fireEvent.update(companion, 'submission:sub2')
    expect(start).toBeEnabled()
    await fireEvent.click(start)

    expect(lastStart(emitted)).toMatchObject({
      parameters: { seat_plan: 'partnership' },
      seats: {
        seat_0: {
          kind: 'human',
          companion: { kind: 'submission', submissionId: 'sub2' },
        },
        seat_1: { kind: 'builtin-agent', name: 'naive' },
      },
    })
  })

  it('keeps a restricted play seat human by default, then restores its designated builtin', async () => {
    const { emitted } = render(SeatAssignmentDialog, {
      props: { ...RESTRICTED_CONTEXT, meta: restrictedMeta(), agents: AGENTS, mode: 'play' },
    })
    const rows = screen.getAllByRole('listitem')
    expect(within(rows[0] as HTMLElement).getByText('You')).toBeInTheDocument()
    expect(screen.getByText('Cautious bidder controls the other players.')).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Companion agent for Seat 1' })).toBeNull()

    await fireEvent.click(screen.getByRole('button', { name: 'Start playing' }))
    expect(lastStart(emitted).seats).toEqual({
      seat_0: { kind: 'human' },
      seat_1: { kind: 'builtin-agent', name: 'naive' },
    })

    await fireEvent.click(within(rows[1] as HTMLElement).getByRole('button', { name: 'Sit here' }))
    const restricted = seat('Seat 1')
    expect(restricted).toHaveValue('builtin:cautious')
    expect(restricted).toBeDisabled()
  })

  it('locks restricted watch seats and leaves unrestricted seats editable', () => {
    render(SeatAssignmentDialog, {
      props: { ...RESTRICTED_CONTEXT, meta: restrictedMeta(), agents: AGENTS, mode: 'watch' },
    })
    expect(seat('Seat 1')).toHaveValue('builtin:cautious')
    expect(seat('Seat 1')).toBeDisabled()
    expect(seat('Seat 2')).not.toBeDisabled()
  })

  it('locks a non-human-capable restricted seat to its designated builtin', () => {
    const meta = restrictedMeta()
    meta.human_players = ['player_1', 'player_3']
    render(SeatAssignmentDialog, {
      props: { ...RESTRICTED_CONTEXT, meta, agents: AGENTS, mode: 'play' },
    })
    expect(seat('Seat 1')).toHaveValue('builtin:cautious')
    expect(seat('Seat 1')).toBeDisabled()
    expect(within(seat('Seat 1')).queryByRole('option', { name: 'Human' })).toBeNull()
  })

  // A rating run that leaves the restricted seat at its Human default is a session the rater plays, so
  // the copy has to say so rather than describing a watch.
  it('rate: says the rater plays when the restricted seat keeps its human default', async () => {
    const { emitted } = render(SeatAssignmentDialog, {
      props: {
        ...RESTRICTED_CONTEXT,
        meta: restrictedMeta(),
        agents: AGENTS,
        mode: 'rate',
        preselect: { kind: 'submission', submissionId: 'sub1' } satisfies AgentAssignmentInput,
      },
    })

    expect(
      screen.getByText(
        'This rating run uses the selected agent and season settings. You play Seat 1.',
      ),
    ).toBeInTheDocument()
    expect(seat('Seat 1')).toHaveValue('human')
    await fireEvent.click(screen.getByRole('button', { name: 'Start playing' }))
    expect(lastStart(emitted).seats).toEqual({
      seat_0: { kind: 'human' },
      seat_1: { kind: 'submission', submissionId: 'sub1' },
    })
  })

  it('rate keeps the intended agent in unrestricted seats and exposes only the restricted choice', async () => {
    const meta = restrictedMeta()
    meta.parameters = [
      ...meta.parameters,
      {
        name: 'rounds',
        title: 'Rounds',
        description: 'Rounds per game.',
        type: 'int',
        default: 3,
        min: 1,
        max: 5,
      },
      {
        name: 'rules',
        title: 'Rules',
        description: 'Optional rules.',
        type: 'multi_choice',
        default: ['wind'],
        choices: [
          { value: 'wind', label: 'Wind' },
          { value: 'night', label: 'Night' },
        ],
      },
    ]
    const { emitted } = render(SeatAssignmentDialog, {
      props: {
        seasonId: 'season-1',
        parameters: { seat_plan: 'restricted', rounds: 3, rules: ['wind'] },
        meta,
        agents: AGENTS,
        mode: 'rate',
        preselect: { kind: 'submission', submissionId: 'sub1' } satisfies AgentAssignmentInput,
      },
    })
    const restricted = seat('Seat 1')
    expect(restricted).not.toBeDisabled()
    expect(within(restricted).getAllByRole('option')).toHaveLength(2)
    expect(seat('Seat 2')).toHaveValue('submission:sub1')
    expect(seat('Seat 2')).toBeDisabled()
    expect(screen.getByRole('spinbutton', { name: 'Rounds' })).toBeDisabled()
    expect(screen.getByRole('group', { name: 'Rules' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Wind' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Wind' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Night' })).toBeDisabled()
    expect(screen.getByRole('spinbutton', { name: 'Seed (optional)' })).toBeDisabled()

    await fireEvent.update(restricted, 'builtin:cautious')
    await fireEvent.click(screen.getByRole('button', { name: 'Start watching' }))
    expect(lastStart(emitted).seats).toEqual({
      seat_0: { kind: 'builtin-agent', name: 'cautious' },
      seat_1: { kind: 'submission', submissionId: 'sub1' },
    })
    expect(lastStart(emitted).parameters).toEqual({
      seat_plan: 'restricted',
      rounds: 3,
      rules: ['wind'],
    })
  })

  it('keeps the player count in the seat heading without changing the select name', () => {
    render(SeatAssignmentDialog, {
      props: { ...RESTRICTED_CONTEXT, meta: restrictedMeta(), agents: AGENTS, mode: 'watch' },
    })
    const heading = screen.getByText('Seat 1').parentElement
    expect(heading).toHaveClass('seat-heading')
    expect(within(heading as HTMLElement).getByText('2 players')).toBeInTheDocument()
    expect(heading?.parentElement?.querySelector('.seat-control .player-count')).toBeNull()
    expect(seat('Seat 1')).toHaveAccessibleName('Seat 1')
  })

  it('removes a wide-seat companion when the human moves away and does not restore it later', async () => {
    render(SeatAssignmentDialog, {
      props: {
        seasonId: 'season-1',
        parameters: { seat_plan: 'partnership' },
        meta: spadesMeta(),
        agents: AGENTS,
        mode: 'play',
      },
    })

    await fireEvent.update(
      screen.getByRole('combobox', { name: 'Companion agent for Seat 1' }),
      'submission:sub1',
    )
    const rows = screen.getAllByRole('listitem')
    await fireEvent.click(within(rows[1] as HTMLElement).getByRole('button', { name: 'Sit here' }))
    expect(screen.getByRole('combobox', { name: 'Companion agent for Seat 2' })).toHaveValue('')

    await fireEvent.click(within(rows[0] as HTMLElement).getByRole('button', { name: 'Sit here' }))
    expect(screen.getByRole('combobox', { name: 'Companion agent for Seat 1' })).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Start playing' })).toBeDisabled()
  })

  it('rebuilds exact seats on plan changes and clears a companion that is illegal in solo', async () => {
    const { emitted } = render(SeatAssignmentDialog, {
      props: {
        seasonId: 'season-1',
        parameters: { seat_plan: 'partnership' },
        meta: spadesMeta(),
        agents: AGENTS,
        mode: 'play',
      },
    })

    await fireEvent.update(
      screen.getByRole('combobox', { name: 'Companion agent for Seat 1' }),
      'submission:sub1',
    )
    await fireEvent.update(screen.getByRole('combobox', { name: 'Seat 2' }), 'submission:sub2')
    await fireEvent.update(screen.getByRole('combobox', { name: 'Seat plan' }), 'solo')

    expect(screen.getAllByText('1 player')).toHaveLength(4)
    expect(screen.queryByRole('combobox', { name: /Companion agent/ })).toBeNull()
    await fireEvent.click(screen.getByRole('button', { name: 'Start playing' }))
    expect(lastStart(emitted).seats).toEqual({
      seat_0: { kind: 'human' },
      seat_1: { kind: 'submission', submissionId: 'sub2' },
      seat_2: { kind: 'builtin-agent', name: 'naive' },
      seat_3: { kind: 'builtin-agent', name: 'naive' },
    })

    await fireEvent.update(screen.getByRole('combobox', { name: 'Seat plan' }), 'partnership')
    expect(screen.getByRole('combobox', { name: 'Companion agent for Seat 1' })).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Start playing' })).toBeDisabled()
  })

  // Every environment today is fixed-player, so `players` is hidden and the grid never resizes. These
  // cover the machinery that exists for the first variable-player environment, where the players control
  // becomes visible and the grid follows it.
  describe('a visible seat count', () => {
    /** Hearts with a variable player range, so the synthesized `players` control is visible. */
    function variableSeatMeta() {
      return heartsMeta({
        layout: { kind: 'player_bounds', min: 2, max: 6 },
        human_players: ['player_0', 'player_1', 'player_2', 'player_3', 'player_4', 'player_5'],
        parameters: [
          {
            name: 'players',
            title: 'Players',
            description: 'Players.',
            type: 'int',
            default: 4,
            min: 2,
            max: 6,
          },
        ],
      })
    }

    const CONTEXT = { seasonId: 'season-1', parameters: { players: 4 } }

    it('fills a seat added by a growing count with the dialog default, not the Naive baseline', async () => {
      render(SeatAssignmentDialog, {
        props: {
          ...CONTEXT,
          meta: variableSeatMeta(),
          agents: AGENTS,
          mode: 'watch',
          preselect: { kind: 'submission', submissionId: 'sub2' } satisfies AgentAssignmentInput,
        },
      })
      await fireEvent.update(screen.getByLabelText(/Players/), '6')

      // "Preselect that agent into every seat" has to keep holding for the seats that appear later,
      // otherwise growing the grid quietly seats Naive in the new rows.
      for (const name of ['Seat 1', 'Seat 5', 'Seat 6']) {
        expect(seat(name).value).toBe('submission:sub2')
      }
    })

    it('does not resize the grid while the players field holds a value it rejects', async () => {
      render(SeatAssignmentDialog, {
        props: { ...CONTEXT, meta: variableSeatMeta(), agents: AGENTS, mode: 'watch' },
      })
      await fireEvent.update(seat('Seat 2'), 'submission:sub1')

      // Out of range, and mid-edit an empty field is momentarily out of range too. Either would
      // otherwise resolve to nothing, snap the grid back to the environment maximum, and evict the
      // assignment above before the form had reported the problem.
      for (const rejected of ['99', '']) {
        await fireEvent.update(screen.getByLabelText(/Players/), rejected)
        expect(screen.getAllByRole('listitem')).toHaveLength(4)
        expect(seat('Seat 2').value).toBe('submission:sub1')
        expect(screen.getByRole('button', { name: 'Start watching' })).toBeDisabled()
      }

      // Back to a value the declaration accepts, and the grid follows again.
      await fireEvent.update(screen.getByLabelText(/Players/), '5')
      expect(screen.getAllByRole('listitem')).toHaveLength(5)
      expect(seat('Seat 2').value).toBe('submission:sub1')
      expect(screen.getByRole('button', { name: 'Start watching' })).not.toBeDisabled()
    })
  })
})
