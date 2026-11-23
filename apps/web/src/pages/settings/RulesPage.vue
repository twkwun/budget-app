<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import {
  RULE_MATCH_LABELS,
  RULE_MATCH_TYPES,
  type CategoryKind,
  type RuleInfo,
  type RuleList,
  type RuleMatchType,
} from '@budget/shared';
import { api } from '../../api/client.ts';
import { errorMessage } from '../../auth/messages.ts';
import BottomSheet from '../../components/BottomSheet.vue';
import CategorySelect from '../../components/CategorySelect.vue';
import { useLedgerStore } from '../../stores/ledger.ts';

const ledger = useLedgerStore();
const rules = ref<RuleList>({ user: [], system: [] });
const error = ref('');
const notice = ref('');
const busy = ref(false);
const editing = ref<RuleInfo | 'new' | null>(null);
const form = reactive({
  pattern: '',
  matchType: 'contains' as RuleMatchType,
  kind: 'expense' as CategoryKind,
  categoryId: null as number | null,
  applyToExisting: true,
});

const systemGroups = computed(() => {
  const groups = new Map<string, RuleInfo[]>();
  for (const r of rules.value.system)
    groups.set(r.categoryLabel, [...(groups.get(r.categoryLabel) ?? []), r]);
  return [...groups.entries()];
});

async function run(action: () => Promise<void>): Promise<boolean> {
  busy.value = true;
  error.value = '';
  try {
    await action();
    return true;
  } catch (e) {
    error.value = errorMessage(e);
    return false;
  } finally {
    busy.value = false;
  }
}

onMounted(
  () =>
    void run(async () => {
      [rules.value] = await Promise.all([api.get<RuleList>('/rules'), ledger.load()]);
    }),
);

function open(target: RuleInfo | 'new'): void {
  editing.value = target;
  const r = target === 'new' ? null : target;
  Object.assign(form, {
    pattern: r?.pattern ?? '',
    matchType: r?.matchType ?? 'contains',
    kind: r?.kind ?? 'expense',
    categoryId: r?.categoryId ?? null,
    applyToExisting: true,
  });
}

async function save(): Promise<void> {
  const ok = await run(async () => {
    notice.value = '';
    if (editing.value === 'new') {
      const res = await api.post<{ applied: number; rules: RuleList }>('/rules', {
        pattern: form.pattern,
        matchType: form.matchType,
        categoryId: form.categoryId,
        applyToExisting: form.applyToExisting,
      });
      rules.value = res.rules;
      if (res.applied) notice.value = `미분류 ${res.applied}건에 적용했습니다.`;
    } else if (editing.value) {
      rules.value = await api.patch<RuleList>(`/rules/${editing.value.id}`, {
        pattern: form.pattern,
        matchType: form.matchType,
        categoryId: form.categoryId,
      });
    }
  });
  if (ok) editing.value = null;
}

const remove = (r: RuleInfo) =>
  run(async () => {
    if (!window.confirm(`‘${r.pattern}’ 규칙을 삭제할까요?`)) return;
    await api.delete(`/rules/${r.id}`);
    rules.value = await api.get<RuleList>('/rules');
  });

const move = (r: RuleInfo, delta: number) =>
  run(async () => {
    const ids = rules.value.user.map((x) => x.id);
    const i = ids.indexOf(r.id);
    const j = i + delta;
    if (j < 0 || j >= ids.length) return;
    ids.splice(j, 0, ...ids.splice(i, 1));
    rules.value = await api.put<RuleList>('/rules/order', { ids });
  });

const apply = (r: RuleInfo) =>
  run(async () => {
    const res = await api.post<{ applied: number }>(`/rules/${r.id}/apply`);
    notice.value = res.applied
      ? `미분류 ${res.applied}건에 적용했습니다.`
      : '적용할 미분류 거래가 없습니다.';
  });

const toggle = (r: RuleInfo) =>
  run(async () => {
    rules.value = await api.patch<RuleList>(`/rules/${r.id}`, { disabled: !r.disabled });
  });
</script>

