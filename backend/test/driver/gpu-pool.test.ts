import { describe, expect, it } from 'vitest'

import { GpuBusyError, GpuPool } from '../../src/driver/gpu-pool.js'

describe('GpuPool', () => {
  it('spreads leases across devices before sharing one', async () => {
    const pool = new GpuPool(['0', '1'], 2)
    expect(pool.capacity).toBe(4)
    const devices = [
      (await pool.lease('fail')).device,
      (await pool.lease('fail')).device,
      (await pool.lease('fail')).device,
    ]
    expect(devices.slice(0, 2).sort()).toEqual(['0', '1'])
    expect(['0', '1']).toContain(devices[2])
  })

  it('refuses a fail lease when every slot is taken, and frees the slot on release', async () => {
    const pool = new GpuPool(['0'], 1)
    const held = await pool.lease('fail')
    await expect(pool.lease('fail')).rejects.toBeInstanceOf(GpuBusyError)
    held.release()
    await expect(pool.lease('fail')).resolves.toMatchObject({ device: '0' })
  })

  it('queues a wait lease until a slot frees, and ignores a repeated release', async () => {
    const pool = new GpuPool(['0'], 1)
    const held = await pool.lease('wait')
    let granted = false
    const waiting = pool.lease('wait').then((lease) => {
      granted = true
      return lease
    })
    await Promise.resolve()
    expect(granted).toBe(false)

    held.release()
    const next = await waiting
    expect(next.device).toBe('0')
    // A second release of the old lease must not free the slot the waiter now holds.
    held.release()
    await expect(pool.lease('fail')).rejects.toBeInstanceOf(GpuBusyError)
  })
})
