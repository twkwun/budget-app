<script setup lang="ts">
import { ref } from 'vue';

/** Read-only value with a copy button, for values typed into the Shortcuts app. */
const props = defineProps<{ label: string; value: string; multiline?: boolean; testid?: string }>();
const copied = ref(false);

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    copied.value = false;
  }
}
</script>

<template>
  <div class="copy-field">
    <span class="label">{{ label }}</span>
    <div class="row">
      <pre v-if="multiline" class="value" :data-testid="testid">{{ value }}</pre>
      <code v-else class="value" :data-testid="testid">{{ value }}</code>
      <button type="button" class="btn btn-small" @click="copy">
        {{ copied ? '복사됨' : '복사' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.copy-field {
  display: grid;
  gap: 4px;
}
.label {
  font-size: 0.8rem;
  color: var(--text-muted);
  font-weight: 600;
}
.row {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}
.value {
  flex: 1;
  min-width: 0;
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--surface-hover);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.8rem;
  word-break: break-all;
  white-space: pre-wrap;
}
</style>
