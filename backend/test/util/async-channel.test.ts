import { describe, expect, it } from 'vitest'

import { AsyncChannel } from '../../src/util/async-channel.js'

describe('AsyncChannel', () => {
  it('buffers values in order and drains them after close', async () => {
    const channel = new AsyncChannel<string>()
    channel.push('first')
    channel.push('second')
    channel.close()

    const iterator = channel[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({ value: 'first', done: false })
    await expect(iterator.next()).resolves.toEqual({ value: 'second', done: false })
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true })
  })

  it('delivers pushed values in order to a waiting consumer', async () => {
    const channel = new AsyncChannel<string>()
    const iterator = channel[Symbol.asyncIterator]()
    const first = iterator.next()
    const second = iterator.next()

    channel.push('first')
    channel.push('second')

    await expect(first).resolves.toEqual({ value: 'first', done: false })
    await expect(second).resolves.toEqual({ value: 'second', done: false })
  })

  it('wakes a waiting consumer on close and ignores later pushes and closes', async () => {
    const channel = new AsyncChannel<string>()
    const iterator = channel[Symbol.asyncIterator]()
    const waitingRead = iterator.next()

    channel.close()
    channel.close()
    channel.push('ignored')

    await expect(waitingRead).resolves.toEqual({ value: undefined, done: true })
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true })
  })
})
