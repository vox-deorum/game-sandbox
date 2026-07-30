/** Shared asynchronous chat state for live web and local sessions. */
import type { StepState } from '@game-sandbox/schema'
import type { Command } from '@game-sandbox/schema/protocol'
import { computed, type Ref } from 'vue'

/** The designated human sender's current messaging policy, published on every live state. */
export interface LiveChatPolicy {
  sender: string
  targetRecipients: readonly string[]
  defaultRecipient: string | null
}

export interface LiveChatPayload {
  sender: string
  to: string | null
  text: string
}

interface LiveChatOptions {
  state: Readonly<Ref<StepState | null>>
  controlledPlayers: Readonly<Ref<readonly string[]>>
  enabled: Readonly<Ref<boolean>>
  /** The session socket's connection state, which decides whether the composer may send. */
  connection: Readonly<Ref<string>>
  send(command: Command): void
}

export function useLiveChat(options: LiveChatOptions) {
  const connected = computed(() => options.connection.value === 'open')

  const policy = computed<LiveChatPolicy | null>(() => {
    const published = options.state.value?.chat_options
    if (published === undefined) {
      return null
    }
    return {
      sender: published.sender,
      targetRecipients: published.target_recipients,
      defaultRecipient: published.default_recipient,
    }
  })

  const chatSendable = computed(() => {
    const state = options.state.value
    const current = policy.value
    return (
      options.enabled.value &&
      connected.value &&
      state !== null &&
      !state.overlay?.terminal &&
      current !== null &&
      options.controlledPlayers.value.includes(current.sender)
    )
  })

  /** Both outbound paths share one gate: the socket silently no-ops while reconnecting, so a command
   *  sent then is lost, and the composer must not clear a draft into one. */
  function forward(command: Command): void {
    if (connected.value) {
      options.send(command)
    }
  }

  /** Forward a renderer action. The chat composer buffers independently and is untouched by it. */
  function sendInput(playerId: string, action: unknown): void {
    forward({ kind: 'input', player: playerId, action })
  }

  function sendChat(payload: LiveChatPayload): void {
    forward({ kind: 'chat', player: payload.sender, to: payload.to, text: payload.text })
  }

  /** The chat panel bindings for the latest self-contained live policy. */
  const chatProps = computed(() => ({
    sendable: chatSendable.value,
    policy: policy.value,
  }))

  return {
    chatProps,
    sendInput,
    sendChat,
  }
}
