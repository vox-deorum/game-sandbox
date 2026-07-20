<!--
  The dev-only styleguide: token swatches and every components/ui/ primitive in every variant and
  state. This page is the working surface for design review (Stage 4.5 checkpoint two) and the
  permanent definition of done for a primitive: a variant that is not shown here does not exist.
  Registered in main.ts only in dev builds; production carries neither the route nor this code.
-->
<script setup lang="ts">
import { ref } from 'vue'

import UiBadge from '../components/ui/UiBadge.vue'
import UiButton from '../components/ui/UiButton.vue'
import UiCard from '../components/ui/UiCard.vue'
import UiDialog from '../components/ui/UiDialog.vue'
import UiEmptyState from '../components/ui/UiEmptyState.vue'
import UiField from '../components/ui/UiField.vue'
import UiInput from '../components/ui/UiInput.vue'
import UiMeter from '../components/ui/UiMeter.vue'
import UiSelect from '../components/ui/UiSelect.vue'
import UiSlider from '../components/ui/UiSlider.vue'
import UiStatusBadge from '../components/ui/UiStatusBadge.vue'
import UiTabs from '../components/ui/UiTabs.vue'

// The semantic color tokens, named so the swatch grid stays in sync with tokens.css by review.
const colorTokens = [
  'bg',
  'surface',
  'surface-raised',
  'border',
  'border-strong',
  'text',
  'text-muted',
  'accent',
  'on-accent',
  'danger',
  'success',
  'warning',
  'focus-ring',
  'stage-backdrop',
]

const spaceTokens = [1, 2, 3, 4, 5, 6, 7, 8]
const textTokens = ['xs', 'sm', 'md', 'lg', 'xl', '2xl']

const dialogOpen = ref(false)
const inputValue = ref('')
const invalidValue = ref('not a number')
const selectValue = ref('builtin')
const sliderValue = ref(120)
const tabsValue = ref('all')
const llmEnablement = ref('default')
const llmModelsMode = ref('all')
const llmTokenBudget = ref<number | ''>('')
</script>

