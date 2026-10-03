// The player identity feature (see plans/player-identity.md): the renderer-supplied player profiles
// (in-game names and teams) and highlight that flow through usePlayerIdentity into PlayerTag, the
// shared senderIdentity tone and label helper, the recipient badge, and the chat and thread surfaces
// that consume both.
import type { RecordingHeader, StepState } from '@game-sandbox/schema'
import type { EnvironmentMeta } from '@game-sandbox/schema/environment'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref, shallowRef, type VNode } from 'vue'

import ChatPanel from '../src/components/ChatPanel.vue'
import DecisionLog from '../src/components/DecisionLog.vue'
import GameThread from '../src/components/GameThread.vue'
import PlayerTag from '../src/components/PlayerTag.vue'
import {
  providePlayerIdentity,
  sharedHighlight,
  usePlayerIdentity,
} from '../src/composables/usePlayerIdentity.js'
import { useRendererMount } from '../src/composables/useRendererMount.js'
import { messageBadge, senderIdentity } from '../src/lib/chat.js'
import { registerRenderer } from '../src/renderers/registry.js'
import type { PlayerProfile, RendererInstance } from '../src/renderers/types.js'

// A four-player roster shaped like the other chat suites: two builtin agents (one of them named
// below), the viewer's human player, and a submitted agent owned by someone else.
const PLAYERS = {
  player_0: { kind: 'agent' as const, builtin_name: 'naive', label: 'Naive agent' },
  player_1: { kind: 'agent' as const, builtin_name: 'naive', label: 'Naive agent' },
  player_2: { kind: 'human' as const, label: 'dev', user: 'dev' },
  player_3: { kind: 'agent' as const, label: "maya's agent", user: 'maya', submission_id: 'sub-1' },
}

/**
 * Mount `child` under a parent that provides the given renderer identity, sharing the highlight among
 * its tags as useRendererMount does, and record what reaches the renderer.
 */
function mountInsideProvider(profiles: Record<string, PlayerProfile>, child: () => VNode) {
  const highlight = vi.fn()
  const wrapper = mount(
    defineComponent({
      setup() {
        providePlayerIdentity({
          profiles: shallowRef<Readonly<Record<string, PlayerProfile>>>(profiles),
          highlight: sharedHighlight(highlight),
        })
        return child
      },
    }),
  )
  return { highlight, wrapper }
}

describe('PlayerTag', () => {
  it('renders the plain compact id, and None for an empty one, without a provider', () => {
    const player = mount(PlayerTag, { props: { playerId: 'player_3' } })
    expect(player.text()).toBe('P3')
    expect(player.find('button').exists()).toBe(false)

    const none = mount(PlayerTag, { props: { playerId: '' } })
    expect(none.text()).toBe('None')
    expect(none.find('button').exists()).toBe(false)
  })

  it('offers a tooltip trigger that highlights the player on hover and focus', async () => {
    const { highlight, wrapper } = mountInsideProvider({ player_3: { name: 'S0_cavalry_3' } }, () =>
      h(PlayerTag, { playerId: 'player_3' }),
    )
    const tag = wrapper.get('.player-tag')
    expect(tag.find('button').exists()).toBe(true)
    expect(tag.get('button').text()).toBe('P3')

    await tag.trigger('mouseenter')
    expect(highlight).toHaveBeenCalledWith('player_3')
    await tag.trigger('mouseleave')
    expect(highlight).toHaveBeenLastCalledWith(null)

    await tag.trigger('focusin')
    expect(highlight).toHaveBeenLastCalledWith('player_3')
    await tag.trigger('focusout')
    expect(highlight).toHaveBeenLastCalledWith(null)

    // Leaving the page mid-hover must not strand the highlight on the renderer.
    await tag.trigger('mouseenter')
    await wrapper.unmount()
    expect(highlight).toHaveBeenLastCalledWith(null)
  })

  it('keeps the highlight while the tag stays focused or hovered', async () => {
    const { highlight, wrapper } = mountInsideProvider({ player_3: { name: 'S0_cavalry_3' } }, () =>
      h(PlayerTag, { playerId: 'player_3' }),
    )
    const tag = wrapper.get('.player-tag')

    // The pointer passing over a keyboard-focused tag must not clear the highlight focus holds.
    await tag.trigger('focusin')
    await tag.trigger('mouseenter')
    await tag.trigger('mouseleave')
    expect(highlight.mock.calls).toEqual([['player_3']])

    // Nor does blurring a hovered tag.
    await tag.trigger('mouseenter')
    await tag.trigger('focusout')
    expect(highlight.mock.calls).toEqual([['player_3']])
    await tag.trigger('mouseleave')
    expect(highlight).toHaveBeenLastCalledWith(null)
  })

  it('shares one highlight among tags, so one tag never clears another', async () => {
    const { highlight, wrapper } = mountInsideProvider(
      { player_1: { name: 'S0_archer_0' }, player_3: { name: 'S0_cavalry_3' } },
      () =>
        h('div', [h(PlayerTag, { playerId: 'player_1' }), h(PlayerTag, { playerId: 'player_3' })]),
    )
    const [focused, hovered] = wrapper.findAll('.player-tag')

    await focused?.trigger('focusin')
    await hovered?.trigger('mouseenter')
    expect(highlight).toHaveBeenLastCalledWith('player_3')
    // Leaving the hovered tag hands the highlight back to the focused one rather than clearing it.
    await hovered?.trigger('mouseleave')
    expect(highlight).toHaveBeenLastCalledWith('player_1')
    await focused?.trigger('focusout')
    expect(highlight).toHaveBeenLastCalledWith(null)
  })

  it('stays plain text and never highlights a player the renderer does not name', async () => {
    const { highlight, wrapper } = mountInsideProvider({}, () =>
      h(PlayerTag, { playerId: 'player_3' }),
    )
    expect(wrapper.find('button').exists()).toBe(false)
    await wrapper.get('.player-tag').trigger('mouseenter')
    await wrapper.get('.player-tag').trigger('focusin')
    expect(highlight).not.toHaveBeenCalled()
  })
})

