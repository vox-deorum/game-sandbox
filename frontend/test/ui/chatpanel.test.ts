import { fireEvent, render, screen } from '@testing-library/vue'
import { describe, expect, it } from 'vitest'

import ChatPanel from '../../src/components/ChatPanel.vue'
import type { ChatEntry } from '../../src/lib/chat.js'

// A four-seat Spades attribution map: two plain agents, the viewer's human seat, and a submitted
// agent whose ownership a blind viewer must not see.
const PLAYERS = {
  player_0: { kind: 'agent' as const, label: 'Naive agent' },
  player_1: { kind: 'agent' as const, label: 'Naive agent' },
  player_2: { kind: 'human' as const, label: 'dev', user: 'dev' },
  player_3: { kind: 'agent' as const, label: "maya's agent", user: 'maya', submission_id: 'sub-1' },
}

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
      },
    })
    const recipient = screen.getByRole('combobox')
    const input = screen.getByRole('textbox') as HTMLInputElement

    // A targeted message carries the chosen recipient.
    await fireEvent.update(recipient, 'player_0')
    await fireEvent.update(input, 'hello')
    await fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(emitted('send')?.[0]).toEqual([{ to: 'player_0', text: 'hello' }])
    // No optimistic echo: the draft clears and the panel waits for the recorded line.
    expect(input.value).toBe('')

    // "Everyone" is a broadcast: a null recipient.
    await fireEvent.update(recipient, '')
    await fireEvent.update(input, 'table!')
    await fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(emitted('send')?.[1]).toEqual([{ to: null, text: 'table!' }])
  })

  it('disables Send and keeps the draft while the transport is disconnected', async () => {
    const props = {
      entries: [] as ChatEntry[],
      players: PLAYERS,
      viewerPlayers: ['player_2'],
      sendable: true,
      connected: false,
      messageCap: 120,
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
    expect(emitted('send')?.[0]).toEqual([{ to: null, text: 'lead low' }])
  })

  it('tells same-labelled seats apart by seat number in options and sender lines', () => {
    // Three opponents share the "Naive agent" label — the common default Spades table. Attribution
    // alone would render three identical recipient options; the seat prefix keeps them distinct.
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
      },
    })

    // Each opponent is a distinct recipient option, told apart by its compact player id alone.
    expect(screen.getByRole('option', { name: 'P0' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'P1' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'P3' })).toBeInTheDocument()
    // And a message line carries its sender's seat beside the shared label (queried by the seat cell,
    // since the terse "P0" now also names the recipient option).
    expect(container.querySelector('.chat-player')?.textContent).toBe('P0')
  })
})
