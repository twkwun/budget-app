<script setup lang="ts">
import { ICONS, type IconName } from '../icons.ts';

defineProps<{ name: IconName; size?: number }>();
</script>

<template>
  <svg
    class="icon"
    :width="size ?? 24"
    :height="size ?? 24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path :d="ICONS[name]" />
  </svg>
</template>
