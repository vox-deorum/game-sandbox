/**
 * The vocabulary of the backend's current-process log buffer, defined once so the buffer, the admin
 * route's query validation, and the frontend client all agree on the same levels and sources.
 */

/** The severities the backend process-log buffer retains. */
export const LOG_LEVELS = ['info', 'warn', 'error'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

/** The backend subsystems that write retained process log entries. */
export const LOG_SOURCES = [
  'main',
  'http',
  'llm',
  'auth',
  'retention',
  'overlay-eviction',
  'session',
  'workflow',
  'leaderboard',
  'submission',
] as const
export type LogSource = (typeof LOG_SOURCES)[number]
