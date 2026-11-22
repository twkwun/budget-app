<script setup lang="ts">
import AppIcon from '../components/AppIcon.vue';
import { MORE_ITEMS } from '../nav.ts';
</script>

<template>
  <section class="page">
    <h1>더보기</h1>
    <ul class="card list">
      <li v-for="item in MORE_ITEMS" :key="item.name">
        <RouterLink :to="item.path" class="row">
          <AppIcon :name="item.icon" :size="20" />
          <span>{{ item.label }}</span>
          <AppIcon name="chevron" :size="18" class="chevron" />
        </RouterLink>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.list {
  list-style: none;
  margin: 0;
  padding: 4px 0;
}
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  color: inherit;
  text-decoration: none;
}
li + li .row {
  border-top: 1px solid var(--border);
}
.chevron {
  margin-left: auto;
  color: var(--text-muted);
}
</style>
