<!--
  The post-session rating panel (Stage 6.6), shown on the end-of-session card for both the watch and
  play flows — ratings come from any finished session, so this is the same component in both; only the
  set of involved agents differs. It reads the rateable agents (and the caller's prior ratings) for the
  session, presents a 1-5 control per agent, and posts the batch.

  Three rules, all enforced by the backend and mirrored here so the UI never offers an illegal action:
  - The caller's own submitted agent is shown without a control or comment box, labeled as theirs (the exclusion).
  - The built-in Naive baseline gets a normal control and comment box (it has no owner).
  - A closed play window is read-only: prior ratings and comments show as text, no save control is offered.

  Every rating needs a written comment, so the panel keeps the save disabled until every agent that has
  a score also has a non-blank comment, and mirrors the server's length cap with a live counter.

  The response also carries viewer-appropriate names and both prompts, so no second request or local
  identity reconstruction is needed. Season instructions render once above the list; an author's
  instructions render only beside that agent. The card enters after termination with a short
  expanding downward reveal, making the new post-session action visible above the canvas.
-->
<script setup lang="ts">
import { agentRefKey } from '@game-sandbox/schema/board'
import { RATING_FEEDBACK_MAX } from '@game-sandbox/schema/seasons'
import { codePointLength } from '@game-sandbox/schema/text'
import { computed, onMounted, ref } from 'vue'

import {
  type AgentRefWire,
  getSessionRatings,
  type SessionRatings,
  submitRatings,
} from '../api/client.js'
import UiButton from './ui/UiButton.vue'
import UiCard from './ui/UiCard.vue'
import UiTextarea from './ui/UiTextarea.vue'

const props = defineProps<{ sessionId: string }>()

const SCORES = [1, 2, 3, 4, 5] as const

const ratings = ref<SessionRatings | null>(null)
// The caller's pending selections and comments, keyed by agent wire key, seeded from their prior values.
const selections = ref<Record<string, number>>({})
const comments = ref<Record<string, string>>({})
const saving = ref(false)
const saved = ref(false)
const error = ref<string | null>(null)

type RateableView = SessionRatings['agents'][number]

/** Every involved agent, shown in the panel; the caller's own agent appears without a control. */
const agents = computed<RateableView[]>(() => ratings.value?.agents ?? [])

/** The agents the caller can actually rate: not their own, regardless of read-only state. */
const rateable = computed<RateableView[]>(() => agents.value.filter((agent) => !agent.is_own))

onMounted(load)

async function load(): Promise<void> {
  const result = await getSessionRatings(props.sessionId)
  if (!result.ok) {
    // Not rateable (old null-season session, or no finalized recording): render nothing.
    return
  }
  ratings.value = result.ratings
  seedSelections(result.ratings)
}

/** Seed the pending selections and comments from the saved values, so reopening shows the prior state. */
function seedSelections(view: SessionRatings): void {
  const seeded: Record<string, number> = {}
  const seededComments: Record<string, string> = {}
  for (const agent of view.agents) {
    if (agent.your_rating !== null) {
      seeded[agentRefKey(agent.agent)] = agent.your_rating
    }
    if (agent.your_feedback !== null) {
      seededComments[agentRefKey(agent.agent)] = agent.your_feedback
    }
  }
  selections.value = seeded
  comments.value = seededComments
}

function select(agent: AgentRefWire, score: number): void {
  if (ratings.value?.read_only === true) {
    return
  }
  selections.value = { ...selections.value, [agentRefKey(agent)]: score }
  saved.value = false
}

function selectionFor(agent: AgentRefWire): number | undefined {
  return selections.value[agentRefKey(agent)]
}

/** The caller's pending comment for one agent, or an empty string when they have written none. */
function commentFor(agent: AgentRefWire): string {
  return comments.value[agentRefKey(agent)] ?? ''
}

function setComment(agent: AgentRefWire, value: string): void {
  if (ratings.value?.read_only === true) {
    return
  }
  comments.value = { ...comments.value, [agentRefKey(agent)]: value }
  saved.value = false
}

/** Whether the caller can save: at least one score chosen, and every scored agent has a comment. */
const canSave = computed(
  () =>
    Object.keys(selections.value).length > 0 &&
    rateable.value.every(
      (agent) =>
        selections.value[agentRefKey(agent.agent)] === undefined ||
        commentFor(agent.agent).trim() !== '',
    ),
)

/** The per-agent hint below the comment box, or null in the ordinary case (nothing renders). */
function commentHint(agent: RateableView): string | null {
  if (ratings.value?.read_only === true) {
    return null
  }
  const comment = commentFor(agent.agent)
  if (selectionFor(agent.agent) !== undefined && comment.trim() === '') {
    return 'Add a comment before saving.'
  }
  const over = codePointLength(comment) - RATING_FEEDBACK_MAX
  if (over > 0) {
    return `Too long by ${over} characters.`
  }
  return null
}

async function submit(): Promise<void> {
  if (ratings.value === null) {
    return
  }
  const batch = rateable.value
    .map((agent) => ({
      agent: agent.agent,
      score: selectionFor(agent.agent),
      feedback: commentFor(agent.agent),
    }))
    .filter(
      (entry): entry is { agent: AgentRefWire; score: number; feedback: string } =>
        entry.score !== undefined,
    )
  if (batch.length === 0) {
    return
  }
  saving.value = true
  error.value = null
  const result = await submitRatings(props.sessionId, batch)
  saving.value = false
  if (result.ok) {
    ratings.value = result.ratings
    seedSelections(result.ratings)
    saved.value = true
    return
  }
  error.value = errorMessage(result.reason)
}

/** A friendly line for a submit refusal; a window that closed between read and write is the live one. */
function errorMessage(
  reason:
    | 'play_closed'
    | 'not_rateable'
    | 'not_finished'
    | 'invalid'
    | 'empty_feedback'
    | 'feedback_too_long'
    | 'failed',
): string {
  switch (reason) {
    case 'play_closed':
      return 'Rating for this round has closed.'
    case 'not_rateable':
    case 'not_finished':
      return 'This session can no longer be rated.'
    case 'invalid':
      return 'That rating was not accepted.'
    case 'empty_feedback':
      return 'Add a comment to every rating before saving.'
    case 'feedback_too_long':
      return 'One comment is too long. Trim it and save again.'
    default:
      return 'Could not save your rating. Please try again.'
  }
}
</script>

<template>
  <Transition name="ratings-reveal">
    <div v-if="agents.length > 0" class="ratings-reveal" data-testid="ratings-reveal">
      <div class="ratings-reveal-inner">
        <UiCard class="ratings">
          <h2 class="ratings-title">Rate the Agents</h2>
          <p v-if="ratings?.read_only" class="ratings-closed">
            Rating for this round has closed. Your previous ratings are shown below.
          </p>

          <!-- The season instructions apply to every agent, so they show once for the panel. -->
          <p v-if="ratings?.season_prompt" class="prompt">
            <span class="prompt-from">The instructor wants you to rate by:</span> {{ ratings.season_prompt }}
          </p>

          <ul class="agent-list">
            <li v-for="agent in agents" :key="agentRefKey(agent.agent)" class="agent">
              <div class="agent-head">
                <span class="agent-name">{{ agent.display_name }}</span>
                <!-- The caller's own agent is shown for context but carries no controls. -->
                <span v-if="agent.is_own" class="agent-own">You can't rate your own agent.</span>
                <template v-else-if="ratings?.read_only">
                  <span v-if="selectionFor(agent.agent) !== undefined" class="prior-score">
                    ★ {{ selectionFor(agent.agent) }}
                  </span>
                  <span v-else class="agent-own">Not rated</span>
                </template>
                <div
                  v-else
                  class="score-group"
                  role="radiogroup"
                  :aria-label="`Rate ${agent.display_name} from 1 to 5`"
                >
                  <UiButton
                    v-for="score in SCORES"
                    :key="score"
                    size="tight"
                    :variant="selectionFor(agent.agent) === score ? 'primary' : 'secondary'"
                    :disabled="ratings?.read_only"
                    :aria-pressed="selectionFor(agent.agent) === score"
                    @click="select(agent.agent, score)"
                  >
                    {{ score }}
                  </UiButton>
                </div>
              </div>

              <p v-if="agent.author_prompt" class="prompt">
                <span class="prompt-from">The author wants you to rate by:</span> {{ agent.author_prompt }}
              </p>

              <!-- A comment box for every agent the caller can rate; their own agent never has one. -->
              <template v-if="!agent.is_own">
                <p v-if="ratings?.read_only" class="prior-comment">
                  <template v-if="commentFor(agent.agent) !== ''">{{ commentFor(agent.agent) }}</template>
                  <span v-else class="agent-own">No comment.</span>
                </p>
                <div v-else class="comment-box">
                  <div class="comment-field">
                    <UiTextarea
                      :model-value="commentFor(agent.agent)"
                      class="comment-input"
                      rows="2"
                      placeholder="Tell the author what you thought"
                      :invalid="codePointLength(commentFor(agent.agent)) > RATING_FEEDBACK_MAX"
                      @update:model-value="(value: string) => setComment(agent.agent, value)"
                    />
                    <span
                      class="comment-count"
                      :class="{ over: codePointLength(commentFor(agent.agent)) > RATING_FEEDBACK_MAX }"
                    >
                      {{ codePointLength(commentFor(agent.agent)) }} / {{ RATING_FEEDBACK_MAX }}
                    </span>
                  </div>
                  <p v-if="commentHint(agent)" class="comment-hint">{{ commentHint(agent) }}</p>
                </div>
              </template>
            </li>

          </ul>

          <div v-if="!ratings?.read_only" class="ratings-actions">
            <UiButton :loading="saving" :disabled="!canSave" @click="submit">Save ratings</UiButton>
            <span v-if="saved" class="ratings-saved" role="status">Saved ✓</span>
            <span v-if="error" class="ratings-error" role="alert">{{ error }}</span>
          </div>
        </UiCard>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.ratings-reveal {
  display: grid;
  grid-template-rows: 1fr;
  margin-bottom: var(--space-4);
  transition:
    grid-template-rows var(--motion-base) var(--ease-out),
    opacity var(--motion-base) var(--ease-out),
    transform var(--motion-base) var(--ease-out);
}

.ratings-reveal-inner {
  min-height: 0;
  overflow: hidden;
}

.ratings-reveal-enter-from {
  grid-template-rows: 0fr;
  opacity: 0;
  transform: translateY(calc(var(--space-3) * -1));
}

.ratings {
  width: 100%;
}

.ratings-title {
  margin: 0 0 var(--space-2);
  font-size: var(--text-lg);
}

.ratings-closed {
  margin: 0 0 var(--space-3);
  font-size: var(--text-md);
  color: var(--color-text-muted);
}

.agent {
  border-top: 1px solid;
  border-color: var(--color-text-muted);
  padding: var(--space-1) 0 var(--space-1) 0;
}

.agent .prompt {
  margin: var(--space-1) 0 var(--space-1) 0;
}

.agent-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.agent-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
}

