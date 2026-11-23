<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  ACCOUNT_KIND_LABELS,
  IMPORT_GROUP_LABELS,
  type AccountInfo,
  type ColumnMap,
  type ImportBatchInfo,
  type ImportOutcome,
  type ImportPreview,
} from '@budget/shared';
import { ApiError, api } from '../api/client.ts';
import { formatDateTime } from '../auth/format.ts';
import { errorMessage } from '../auth/messages.ts';
import CategorySelect from '../components/CategorySelect.vue';
import ImportColumns from '../components/import/ImportColumns.vue';
import ImportRows from '../components/import/ImportRows.vue';
import { useInboxStore } from '../stores/inbox.ts';
import { useLedgerStore } from '../stores/ledger.ts';

const ledger = useLedgerStore();
const inbox = useInboxStore();
type View = 'start' | 'password' | 'columns' | 'preview' | 'result';
const view = ref<View>('start');
const file = ref<File | null>(null);
const password = ref('');
const preview = ref<ImportPreview | null>(null);
const history = ref<ImportBatchInfo[]>([]);
const result = ref<Record<string, number> | null>(null);
const busy = ref(false);
const error = ref('');
const dragging = ref(false);
const group = ref<ImportOutcome | 'transfer'>('new');
const version = ref(0);

const STATUS: Record<string, string> = {
  needs_mapping: '열 지정 필요',
  previewed: '미리보기',
  applying: '반영 중',
  applied: '반영됨',
  undone: '취소됨',
  failed: '실패',
};
const GROUPS: ImportOutcome[] = [
  'review',
  'new',
  'duplicate',
  'cancel',
  'cancel_duplicate',
  'already',
  'error',
];

const batch = computed(() => preview.value?.batch ?? null);
function currentId(): number {
  if (!batch.value) throw new Error('no import in progress');
  return batch.value.id;
}
const groupTabs = computed(() => {
  const counts = batch.value?.counts ?? {};
  const tabs: { key: ImportOutcome | 'transfer'; label: string; n: number }[] = GROUPS.filter(
    (g) => counts[g],
  ).map((g) => ({
    key: g,
    label: IMPORT_GROUP_LABELS[g],
    n: counts[g] ?? 0,
  }));
  if (batch.value?.transferSuggestions)
    tabs.splice(1, 0, { key: 'transfer', label: '이체 추정', n: batch.value.transferSuggestions });
  return tabs;
});
const toApply = computed(() => {
  const c = batch.value?.counts ?? {};
  return (
    (c.new ?? 0) +
    (c.duplicate ?? 0) +
    (c.review ?? 0) +
    (c.cancel ?? 0) +
    (c.cancel_duplicate ?? 0)
  );
});

async function loadHistory(): Promise<void> {
  history.value = await api.get<ImportBatchInfo[]>('/imports');
}
onMounted(
  () =>
    void Promise.all([loadHistory(), ledger.load()]).catch((e) => (error.value = errorMessage(e))),
);

async function run(action: () => Promise<void>): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    await action();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}

function show(p: ImportPreview): void {
  preview.value = p;
  view.value = p.batch.status === 'needs_mapping' ? 'columns' : 'preview';
  const first = groupTabs.value[0];
  group.value = first?.key ?? 'new';
  version.value += 1;
}

async function upload(withPassword: boolean): Promise<void> {
  if (!file.value) return;
  busy.value = true;
  error.value = '';
  try {
    const p = await api.post<ImportPreview>('/imports', undefined, {
      rawBody: file.value,
      timeoutMs: 120_000,
      headers: {
        'x-file-name': encodeURIComponent(file.value.name),
        ...(withPassword && password.value
          ? { 'x-file-password': encodeURIComponent(password.value) }
          : {}),
      },
    });
    password.value = '';
    show(p);
    void loadHistory();
  } catch (e) {
    if (
      e instanceof ApiError &&
      (e.code === 'password_required' || e.code === 'password_invalid')
    ) {
      view.value = 'password';
      if (e.code === 'password_invalid') error.value = errorMessage(e);
    } else {
      error.value = errorMessage(e);
    }
  } finally {
    busy.value = false;
  }
}

function pick(f: File | undefined | null): void {
  if (!f) return;
  file.value = f;
  void upload(false);
}

function onDrop(event: DragEvent): void {
  dragging.value = false;
  pick(event.dataTransfer?.files?.[0]);
}

