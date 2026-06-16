/**
 * Human-rating queries: the validated 1-5 rating upsert (own-agent rule enforced before any
 * write), the per-user/per-iteration reads, the mean-and-count aggregation behind the human board,
 * and the agent author's per-iteration rating prompt.
 */
import { randomUUID } from 'node:crypto'

import type { Kysely } from 'kysely'

import type { AgentRef, RatingAggregate, UpsertRatingInput, UpsertRatingResult } from '../index.js'
import type { AgentRatingPrompt, Database, Rating } from '../schema.js'
import { requireIteration } from './iterations.js'
import { type AgentColumns, agentColumns, agentKey, agentRefFromColumns } from './shared.js'

export async function upsertRating(
  db: Kysely<Database>,
  input: UpsertRatingInput,
): Promise<UpsertRatingResult> {
  if (!Number.isInteger(input.score) || input.score < 1 || input.score > 5) {
    return { ok: false, reason: 'invalid_score' }
  }
  // A participant cannot rate their own submitted agent; the ownerless Naive baseline is rateable.
  if (input.agent.kind === 'submission' && input.agent.user_id === input.rater_user_id) {
    return { ok: false, reason: 'own_agent' }
  }
  const existing = await getRating(db, input.iteration_id, input.rater_user_id, input.agent)
  const now = new Date().toISOString()
  if (existing !== undefined) {
    const updated = await db
      .updateTable('ratings')
      .set({ score: input.score, updated_at: now })
      .where('id', '=', existing.id)
      .returningAll()
      .executeTakeFirstOrThrow()
    return { ok: true, rating: updated }
  }
  const inserted = await db
    .insertInto('ratings')
    .values({
      id: randomUUID(),
      iteration_id: input.iteration_id,
      env_id: input.env_id,
      rater_user_id: input.rater_user_id,
      ...agentColumns(input.agent),
      score: input.score,
      created_at: now,
      updated_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow()
  return { ok: true, rating: inserted }
}

export async function getRating(
  db: Kysely<Database>,
  iterationId: string,
  raterUserId: string,
  agent: AgentRef,
): Promise<Rating | undefined> {
  const cols = agentColumns(agent)
  let query = db
    .selectFrom('ratings')
    .selectAll()
    .where('iteration_id', '=', iterationId)
    .where('rater_user_id', '=', raterUserId)
    .where('agent_kind', '=', cols.agent_kind)
  query =
    cols.agent_submission_id === null
      ? query.where('agent_submission_id', 'is', null)
      : query.where('agent_submission_id', '=', cols.agent_submission_id)
  return await query.executeTakeFirst()
}

export async function listRatingsByIteration(
  db: Kysely<Database>,
  iterationId: string,
): Promise<Rating[]> {
  return await db
    .selectFrom('ratings')
    .selectAll()
    .where('iteration_id', '=', iterationId)
    .execute()
}

export async function aggregateRatingsByAgent(
  db: Kysely<Database>,
  iterationId: string,
): Promise<RatingAggregate[]> {
  const ratings = await listRatingsByIteration(db, iterationId)
  const groups = new Map<string, { agent: AgentColumns; sum: number; count: number }>()
  for (const rating of ratings) {
    const key = agentKey(rating)
    const acc = groups.get(key) ?? { agent: rating, sum: 0, count: 0 }
    acc.sum += rating.score
    acc.count += 1
    groups.set(key, acc)
  }
  return [...groups.values()].map((acc) => ({
    agent: agentRefFromColumns(acc.agent),
    mean: acc.count > 0 ? acc.sum / acc.count : 0,
    count: acc.count,
  }))
}

export async function upsertAgentRatingPrompt(
  db: Kysely<Database>,
  iterationId: string,
  userId: string,
  prompt: string,
): Promise<void> {
  const iteration = await requireIteration(db, iterationId)
  const now = new Date().toISOString()
  await db
    .insertInto('agent_rating_prompts')
    .values({
      iteration_id: iterationId,
      env_id: iteration.env_id,
      user_id: userId,
      prompt,
      updated_at: now,
    })
    .onConflict((oc) =>
      oc.columns(['iteration_id', 'user_id']).doUpdateSet({ prompt, updated_at: now }),
    )
    .execute()
}

export async function getAgentRatingPrompt(
  db: Kysely<Database>,
  iterationId: string,
  userId: string,
): Promise<AgentRatingPrompt | undefined> {
  return await db
    .selectFrom('agent_rating_prompts')
    .selectAll()
    .where('iteration_id', '=', iterationId)
    .where('user_id', '=', userId)
    .executeTakeFirst()
}

export async function listAgentRatingPromptsByIteration(
  db: Kysely<Database>,
  iterationId: string,
): Promise<AgentRatingPrompt[]> {
  return await db
    .selectFrom('agent_rating_prompts')
    .selectAll()
    .where('iteration_id', '=', iterationId)
    .execute()
}
