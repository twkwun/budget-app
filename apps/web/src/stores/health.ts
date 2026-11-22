import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { HealthResponse } from '@budget/shared';
import { getJson } from '../api/client.ts';

export type ConnectionState = 'idle' | 'checking' | 'online' | 'degraded' | 'offline';

export const useHealthStore = defineStore('health', () => {
  const state = ref<ConnectionState>('idle');
  const health = ref<HealthResponse | null>(null);
  const error = ref<string | null>(null);
  const checkedAt = ref<Date | null>(null);
  let inflight: Promise<void> | null = null;

  async function run(): Promise<void> {
    state.value = 'checking';
    try {
      const { body } = await getJson<HealthResponse>('/health');
      health.value = body;
      error.value = null;
      state.value = body.status === 'ok' && body.db.status === 'ok' ? 'online' : 'degraded';
    } catch (cause) {
      health.value = null;
      error.value = cause instanceof Error ? cause.message : String(cause);
      state.value = 'offline';
    } finally {
      checkedAt.value = new Date();
    }
  }

  /** Check the server; concurrent callers share one request. */
  function check(): Promise<void> {
    inflight ??= run().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  const isOnline = computed(() => state.value === 'online');

  return { state, health, error, checkedAt, isOnline, check };
});
