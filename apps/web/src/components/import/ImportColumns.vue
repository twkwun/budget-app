<script setup lang="ts">
import { reactive } from 'vue';
import {
  COLUMN_ROLES,
  COLUMN_ROLE_LABELS,
  type ColumnMap,
  type ColumnRole,
  type ImportPreview,
} from '@budget/shared';

/** Column-mapping step for files whose columns could not be recognised. */
const props = defineProps<{ preview: ImportPreview; busy: boolean }>();
const emit = defineEmits<{ save: [map: ColumnMap] }>();
const choice = reactive<Record<ColumnRole, number | ''>>(
  Object.fromEntries(COLUMN_ROLES.map((r) => [r, props.preview.columnMap[r] ?? ''])) as Record<
    ColumnRole,
    number | ''
  >,
);
const shown: ColumnRole[] = [
  'date',
  'time',
  'merchant',
  'amount',
  'withdrawal',
  'deposit',
  'type',
  'payment',
  'category',
  'approval',
  'installment',
  'cancel',
  'memo',
];

function save(): void {
  const map: ColumnMap = {};
  for (const r of COLUMN_ROLES) if (choice[r] !== '') map[r] = Number(choice[r]);
  emit('save', map);
}
const ready = () =>
  choice.date !== '' && (choice.amount !== '' || choice.withdrawal !== '' || choice.deposit !== '');
</script>

<template>
  <div class="stack" data-testid="import-columns">
    <p class="notice">
      열 이름을 알아보지 못했습니다. 각 항목이 어느 열인지 골라 주세요. 같은 형식의 파일은 다음부터
      자동으로 맞춥니다.
    </p>
    <div class="card sample-wrap">
      <table class="sample">
        <thead>
          <tr>
            <th v-for="(h, i) in preview.header" :key="i" scope="col">
              {{ i + 1 }}. {{ h || '(빈 칸)' }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(r, ri) in preview.sample" :key="ri">
            <td v-for="(c, ci) in preview.header" :key="ci">{{ r[ci] ?? '' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="card grid">
      <label v-for="role in shown" :key="role" class="field">
        <span>{{ COLUMN_ROLE_LABELS[role] }}</span>
        <select v-model="choice[role]" :data-testid="`column-${role}`">
          <option value="">없음</option>
          <option v-for="(h, i) in preview.header" :key="i" :value="i">
            {{ i + 1 }}. {{ h || '(빈 칸)' }}
          </option>
        </select>
      </label>
    </div>
    <button
      type="button"
      class="btn btn-primary"
      :disabled="busy || !ready()"
      data-testid="columns-save"
      @click="save"
    >
      이대로 읽기
    </button>
  </div>
</template>

<style scoped>
.sample-wrap {
  overflow-x: auto;
  padding: 0;
}
.sample {
  border-collapse: collapse;
  font-size: 0.8rem;
  white-space: nowrap;
}
.sample th,
.sample td {
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  text-align: left;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 8px;
}
</style>
