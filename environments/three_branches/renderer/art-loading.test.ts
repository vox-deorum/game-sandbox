import { describe, expect, it, vi } from 'vitest'

import { type ArtLoadLifecycle, replaceFallback, runArtLoad } from './art-loading.js'

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
} {
  let resolve = (_value: T): void => {}
  let reject = (_error: unknown): void => {}
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function lifecycle(load: () => Promise<string>): ArtLoadLifecycle<string> & {
  live: boolean
  install: ReturnType<typeof vi.fn>
  status: ReturnType<typeof vi.fn>
  report: ReturnType<typeof vi.fn>
} {
  const result = {
    live: true,
    load,
    active: () => result.live,
    install: vi.fn(),
    status: vi.fn(),
    report: vi.fn(),
  }
  return result
}

describe('Three Branches art loading', () => {
  it('keeps the fallback until loading succeeds, then installs and reports ready', async () => {
    const pending = deferred<string>()
    const hooks = lifecycle(() => pending.promise)
    const loading = runArtLoad(hooks)

    expect(hooks.install).not.toHaveBeenCalled()
    expect(hooks.status).not.toHaveBeenCalled()
    pending.resolve('art')
    await loading

    expect(hooks.install).toHaveBeenCalledWith('art')
    expect(hooks.status).toHaveBeenCalledWith('ready')
    expect(hooks.report).not.toHaveBeenCalled()
  })

  it('retains the fallback and reports a live load failure', async () => {
    const failure = new Error('missing atlas')
    const hooks = lifecycle(() => Promise.reject(failure))

    await runArtLoad(hooks)

    expect(hooks.install).not.toHaveBeenCalled()
    expect(hooks.status).toHaveBeenCalledWith('error')
    expect(hooks.report).toHaveBeenCalledWith(failure)
  })

  it('destroys a failed replacement and retains the fallback when redraw fails', async () => {
    const fallback = { destroy: vi.fn() }
    const replacement = { destroy: vi.fn() }
    const redrawFailure = new Error('redraw failed')
    const hooks = lifecycle(() => Promise.resolve('art'))
    hooks.install.mockImplementation(() => {
      replaceFallback(
        fallback,
        () => replacement,
        () => {
          throw redrawFailure
        },
      )
    })

    await runArtLoad(hooks)

    expect(replacement.destroy).toHaveBeenCalledOnce()
    expect(fallback.destroy).not.toHaveBeenCalled()
    expect(hooks.status).toHaveBeenCalledWith('error')
    expect(hooks.report).toHaveBeenCalledWith(redrawFailure)
  })

  it('does nothing when its renderer is destroyed while loading', async () => {
    const pending = deferred<string>()
    const hooks = lifecycle(() => pending.promise)
    const loading = runArtLoad(hooks)
    hooks.live = false
    pending.resolve('late art')

    await loading

    expect(hooks.install).not.toHaveBeenCalled()
    expect(hooks.status).not.toHaveBeenCalled()
    expect(hooks.report).not.toHaveBeenCalled()
  })
})
