<script setup lang="ts">
import { useRoute } from 'vue-router';
import { NAV_ITEMS } from '../nav.ts';
import AppIcon from './AppIcon.vue';

const route = useRoute();
</script>

<template>
  <nav class="sidebar" aria-label="주 메뉴" data-testid="sidebar">
    <div class="brand">
      <img src="/favicon.svg" alt="" width="28" height="28" />
      <span>가계부</span>
    </div>
    <ul>
      <li v-for="item in NAV_ITEMS" :key="item.name">
        <RouterLink
          :to="item.path"
          class="link"
          :class="{ active: route.name === item.name }"
          :aria-current="route.name === item.name ? 'page' : undefined"
        >
          <AppIcon :name="item.icon" :size="20" />
          <span>{{ item.label }}</span>
        </RouterLink>
      </li>
    </ul>
  </nav>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: var(--sidebar-width);
  height: 100dvh;
  position: sticky;
  top: 0;
  padding: calc(16px + var(--safe-top)) 12px calc(16px + var(--safe-bottom))
    calc(12px + var(--safe-left));
  box-sizing: content-box;
  background: var(--surface);
  border-right: 1px solid var(--border);
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 12px 16px;
  font-size: 1.15rem;
  font-weight: 700;
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 2px;
}
.link {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 10px;
  color: var(--text-muted);
  text-decoration: none;
  font-weight: 500;
}
.link:hover {
  background: var(--surface-hover);
  color: var(--text);
}
.link.active {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 700;
}
</style>
