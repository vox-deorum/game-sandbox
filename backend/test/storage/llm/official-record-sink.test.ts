import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { LlmSuccessfulRecord } from '../../../src/llm/types.js'
import { ExecutionTelemetryStore } from '../../../src/storage/llm/execution-telemetry.js'
import { createOfficialRecordSink } from '../../../src/storage/llm/official-record-sink.js'

const SUCCESS: LlmSuccessfulRecord = {
  model: 'medium',
  costWeight: 2.5,
  budgetCostUnits: 42.5,
  request: { model: 'medium', messages: [{ role: 'user', content: 'Choose.' }] },
  completion: {
    id: 'completion-1',
    choices: [
      {
        finish_reason: 'stop',
        index: 0,
        logprobs: null,
        message: { content: 'Pass', refusal: null, role: 'assistant' },
      },
    ],
    created: 1,
    model: 'medium',
    object: 'chat.completion',
  },
  usage: { inputTokens: 12, reasoningTokens: 3, outputTokens: 5 },
  usageEstimated: true,
  latencyMs: 87,
}

describe('createOfficialRecordSink', () => {
  let root: string
  let store: ExecutionTelemetryStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gs-official-sink-'))
    store = new ExecutionTelemetryStore(root)
  })

  afterEach(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('persists every supplied field of an estimated successful record', () => {
    const sink = createOfficialRecordSink(store, {
      scopeId: 'run-7',
      sessionId: 'game-3',
      player: 'player_1',
      tick: 14,
    })

    sink(SUCCESS)

    expect(store.listCalls('run-7')).toEqual([
      expect.objectContaining({
        sessionId: 'game-3',
        player: 'player_1',
        tick: 14,
        model: 'medium',
        costWeight: 2.5,
        budgetCostUnits: 42.5,
        request: SUCCESS.request,
        completion: SUCCESS.completion,
        inputTokens: 12,
        reasoningTokens: 3,
        outputTokens: 5,
        usageEstimated: true,
        latencyMs: 87,
      }),
    ])
  })
})
