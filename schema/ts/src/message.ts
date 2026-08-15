/** Dependency-free message identity shared by the host and environment renderers. */
export interface MessageIdentity {
  tick: number
  from: string
  to: string | null
  text: string
}

/** Return the canonical presentation key for one admitted message. */
export function messageKey(message: MessageIdentity): string {
  return JSON.stringify([message.tick, message.from, message.to, message.text])
}
