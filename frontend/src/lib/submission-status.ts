/**
 * The one place a submission status maps to a badge tone and a human label, so the agent profile, the
 * my-agents list, and the operator submissions table stay consistent. "ready" reads as ambiguous on its
 * own ("ready for what?"), so it spells out that the submission passed validation and may compete.
 */
import type { SubmissionStatus } from '../api/client.js'

export type SubmissionStatusTone = 'neutral' | 'success' | 'danger' | 'warning'

const TONE: Record<SubmissionStatus, SubmissionStatusTone> = {
  pending: 'warning',
  ready: 'success',
  static_failed: 'danger',
  build_failed: 'danger',
  load_failed: 'danger',
}

const LABEL: Record<SubmissionStatus, string> = {
  pending: 'pending',
  ready: 'ready to compete',
  static_failed: 'static check failed',
  build_failed: 'build failed',
  load_failed: 'load check failed',
}

export function submissionStatusTone(status: SubmissionStatus): SubmissionStatusTone {
  return TONE[status]
}

export function submissionStatusLabel(status: SubmissionStatus): string {
  return LABEL[status]
}
