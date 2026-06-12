/**
 * A push-based {@link AsyncIterable}: a producer enqueues values with {@link AsyncChannel.push}
 * and ends the stream with {@link AsyncChannel.close}; a single consumer drives it with `for await`.
 *
 * This is the adapter between callback/stream producers (the Docker stdio demux, a relay fan-out)
 * and the `AsyncIterable<string>` channels the execution-driver interface promises. It buffers when
 * the consumer is behind and hands values straight to a waiting consumer otherwise, so no value is
 * dropped and ordering is preserved. Values pushed after {@link close} are ignored.
 */
export class AsyncChannel<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = []
  private readonly waiting: ((result: IteratorResult<T>) => void)[] = []
  private closed = false

  /** Enqueue one value, waking a blocked consumer if there is one. No-op once closed. */
  push(value: T): void {
    if (this.closed) {
      return
    }
    const wake = this.waiting.shift()
    if (wake) {
      wake({ value, done: false })
    } else {
      this.buffer.push(value)
    }
  }

  /** End the stream: every current and future consumer completes once the buffer drains. */
  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    for (const wake of this.waiting.splice(0)) {
      wake({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift() as T, done: false })
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true })
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiting.push(resolve)
        })
      },
    }
  }
}
