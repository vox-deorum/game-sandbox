/** Callbacks that keep asynchronous loading separate from renderer-owned installation. */
export interface ArtLoadLifecycle<T> {
  load(): Promise<T>
  active(): boolean
  install(art: T): void
  status(value: 'ready' | 'error'): void
  report(error: unknown): void
}

/** Install loaded art only while its renderer is live, leaving the current fallback on failure. */
export async function runArtLoad<T>(lifecycle: ArtLoadLifecycle<T>): Promise<void> {
  try {
    const art = await lifecycle.load()
    if (!lifecycle.active()) return
    lifecycle.install(art)
    lifecycle.status('ready')
  } catch (error) {
    if (!lifecycle.active()) return
    lifecycle.status('error')
    lifecycle.report(error)
  }
}
