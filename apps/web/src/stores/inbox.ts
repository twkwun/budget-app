import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '../api/client.ts';

/** 인박스 count for the navigation badge. Refreshed on navigation and after inbox actions. */
export const useInboxStore = defineStore('inbox', () => {
  const count = ref(0);
  let inflight: Promise<void> | null = null;

  function refresh(): Promise<void> {
    inflight ??= api
      .get<{ count: number }>('/inbox/count')
      .then((r) => {
        count.value = r.count;
      })
      .catch(() => {})
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  function set(value: number): void {
    count.value = value;
  }

  return { count, refresh, set };
});
