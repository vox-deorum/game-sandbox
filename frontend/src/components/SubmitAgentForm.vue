<!--
  The "Submit agent" form on the environment page (Stage 5.5), built on the Stage 4.5 primitives.

  The flow mirrors the backend pipeline the participant cannot see directly:
  1. Paste a repository URL (optionally a branch/tag/commit). The form calls the reachability
     pre-check and enables submit only once that exact input verifies reachable — re-typing the URL or
     ref invalidates a prior verdict, so the button re-arms only against what was actually checked.
  2. On submit the pending row is created under the signed-in identity (no name field), and the form
     polls the single-submission read until the row reaches a terminal status, rendering the per-stage
     validation log as a four-step timeline that the owner watches advance from in-progress to passed.
  3. A wedged worker or a downed Docker daemon can legitimately leave a submission `pending`; after a
     bounded number of no-progress polls the form shows a non-terminal "still processing" notice rather
     than spinning forever or inventing a failure. The row is durable; the eventual outcome also lands
     on the owner's agent profile (step 6).

  In dev builds only, and only when the backend reports the local gate is on, the form additionally
  offers a local-folder path — the same `import.meta.env.DEV` + backend-capability pattern Stage 4.5
  used for the styleguide route. Production builds neither render nor ship that affordance.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import { RATING_PROMPT_MAX } from '@game-sandbox/schema/seasons'

import {
  checkReachability,
  getAuthorPrompt,
  getSubmission,
  getSubmissionCapabilities,
  type ReachabilityResult,
  setAuthorPrompt,
  type SubmissionDetail,
  type SubmissionSourceInput,
  submitAgent,
} from '../api/client.js'
import SubmissionStageTimeline from './SubmissionStageTimeline.vue'
import UiButton from './ui/UiButton.vue'
import UiCard from './ui/UiCard.vue'
import UiField from './ui/UiField.vue'
import UiInput from './ui/UiInput.vue'
import UiStatusBadge from './ui/UiStatusBadge.vue'
import UiTextarea from './ui/UiTextarea.vue'
import { useToast } from '../toast.js'

const props = withDefaults(
  defineProps<{
    envId: string
    /** The open submission season the new agent lands in; also the season its rating prompt is saved to. */
    submissionSeasonId: string
    /** A guest may explore the form, but its actions are blocked with a toast and fire no request. */
    blocked?: boolean
    /** Poll cadence once a submission is pending; also lets tests drive the timeline deterministically. */
    pollIntervalMs?: number
    /** No-progress polls before the non-terminal "still processing" notice shows. */
    stallAfterPolls?: number
  }>(),
  { blocked: false, pollIntervalMs: 1500, stallAfterPolls: 20 },
)

const emit = defineEmits<{
  /** The backend has created the pending submission row. */
  accepted: [submissionId: string]
  /** Validation reached a terminal success or failure state. */
  settled: [submission: SubmissionDetail]
}>()

const toast = useToast()

const repoUrl = ref('')
const refInput = ref('')
const localPath = ref('')

// The agent author's rating prompt for this season. Prefilled from any existing value so a resubmit
// shows it and a blank field never silently clears it; saved once the submission is accepted.
const ratingPrompt = ref('')
const loadedPrompt = ref('')
const promptSaved = ref(false)
const promptSaveError = ref(false)

const capabilities = ref<{ local_submissions: boolean } | null>(null)
const localEnabled = computed(() => import.meta.env.DEV && capabilities.value?.local_submissions === true)

const verifying = ref(false)
const reachability = ref<ReachabilityResult | null>(null)
// The exact input string a verdict was produced for, so editing after a check disarms submit.
const verifiedKey = ref<string | null>(null)

const submitting = ref(false)
const submitError = ref<string | null>(null)

const phase = ref<'form' | 'polling'>('form')
const submission = ref<SubmissionDetail | null>(null)
const stalled = ref(false)

let timer: ReturnType<typeof setTimeout> | null = null
let pollsWithoutProgress = 0
let lastSignature = ''

onMounted(async () => {
  try {
    capabilities.value = await getSubmissionCapabilities()
  } catch {
    // No capabilities means the dev local-folder affordance simply stays hidden.
    capabilities.value = null
  }
  try {
    const current = await getAuthorPrompt(props.submissionSeasonId)
    ratingPrompt.value = current.prompt ?? ''
    loadedPrompt.value = current.prompt ?? ''
  } catch {
    // A failed prefill just leaves the field empty; the author can still type a prompt.
  }
})

