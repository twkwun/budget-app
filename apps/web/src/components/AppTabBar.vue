<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { TAB_ITEMS, activeTabFor } from '../nav.ts';
import AppIcon from './AppIcon.vue';

const route = useRoute();
const active = computed(() => activeTabFor(route.name?.toString()));
</script>

<template>
  <nav class="tabbar" aria-label="주 메뉴" data-testid="tabbar">
    <RouterLink
      v-for="item in TAB_ITEMS"
      :key="item.name"
      :to="item.path"
      class="tab"
      :class="{ active: active === item.name, primary: item.name === 'add' }"
      :aria-current="active === item.name ? 'page' : undefined"
    >
      <span class="glyph"><AppIcon :name="item.icon" :size="item.name === 'add' ? 26 : 24" /></span>
      <span class="label">{{ item.label }}</span>
    </RouterLink>
  </nav>
</template>

<style scoped>
.tabbar {
  position: fixed;
  inset: auto 0 0 0;
  z-index: 10;
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  height: var(--tabbar-height);
  padding: 0 var(--safe-right) var(--safe-bottom) var(--safe-left);
  background: color-mix(in srgb, var(--surface) 92%, transparent);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-top: 1px solid var(--border);
}
.tab {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  color: var(--text-muted);
  text-decoration: none;
  font-size: 0.7rem;
  font-weight: 500;
  -webkit-tap-highlight-color: transparent;
}
.tab.active {
  color: var(--accent);
  font-weight: 700;
}
.tab.primary .glyph {
  display: grid;
  place-items: center;
  width: 40px;
  height: 30px;
  border-radius: 10px;
  background: var(--accent);
  color: var(--on-accent);
}
</style>
