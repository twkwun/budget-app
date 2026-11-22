<script setup lang="ts">
defineProps<{ title: string; subtitle?: string }>();
</script>

<template>
  <div class="auth-layout">
    <div class="auth-card">
      <div class="auth-brand">
        <img src="/favicon.svg" alt="" width="48" height="48" />
        <h1>{{ title }}</h1>
        <p v-if="subtitle" class="muted">{{ subtitle }}</p>
      </div>
      <slot />
    </div>
  </div>
</template>

<style scoped>
.auth-layout {
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: calc(24px + var(--safe-top)) calc(16px + var(--safe-right))
    calc(24px + var(--safe-bottom)) calc(16px + var(--safe-left));
}
.auth-card {
  width: 100%;
  max-width: 400px;
}
.auth-brand {
  text-align: center;
  margin-bottom: 24px;
}
.auth-brand h1 {
  margin: 12px 0 4px;
}
.auth-brand p {
  margin: 0;
}
</style>