onBeforeUnmount(() => {
  if (timer !== null) {
    clearTimeout(timer)
  }
})

/** The current source input: a non-empty local path wins, otherwise the git repo URL and ref. */
function currentInput(): SubmissionSourceInput {
  if (localEnabled.value && localPath.value.trim() !== '') {
    return { localPath: localPath.value.trim() }
  }
  return { repoUrl: repoUrl.value.trim(), ref: refInput.value.trim() || null }
}

/** A stable key for the current input, so a verified verdict only applies to that exact input. */
const inputKey = computed(() => JSON.stringify(currentInput()))

const hasSource = computed(() => {
  const input = currentInput()
  return (input.localPath ?? '') !== '' || (input.repoUrl ?? '') !== ''
})

const verified = computed(
  () => reachability.value?.reachable === true && verifiedKey.value === inputKey.value,
)

const canSubmit = computed(() => verified.value && !submitting.value)

async function verify(): Promise<void> {
  // A guest may explore the form, but its actions are blocked with a toast and never reach the API
  // (the backend's requireActive would refuse them anyway).
  if (props.blocked) {
    toast.show("Guest accounts can't submit agents.")
    return
  }
  if (!hasSource.value) {
    return
  }
  verifying.value = true
  submitError.value = null
  try {
    reachability.value = await checkReachability(currentInput())
    verifiedKey.value = inputKey.value
  } finally {
    verifying.value = false
  }
}

const REASON_MESSAGE: Record<string, string> = {
  no_open_season: 'Submissions are closed for this environment.',
  resubmit_conflict: 'Another submission just took the seat. Please try again.',
  local_disabled: 'Local submissions are disabled on this deployment.',
  invalid_source: 'Enter a repository URL (or a local folder path).',
}

async function onSubmit(): Promise<void> {
  // A guest may explore the form, but its submit action is blocked with a toast and never reaches
  // the API (the backend's requireActive would refuse it anyway).
  if (props.blocked) {
    toast.show("Guest accounts can't submit agents.")
    return
  }
  if (!canSubmit.value) {
    return
  }
  submitting.value = true
  submitError.value = null
  const result = await submitAgent(props.envId, currentInput())
  if (!result.ok) {
    submitError.value = REASON_MESSAGE[result.reason] ?? result.message
    submitting.value = false
    return
  }
  phase.value = 'polling'
  emit('accepted', result.id)
  startPolling(result.id)
  // The pending submission row now exists and the season's submission window is still open, so save
  // the rating prompt right away rather than on the eventual `ready` poll: deferring it would silently
  // drop the prompt if the author leaves the page while validation runs, leaving an accepted agent
  // with none. Fire-and-forget — the save is exception-safe and independent of the polling above.
  void saveRatingPrompt(props.submissionSeasonId)
}

function startPolling(id: string): void {
  submission.value = null
  stalled.value = false
  pollsWithoutProgress = 0
  lastSignature = ''
  void poll(id)
}

/** One poll: refresh the row, detect a terminal status or a stall, then schedule the next. */
async function poll(id: string): Promise<void> {
  let detail: SubmissionDetail
  try {
    detail = await getSubmission(id)
  } catch {
    // A transient read failure is not terminal; try again on the next tick.
    timer = setTimeout(() => void poll(id), props.pollIntervalMs)
    return
  }
  submission.value = detail

  if (detail.status !== 'pending') {
    // Terminal: stop polling; the timeline and result banner now render the outcome. The rating
    // prompt was already saved when the submission was accepted (see onSubmit), so nothing to do here.
    emit('settled', detail)
    return
  }

  const signature = `${detail.status}|${detail.checks.map((c) => `${c.stage}:${c.status}`).join(',')}`
  if (signature === lastSignature) {
    pollsWithoutProgress += 1
  } else {
    pollsWithoutProgress = 0
    lastSignature = signature
  }
  if (pollsWithoutProgress >= props.stallAfterPolls) {
    stalled.value = true
  }
  timer = setTimeout(() => void poll(id), props.pollIntervalMs)
}

/**
 * Persist the author's rating prompt for the submission's season, but only when it differs from the
 * prefilled value, so leaving the field untouched never rewrites or clears an existing prompt.
 */
async function saveRatingPrompt(seasonId: string): Promise<void> {
  const trimmed = ratingPrompt.value.trim()
  if (trimmed === loadedPrompt.value.trim()) {
    return
  }
  // A failed save must never break the submit flow it runs inside, so a thrown request is caught and
  // surfaced as the non-blocking notice rather than rejecting onSubmit.
  try {
    const result = await setAuthorPrompt(seasonId, trimmed === '' ? null : trimmed)
    if (result.ok) {
      loadedPrompt.value = result.prompt ?? ''
      promptSaved.value = true
    } else {
      promptSaveError.value = true
    }
  } catch {
    promptSaveError.value = true
  }
}

