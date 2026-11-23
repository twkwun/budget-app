<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  addDays,
  addMonths,
  currentYearMonth,
  daysInMonth,
  toLocalDate,
  type BackupStatus,
} from '@budget/shared';
import { api, type Download } from '../../api/client.ts';
import { errorMessage } from '../../auth/messages.ts';
import { useAuthStore } from '../../stores/auth.ts';

const auth = useAuthStore();

// ---- CSV export ----
const today = toLocalDate(Date.now());
const thisMonth = currentYearMonth();
const from = ref(`${today.slice(0, 4)}-01-01`);
const to = ref(today);
const exporting = ref(false);
const exportError = ref('');
const exportNotice = ref('');

const presets = [
  { label: '이번 달', from: `${thisMonth}-01`, to: today },
  {
    label: '지난달',
    from: `${addMonths(thisMonth, -1)}-01`,
    to: addDays(`${thisMonth}-01`, -1),
  },
  { label: '올해', from: `${today.slice(0, 4)}-01-01`, to: today },
  {
    label: '작년',
    from: `${Number(today.slice(0, 4)) - 1}-01-01`,
    to: `${Number(today.slice(0, 4)) - 1}-12-${daysInMonth(`${Number(today.slice(0, 4)) - 1}-12`)}`,
  },
];

async function exportCsv(): Promise<void> {
  exportError.value = '';
  exportNotice.value = '';
  if (!from.value || !to.value || from.value > to.value) {
    exportError.value = '시작일이 종료일보다 늦지 않게 골라 주세요.';
    return;
  }
  exporting.value = true;
  try {
    const file = await api.get<Download>(
      `/export/transactions.csv?from=${from.value}&to=${to.value}`,
      { download: true, timeoutMs: 60_000 },
    );
    const url = URL.createObjectURL(file.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    exportNotice.value = `${file.filename} 파일을 만들었습니다.`;
  } catch (e) {
    exportError.value = errorMessage(e);
  } finally {
    exporting.value = false;
  }
}

// ---- Backups (admins) ----
const status = ref<BackupStatus | null>(null);
const backupError = ref('');
const backupNotice = ref('');
const backingUp = ref(false);

async function loadStatus(): Promise<void> {
  try {
    status.value = await api.get<BackupStatus>('/admin/backup');
  } catch (e) {
    backupError.value = errorMessage(e);
  }
}

async function backupNow(): Promise<void> {
  backingUp.value = true;
  backupError.value = '';
  backupNotice.value = '';
  try {
    status.value = await api.post<BackupStatus>('/admin/backup', {}, { timeoutMs: 120_000 });
    backupNotice.value = '백업을 만들었습니다.';
  } catch (e) {
    backupError.value = errorMessage(e);
  } finally {
    backingUp.value = false;
  }
}

onMounted(() => {
  if (auth.isAdmin) void loadStatus();
});

const size = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)}MB`
    : `${Math.max(1, Math.round(bytes / 1024))}KB`;
const when = (iso: string) =>
  new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
</script>

<template>
  <section class="page backup-page" data-testid="backup-page">
    <h1>백업·내보내기</h1>

    <section class="card block" aria-labelledby="export-title">
      <h2 id="export-title">CSV로 내보내기</h2>
      <p class="muted small">
        엑셀이나 넘버스에서 바로 열 수 있는 파일입니다. 내가 볼 수 있는 거래만 담기고, 다른 가족의
        ‘나만 보기’ 거래는 빠집니다. 내보내기 전에 본인 확인을 한 번 더 합니다.
      </p>
      <div class="presets" role="group" aria-label="기간 빠르게 고르기">
        <button
          v-for="p in presets"
          :key="p.label"
          type="button"
          class="btn btn-small"
          :aria-pressed="from === p.from && to === p.to"
          @click="((from = p.from), (to = p.to))"
        >
          {{ p.label }}
        </button>
      </div>
      <div class="dates">
        <label class="field">
          <span>시작일</span>
          <input v-model="from" type="date" data-testid="export-from" />
        </label>
        <label class="field">
          <span>종료일</span>
          <input v-model="to" type="date" data-testid="export-to" />
        </label>
      </div>
      <p v-if="exportNotice" class="notice" role="status">{{ exportNotice }}</p>
      <p v-if="exportError" class="error-text" role="alert">{{ exportError }}</p>
      <button
        type="button"
        class="btn btn-primary"
        :disabled="exporting"
        data-testid="export-csv"
        @click="exportCsv"
      >
        {{ exporting ? '만드는 중…' : 'CSV 파일 받기' }}
      </button>
    </section>

    <section v-if="auth.isAdmin" class="card block" aria-labelledby="backup-title">
      <h2 id="backup-title">데이터베이스 백업</h2>
      <p v-if="backupNotice" class="notice" role="status">{{ backupNotice }}</p>
      <p v-if="backupError" class="error-text" role="alert">{{ backupError }}</p>
      <p v-if="!status && !backupError" class="muted">불러오는 중…</p>
      <dl v-if="status" class="facts" data-testid="backup-status">
        <div>
          <dt>마지막 백업</dt>
          <dd>
            <template v-if="status.last">
              {{ when(status.last.takenAt) }} · {{ size(status.last.bytes) }}
            </template>
            <template v-else>아직 없음</template>
          </dd>
        </div>
        <div>
          <dt>보관 중</dt>
          <dd>
            {{ status.count }}개 · 모두 {{ size(status.totalBytes) }} · {{ status.retentionDays }}일
            보관
          </dd>
        </div>
        <div>
          <dt>자동 백업</dt>
          <dd>
            <template v-if="status.enabled">
              매일 {{ status.time
              }}<template v-if="status.nextRunAt"> · 다음 {{ when(status.nextRunAt) }}</template>
            </template>
            <template v-else>꺼짐 (BACKUP_ENABLED=false)</template>
          </dd>
        </div>
      </dl>
      <button
        type="button"
        class="btn"
        :disabled="backingUp"
        data-testid="backup-now"
        @click="backupNow"
      >
        {{ backingUp ? '백업 중…' : '지금 백업' }}
      </button>
      <p class="muted small">
        백업 파일은 서버의 데이터 폴더 안 <code>backups/</code>에 쌓입니다. 시놀로지 Hyper
        Backup으로 이 폴더를 다른 곳에 한 번 더 복사해 두세요. 복원 방법은 README의 ‘백업과 복원’에
        있습니다.
      </p>
    </section>
  </section>
</template>

<style scoped>
.backup-page {
  display: grid;
  gap: 12px;
  max-width: 720px;
}
.block {
  display: grid;
  gap: 12px;
  justify-items: start;
}
.block > * {
  margin: 0;
}
.block .notice,
.block .dates,
.block .facts {
  justify-self: stretch;
}
.small {
  font-size: 0.85rem;
}
.presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.presets [aria-pressed='true'] {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}
.dates {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 10px;
}
.dates input {
  min-width: 0;
}
.facts {
  display: grid;
  gap: 8px;
}
.facts div {
  display: grid;
  grid-template-columns: 6.5em 1fr;
  gap: 8px;
}
.facts dt {
  color: var(--text-muted);
}
.facts dd {
  margin: 0;
}
</style>