.agent-name {
  font-weight: 600;
}

.agent-own {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.score-group {
  display: flex;
  gap: var(--space-1);
}

.prompt {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.prompt-from {
  color: var(--color-text);
  font-weight: 600;
}

.ratings-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-3);
}

.ratings-saved {
  font-size: var(--text-sm);
  color: var(--color-success);
}

.ratings-error {
  font-size: var(--text-sm);
  color: var(--color-danger);
}

/* The written-comment surface: a compact box with the live counter anchored inside, bottom right. */
.comment-box {
  margin-top: var(--space-1);
}

.comment-field {
  position: relative;
}

.comment-field :deep(.ui-textarea) {
  /* Room for the counter at the bottom-right so typed text never runs under it. */
  padding-bottom: var(--space-5);
}

.comment-count {
  position: absolute;
  right: var(--space-3);
  bottom: var(--space-1);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}

.comment-count.over {
  color: var(--color-danger);
}

.comment-hint {
  margin: var(--space-1) 0 0;
  font-size: var(--text-sm);
  color: var(--color-danger);
}

.prior-score {
  color: var(--color-warning);
  font-weight: 600;
}

.prior-comment {
  margin: var(--space-1) 0 0;
  font-size: var(--text-sm);
  color: var(--color-text);
}
</style>
