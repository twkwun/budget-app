<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { TAB_ITEMS, activeTabFor } from '../nav.ts';
import { useInboxStore } from '../stores/inbox.ts';
import AppIcon from './AppIcon.vue';

const route = useRoute();
const inbox = useInboxStore();
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
      <span class="glyph">
        <AppIcon :name="item.icon" :size="item.name === 'add' ? 26 : 24" />
        <span v-if="item.name === 'inbox' && inbox.count" class="count" data-testid="inbox-badge"
          >{{ inbox.count > 99 ? '99+' : inbox.count }}<span class="sr-only">건</span></span
        >
      </span>
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
  background: var(--surface);
  border-top: 1px solid var(--border);
  box-shadow: 0 -1px 6px rgb(0 0 0 / 6%);
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
.glyph {
  position: relative;
  display: grid;
  place-items: center;
}
.count {
  position: absolute;
  top: -4px;
  right: -12px;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--error);
  color: #fff;
  font-size: 0.68rem;
  font-weight: 700;
  line-height: 18px;
  text-align: center;
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
