<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { currentYearMonth, parseYearMonth } from '@budget/shared';
import AppIcon from '../components/AppIcon.vue';
import { useHealthStore } from '../stores/health.ts';

const health = useHealthStore();
onMounted(() => void health.check());

const monthLabel = computed(() => {
  const { year, month } = parseYearMonth(currentYearMonth());
  return `${year}년 ${month}월`;
});

const statusText = computed(() => {
  switch (health.state) {
    case 'online':
      return '서버 연결됨';
    case 'degraded':
      return '서버는 응답하지만 데이터베이스에 문제가 있습니다';
    case 'offline':
      return '서버에 연결할 수 없습니다';
    default:
      return '서버 확인 중…';
  }
});

const checkedAtText = computed(() =>
  health.checkedAt
    ? health.checkedAt.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
    : '',
);
</script>

<template>
  <section class="page">
    <h1>{{ monthLabel }}</h1>

    <div class="summary">
      <div class="card">
        <h2>이번 달 지출</h2>
        <p class="amount tabular">—</p>
        <p class="muted small">3단계에서 집계합니다.</p>
      </div>
      <div class="card">
        <h2>이번 달 수입</h2>
        <p class="amount tabular">—</p>
        <p class="muted small">3단계에서 집계합니다.</p>
      </div>
    </div>

    <div
      class="card status"
      data-testid="health-status"
      :data-state="health.state"
      role="status"
      aria-live="polite"
    >
      <div class="status-head">
        <span class="dot" :class="health.state" aria-hidden="true" />
        <strong>{{ statusText }}</strong>
        <button
          type="button"
          class="retry"
          :disabled="health.state === 'checking'"
          @click="health.check()"
        >
          <AppIcon name="refresh" :size="16" />
          다시 확인
        </button>
      </div>
      <dl v-if="health.health" class="details">
        <dt>버전</dt>
        <dd class="tabular" data-testid="health-version">{{ health.health.version }}</dd>
        <dt>데이터베이스</dt>
        <dd>
          {{ health.health.db.status === 'ok' ? '정상' : '오류' }}
          <span v-if="health.health.db.journalMode" class="muted"
            >({{ health.health.db.journalMode.toUpperCase() }})</span
          >
        </dd>
        <dt>확인 시각</dt>
        <dd class="tabular">{{ checkedAtText }}</dd>
      </dl>
      <p v-else-if="health.state === 'offline'" class="muted small">
        Tailscale 연결과 NAS의 컨테이너 상태를 확인하세요.
      </p>
    </div>
  </section>
</template>

<style scoped>
.summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
  margin-bottom: 12px;
}
.amount {
  font-size: 1.6rem;
  font-weight: 700;
  margin: 0;
}
.small {
  font-size: 0.85rem;
  margin: 4px 0 0;
}
.status-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--text-muted);
  flex: none;
}
.dot.online {
  background: var(--ok);
}
.dot.degraded {
  background: var(--warn);
}
.dot.offline {
  background: var(--error);
}
.retry {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  font-size: 0.85rem;
  cursor: pointer;
  flex: none;
}
.retry:disabled {
  opacity: 0.5;
}
.details {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 16px;
  margin: 12px 0 0;
  font-size: 0.9rem;
}
.details dt {
  color: var(--text-muted);
}
.details dd {
  margin: 0;
}
</style>
