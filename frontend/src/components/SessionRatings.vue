<!--
  The post-session rating panel (Stage 6.6), shown on the end-of-session card for both the watch and
  play flows — ratings come from any finished session, so this is the same component in both; only the
  set of involved agents differs. It reads the rateable agents (and the caller's prior ratings) for the
  session, presents a 1-5 control per agent, and posts the batch.

  Three rules, all enforced by the backend and mirrored here so the UI never offers an illegal action:
  - The caller's own submitted agent is shown without a control, labeled as theirs (the exclusion).
  - The built-in Naive baseline gets a normal control (it has no owner).
  - A closed play window is read-only: prior ratings show, but no save control is offered.

  The response also carries viewer-appropriate names and both prompts, so no second request or local
  identity reconstruction is needed. Season instructions render once above the list; an author's
  instructions render only beside that agent. The card enters after termination with a short
  expanding downward reveal, making the new post-session action visible above the canvas.
-->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  type AgentRefWire,
  getSessionRatings,
  type SessionRatings,
  submitRatings,
} from '../api/client.js'
import UiButton from './ui/UiButton.vue'
import UiCard from './ui/UiCard.vue'

const props = defineProps<{ sessionId: string }>()

const SCORES = [1, 2, 3, 4, 5] as const

const ratings = ref<SessionRatings | null>(null)
// The caller's pending selections, keyed by agent wire key, seeded from their prior ratings.
const selections = ref<Record<string, number>>({})
const saving = ref(false)
const saved = ref(false)
const error = ref<string | null>(null)

/** The stable wire key for an agent, matching the backend's, so a selection maps to one agent. */
function wireKey(agent: AgentRefWire): string {
  return agent.kind === 'submission' ? `submission:${agent.submission_id}` : 'builtin-naive'
}

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

/** Seed the pending selections from the saved ratings, so reopening shows the prior values. */
function seedSelections(view: SessionRatings): void {
  const seeded: Record<string, number> = {}
  for (const agent of view.agents) {
    if (agent.your_rating !== null) {
      seeded[wireKey(agent.agent)] = agent.your_rating
    }
  }
  selections.value = seeded
}

function select(agent: AgentRefWire, score: number): void {
  if (ratings.value?.read_only === true) {
    return
  }
  selections.value = { ...selections.value, [wireKey(agent)]: score }
  saved.value = false
}

function selectionFor(agent: AgentRefWire): number | undefined {
  return selections.value[wireKey(agent)]
}

/** Whether the caller has chosen at least one score to save. */
const hasSelection = computed(() => Object.keys(selections.value).length > 0)

async function submit(): Promise<void> {
  if (ratings.value === null) {
    return
  }
  const batch = rateable.value
    .map((agent) => ({ agent: agent.agent, score: selectionFor(agent.agent) }))
    .filter((entry): entry is { agent: AgentRefWire; score: number } => entry.score !== undefined)
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
function errorMessage(reason: 'play_closed' | 'not_rateable' | 'not_finished' | 'invalid' | 'failed'): string {
  switch (reason) {
    case 'play_closed':
      return 'Rating for this round has closed.'
    case 'not_rateable':
    case 'not_finished':
      return 'This session can no longer be rated.'
    case 'invalid':
      return 'That rating was not accepted.'
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
          <h2 class="ratings-title">Rate the agents</h2>
          <p v-if="ratings?.read_only" class="ratings-closed">
            Rating for this round has closed. Your previous ratings are shown below.
          </p>

          <!-- The season instructions apply to every agent, so they show once for the panel. -->
          <p v-if="ratings?.season_prompt" class="prompt">
            <span class="prompt-from">Season instructions:</span> {{ ratings.season_prompt }}
          </p>

          <ul class="agent-list">
            <li v-for="agent in agents" :key="wireKey(agent.agent)" class="agent">
              <div class="agent-head">
                <span class="agent-name">{{ agent.display_name }}</span>
                <!-- The caller's own agent is shown for context but carries no control. -->
                <span v-if="agent.is_own" class="agent-own">You can't rate your own agent.</span>
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
                <span class="prompt-from">Agent instructions:</span> {{ agent.author_prompt }}
              </p>
            </li>
          </ul>

          <div v-if="!ratings?.read_only" class="ratings-actions">
            <UiButton :loading="saving" :disabled="!hasSelection" @click="submit">Save ratings</UiButton>
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
  margin: 0 0 var(--space-3);
  font-size: var(--text-md);
}

.ratings-closed {
  margin: 0 0 var(--space-3);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.agent-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
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
  margin: var(--space-2) 0 0;
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
  margin-top: var(--space-4);
}

.ratings-saved {
  font-size: var(--text-sm);
  color: var(--color-success);
}

.ratings-error {
  font-size: var(--text-sm);
  color: var(--color-danger);
}
</style>
