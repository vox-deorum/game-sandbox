<!--
  The shared footer for confirmation dialogs. It keeps primary or destructive actions together with
  their cancellation control while allowing each dialog to retain its own wording and state.
-->
<template>
  <div class="ui-dialog-actions">
    <slot />
  </div>
</template>

<style scoped>
.ui-dialog-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-4);
}
</style>
