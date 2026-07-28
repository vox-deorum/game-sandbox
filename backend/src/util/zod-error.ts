/**
 * Render the first issue of a {@link z.ZodError} as a compact "path: message" string.
 *
 * Every zod validation boundary in the backend reports failures the same way: a 400 `reason` on the
 * admin routes, the message of a typed error in the storage codecs. This is the one place that shape
 * is spelled, so a caller cannot drift from the format its tests and its clients already expect.
 * The fallback covers an error carrying no issues, which zod does not produce today.
 */
import type { z } from 'zod'

export function zodReason(error: z.ZodError, fallback = 'invalid request body'): string {
  const issue = error.issues[0]
  if (issue === undefined) {
    return fallback
  }
  const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
  return `${path}: ${issue.message}`
}