describe('senderIdentity', () => {
  it('prefers the renderer name and falls back to the attribution label', () => {
    expect(
      senderIdentity('player_1', { player_1: { name: 'S0_cavalry_1' } }, PLAYERS, {}, []),
    ).toEqual({ label: 'S0_cavalry_1', tone: 'other' })
    expect(senderIdentity('player_1', {}, PLAYERS, {}, [])).toEqual({
      label: 'Naive agent',
      tone: 'other',
    })
    // No header entry at all: the compact player id stands in, as in attributionLabel.
    expect(senderIdentity('player_7', {}, undefined, {}, [])).toEqual({
      label: 'P7',
      tone: 'other',
    })
  })

  it('tones the players and accounts belonging to the viewer as own, failing closed', () => {
    // Players the viewer controls are own, whatever the header says about them.
    expect(senderIdentity('player_0', {}, PLAYERS, {}, ['player_0']).tone).toBe('own')
    // The viewer's own account owns its player even while the viewer controls nobody (a replay).
    expect(senderIdentity('player_2', {}, PLAYERS, { viewerId: 'dev' }, []).tone).toBe('own')
    // The viewer's own submitted agent is own too, which is what the accent color carries once an
    // in-game name replaces "Your agent".
    expect(
      senderIdentity('player_3', {}, PLAYERS, { viewerId: 'maya', blind: true }, []).tone,
    ).toBe('own')
    // Someone else's player never reads as own.
    expect(senderIdentity('player_3', {}, PLAYERS, { viewerId: 'dev' }, []).tone).toBe('other')
    // An anonymous viewer must not match a player that also carries no user id.
    expect(senderIdentity('player_0', {}, PLAYERS, {}, []).tone).toBe('other')
  })

  it("tones a sender by team against the viewer's own players", () => {
    const teams: Record<string, PlayerProfile> = {
      player_0: { team: 'red' },
      player_1: { team: 'blue' },
      player_2: { team: 'red' },
      player_3: { team: 'blue' },
    }
    // A sender sharing a team with a player the viewer controls is an ally; the opposite team is not.
    expect(senderIdentity('player_2', teams, PLAYERS, {}, ['player_0']).tone).toBe('ally')
    expect(senderIdentity('player_1', teams, PLAYERS, {}, ['player_0']).tone).toBe('other')
    // A sender the renderer gives no team is nobody's ally.
    expect(
      senderIdentity('player_1', { ...teams, player_1: {} }, PLAYERS, {}, ['player_0']).tone,
    ).toBe('other')
    // A header-owned player carries the viewer's side even while the viewer controls nobody: player_3
    // is the viewer's own by header, so its team makes player_1 an ally.
    expect(senderIdentity('player_1', teams, PLAYERS, { viewerId: 'maya' }, []).tone).toBe('ally')
    // A spectator owns nobody, so even a shared team reads as other.
    expect(senderIdentity('player_2', teams, PLAYERS, {}, []).tone).toBe('other')
  })
})

