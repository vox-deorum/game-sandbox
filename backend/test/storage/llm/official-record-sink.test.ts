import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { LlmSuccessfulRecord, OfficialTickMarkerRef } from '../../../src/llm/types.js'
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
    store = new ExecutionTelemetryStore(root, () => new Date('2026-07-15T15:00:00.000Z'))
  })

  afterEach(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('reads the tick at commit time and maps successful records into official rows', () => {
    const tick: OfficialTickMarkerRef = { current: null }
    const sink = createOfficialRecordSink(store, {
      scopeId: 'run-1',
      sessionId: 'game-1',
      player: 'player_2',
      tick,
    })

    sink(SUCCESS)
    tick.current = 14
    sink({ ...SUCCESS, usageEstimated: false, latencyMs: 20 })

    expect(store.listCalls('run-1')).toEqual([
      {
        id: 1,
        sessionId: 'game-1',
        player: 'player_2',
        tick: null,
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
        createdAt: '2026-07-15T15:00:00.000Z',
      },
      {
        id: 2,
        sessionId: 'game-1',
        player: 'player_2',
        tick: 14,
        model: 'medium',
        costWeight: 2.5,
        budgetCostUnits: 42.5,
        request: SUCCESS.request,
        completion: SUCCESS.completion,
        inputTokens: 12,
        reasoningTokens: 3,
        outputTokens: 5,
        usageEstimated: false,
        latencyMs: 20,
        createdAt: '2026-07-15T15:00:00.000Z',
      },
    ])
  })

  it('writes the record to the bound scope', () => {
    const sink = createOfficialRecordSink(store, {
      scopeId: 'live-session',
      sessionId: 'live-session',
      player: 'player_0',
      tick: { current: null },
    })

    sink(SUCCESS)

    expect(store.listCalls('live-session')[0]).toMatchObject({
      sessionId: 'live-session',
      player: 'player_0',
      model: 'medium',
    })
  })
})