<template>
  <div class="styleguide">
    <h1>Styleguide</h1>
    <p class="intro">
      Tokens and primitives, every variant and state. Dev-only; see docs/contributors/design.md.
    </p>

    <section>
      <h2>Color tokens</h2>
      <div class="swatch-grid">
        <div v-for="token in colorTokens" :key="token" class="swatch">
          <div class="swatch-chip" :style="{ background: `var(--color-${token})` }" />
          <code>--color-{{ token }}</code>
        </div>
      </div>
    </section>

    <section>
      <h2>Spacing</h2>
      <div v-for="step in spaceTokens" :key="step" class="space-row">
        <code>--space-{{ step }}</code>
        <div class="space-bar" :style="{ width: `var(--space-${step})` }" />
      </div>
    </section>

    <section>
      <h2>Type scale</h2>
      <p v-for="size in textTokens" :key="size" :style="{ fontSize: `var(--text-${size})` }">
        <code>--text-{{ size }}</code> The quick brown fox jumps over the lazy dog
      </p>
      <p :style="{ fontFamily: 'var(--font-heading)', fontSize: 'var(--text-xl)' }">
        Heading face (EB Garamond)
      </p>
      <p :style="{ fontFamily: 'var(--font-mono)' }">mono: seed 42417, tick 00312</p>
    </section>

    <section>
      <h2>UiButton</h2>
      <div class="row">
        <UiButton variant="primary">Primary</UiButton>
        <UiButton variant="secondary">Secondary</UiButton>
        <UiButton variant="ghost">Ghost</UiButton>
        <UiButton variant="danger">Danger</UiButton>
      </div>
      <div class="row">
        <UiButton size="lg">Large primary</UiButton>
        <UiButton variant="secondary" size="lg">Large secondary</UiButton>
        <UiButton size="tight">Tight primary</UiButton>
        <UiButton variant="secondary" size="tight">Tight secondary</UiButton>
      </div>
      <div class="row">
        <UiButton disabled>Disabled</UiButton>
        <UiButton loading>Loading</UiButton>
        <UiButton to="/">Link as button</UiButton>
        <UiButton href="/styleguide-example.txt" download="styleguide-example.txt">
          Native download link
        </UiButton>
      </div>
    </section>

    <section>
      <h2>UiBadge</h2>
      <div class="row">
        <UiBadge>neutral</UiBadge>
        <UiBadge variant="accent">accent</UiBadge>
        <UiBadge variant="warning">warning</UiBadge>
        <UiBadge variant="danger">danger</UiBadge>
      </div>
    </section>

    <section>
      <h2>UiStatusBadge</h2>
      <div class="row">
        <UiStatusBadge label="idle" />
        <UiStatusBadge tone="success" label="running" />
        <UiStatusBadge tone="danger" label="ended" />
        <UiStatusBadge tone="warning" label="reconnecting" />
      </div>
    </section>

    <section>
      <h2>UiCard</h2>
      <div class="row cards">
        <UiCard>A padded card surface.</UiCard>
        <UiCard :padded="false">
          <div class="card-demo-thumb" />
          <p class="card-demo-body">Unpadded card with edge-to-edge content.</p>
        </UiCard>
        <UiCard interactive>Interactive card (hover me).</UiCard>
      </div>
    </section>

    <section>
      <h2>UiField and UiInput</h2>
      <div class="fields">
        <UiField label="Seed" hint="Optional. Leave empty for a random seed.">
          <template #default="{ id, describedby, invalid }">
            <UiInput :id="id" v-model="inputValue" :aria-describedby="describedby" :invalid="invalid" />
          </template>
        </UiField>
        <UiField label="Timeout (ms)" error="Must be a positive number.">
          <template #default="{ id, describedby, invalid }">
            <UiInput :id="id" v-model="invalidValue" :aria-describedby="describedby" :invalid="invalid" />
          </template>
        </UiField>
      </div>
    </section>

    <section>
      <h2>UiSelect</h2>
      <div class="fields">
        <UiField label="Seat 1" hint="The agent assigned to this seat.">
          <template #default="{ id, describedby }">
            <UiSelect :id="id" v-model="selectValue" :aria-describedby="describedby">
              <option value="builtin">Naive agent</option>
              <option value="submission:sub1">Agent 1</option>
              <option value="submission:sub2">Agent 2</option>
            </UiSelect>
          </template>
        </UiField>
        <UiField label="Disabled">
          <template #default="{ id }">
            <UiSelect :id="id" v-model="selectValue" disabled>
              <option value="builtin">Naive agent</option>
            </UiSelect>
          </template>
        </UiField>
      </div>
    </section>

    <section>
      <h2>Season LLM controls</h2>
      <div class="fields">
        <UiField label="LLM enablement" hint="A season must explicitly enable access.">
          <template #default="{ id }">
            <UiSelect :id="id" v-model="llmEnablement">
              <option value="default">Not set (disabled)</option>
              <option value="on">Enabled</option>
              <option value="off">Explicitly disabled</option>
            </UiSelect>
          </template>
        </UiField>
        <UiField label="Allowed model aliases" hint="Inherit all aliases or choose a subset.">
          <template #default="{ id }">
            <UiSelect :id="id" v-model="llmModelsMode">
              <option value="all">All deployment aliases</option>
              <option value="custom">Custom selection</option>
            </UiSelect>
          </template>
        </UiField>
        <UiField label="Official token budget" hint="Optional; inherits the deployment default.">
          <template #default="{ id }">
            <UiInput
              :id="id"
              v-model.number="llmTokenBudget"
              type="number"
              min="1"
              placeholder="default"
            />
          </template>
        </UiField>
        <UiField label="Invalid development token budget" error="Must be a positive integer.">
          <template #default="{ id, describedby, invalid }">
            <UiInput
              :id="id"
              model-value="0"
              type="number"
              :aria-describedby="describedby"
              :invalid="invalid"
            />
          </template>
        </UiField>
      </div>
    </section>

    <section>
      <h2>UiTabs</h2>
      <UiTabs
        v-model="tabsValue"
        :tabs="[
          { key: 'all', label: 'All' },
          { key: 'pending', label: 'Pending' },
          { key: 'banned', label: 'Banned' },
        ]"
      />
      <p class="slider-readout">selected: {{ tabsValue }}</p>
    </section>

    <section>
      <h2>UiDialog</h2>
      <UiButton variant="secondary" @click="dialogOpen = true">Open dialog</UiButton>
      <UiDialog v-model:open="dialogOpen" title="Start session" description="A demo of the start form dialog.">
        <p>Dialog body content. Escape closes, focus is trapped.</p>
        <div class="row">
          <UiButton @click="dialogOpen = false">Confirm</UiButton>
          <UiButton variant="ghost" @click="dialogOpen = false">Cancel</UiButton>
        </div>
      </UiDialog>
    </section>

    <section>
      <h2>UiSlider</h2>
      <UiSlider v-model="sliderValue" label="Demo position" :max="300" />
      <p class="slider-readout">value: {{ sliderValue }} / 300</p>
      <UiSlider v-model="sliderValue" label="Disabled slider" :max="300" disabled />
    </section>

    <section>
      <h2>UiMeter</h2>
      <UiMeter
        :value="41600"
        :max="100000"
        label="Development budget used"
        text-value="41.6k of 100k budget units used"
      />
    </section>

    <section>
      <h2>UiEmptyState</h2>
      <UiEmptyState>Loading recent replays…</UiEmptyState>
      <UiEmptyState>No replays yet.</UiEmptyState>
      <UiEmptyState tone="danger">Could not load the session.</UiEmptyState>
    </section>
  </div>
</template>

<style scoped>
.styleguide section {
  margin: var(--space-6) 0;
  padding-top: var(--space-4);
  border-top: 1px solid var(--color-border);
}

.intro {
  color: var(--color-text-muted);
}

.row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  margin: var(--space-3) 0;
}

.swatch-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: var(--space-3);
}

.swatch {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-xs);
}

.swatch-chip {
  width: var(--space-6);
  height: var(--space-5);
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  flex: none;
}

.space-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin: var(--space-1) 0;
  font-size: var(--text-xs);
}

.space-row code {
  width: var(--space-8);
}

.space-bar {
  height: var(--space-2);
  background: var(--color-accent);
  border-radius: var(--radius-sm);
}

.cards > * {
  max-width: 16rem;
}

.card-demo-thumb {
  aspect-ratio: 16 / 9;
  background: var(--color-surface-raised);
}

.card-demo-body {
  margin: 0;
  padding: var(--space-3) var(--space-4);
}

.fields {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  max-width: 20rem;
}

.slider-readout {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
</style>
