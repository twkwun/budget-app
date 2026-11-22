<script setup lang="ts">
defineProps<{ title: string; description: string; stage: string }>();
</script>

<template>
  <section class="page">
    <h1>{{ title }}</h1>
    <div class="card placeholder">
      <p>{{ description }}</p>
      <p class="muted">{{ stage }}에서 만들 예정입니다.</p>
    </div>
  </section>
</template>

<style scoped>
.placeholder p {
  margin: 0 0 6px;
}
</style>