describe('messageBadge', () => {
  const line = (from: string, to: string | null) => ({ tick: 1, from, to, text: 'hi' })

  it("badges every line by its recipient, the viewer's own sends included", () => {
    const badge = (from: string, to: string | null) =>
      messageBadge(line(from, to), PLAYERS, {}, ['player_2'])
    expect(badge('player_0', null)).toEqual({ variant: 'neutral', kind: 'broadcast' })
    expect(badge('player_0', 'player_2')).toEqual({ variant: 'accent', kind: 'to-you' })
    expect(badge('player_0', 'player_3')).toEqual({
      variant: 'neutral',
      kind: 'to-player',
      playerId: 'player_3',
    })
    // A line the viewer sent is badged by its recipient like anyone else's: there is no from-you case.
    expect(badge('player_2', 'player_0')).toEqual({
      variant: 'neutral',
      kind: 'to-player',
      playerId: 'player_0',
    })
  })

  it('reads "to you" for a player the header attributes to the viewer, as the sender tone does', () => {
    // A replay of maya's own game: she controls nobody, yet the line to her agent is to her.
    expect(messageBadge(line('player_0', 'player_3'), PLAYERS, { viewerId: 'maya' }, [])).toEqual({
      variant: 'accent',
      kind: 'to-you',
    })
    // Anyone else replaying it sees the agent's compact id.
    expect(messageBadge(line('player_0', 'player_3'), PLAYERS, { viewerId: 'dev' }, [])).toEqual({
      variant: 'neutral',
      kind: 'to-player',
      playerId: 'player_3',
    })
  })
})

describe('ChatPanel with a renderer identity', () => {
  it('names senders by their in-game name, colors the own row, and labels options by name', () => {
    const { wrapper } = mountInsideProvider({ player_1: { name: 'S0_footman_1' } }, () =>
      h(ChatPanel, {
        entries: [
          { tick: 1, from: 'player_1', to: null, text: 'the well is dry' },
          { tick: 2, from: 'player_2', to: 'player_1', text: 'try the mill' },
        ],
        players: PLAYERS,
        viewerPlayers: ['player_2'],
        sendable: true,
        messageCap: 120,
        policy: {
          sender: 'player_2',
          targetRecipients: ['player_0', 'player_1'],
          defaultRecipient: 'player_0',
        },
      }),
    )

    // The named player's in-game name replaces its attribution label; the unnamed one keeps it.
    const from = wrapper.findAll('.chat-from')
    expect(from[0]?.text()).toBe('S0_footman_1')
    expect(from[1]?.text()).toBe('dev')
    // The tone classes mark the viewer's own row and everyone else's.
    expect(from[0]?.classes()).toContain('chat-from--other')
    expect(from[1]?.classes()).toContain('chat-from--own')

    // A recipient option carries the compact id plus the name when there is one.
    expect(wrapper.findAll('option').map((option) => option.text().trim())).toEqual([
      'Everyone',
      'P0',
      'P1 · S0_footman_1',
    ])
  })

  it('badges the recipient with a named tag and tones senders own, ally, and other', () => {
    const { wrapper } = mountInsideProvider(
      {
        player_0: { name: 'S0_footman_0', team: 'red' },
        player_1: { team: 'blue' },
        player_2: { team: 'red' },
      },
      () =>
        h(ChatPanel, {
          entries: [
            { tick: 1, from: 'player_2', to: 'player_0', text: 'to the named unit' },
            { tick: 2, from: 'player_0', to: null, text: 'ally broadcast' },
            { tick: 3, from: 'player_1', to: null, text: 'rival broadcast' },
          ],
          players: PLAYERS,
          viewerPlayers: ['player_2'],
        }),
    )

    // The recipient badge's compact id is a PlayerTag: a tooltip trigger whose accessible name
    // carries the profile name the renderer reports.
    const badgeTag = wrapper.get('.ui-badge .player-tag button')
    expect(badgeTag.text()).toBe('P0')
    expect(badgeTag.attributes('aria-label')).toContain('S0_footman_0')

    // The sender tones: the viewer's own player, a teammate of it, and everyone else.
    const from = wrapper.findAll('.chat-from')
    expect(from[0]?.classes()).toContain('chat-from--own')
    expect(from[1]?.classes()).toContain('chat-from--ally')
    expect(from[2]?.classes()).toContain('chat-from--other')
  })
})

