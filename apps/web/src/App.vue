<script setup lang="ts">
import AppSidebar from './components/AppSidebar.vue';
import AppTabBar from './components/AppTabBar.vue';
</script>

<template>
  <div class="shell">
    <AppSidebar class="only-wide" />
    <main class="main">
      <RouterView />
    </main>
    <AppTabBar class="only-narrow" />
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  min-height: 100dvh;
}
.main {
  flex: 1;
  min-width: 0;
  padding: calc(16px + var(--safe-top)) calc(16px + var(--safe-right))
    calc(var(--tabbar-height) + var(--safe-bottom) + 24px) calc(16px + var(--safe-left));
}
@media (min-width: 720px) {
  .main {
    padding: calc(32px + var(--safe-top)) calc(40px + var(--safe-right))
      calc(32px + var(--safe-bottom)) 40px;
  }
}
</style>
