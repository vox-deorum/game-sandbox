import { describe, expect, it } from 'vitest'

import { agentColumns, agentKey, agentRefFromColumns } from '../../src/storage/kysely/shared.js'
import type { AgentColumns } from '../../src/storage/schema.js'

describe('stored agent identity codec', () => {
  it('round-trips distinct named builtins and submissions', () => {
    for (const agent of [
      { kind: 'builtin' as const, name: 'naive' },
      { kind: 'builtin' as const, name: 'cautious' },
      {
        kind: 'submission' as const,
        submission_id: 'submission-1',
        user_id: 'user-1',
      },
    ]) {
      const columns = agentColumns(agent)
      expect(agentRefFromColumns(columns)).toEqual(agent)
      expect(agentKey(columns)).toBe(
        agent.kind === 'builtin' ? `builtin:${agent.name}` : `submission:${agent.submission_id}`,
      )
    }
  })

  it.each([
    {
      agent_kind: 'builtin',
      agent_builtin_name: null,
      agent_submission_id: null,
      agent_user_id: null,
    },
    {
      agent_kind: 'builtin',
      agent_builtin_name: 'naive',
      agent_submission_id: 'submission-1',
      agent_user_id: null,
    },
    {
      agent_kind: 'submission',
      agent_builtin_name: null,
      agent_submission_id: '',
      agent_user_id: 'user-1',
    },
    {
      agent_kind: 'submission',
      agent_builtin_name: 'naive',
      agent_submission_id: 'submission-1',
      agent_user_id: 'user-1',
    },
  ] satisfies AgentColumns[])('rejects malformed stored columns %#', (columns) => {
    expect(() => agentRefFromColumns(columns)).toThrow(/invalid identity/)
    expect(() => agentKey(columns)).toThrow(/invalid identity/)
  })
})
