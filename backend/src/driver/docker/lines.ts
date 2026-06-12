/**
 * Pump a byte stream into an {@link AsyncChannel} one newline-delimited line at a time.
 *
 * The execution-driver interface promises newline-stripped protocol lines; Docker hands us a raw
 * byte stream whose chunks do not align to newlines. This buffers the partial tail between chunks,
 * emits each complete line stripped of its terminator (tolerating CRLF), flushes any unterminated
 * final line on end, and closes the channel when the stream ends or errors. It is the one place
 * the stdio carrier is turned into the line channel the driver exposes.
 */
import type { Readable } from 'node:stream'

import type { AsyncChannel } from '../../util/async-channel.js'

export function pumpLines(stream: Readable, channel: AsyncChannel<string>): void {
  let pending = ''
  stream.setEncoding('utf-8')

  stream.on('data', (chunk: string) => {
    pending += chunk
    let newline = pending.indexOf('\n')
    while (newline !== -1) {
      channel.push(stripCarriageReturn(pending.slice(0, newline)))
      pending = pending.slice(newline + 1)
      newline = pending.indexOf('\n')
    }
  })

  const finish = (): void => {
    if (pending.length > 0) {
      channel.push(stripCarriageReturn(pending))
      pending = ''
    }
    channel.close()
  }

  stream.on('end', finish)
  stream.on('error', () => channel.close())
}

function stripCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}