const isReady = computed(() => submission.value?.status === 'ready')
const isFailed = computed(
  () => submission.value !== null && submission.value.status !== 'pending' && !isReady.value,
)
</script>

<template>
  <UiCard>
    <form v-if="phase === 'form'" class="submit-form" @submit.prevent="onSubmit">
      <slot name="fields-before" />

      <UiField
        label="Public Repository URL"
        hint="A public git repository containing your agent and its manifest. We verify it before validating and building your submission."
      >
        <template #default="{ id, describedby }">
          <UiInput
            :id="id"
            v-model="repoUrl"
            placeholder="https://github.com/you/agent"
            :aria-describedby="describedby"
          />
        </template>
      </UiField>

      <UiField label="Branch, tag, or commit (optional)" hint="Leave blank to take the default-branch head.">
        <template #default="{ id, describedby }">
          <UiInput :id="id" v-model="refInput" placeholder="main" :aria-describedby="describedby" />
        </template>
      </UiField>

      <UiField
        v-if="localEnabled"
        label="Local folder path (dev only)"
        hint="A server-side folder, used instead of the repository URL when set."
      >
        <template #default="{ id, describedby }">
          <UiInput :id="id" v-model="localPath" placeholder="/srv/agents/mine" :aria-describedby="describedby" />
        </template>
      </UiField>

      <UiField
        label="Rating prompt (optional)"
        hint="Tell raters what to evaluate about your agent. Shown next to the 1-5 control after a session. You can edit it while submissions stay open."
      >
        <template #default="{ id, describedby }">
          <UiTextarea
            :id="id"
            v-model="ratingPrompt"
            rows="3"
            :maxlength="RATING_PROMPT_MAX"
            placeholder="e.g. My agent does not play to win. Give a good grade if you feel it acts funnily!"
            :aria-describedby="describedby"
          />
        </template>
      </UiField>

      <div class="submit-actions" role="group" aria-label="Submission actions">
        <slot name="actions-before" />
        <UiButton type="button" variant="secondary" :loading="verifying" :disabled="!hasSource" @click="verify">
          Verify reachability
        </UiButton>
        <UiButton type="submit" :loading="submitting" :disabled="!canSubmit">Submit agent</UiButton>
        <UiStatusBadge
          v-if="reachability !== null && verifiedKey === inputKey"
          :tone="reachability.reachable ? 'success' : 'danger'"
          :label="reachability.reachable ? 'reachable' : reachability.detail ?? 'not reachable'"
        />
      </div>

      <p v-if="submitError !== null" class="submit-error" role="alert">{{ submitError }}</p>
    </form>

    <div v-else class="submit-progress">
      <h3 class="submit-progress-title">Validating your submission</h3>
      <SubmissionStageTimeline :checks="submission?.checks ?? []" />

      <p v-if="isReady" class="submit-result submit-result-ok" role="status">
        Accepted.
        <template v-if="submission?.commit_sha">
          Pinned commit <code>{{ submission.commit_sha.slice(0, 10) }}</code>.
        </template>
        <template v-if="promptSaved"> Rating prompt saved.</template>
      </p>
      <p v-if="isReady && promptSaveError" class="submit-result submit-result-wait" role="status">
        Your agent was accepted, but we couldn't save the rating prompt. You can set it by resubmitting
        while submissions stay open.
      </p>
      <p v-else-if="isFailed" class="submit-result submit-result-fail" role="alert">
        {{ submission?.reason ?? 'Validation failed.' }}
      </p>
      <p v-else-if="stalled" class="submit-result submit-result-wait" role="status">
        Still processing — this is taking longer than usual. Your submission is saved and will keep
        validating; you can leave this page and check your profile later.
      </p>
      <p v-else class="submit-result" role="status">Working…</p>
    </div>
  </UiCard>
</template>

<style scoped>
.submit-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.submit-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-3);
}

.submit-error {
  color: var(--color-danger);
  font-size: var(--text-sm);
}

.submit-progress {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.submit-progress-title {
  margin: 0;
}

.submit-result {
  font-size: var(--text-sm);
}

.submit-result-ok {
  color: var(--color-success);
}

.submit-result-fail {
  color: var(--color-danger);
}

.submit-result-wait {
  color: var(--color-text-muted);
}
</style>