const saveColumns = (map: ColumnMap) =>
  run(async () =>
    show(await api.put<ImportPreview>(`/imports/${currentId()}/columns`, { columnMap: map })),
  );

async function mapAccount(label: string, value: string): Promise<void> {
  await run(async () => {
    let accountId: number | null = null;
    if (value === 'new') {
      const kind = /현금/.test(label)
        ? 'cash'
        : /통장|계좌|은행|입출금/.test(label)
          ? 'bank'
          : 'card';
      const digits = /(\d{4})(?!.*\d{4})/.exec(label)?.[1] ?? null;
      const created = await api.post<AccountInfo>('/accounts', {
        kind,
        name: label.slice(0, 40) || '가져온 수단',
        last4: kind === 'cash' ? null : digits,
      });
      await ledger.load(true);
      accountId = created.id;
    } else if (value !== '') accountId = Number(value);
    show(
      await api.put<ImportPreview>(`/imports/${currentId()}/accounts`, {
        mappings: [{ label, accountId }],
      }),
    );
  });
}

const mapCategory = (key: string, categoryId: number | null) =>
  run(async () => {
    preview.value = await api.put<ImportPreview>(`/imports/${currentId()}/categories`, {
      mappings: [{ key, categoryId }],
    });
  });

const bulk = (body: object) =>
  run(async () => {
    const res = await api.put<{ batch: ImportBatchInfo }>(`/imports/${currentId()}/decisions`, {
      bulk: body,
    });
    if (preview.value) preview.value = { ...preview.value, batch: res.batch };
    version.value += 1;
  });

async function refreshBatch(): Promise<void> {
  if (batch.value) preview.value = await api.get<ImportPreview>(`/imports/${batch.value.id}`);
}

const apply = () =>
  run(async () => {
    const res = await api.post<{ result: Record<string, number> }>(
      `/imports/${currentId()}/apply`,
      {},
      { timeoutMs: 180_000 },
    );
    result.value = res.result;
    view.value = 'result';
    void loadHistory();
    void inbox.refresh();
  });

const discard = () =>
  run(async () => {
    if (batch.value) await api.delete(`/imports/${batch.value.id}`);
    reset();
    await loadHistory();
  });

function reset(): void {
  view.value = 'start';
  preview.value = null;
  file.value = null;
  result.value = null;
}

const undo = (b: ImportBatchInfo) =>
  run(async () => {
    if (
      !window.confirm(
        '이 가져오기로 추가된 거래를 지우고, 연결한 거래는 연결을 풉니다. 계속할까요?',
      )
    )
      return;
    try {
      await api.post(`/imports/${b.id}/undo`, {});
    } catch (e) {
      if (e instanceof ApiError && e.code === 'undo_conflict') {
        if (!window.confirm('가져온 뒤 직접 고친 거래가 있습니다. 그 거래도 함께 되돌릴까요?'))
          return;
        await api.post(`/imports/${b.id}/undo`, { confirm: true });
      } else throw e;
    }
    await loadHistory();
  });

const openBatch = (b: ImportBatchInfo) =>
  run(async () => show(await api.get<ImportPreview>(`/imports/${b.id}`)));
const accountLabel = (a: AccountInfo) =>
  `${a.name}${a.last4 ? ` ····${a.last4}` : ''} (${ACCOUNT_KIND_LABELS[a.kind]})`;
</script>

