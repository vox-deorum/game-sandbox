/**
 * The in-memory registry of live sessions, and the index that enforces one active session per user.
 */
import type { LiveSession } from './live-session.js'

export class SessionRegistry {
  private readonly byId = new Map<string, LiveSession>()
  private readonly userToId = new Map<string, string>()

  add(session: LiveSession): void {
    this.byId.set(session.id, session)
    this.userToId.set(session.userId, session.id)
  }

  get(id: string): LiveSession | undefined {
    return this.byId.get(id)
  }

  /** The id of the user's currently active session, or `undefined` if they have none. */
  activeIdForUser(userId: string): string | undefined {
    return this.userToId.get(userId)
  }

  /** Drop a session once its teardown is complete. Idempotent. */
  remove(id: string): void {
    const session = this.byId.get(id)
    if (session === undefined) {
      return
    }
    this.byId.delete(id)
    if (this.userToId.get(session.userId) === id) {
      this.userToId.delete(session.userId)
    }
  }

  all(): LiveSession[] {
    return [...this.byId.values()]
  }
}