<template>
  <section class="page" data-testid="rules-page">
    <h1>분류 규칙</h1>
    <p class="muted small">
      새 거래는 ① 아래 가족 규칙(위에 있을수록 먼저) ② 같은 가맹점의 이전 분류 ③ 기본 키워드 순서로
      자동 분류됩니다. 가맹점 이름은 띄어쓰기·(주)·기호를 빼고 비교합니다. 네이버페이·카카오페이
      같은 간편결제는 실제 가맹점을 알 수 없어 미분류로 둡니다.
    </p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>

    <h2 class="section-title">가족 규칙</h2>
    <div class="card">
      <ul class="row-list" data-testid="rule-list">
        <li v-for="r in rules.user" :key="r.id">
          <div class="row-main">
            <strong>‘{{ r.pattern }}’</strong>
            <span class="badge">{{ RULE_MATCH_LABELS[r.matchType] }}</span>
            <div class="row-sub">→ {{ r.categoryLabel }}</div>
          </div>
          <button
            type="button"
            class="btn btn-small"
            aria-label="위로"
            :disabled="busy"
            @click="move(r, -1)"
          >
            ↑
          </button>
          <button
            type="button"
            class="btn btn-small"
            aria-label="아래로"
            :disabled="busy"
            @click="move(r, 1)"
          >
            ↓
          </button>
          <button type="button" class="btn btn-small" :disabled="busy" @click="apply(r)">
            미분류에 적용
          </button>
          <button type="button" class="btn btn-small" @click="open(r)">수정</button>
          <button
            type="button"
            class="btn btn-small btn-danger"
            :disabled="busy"
            @click="remove(r)"
          >
            삭제
          </button>
        </li>
        <li v-if="rules.user.length === 0" class="muted">
          아직 만든 규칙이 없습니다. 인박스나 거래 수정에서 ‘앞으로도 이렇게’를 고르면 생깁니다.
        </li>
      </ul>
      <button type="button" class="btn btn-primary" data-testid="add-rule" @click="open('new')">
        규칙 추가
      </button>
    </div>

    <h2 class="section-title">기본 키워드 ({{ rules.system.length }}개)</h2>
    <details class="card">
      <summary>펼쳐 보기 · 필요 없는 키워드는 끌 수 있습니다</summary>
      <section v-for="[label, list] in systemGroups" :key="label" class="kw-group">
        <h3>{{ label }}</h3>
        <div class="kw">
          <button
            v-for="r in list"
            :key="r.id"
            type="button"
            class="kw-chip"
            :class="{ off: r.disabled }"
            :aria-pressed="!r.disabled"
            :title="r.disabled ? '꺼짐 · 눌러서 켜기' : '켜짐 · 눌러서 끄기'"
            @click="toggle(r)"
          >
            {{ r.pattern }}<template v-if="r.matchType === 'exact'"> (일치)</template>
          </button>
        </div>
      </section>
    </details>

    <BottomSheet
      v-if="editing"
      :title="editing === 'new' ? '규칙 추가' : '규칙 수정'"
      testid="rule-sheet"
      @close="editing = null"
    >
      <form id="rule-form" class="stack" @submit.prevent="save">
        <label class="field">
          <span>가맹점 이름에</span>
          <input
            v-model="form.pattern"
            required
            maxlength="60"
            placeholder="예: 스타벅스"
            data-testid="rule-pattern"
          />
        </label>
        <label class="field">
          <span>조건</span>
          <select v-model="form.matchType">
            <option v-for="m in RULE_MATCH_TYPES" :key="m" :value="m">
              {{ RULE_MATCH_LABELS[m] }}
            </option>
          </select>
        </label>
        <label class="field">
          <span>지출/수입</span>
          <select v-model="form.kind" @change="form.categoryId = null">
            <option value="expense">지출</option>
            <option value="income">수입</option>
          </select>
        </label>
        <label class="field">
          <span>분류</span>
          <CategorySelect v-model="form.categoryId" :kind="form.kind" testid="rule-category" />
        </label>
        <label v-if="editing === 'new'" class="check">
          <input v-model="form.applyToExisting" type="checkbox" /> 지금 있는 미분류 거래에도 적용
        </label>
        <p v-if="error" class="error-text" role="alert">{{ error }}</p>
      </form>
      <template #footer>
        <button type="button" class="btn" @click="editing = null">취소</button>
        <button
          type="submit"
          form="rule-form"
          class="btn btn-primary grow"
          :disabled="busy || !form.categoryId"
        >
          저장
        </button>
      </template>
    </BottomSheet>
  </section>
</template>

<style scoped>
.small {
  font-size: 0.85rem;
}
.card > .btn {
  margin-top: 8px;
}
details summary {
  cursor: pointer;
  color: var(--accent);
  font-weight: 600;
}
.kw-group h3 {
  font-size: 0.85rem;
  margin: 14px 0 6px;
}
.kw {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.kw-chip {
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text);
  font-size: 0.8rem;
  cursor: pointer;
}
.kw-chip.off {
  text-decoration: line-through;
  color: var(--text-muted);
  opacity: 0.6;
}
.check {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 0.9rem;
}
.check input {
  width: auto;
}
.grow {
  flex: 1;
}
</style>