<template>
  <section class="page import" data-testid="import-page">
    <h1>가져오기</h1>
    <p v-if="error" class="error-text" role="alert" data-testid="import-error">{{ error }}</p>

    <!-- 1. Choose a file -->
    <template v-if="view === 'start'">
      <label
        class="drop card"
        :class="{ dragging }"
        data-testid="dropzone"
        @dragover.prevent="dragging = true"
        @dragleave="dragging = false"
        @drop.prevent="onDrop"
      >
        <input
          type="file"
          class="sr-only"
          accept=".xlsx,.xls,.csv,.txt,.htm,.html,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
          data-testid="file-input"
          @change="pick(($event.target as HTMLInputElement).files?.[0])"
        />
        <strong>{{ busy ? '읽는 중…' : '파일 선택' }}</strong>
        <span class="muted small"
          >뱅크샐러드 · 카드사 · 은행 엑셀(.xlsx, .xls) 또는 CSV, 최대 10MB · 2만 행</span
        >
        <span class="muted small only-wide">여기로 끌어다 놓아도 됩니다</span>
      </label>
      <details class="card help" open>
        <summary>파일 받는 방법</summary>
        <h3>뱅크샐러드</h3>
        <ol>
          <li>
            뱅크샐러드 앱 → <strong>가계부</strong> → <strong>설정</strong> →
            <strong>파일로 받기</strong>를 고릅니다. 한 번에 최근 1년까지 받을 수 있습니다.
          </li>
          <li>
            메일로 온 엑셀 파일은 비밀번호가 걸려 있습니다. 여기서 파일을 고르면 비밀번호를
            물어봅니다. 비밀번호는 저장하지 않습니다.
          </li>
        </ol>
        <h3>카드사·은행</h3>
        <ol>
          <li>
            카드사 홈페이지(PC 화면)에서 <strong>이용내역 조회</strong> → 기간 선택 →
            <strong>엑셀 다운로드</strong>. 은행은 <strong>거래내역 조회</strong>에서 받습니다.
          </li>
          <li>
            처음 보는 형식이면 어느 열이 날짜·금액인지 한 번만 골라 주면 다음부터는 자동입니다.
          </li>
        </ol>
        <h3>아이폰·아이패드</h3>
        <p class="muted small">
          메일 첨부 파일은 길게 눌러 <strong>파일에 저장</strong>한 뒤, 위의
          <strong>파일 선택</strong>에서 ‘파일’ 앱으로 고르세요. 같은 기간을 여러 번 올려도 이미
          가져온 거래는 다시 들어가지 않습니다.
        </p>
      </details>
    </template>

    <!-- 2. Password -->
    <form
      v-else-if="view === 'password'"
      class="card stack"
      data-testid="import-password"
      @submit.prevent="upload(true)"
    >
      <p>
        <strong>{{ file?.name }}</strong>은(는) 비밀번호가 걸린 파일입니다.
      </p>
      <label class="field">
        <span>파일 비밀번호</span>
        <input
          v-model="password"
          type="password"
          autocomplete="off"
          required
          data-testid="import-password-input"
        />
      </label>
      <p class="muted small">비밀번호는 파일을 여는 데만 쓰고 저장하지 않습니다.</p>
      <div class="actions">
        <button
          type="submit"
          class="btn btn-primary"
          :disabled="busy || !password"
          data-testid="import-password-submit"
        >
          {{ busy ? '여는 중…' : '열기' }}
        </button>
        <button type="button" class="btn" @click="reset">취소</button>
      </div>
    </form>

    <!-- 3. Columns -->
    <template v-else-if="view === 'columns' && preview">
      <ImportColumns :preview="preview" :busy="busy" @save="saveColumns" />
      <button type="button" class="btn" @click="discard">취소</button>
    </template>

    <!-- 4. Preview -->
    <template v-else-if="view === 'preview' && preview && batch">
      <div class="card summary" data-testid="import-summary">
        <div class="file">
          <strong>{{ batch.fileName ?? '파일' }}</strong>
          <span class="muted small"
            >{{ batch.format === 'banksalad' ? '뱅크샐러드' : '일반 표' }} ·
            {{ batch.rowCount.toLocaleString('ko-KR') }}행</span
          >
        </div>
        <div class="chips">
          <span
            v-for="t in groupTabs"
            :key="t.key"
            class="badge"
            :class="{ 'badge-accent': t.key === 'new', warn: t.key === 'review' }"
            :data-testid="`count-${t.key}`"
            >{{ t.label }} {{ t.n.toLocaleString('ko-KR') }}</span
          >
        </div>
      </div>

      <section
        v-if="preview.accounts.length && batch.status === 'previewed'"
        class="card stack"
        data-testid="account-mappings"
      >
        <h2>결제수단 연결</h2>
        <p class="muted small">
          파일의 결제수단을 가계부의 카드·계좌와 연결합니다. 한 번 정하면 다음 가져오기에도 그대로
          씁니다.
        </p>
        <div v-for="m in preview.accounts" :key="m.label" class="map-row">
          <div class="map-label">
            <strong>{{ m.label || '(파일 전체)' }}</strong>
            <span class="muted small">{{ m.rows }}건</span>
            <span v-if="!m.saved && m.accountId" class="badge badge-accent">추천</span>
          </div>
          <select
            :value="m.accountId ?? ''"
            :data-testid="`account-map-${m.label || 'file'}`"
            @change="mapAccount(m.label, ($event.target as HTMLSelectElement).value)"
          >
            <option value="">수단 없음</option>
            <option v-for="a in ledger.activeAccounts" :key="a.id" :value="a.id">
              {{ accountLabel(a) }}
            </option>
            <option value="new">
              ＋ ‘{{ (m.label || '가져온 수단').slice(0, 20) }}’ 새로 만들기
            </option>
          </select>
        </div>
      </section>

      <details
        v-if="preview.categories.length && batch.status === 'previewed'"
        class="card"
        data-testid="category-mappings"
      >
        <summary>파일의 분류 연결 ({{ preview.categories.length }})</summary>
        <div v-for="c in preview.categories" :key="c.key" class="map-row">
          <div class="map-label">
            <span>{{ c.kind === 'income' ? '수입' : '지출' }} · {{ c.label }}</span
            ><span class="muted small">{{ c.rows }}건</span>
          </div>
          <CategorySelect
            :model-value="c.categoryId"
            :kind="c.kind"
            empty-label="미분류 (자동 분류)"
            @update:model-value="(v) => mapCategory(c.key, v)"
          />
        </div>
      </details>

      <div v-if="batch.transferSuggestions" class="card notice-row">
        <span>이체로 보이는 거래 {{ batch.transferSuggestions }}건 (카드대금·내 계좌 이동)</span>
        <div class="actions">
          <button
            type="button"
            class="btn btn-small"
            @click="bulk({ outcome: 'transfer', transfer: true })"
          >
            모두 이체로
          </button>
          <button
            type="button"
            class="btn btn-small"
            @click="bulk({ outcome: 'transfer', transfer: false })"
          >
            모두 지출·수입으로
          </button>
        </div>
      </div>

      <section class="card">
        <div class="tabs" role="tablist">
          <button
            v-for="t in groupTabs"
            :key="t.key"
            type="button"
            role="tab"
            :aria-selected="group === t.key"
            :class="{ on: group === t.key }"
            :data-testid="`tab-${t.key}`"
            @click="group = t.key"
          >
            {{ t.label }} <span class="tabular">{{ t.n.toLocaleString('ko-KR') }}</span>
          </button>
        </div>
        <p v-if="group === 'review'" class="muted small">
          이미 있는 거래와 같은지 확실하지 않은 행입니다. 하나씩 고르거나 한꺼번에 정하세요. 남은
          항목 {{ batch.undecided }}건.
        </p>
        <div v-if="group === 'review' && batch.status === 'previewed'" class="actions bulk">
          <button
            type="button"
            class="btn btn-small"
            data-testid="bulk-create"
            @click="bulk({ outcome: 'review', decision: 'create' })"
          >
            모두 새로 등록
          </button>
          <button
            type="button"
            class="btn btn-small"
            data-testid="bulk-skip"
            @click="bulk({ outcome: 'review', decision: 'skip' })"
          >
            모두 건너뛰기
          </button>
        </div>
        <p v-if="group === 'duplicate'" class="muted small">
          이미 문자나 직접 입력으로 들어온 거래입니다. 새로 만들지 않고 연결해 ‘확인됨’으로
          표시합니다. 비어 있던 분류·가맹점·수단만 채우고 금액은 바꾸지 않습니다.
        </p>
        <p v-if="group === 'already'" class="muted small">
          전에 가져온 행입니다. 그 뒤 고치거나 지운 거래도 다시 들어가지 않습니다.
        </p>
        <ImportRows
          v-if="batch.status === 'previewed' || batch.status === 'applied'"
          :batch-id="batch.id"
          :outcome="group"
          :version="version"
          :editable="batch.status === 'previewed'"
          @changed="refreshBatch"
        />
      </section>

      <div v-if="batch.status === 'previewed'" class="apply-bar">
        <button
          type="button"
          class="btn btn-primary grow"
          :disabled="busy || batch.undecided > 0 || toApply === 0"
          data-testid="import-apply"
          @click="apply"
        >
          {{
            busy
              ? '반영 중…'
              : batch.undecided > 0
                ? `확인 필요 ${batch.undecided}건을 먼저 정하세요`
                : `${toApply.toLocaleString('ko-KR')}건 반영`
          }}
        </button>
        <button type="button" class="btn" :disabled="busy" @click="discard">취소</button>
      </div>
      <p v-if="batch.status === 'previewed' && batch.expiresAt" class="muted small center">
        반영하지 않은 미리보기는 {{ formatDateTime(batch.expiresAt) }}에 지워집니다.
      </p>
    </template>

    <!-- 5. Result -->
    <div v-else-if="view === 'result' && result" class="card stack" data-testid="import-result">
      <h2>가져오기를 마쳤습니다</h2>
      <dl class="result">
        <dt>새로 추가</dt>
        <dd class="tabular" data-testid="result-created">{{ result.created ?? 0 }}건</dd>
        <dt>기존 거래와 연결</dt>
        <dd class="tabular" data-testid="result-attached">{{ result.attached ?? 0 }}건</dd>
        <dt>취소 반영</dt>
        <dd class="tabular">{{ result.cancelled ?? 0 }}건</dd>
        <dt>이미 가져옴</dt>
        <dd class="tabular" data-testid="result-already">{{ result.already ?? 0 }}건</dd>
        <dt>건너뜀·읽지 못함</dt>
        <dd class="tabular">{{ (result.skipped ?? 0) + (result.errors ?? 0) }}건</dd>
      </dl>
      <div class="actions">
        <RouterLink to="/transactions" class="btn btn-primary">내역 보기</RouterLink>
        <button type="button" class="btn" @click="reset">다른 파일 가져오기</button>
      </div>
    </div>

    <h2 class="section-title">가져오기 기록</h2>
    <div class="card">
      <ul class="row-list" data-testid="import-history">
        <li v-for="b in history" :key="b.id">
          <div class="row-main">
            <strong>{{ b.fileName ?? '파일' }}</strong>
            <span class="badge" :class="{ 'badge-accent': b.status === 'applied' }">{{
              STATUS[b.status] ?? b.status
            }}</span>
            <div class="row-sub">
              {{ formatDateTime(b.appliedAt ?? b.createdAt) }} · {{ b.rowCount }}행
              <template v-if="b.result">
                · 추가 {{ b.result.created ?? 0 }} · 연결 {{ b.result.attached ?? 0 }} · 이미
                {{ b.result.already ?? 0 }}</template
              >
            </div>
          </div>
          <button
            v-if="b.status === 'previewed' || b.status === 'needs_mapping'"
            type="button"
            class="btn btn-small"
            @click="openBatch(b)"
          >
            이어서
          </button>
          <button
            v-if="b.status === 'applied'"
            type="button"
            class="btn btn-small btn-danger"
            :disabled="busy"
            data-testid="import-undo"
            @click="undo(b)"
          >
            가져오기 취소
          </button>
        </li>
        <li v-if="history.length === 0" class="muted">아직 가져온 파일이 없습니다.</li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.import {
  max-width: 820px;
}
.drop {
  display: grid;
  justify-items: center;
  gap: 6px;
  padding: 32px 16px;
  border: 2px dashed var(--border);
  text-align: center;
  cursor: pointer;
}
.drop.dragging {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.help {
  margin-top: 12px;
}
.help summary {
  cursor: pointer;
  font-weight: 600;
}
.help h3 {
  font-size: 0.95rem;
  margin: 12px 0 4px;
}
.help ol {
  margin: 0;
  padding-left: 1.2em;
  font-size: 0.9rem;
  display: grid;
  gap: 4px;
}
.small {
  font-size: 0.82rem;
}
.summary,
.map-row,
.notice-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
}
.summary {
  margin-bottom: 12px;
}
.file {
  display: grid;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.badge.warn {
  background: color-mix(in srgb, var(--warn) 18%, transparent);
  color: var(--warn);
}
section.card,
details.card,
.notice-row {
  margin-bottom: 12px;
}
.map-row {
  padding: 8px 0;
  border-top: 1px solid var(--border);
}
.map-row select,
.map-row :deep(select) {
  flex: 1 1 200px;
  max-width: 360px;
}
.map-label {
  display: flex;
  gap: 6px;
  align-items: center;
  flex: 1 1 160px;
}
h2 {
  margin: 0;
}
.tabs {
  display: flex;
  gap: 4px;
  overflow-x: auto;
  margin-bottom: 8px;
}
.tabs button {
  flex: none;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text-muted);
  font-weight: 600;
  cursor: pointer;
}
.tabs .on {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}
.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.bulk {
  margin-bottom: 8px;
}
.apply-bar {
  display: flex;
  gap: 8px;
  position: sticky;
  bottom: calc(var(--tabbar-height) + var(--safe-bottom) + 8px);
}
@media (min-width: 720px) {
  .apply-bar {
    bottom: 16px;
  }
}
.grow {
  flex: 1;
}
.center {
  text-align: center;
}
.result {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 16px;
  margin: 0;
}
.result dd {
  margin: 0;
  font-weight: 700;
}
</style>
