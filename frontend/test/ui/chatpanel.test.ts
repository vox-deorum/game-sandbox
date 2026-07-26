import { fireEvent, render, screen } from '@testing-library/vue'
import { describe, expect, it } from 'vitest'

import ChatPanel from '../../src/components/ChatPanel.vue'
import type { ChatEntry } from '../../src/lib/chat.js'

// A four-player Spades attribution map: two plain agents, the viewer's human player, and a submitted
// agent whose ownership a blind viewer must not see.
const PLAYERS = {
  player_0: { kind: 'agent' as const, label: 'Naive agent' },
  player_1: { kind: 'agent' as const, label: 'Naive agent' },
  player_2: { kind: 'human' as const, label: 'dev', user: 'dev' },
  player_3: { kind: 'agent' as const, label: "maya's agent", user: 'maya', submission_id: 'sub-1' },
}
// One published external turn: the state names the sender, the tick it was published on, the
// recipients the environment allows, and the recipient selected by default.
const OPPORTUNITY = {
  sender: 'player_2',
  tick: 7,
  targetRecipients: ['player_0', 'player_1', 'player_3'],
  defaultRecipient: 'player_0',
}
const TURN = { opportunity: OPPORTUNITY }

describe('ChatPanel', () => {
  it('badges broadcasts, to-you, from-you, and blind-labels senders', () => {
    const entries: ChatEntry[] = [
      { tick: 1, from: 'player_0', to: null, text: 'hearts broken?' },
      { tick: 2, from: 'player_1', to: 'player_2', text: 'partner up' },
      { tick: 3, from: 'player_2', to: 'player_0', text: 'on it' },
      { tick: 4, from: 'player_3', to: null, text: 'going nil' },
    ]
    render(ChatPanel, {
      props: {
        entries,
        players: PLAYERS,
        viewerPlayers: ['player_2'],
        blind: true,
        viewerId: 'dev',
        anonymousNumbers: { 'sub-1': 4 },
      },
    })

    // Each entry carries the badge for what it is.
    expect(screen.getAllByText('broadcast')).toHaveLength(2)
    expect(screen.getByText('to you')).toBeInTheDocument()
    expect(screen.getByText('from you')).toBeInTheDocument()

    // Message bodies render.
    expect(screen.getByText('hearts broken?')).toBeInTheDocument()
    expect(screen.getByText('on it')).toBeInTheDocument()

    // The blind viewer sees the submitted agent's season number, never its owner's label.
    expect(screen.getByText('Agent 4')).toBeInTheDocument()
    expect(screen.queryByText("maya's agent")).toBeNull()
  })

  it('shows an empty state and no composer when not sendable', () => {
    render(ChatPanel, { props: { entries: [], players: PLAYERS } })
    expect(screen.getByText('No messages yet.')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
  })

  it('counts code points against the cap: exactly the cap sends, one more does not', async () => {
    render(ChatPanel, {
      props: {
        entries: [],
        players: PLAYERS,
        viewerPlayers: ['player_2'],
        sendable: true,
        messageCap: 3,
        ...TURN,
      },
    })
    const input = screen.getByRole('textbox')
    const send = screen.getByRole('button', { name: 'Send' })

    // An empty draft cannot send.
    expect(send).toBeDisabled()

    // Three astral-plane emoji are three code points (six UTF-16 units): exactly the cap sends.
    await fireEvent.update(input, '😀😀😀')
    expect(screen.getByText('3/3')).toBeInTheDocument()
    expect(send).toBeEnabled()

    // One more emoji is over the cap: send is disabled.
    await fireEvent.update(input, '😀😀😀😀')
    expect(send).toBeDisabled()
  })

  it('emits the pinned send payload and clears the draft', async () => {
    const { emitted } = render(ChatPanel, {
      props: {
        entries: [],
        players: PLAYERS,
        viewerPlayers: ['player_2'],
        sendable: true,
        messageCap: 120,
        ...TURN,
      },
    })
    const recipient = screen.getByRole('combobox')
    const input = screen.getByRole('textbox') as HTMLInputElement

    // A targeted message carries the chosen recipient.
    await fireEvent.update(recipient, 'player_0')
    await fireEvent.update(input, 'hello')
    await fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(emitted('send')?.[0]).toEqual([
      { sender: 'player_2', tick: 7, to: 'player_0', text: 'hello' },
    ])
    // No optimistic echo: the draft clears and the panel waits for the recorded line.
    expect(input.value).toBe('')

    // "Everyone" is a broadcast: a null recipient.
    await fireEvent.update(recipient, '')
    await fireEvent.update(input, 'table!')
    await fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(emitted('send')?.[1]).toEqual([
      { sender: 'player_2', tick: 7, to: null, text: 'table!' },
    ])
  })

  it('disables Send and keeps the draft while the transport is disconnected', async () => {
    const props = {
      entries: [] as ChatEntry[],
      players: PLAYERS,
      viewerPlayers: ['player_2'],
      sendable: true,
      connected: false,
      messageCap: 120,
      ...TURN,
    }
    const { container, emitted, rerender } = render(ChatPanel, { props })
    const input = screen.getByRole('textbox') as HTMLInputElement
    await fireEvent.update(input, 'lead low')

    // A dropped connection: the socket would silently no-op a send, so Send is disabled and submitting
    // is a no-op that must never clear the typed draft into a lost message.
    const send = screen.getByRole('button', { name: 'Send' })
    expect(send).toBeDisabled()
    await fireEvent.submit(container.querySelector('form') as HTMLFormElement)
    expect(emitted('send')).toBeUndefined()
    expect(input.value).toBe('lead low')

    // When the connection returns, the preserved draft is sendable.
    await rerender({ ...props, connected: true })
    expect(send).toBeEnabled()
    await fireEvent.click(send)
    expect(emitted('send')?.[0]).toEqual([
      { sender: 'player_2', tick: 7, to: 'player_0', text: 'lead low' },
    ])
  })

  it('tells same-labelled players apart by player number in options and sender lines', () => {
    // Three opponents share the "Naive agent" label, the common default Spades table. Attribution
    // alone would render three identical recipient options; the player prefix keeps them distinct.
    const roster = {
      player_0: { kind: 'agent' as const, label: 'Naive agent' },
      player_1: { kind: 'agent' as const, label: 'Naive agent' },
      player_2: { kind: 'human' as const, label: 'dev', user: 'dev' },
      player_3: { kind: 'agent' as const, label: 'Naive agent' },
    }
    const { container } = render(ChatPanel, {
      props: {
        entries: [{ tick: 1, from: 'player_0', to: null, text: 'hi' }] as ChatEntry[],
        players: roster,
        viewerPlayers: ['player_2'],
        sendable: true,
        messageCap: 120,
        ...TURN,
      },
    })

    // Each opponent is a distinct recipient option, told apart by its compact player id alone.
    expect(screen.getByRole('option', { name: 'P0' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'P1' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'P3' })).toBeInTheDocument()
    // And a message line carries its sender's player beside the shared label (queried by the player cell,
    // since the terse "P0" now also names the recipient option).
    expect(container.querySelector('.chat-player')?.textContent).toBe('P0')
  })

  it('renders only policy recipients and resets composer state on a new opportunity', async () => {
    const props = {
      entries: [] as ChatEntry[],
      players: PLAYERS,
      viewerPlayers: ['player_2'],
      sendable: true,
      messageCap: 120,
      opportunity: {
        sender: 'player_2',
        tick: 7,
        targetRecipients: ['player_0', 'player_3'],
        defaultRecipient: 'player_0',
      },
    }
    const { rerender } = render(ChatPanel, { props })
    const recipient = screen.getByRole('combobox')
    const input = screen.getByRole('textbox') as HTMLInputElement
    expect(screen.getByRole('option', { name: 'Everyone' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'P0' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'P3' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'P1' })).toBeNull()
    expect(recipient).toHaveValue('player_0')

    await fireEvent.update(recipient, '')
    await fireEvent.update(input, 'message for the previous turn')
    await rerender({ ...props, sendable: false })
    expect(screen.queryByRole('textbox')).toBeNull()
    await rerender({
      ...props,
      sendable: true,
      opportunity: {
        sender: 'player_2',
        tick: 11,
        targetRecipients: ['player_1'],
        defaultRecipient: 'player_1',
      },
    })
    expect(screen.getByRole('combobox')).toHaveValue('player_1')
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('')
    expect(screen.getByRole('option', { name: 'P1' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'P0' })).toBeNull()
  })

  // The opening frame and the first recorded step both carry tick 0, so a tick alone does not name
  // an opportunity. Resetting on the sender and tick together keeps one player's draft and recipient
  // from carrying into another player's turn.
  it('resets when a new sender is announced on the same tick', async () => {
    const props = {
      entries: [] as ChatEntry[],
      players: PLAYERS,
      viewerPlayers: ['player_2'],
      sendable: true,
      messageCap: 120,
      opportunity: {
        sender: 'player_2',
        tick: 0,
        targetRecipients: ['player_0'],
        defaultRecipient: 'player_0',
      },
    }
    const { rerender } = render(ChatPanel, { props })
    await fireEvent.update(screen.getByRole('combobox'), '')
    await fireEvent.update(screen.getByRole('textbox'), 'meant for player_2')

    await rerender({
      ...props,
      opportunity: {
        sender: 'player_3',
        tick: 0,
        targetRecipients: ['player_1'],
        defaultRecipient: 'player_1',
      },
    })
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('')
    expect(screen.getByRole('combobox')).toHaveValue('player_1')
  })
})
