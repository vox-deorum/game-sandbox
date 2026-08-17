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

/** Build and redraw a replacement before releasing its fallback, rolling back on failure. */
export function replaceFallback<T extends { destroy(): void }>(
  fallback: T,
  build: () => T,
  redraw: () => void,
): T {
  const replacement = build()
  try {
    redraw()
    fallback.destroy()
    return replacement
  } catch (error) {
    replacement.destroy()
    throw error
  }
}
