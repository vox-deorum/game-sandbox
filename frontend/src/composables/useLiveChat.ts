/**
 * Shared turn-authoritative chat state for live web and local sessions.
 *
 * The latest state declares who may speak, the recipients the environment allows them, and the
 * recipient selected by default. Those choices plus the tick they were published on form one
 * opportunity, carried as a single value so the composer, the send path, and the reset rule can
 * never disagree about which turn they are on. Sending that player's action consumes the
 * opportunity immediately, and the next declared one reopens the composer.
 */
import type { StepState } from '@game-sandbox/schema'
import type { Command } from '@game-sandbox/schema/protocol'
import { computed, type Ref, ref } from 'vue'

/** One external turn's messaging choices, as published by the state that opened it. */
export interface LiveChatOpportunity {
  sender: string
  tick: number
  targetRecipients: readonly string[]
  defaultRecipient: string | null
}

export interface LiveChatPayload {
  sender: string
  tick: number
  to: string | null
  text: string
}

interface LiveChatOptions {
  state: Readonly<Ref<StepState | null>>
  controlledPlayers: Readonly<Ref<readonly string[]>>
  enabled: Readonly<Ref<boolean>>
  /** The session socket's connection state, which gates both sending and consuming. */
  connection: Readonly<Ref<string>>
  send(command: Command): void
}

function opportunityKey({ sender, tick }: Pick<LiveChatOpportunity, 'sender' | 'tick'>): string {
  return `${sender}:${tick}`
}

export function useLiveChat(options: LiveChatOptions) {
  const connected = computed(() => options.connection.value === 'open')
  const consumedKey = ref<string | null>(null)

  const opportunity = computed<LiveChatOpportunity | null>(() => {
    const state = options.state.value
    const policy = state?.chat_options
    if (state === null || state === undefined || policy === undefined) {
      return null
    }
    return {
      sender: policy.sender,
      tick: state.tick,
      targetRecipients: policy.target_recipients,
      defaultRecipient: policy.default_recipient,
    }
  })

  const chatSendable = computed(() => {
    const state = options.state.value
    const current = opportunity.value
    return (
      options.enabled.value &&
      state !== null &&
      !state.overlay?.terminal &&
      current !== null &&
      options.controlledPlayers.value.includes(current.sender) &&
      consumedKey.value !== opportunityKey(current)
    )
  })

  /**
   * Forward a renderer action for one player, closing that turn's composer.
   *
   * The connection check comes first because the socket silently no-ops while reconnecting: an
   * action that never reached the server must not consume the opportunity it was never sent for.
   */
  function sendInput(playerId: string, action: unknown): void {
    if (!connected.value) {
      return
    }
    const current = opportunity.value
    if (current !== null && current.sender === playerId) {
      consumedKey.value = opportunityKey(current)
    }
    options.send({ kind: 'input', player: playerId, action })
  }

  function sendChat(payload: LiveChatPayload): void {
    options.send({
      kind: 'chat',
      player: payload.sender,
      tick: payload.tick,
      to: payload.to,
      text: payload.text,
    })
  }

  /** The chat panel bindings that follow the live turn, bound as one object at every call site. */
  const chatProps = computed(() => ({
    sendable: chatSendable.value,
    connected: connected.value,
    opportunity: opportunity.value,
  }))

  return {
    chatProps,
    sendInput,
    sendChat,
  }
}
