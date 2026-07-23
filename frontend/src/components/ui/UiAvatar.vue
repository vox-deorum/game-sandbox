<!-- A user's visual identity with a labelled image or initial fallback. -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    name: string
    image?: string | null
    size?: 'compact' | 'profile'
  }>(),
  { image: null, size: 'compact' },
)

const initial = computed(() => props.name.trim().charAt(0).toLocaleUpperCase() || '?')
const label = computed(() => `${props.name}'s avatar`)
const imageFailed = ref(false)
watch(
  () => props.image,
  () => {
    imageFailed.value = false
  },
)
</script>

<template>
  <img
    v-if="image && !imageFailed"
    class="ui-avatar"
    :class="size"
    :src="image"
    :alt="label"
    @error="imageFailed = true"
  />
  <span v-else class="ui-avatar fallback" :class="size" role="img" :aria-label="label">
    {{ initial }}
  </span>
</template>

<style scoped>
.ui-avatar {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
  background: var(--color-surface-raised);
  color: var(--color-text);
  font-weight: 700;
  object-fit: cover;
}

.ui-avatar.compact {
  width: var(--space-5);
  height: var(--space-5);
  font-size: var(--text-sm);
}

.ui-avatar.profile {
  width: var(--space-7);
  height: var(--space-7);
  font-size: var(--text-xl);
}
</style>
