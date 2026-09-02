import { randomInt } from 'node:crypto'

/**
 * Draw one fresh game seed. Every seed the platform generates itself (a play session without a
 * requested seed, a scheduled match with an empty seed list) comes from here, so the range stays
 * one convention: a non-negative 31-bit integer every environment and the harness accept.
 */
export function drawSeed(): number {
  return randomInt(0, 2 ** 31)
}
