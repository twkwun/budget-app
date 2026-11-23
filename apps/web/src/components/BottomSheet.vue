<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';

/** Modal sheet: slides up from the bottom on phones, centered dialog on wide screens. */
defineProps<{ title: string; testid?: string }>();
const emit = defineEmits<{ close: [] }>();

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close');
}
onMounted(() => {
  document.addEventListener('keydown', onKey);
  document.body.style.overflow = 'hidden';
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey);
  document.body.style.overflow = '';
});
</script>

<template>
  <div class="sheet-backdrop" @click.self="emit('close')">
    <div class="sheet" role="dialog" aria-modal="true" :aria-label="title" :data-testid="testid">
      <header class="sheet-head">
        <h2>{{ title }}</h2>
        <button type="button" class="close" aria-label="닫기" @click="emit('close')">✕</button>
      </header>
      <div class="sheet-body">
        <slot />
      </div>
      <footer v-if="$slots.footer" class="sheet-foot">
        <slot name="footer" />
      </footer>
    </div>
  </div>
</template>

<style scoped>
.sheet-backdrop {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  background: rgb(0 0 0 / 40%);
}
.sheet {
  width: 100%;
  max-height: 92dvh;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-radius: 18px 18px 0 0;
  padding-bottom: var(--safe-bottom);
}
.sheet-head {
  display: flex;
  align-items: center;
  padding: 14px 16px 6px;
}
.sheet-head h2 {
  margin: 0;
  flex: 1;
}
.close {
  border: 0;
  background: none;
  color: var(--text-muted);
  font-size: 1.1rem;
  width: 40px;
  height: 40px;
  cursor: pointer;
}
.sheet-body {
  overflow-y: auto;
  padding: 8px 16px 16px;
}
.sheet-foot {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
}
@media (min-width: 720px) {
  .sheet-backdrop {
    align-items: center;
  }
  .sheet {
    max-width: 520px;
    border-radius: 18px;
    padding-bottom: 0;
  }
}
</style>
