/** Shared scalar math for renderer scene computation and animation. */

/** Keep a number inside the inclusive range from `min` to `max`. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Interpolate linearly between two numbers. */
export function lerp(from: number, to: number, progress: number): number {
  return from + (to - from) * progress
}

/** Interpolate degrees along the shortest turn and normalize the result to the range [0, 360). */
export function interpolateDegrees(from: number, to: number, progress: number): number {
  const turn = ((to - from + 540) % 360) - 180
  return (from + turn * progress + 360) % 360
}

/** Convert degrees to radians for Pixi rotations and trigonometry. */
export function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}

/** Produce a deterministic unsigned FNV-1a hash for renderer presentation choices. */
export function stableHash(value: string): number {
  let hash = 0x811c9dc5
  for (const character of value) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}
