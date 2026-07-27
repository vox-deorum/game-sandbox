export interface LatestRequest {
  /** Start a request; the returned isCurrent() reports whether it is still the newest. */
  begin(): () => boolean
  /** Invalidate all outstanding requests without starting a new one (unmount, reseed). */
  invalidate(): void
}

export function useLatestRequest(): LatestRequest {
  let latest = 0

  return {
    begin(): () => boolean {
      const request = ++latest
      return () => request === latest
    },
    invalidate(): void {
      latest += 1
    },
  }
}
