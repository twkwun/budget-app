<template>
  <div class="cover" aria-hidden="true" data-testid="privacy-cover">
    <img src="/favicon.svg" alt="" width="72" height="72" />
  </div>
</template>

<style scoped>
.cover {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  place-items: center;
  background: var(--bg);
}
</style>
