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

import {
  checkReachability,
  getSubmission,
  getSubmissionCapabilities,
  type ReachabilityResult,
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

const props = withDefaults(
  defineProps<{
    envId: string
    /** Poll cadence once a submission is pending; also lets tests drive the timeline deterministically. */
    pollIntervalMs?: number
    /** No-progress polls before the non-terminal "still processing" notice shows. */
    stallAfterPolls?: number
  }>(),
  { pollIntervalMs: 1500, stallAfterPolls: 20 },
)

const repoUrl = ref('')
const refInput = ref('')
const localPath = ref('')

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
  no_open_iteration: 'Submissions are closed for this environment.',
  resubmit_conflict: 'Another submission just took the slot — please try again.',
  local_disabled: 'Local submissions are disabled on this deployment.',
  invalid_source: 'Enter a repository URL (or a local folder path).',
}

async function onSubmit(): Promise<void> {
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
  startPolling(result.id)
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
    // Terminal: stop polling; the timeline and result banner now render the outcome.
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

const isReady = computed(() => submission.value?.status === 'ready')
const isFailed = computed(
  () => submission.value !== null && submission.value.status !== 'pending' && !isReady.value,
)
</script>

<template>
  <UiCard>
    <form v-if="phase === 'form'" class="submit-form" @submit.prevent="onSubmit">
      <p class="submit-intro">
        Submit an agent for the open iteration. Paste a public repository URL; we verify it is
        reachable before accepting, then validate and build it in the background.
      </p>

      <UiField label="Repository URL" hint="A public git repository containing your agent and its manifest.">
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

      <div class="submit-reach">
        <UiButton type="button" variant="secondary" :loading="verifying" :disabled="!hasSource" @click="verify">
          Verify reachability
        </UiButton>
        <UiStatusBadge
          v-if="reachability !== null && verifiedKey === inputKey"
          :tone="reachability.reachable ? 'success' : 'danger'"
          :label="reachability.reachable ? 'reachable' : reachability.detail ?? 'not reachable'"
        />
      </div>

      <div class="submit-actions">
        <UiButton type="submit" :loading="submitting" :disabled="!canSubmit">Submit agent</UiButton>
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

.submit-intro {
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

.submit-reach {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.submit-actions {
  display: flex;
  gap: var(--space-2);
}

.submit-error {
  margin: 0;
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
  margin: 0;
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
