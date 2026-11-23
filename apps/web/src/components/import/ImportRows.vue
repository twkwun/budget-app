<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import {
  ROW_ERROR_LABELS,
  TRANSACTION_TYPE_LABELS,
  formatKrw,
  type ImportOutcome,
  type ImportRowInfo,
  type ImportRowsPage,
  type RowDecision,
} from '@budget/shared';
import { api } from '../../api/client.ts';
import { dayLabel } from '../../ledger/format.ts';

/** Rows of one preview group, with per-row decisions for 확인 필요 and transfer choices. */
const props = defineProps<{
  batchId: number;
  outcome: ImportOutcome | 'transfer';
  version: number;
  editable: boolean;
}>();
const emit = defineEmits<{ changed: [] }>();
const rows = ref<ImportRowInfo[]>([]);
const total = ref(0);
const loading = ref(false);

async function load(reset = true): Promise<void> {
  loading.value = true;
  try {
    const page = await api.get<ImportRowsPage>(
      `/imports/${props.batchId}/rows?outcome=${props.outcome}&offset=${reset ? 0 : rows.value.length}&limit=50`,
    );
    rows.value = reset ? page.rows : [...rows.value, ...page.rows];
    total.value = page.total;
  } finally {
    loading.value = false;
  }
}
onMounted(() => void load());
watch(
  () => [props.outcome, props.version],
  () => void load(),
);

async function decide(
  row: ImportRowInfo,
  change: { decision?: RowDecision | null; transfer?: boolean },
): Promise<void> {
  await api.put(`/imports/${props.batchId}/decisions`, { items: [{ id: row.id, ...change }] });
  if (change.decision !== undefined) row.decision = change.decision;
  if (change.transfer !== undefined) row.transfer = change.transfer;
  emit('changed');
}
const isAttach = (d: RowDecision | null, id: number) =>
  typeof d === 'object' && d !== null && d.attach === id;
</script>

<template>
  <ul class="rows" :data-testid="`import-rows-${outcome}`">
    <li v-for="r in rows" :key="r.id" class="row" data-testid="import-row">
      <div class="main">
        <div class="line">
          <strong>{{ r.merchant ?? '(내용 없음)' }}</strong>
          <span class="tabular amount" :class="{ refund: r.refund }"
            >{{ r.refund ? '+' : '' }}{{ formatKrw(r.amount) }}</span
          >
        </div>
        <div class="sub">
          {{ r.date ? dayLabel(r.date) : '' }} {{ r.time?.slice(0, 5) ?? '' }} ·
          {{ r.refund ? '환불·취소' : TRANSACTION_TYPE_LABELS[r.type] }}
          <template v-if="r.paymentLabel"> · {{ r.paymentLabel }}</template>
          <template v-if="r.sourceCategory"> · {{ r.sourceCategory }}</template>
          <template v-if="r.error">
            · <span class="warn">{{ ROW_ERROR_LABELS[r.error] ?? r.error }}</span></template
          >
        </div>
        <div v-if="r.match" class="match">
          ↔ {{ r.match.merchant ?? '(가맹점 없음)' }} {{ formatKrw(r.match.amount) }} ·
          {{ dayLabel(r.match.occurredDate) }}<template v-if="r.match.hasSms"> · 문자</template>
        </div>
        <label v-if="editable && r.suggestedTransfer" class="check">
          <input
            type="checkbox"
            :checked="r.transfer"
            @change="decide(r, { transfer: ($event.target as HTMLInputElement).checked })"
          />
          이체로 처리 (카드대금·내 계좌 이동)
        </label>
        <div v-if="editable && r.outcome === 'review'" class="decide">
          <p class="muted small">
            {{ r.cancel ? '어느 거래의 취소인가요?' : '이미 있는 거래와 같은 건가요?' }}
          </p>
          <button
            v-for="c in r.candidates"
            :key="c.id"
            type="button"
            class="btn btn-small"
            :class="{ chosen: isAttach(r.decision, c.id) }"
            @click="decide(r, { decision: { attach: c.id } })"
          >
            {{ r.cancel ? '이 거래 취소' : '같은 거래' }}: {{ c.merchant ?? '가맹점 없음' }}
            {{ formatKrw(c.amount) }} ({{ dayLabel(c.occurredDate) }})
          </button>
          <button
            v-if="!r.cancel"
            type="button"
            class="btn btn-small"
            :class="{ chosen: r.decision === 'create' }"
            @click="decide(r, { decision: 'create' })"
          >
            새로 등록
          </button>
          <button
            type="button"
            class="btn btn-small"
            :class="{ chosen: r.decision === 'skip' }"
            @click="decide(r, { decision: 'skip' })"
          >
            건너뛰기
          </button>
        </div>
        <button
          v-else-if="editable && r.outcome === 'new'"
          type="button"
          class="link-button small"
          @click="decide(r, { decision: r.decision === 'skip' ? null : 'skip' })"
        >
          {{ r.decision === 'skip' ? '건너뛰기 취소' : '이 행 건너뛰기' }}
        </button>
      </div>
    </li>
    <li v-if="!loading && rows.length === 0" class="muted">해당하는 행이 없습니다.</li>
  </ul>
  <button
    v-if="rows.length < total"
    type="button"
    class="btn btn-block"
    :disabled="loading"
    @click="load(false)"
  >
    더 보기 ({{ rows.length }} / {{ total }})
  </button>
</template>

<style scoped>
.rows {
  list-style: none;
  margin: 0;
  padding: 0;
}
.row {
  padding: 10px 0;
}
.row + .row {
  border-top: 1px solid var(--border);
}
.line {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.amount.refund {
  color: var(--accent);
}
.sub,
.match {
  font-size: 0.8rem;
  color: var(--text-muted);
}
.match {
  color: var(--accent);
}
.warn {
  color: var(--warn);
  font-weight: 600;
}
.decide {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
.decide p {
  width: 100%;
  margin: 0;
}
.chosen {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}
.small {
  font-size: 0.8rem;
}
.check {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 0.85rem;
  margin-top: 4px;
}
.check input {
  width: auto;
}
</style>
