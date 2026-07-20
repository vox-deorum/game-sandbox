<script setup lang="ts">
import { computed, ref } from 'vue'

import UiButton from './ui/UiButton.vue'

const props = defineProps<{ request: unknown; response: unknown }>()

const copied = ref<'request' | 'response' | null>(null)
const copyError = ref<'request' | 'response' | null>(null)
const requestText = computed(() => encode(props.request))
const responseText = computed(() => encode(props.response))

function encode(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2) ?? String(value)
}

async function copy(kind: 'request' | 'response', value: string): Promise<void> {
  copied.value = null
  copyError.value = null
  try {
    await navigator.clipboard.writeText(value)
    copied.value = kind
  } catch {
    copyError.value = kind
  }
}
</script>

<template>
  <div class="request-response">
    <section>
      <div class="heading-row">
        <h3>Request</h3>
        <UiButton variant="ghost" size="tight" @click="copy('request', requestText)">
          {{
            copied === 'request'
              ? 'Copied'
              : copyError === 'request'
                ? 'Copy failed'
                : 'Copy request'
          }}
        </UiButton>
      </div>
      <pre><code>{{ requestText }}</code></pre>
    </section>
    <section>
      <div class="heading-row">
        <h3>Response</h3>
        <UiButton variant="ghost" size="tight" @click="copy('response', responseText)">
          {{
            copied === 'response'
              ? 'Copied'
              : copyError === 'response'
                ? 'Copy failed'
                : 'Copy response'
          }}
        </UiButton>
      </div>
      <pre><code>{{ responseText }}</code></pre>
    </section>
  </div>
</template>

<style scoped>
.request-response,
.request-response section {
  display: grid;
  gap: var(--space-2);
}

.request-response {
  gap: var(--space-4);
}

.heading-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

h3 {
  margin: 0;
  font-size: var(--text-md);
}

pre {
  max-height: 18rem;
  margin: 0;
  overflow: auto;
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: var(--text-xs);
}
</style>
