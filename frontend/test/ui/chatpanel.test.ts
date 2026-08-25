import { fireEvent, render, screen } from '@testing-library/vue'
import { describe, expect, it } from 'vitest'

import ChatPanel from '../../src/components/ChatPanel.vue'
import type { ChatEntry } from '../../src/lib/chat.js'

// A four-player Spades attribution map: two plain agents, the viewer's human player, and a submitted
// agent whose ownership a blind viewer must not see.
const PLAYERS = {
  player_0: { kind: 'agent' as const, builtin_name: 'naive', label: 'Naive agent' },
  player_1: { kind: 'agent' as const, builtin_name: 'naive', label: 'Naive agent' },
  player_2: { kind: 'human' as const, label: 'dev', user: 'dev' },
  player_3: { kind: 'agent' as const, label: "maya's agent", user: 'maya', submission_id: 'sub-1' },
}
// The self-contained policy each live state publishes for the designated human sender.
const POLICY = {
  sender: 'player_2',
  targetRecipients: ['player_0', 'player_1', 'player_3'],
  defaultRecipient: 'player_0',
}
const LIVE_POLICY = { policy: POLICY }

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
        ...LIVE_POLICY,
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

    // One more emoji is over the cap: send is disabled and the counter carries the over-cap modifier.
    await fireEvent.update(input, '😀😀😀😀')
    expect(send).toBeDisabled()
    expect(screen.getByText('4/3')).toHaveClass('chat-counter--over')
  })

  it('emits the pinned send payload and clears the draft', async () => {
    const { emitted } = render(ChatPanel, {
      props: {
        entries: [],
        players: PLAYERS,
        viewerPlayers: ['player_2'],
        sendable: true,
        messageCap: 120,
        ...LIVE_POLICY,
      },
    })
    const recipient = screen.getByRole('combobox')
    const input = screen.getByRole('textbox') as HTMLInputElement

    // A targeted message carries the chosen recipient.
    await fireEvent.update(recipient, 'player_0')
    await fireEvent.update(input, 'hello')
    await fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(emitted('send')?.[0]).toEqual([{ sender: 'player_2', to: 'player_0', text: 'hello' }])
    // No optimistic echo: the draft clears and the panel waits for the recorded line.
    expect(input.value).toBe('')

    // "Everyone" is a broadcast: a null recipient.
    await fireEvent.update(recipient, '')
    await fireEvent.update(input, 'table!')
    await fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(emitted('send')?.[1]).toEqual([{ sender: 'player_2', to: null, text: 'table!' }])
  })

  it('keeps the draft while the composer is temporarily unavailable', async () => {
    const props = {
      entries: [] as ChatEntry[],
      players: PLAYERS,
      viewerPlayers: ['player_2'],
      sendable: true,
      messageCap: 120,
      ...LIVE_POLICY,
    }
    const { emitted, rerender } = render(ChatPanel, { props })
    const input = screen.getByRole('textbox') as HTMLInputElement
    await fireEvent.update(input, 'lead low')

    await rerender({ ...props, sendable: false })
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(emitted('send')).toBeUndefined()

    // The component remains mounted while its form is unavailable, so restoring the same policy also
    // restores the unsent draft.
    await rerender(props)
    const restored = screen.getByRole('textbox') as HTMLInputElement
    const send = screen.getByRole('button', { name: 'Send' })
    expect(restored.value).toBe('lead low')
    expect(send).toBeEnabled()
    await fireEvent.click(send)
    expect(emitted('send')?.[0]).toEqual([{ sender: 'player_2', to: 'player_0', text: 'lead low' }])
  })

  it('tells same-labelled players apart by player number in options and sender lines', () => {
    // Three opponents share the "Naive agent" label, the common default Spades table. Attribution
    // alone would render three identical recipient options; the player prefix keeps them distinct.
    const roster = {
      player_0: { kind: 'agent' as const, builtin_name: 'naive', label: 'Naive agent' },
      player_1: { kind: 'agent' as const, builtin_name: 'naive', label: 'Naive agent' },
      player_2: { kind: 'human' as const, label: 'dev', user: 'dev' },
      player_3: { kind: 'agent' as const, builtin_name: 'naive', label: 'Naive agent' },
    }
    const { container } = render(ChatPanel, {
      props: {
        entries: [{ tick: 1, from: 'player_0', to: null, text: 'hi' }] as ChatEntry[],
        players: roster,
        viewerPlayers: ['player_2'],
        sendable: true,
        messageCap: 120,
        ...LIVE_POLICY,
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

  it('resets only the recipient when the policy changes', async () => {
    const props = {
      entries: [] as ChatEntry[],
      players: PLAYERS,
      viewerPlayers: ['player_2'],
      sendable: true,
      messageCap: 120,
      policy: {
        sender: 'player_2',
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
    await fireEvent.update(input, 'keep this draft')
    await rerender({ ...props, entries: [{ tick: 8, from: 'player_0', to: null, text: 'hi' }] })
    expect(recipient).toHaveValue('')
    expect(input.value).toBe('keep this draft')

    await rerender({
      ...props,
      policy: {
        sender: 'player_2',
        targetRecipients: ['player_1'],
        defaultRecipient: 'player_1',
      },
    })
    expect(screen.getByRole('combobox')).toHaveValue('player_1')
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('keep this draft')
    expect(screen.getByRole('option', { name: 'P1' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'P0' })).toBeNull()
  })
})

// Three Branches human play uses player_0 as the designated sender and compact player labels in chat.
describe('ChatPanel — Three Branches human play (step 6)', () => {
  // The visitor with two NPCs currently in hearing range; a third (npc_2) is out of range and so is
  // never offered, matching the range-and-wall speech contract.
  const POLICY = {
    sender: 'player_0',
    targetRecipients: ['player_1', 'player_2'],
    defaultRecipient: null,
  }

  it("offers Everyone plus exactly the policy's permitted addressees, labelled by compact player id", () => {
    render(ChatPanel, {
      props: {
        entries: [],
        viewerPlayers: ['player_0'],
        sendable: true,
        messageCap: 200,
        policy: POLICY,
      },
    })

    expect(screen.getByRole('option', { name: 'Everyone' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'P1' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'P2' })).toBeInTheDocument()
    // npc_2 is out of hearing range on this state, so the policy never lists it: no such option.
    expect(screen.queryByRole('option', { name: 'P3' })).toBeNull()
    expect(screen.getAllByRole('option')).toHaveLength(3)
  })

  it('sends the platform player id for a direct pick and a null recipient for a broadcast', async () => {
    const { emitted } = render(ChatPanel, {
      props: {
        entries: [],
        viewerPlayers: ['player_0'],
        sendable: true,
        messageCap: 200,
        policy: POLICY,
      },
    })
    const recipient = screen.getByRole('combobox')
    const input = screen.getByRole('textbox')
    const send = screen.getByRole('button', { name: 'Send' })

    // A direct line to P2: the select is valued by the platform id while its label is "P2".
    await fireEvent.update(recipient, 'player_2')
    await fireEvent.update(input, 'have you seen the miller?')
    await fireEvent.click(send)
    expect(emitted('send')?.[0]).toEqual([
      { sender: 'player_0', to: 'player_2', text: 'have you seen the miller?' },
    ])

    // "Everyone" broadcasts: a null recipient, not the compact id and not omitted from the payload.
    await fireEvent.update(recipient, '')
    await fireEvent.update(input, 'hello, anyone about?')
    await fireEvent.click(send)
    expect(emitted('send')?.[1]).toEqual([
      { sender: 'player_0', to: null, text: 'hello, anyone about?' },
    ])
  })

  it('resets the recipient when target_recipients narrows (an npc walks out of hearing), keeping a draft that already survived an ordinary state change', async () => {
    const props = {
      entries: [] as ChatEntry[],
      viewerPlayers: ['player_0'],
      sendable: true,
      messageCap: 200,
      policy: POLICY,
    }
    const { rerender } = render(ChatPanel, { props })
    const recipient = screen.getByRole('combobox')
    const input = screen.getByRole('textbox') as HTMLInputElement

    await fireEvent.update(recipient, 'player_2')
    await fireEvent.update(input, 'meet me by the well')

    // An ordinary state change (a new message arrives, nothing about the policy changes) leaves the
    // open draft and the picked recipient alone.
    await rerender({
      ...props,
      entries: [{ tick: 4, from: 'player_1', to: null, text: 'the well is dry' }],
    })
    expect(recipient).toHaveValue('player_2')
    expect(input.value).toBe('meet me by the well')

    // npc_1 (player_2) walks out of hearing: target_recipients narrows to just npc_0, so the picked
    // recipient is no longer offered. The panel falls back to the (still null) default, but the draft
    // text is untouched.
    await rerender({
      ...props,
      entries: [{ tick: 4, from: 'player_1', to: null, text: 'the well is dry' }],
      policy: { sender: 'player_0', targetRecipients: ['player_1'], defaultRecipient: null },
    })
    expect(recipient).toHaveValue('')
    expect(input.value).toBe('meet me by the well')
    expect(screen.queryByRole('option', { name: 'P2' })).toBeNull()
    expect(screen.getByRole('option', { name: 'P1' })).toBeInTheDocument()
  })

  it("renders the visitor's own pre-filtered feed, badging its own sends and receipts as from-you/to-you", () => {
    // The server has already filtered this list to lines the visitor session is entitled to: broadcasts,
    // and lines to or from player_0. An npc-to-npc line is a watcher/replay-only concern and never
    // reaches this list at all (see the GameThread coverage in gamethread.test.ts).
    const entries: ChatEntry[] = [
      { tick: 10, from: 'player_1', to: null, text: 'the well is dry' },
      { tick: 11, from: 'player_0', to: 'player_2', text: 'have you seen the miller?' },
      { tick: 12, from: 'player_2', to: 'player_0', text: 'try the mill' },
    ]
    const { container } = render(ChatPanel, {
      props: { entries, viewerPlayers: ['player_0'] },
    })

    expect(container.querySelectorAll('.chat-entry')).toHaveLength(3)
    expect(screen.getByText('broadcast')).toBeInTheDocument()
    expect(screen.getByText('from you')).toBeInTheDocument()
    expect(screen.getByText('to you')).toBeInTheDocument()
    expect(screen.getByText('have you seen the miller?')).toBeInTheDocument()
    expect(screen.getByText('try the mill')).toBeInTheDocument()
  })

  it("badges a direct line by the other party's display name for a spectator of the same pre-filtered feed", () => {
    // A spectator watching the visitor's session controls nobody, so the from-you/to-you shortcuts never
    // fire: the same pre-filtered entries now badge their targeted line by the addressee's display name.
    const entries: ChatEntry[] = [
      { tick: 11, from: 'player_0', to: 'player_2', text: 'have you seen the miller?' },
      { tick: 12, from: 'player_2', to: 'player_0', text: 'try the mill' },
    ]
    render(ChatPanel, { props: { entries, viewerPlayers: [] } })

    expect(screen.getByText('to P2')).toBeInTheDocument()
    expect(screen.getByText('to P0')).toBeInTheDocument()
    expect(screen.queryByText('to you')).toBeNull()
    expect(screen.queryByText('from you')).toBeNull()
  })
})
