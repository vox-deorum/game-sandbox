/**
 * Shared text helpers for the messaging cap, dependency-free so the browser imports them directly.
 *
 * The harness caps message text in Unicode code points (`len(text)` on a Python `str`), so both the
 * relay's inbound pre-gate and the chat panel's live counter must count the same way. JavaScript's
 * `string.length` counts UTF-16 code units, so an astral-plane character such as an emoji reports as
 * two; iterating the string yields code points, matching Python exactly.
 */

/**
 * Return the number of Unicode code points in `text`, the unit the messaging cap is counted in.
 *
 * Iterating a string with `for...of` walks code points (not UTF-16 code units), so `"😀"` is 1, the
 * same value Python's `len("😀")` reports.
 */
export function codePointLength(text: string): number {
  let count = 0
  for (const _ of text) {
    count += 1
  }
  return count
}