describe('GameThread with a renderer identity', () => {
  it("names message senders and colors the viewer's own and allied rows", () => {
    const profiles = {
      player_0: { team: 'red' },
      player_1: { name: 'S0_footman_1', team: 'blue' },
      player_2: { team: 'red' },
    }
    const { wrapper } = mountInsideProvider(profiles, () =>
      h(GameThread, {
        decisions: [
          { tick: 1, player: 'player_1', action: 'move' },
          { tick: 2, player: 'player_2', action: 'wait' },
        ],
        chat: [
          { tick: 1, from: 'player_1', to: null, text: 'the well is dry' },
          { tick: 2, from: 'player_2', to: 'player_1', text: 'try the mill' },
          { tick: 2, from: 'player_0', to: 'player_2', text: 'on my way' },
        ],
        currentTick: 2,
        players: PLAYERS,
        viewerPlayers: ['player_2'],
      }),
    )

    const from = wrapper.findAll('.thread-from')
    expect(from[0]?.text()).toBe('S0_footman_1')
    expect(from[1]?.text()).toBe('dev')
    expect(from[0]?.classes()).toContain('thread-from--other')
    expect(from[1]?.classes()).toContain('thread-from--own')
    // player_0 shares the viewer's red team, so it reads as an ally.
    expect(from[2]?.classes()).toContain('thread-from--ally')
  })
})

describe('decision rows with a renderer identity', () => {
  it('turns the GameThread and DecisionLog player cells into named tags', () => {
    const profiles = { player_1: { name: 'S0_footman_1' } }
    const decisions = [{ tick: 1, player: 'player_1', action: 'move' }]
    const thread = mountInsideProvider(profiles, () => h(GameThread, { decisions, chat: [] }))
    expect(thread.wrapper.get('.thread-item--decision .player-tag button').text()).toBe('P1')

    const log = mountInsideProvider(profiles, () => h(DecisionLog, { entries: decisions }))
    expect(log.wrapper.get('.player-col .player-tag button').text()).toBe('P1')
  })
})

describe('useRendererMount player identity', () => {
  it('provides the renderer profiles per state, replacing them only on change, and forwards the highlight', () => {
    const highlightPlayer = vi.fn()
    const instance: RendererInstance = {
      internalSize: { width: 1, height: 1 },
      aspectRatio: 1,
      render: () => Promise.resolve(),
      destroy: () => {},
      playerProfiles: (state) => ({
        player_0: {
          name: state.tick >= 2 ? 'unit at tick late' : 'unit at tick early',
          team: state.tick >= 4 ? 'blue' : 'red',
        },
      }),
      highlightPlayer,
    }
    registerRenderer('identity-test', { mount: () => instance }, '')

    let mounted!: ReturnType<typeof useRendererMount>
    let injected!: ReturnType<typeof usePlayerIdentity>
    const Child = defineComponent({
      setup() {
        injected = usePlayerIdentity()
        return () => null
      },
    })
    mount(
      defineComponent({
        setup() {
          mounted = useRendererMount({
            host: ref(document.createElement('div')),
            meta: ref({ renderer: 'identity-test' } as EnvironmentMeta),
          })
          return () => h(Child)
        },
      }),
    )
    mounted.mount({} as RecordingHeader)

    void mounted.render({ tick: 0 } as StepState)
    const first = injected.profiles.value
    expect(first).toEqual({ player_0: { name: 'unit at tick early', team: 'red' } })
    void mounted.render({ tick: 1 } as StepState)
    expect(injected.profiles.value).toBe(first)
    // A changed name replaces the ref.
    void mounted.render({ tick: 2 } as StepState)
    expect(injected.profiles.value).toEqual({
      player_0: { name: 'unit at tick late', team: 'red' },
    })
    const second = injected.profiles.value
    void mounted.render({ tick: 3 } as StepState)
    expect(injected.profiles.value).toBe(second)
    // A team change replaces it just the same.
    void mounted.render({ tick: 4 } as StepState)
    expect(injected.profiles.value).toEqual({
      player_0: { name: 'unit at tick late', team: 'blue' },
    })

    const tag = {}
    injected.highlight(tag, 'player_0')
    expect(highlightPlayer).toHaveBeenCalledWith('player_0')
    // A tag that holds nothing withdrawing never reaches the renderer; the holder's withdrawal does.
    injected.highlight({}, null)
    expect(highlightPlayer).toHaveBeenCalledTimes(1)
    injected.highlight(tag, null)
    expect(highlightPlayer).toHaveBeenLastCalledWith(null)
  })
})
