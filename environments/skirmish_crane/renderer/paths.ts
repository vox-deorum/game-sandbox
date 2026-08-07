/**
 * The stable path codec, mirroring the environment's `paths.py`. A path is zero through four
 * direction digits from 1 through 6; ids run in length order and then lexically, with the last
 * direction varying fastest. Id 0 is the empty path, which is the stand-still order.
 *
 * This is part of the student contract, so both sides of it are pinned by tests: the environment's
 * helper pin tests on the Python side, and the mask-agreement suite here.
 */

export const MAX_PATH_STEPS = 4
/** 6 + 6^2 + 6^3 + 6^4 one-through-four-step sequences, alongside id 0. */
export const MAX_PATH_ID = 6 + 6 ** 2 + 6 ** 3 + 6 ** 4

export function encodePath(directions: readonly number[]): number {
  if (directions.length === 0) return 0
  if (directions.length > MAX_PATH_STEPS || directions.some((digit) => digit < 1 || digit > 6)) {
    throw new Error('a Crane Reach path is zero through four directions numbered 1 through 6')
  }
  let id = 1
  for (let length = 1; length < directions.length; length += 1) id += 6 ** length
  for (const [offset, direction] of directions.entries()) {
    id += (direction - 1) * 6 ** (directions.length - offset - 1)
  }
  return id
}

export function decodePath(pathId: number): number[] {
  if (!Number.isInteger(pathId) || pathId < 0 || pathId > MAX_PATH_ID) {
    throw new Error(`a Crane Reach path id is an integer from 0 through ${MAX_PATH_ID}`)
  }
  if (pathId === 0) return []
  let remaining = pathId - 1
  let length = 1
  while (remaining >= 6 ** length) {
    remaining -= 6 ** length
    length += 1
  }
  const directions: number[] = []
  for (let power = length - 1; power >= 0; power -= 1) {
    const place = 6 ** power
    directions.push(Math.floor(remaining / place) + 1)
    remaining %= place
  }
  return directions
}
