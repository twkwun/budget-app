<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import {
  ACCOUNT_KINDS,
  ACCOUNT_KIND_LABELS,
  CUTOFF_MONTH_END,
  ISSUERS,
  defaultCutoffDay,
  issuerName,
  usagePeriodText,
  type AccountInfo,
  type AccountKind,
  type LabelLinkResult,
} from '@budget/shared';
import { api } from '../../api/client.ts';
import { errorMessage } from '../../auth/messages.ts';
import BottomSheet from '../../components/BottomSheet.vue';
import UnlinkedLabels from '../../components/UnlinkedLabels.vue';
import { useAuthStore } from '../../stores/auth.ts';
import { useLedgerStore } from '../../stores/ledger.ts';

const auth = useAuthStore();
const ledger = useLedgerStore();
const showArchived = ref(false);
const error = ref('');
const busy = ref(false);
const editing = ref<AccountInfo | 'new' | null>(null);
const linkedNotice = ref('');

const form = reactive({
  kind: 'card' as AccountKind,
  name: '',
  issuer: '' as string,
  last4: '',
  billingDay: '' as string | number,
  cutoffDay: '' as string | number,
  ownerUserId: 0,
  primaryUserId: '' as string | number,
});

const visible = computed(() => ledger.accounts.filter((a) => showArchived.value || !a.archived));
const archivedCount = computed(() => ledger.accounts.filter((a) => a.archived).length);

onMounted(() => void run(() => ledger.load(true)));

async function run(action: () => Promise<unknown>): Promise<boolean> {
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

function open(target: AccountInfo | 'new'): void {
  editing.value = target;
  const a = target === 'new' ? null : target;
  Object.assign(form, {
    kind: a?.kind ?? 'card',
    name: a?.name ?? '',
    issuer: a?.issuer ?? '',
    last4: a?.last4 ?? '',
    billingDay: a?.billingDay ?? '',
    cutoffDay: a?.cutoffDay ?? '',
    ownerUserId: a?.ownerUserId ?? auth.user?.id ?? 0,
    primaryUserId: a?.primaryUserId ?? '',
  });
}

/** A new payment day starts from the usual cutoff; it can be changed afterwards. */
function billingDayChanged(): void {
  form.cutoffDay = form.billingDay === '' ? '' : defaultCutoffDay(Number(form.billingDay));
}

const period = computed(() =>
  form.billingDay !== '' && form.cutoffDay !== ''
    ? usagePeriodText(Number(form.billingDay), Number(form.cutoffDay))
    : '',
);

const hasDigits = computed(() => form.kind === 'card' || form.kind === 'bank');

async function labelsLinked(result: LabelLinkResult): Promise<void> {
  await ledger.load(true);
  linkedNotice.value =
    `${result.created ? `카드·계좌 ${result.created}개를 만들고 ` : ''}거래 ${result.linked.toLocaleString()}건에 연결했습니다.` +
    ' 카드는 「수정」에서 결제일을 넣으면 내역에 결제월이 보입니다.';
}

async function save(): Promise<void> {
  const body = {
    kind: form.kind,
    name: form.name,
    issuer: (hasDigits.value && form.issuer) || null,
    last4: (hasDigits.value && form.last4) || null,
    billingDay: form.kind === 'card' && form.billingDay !== '' ? Number(form.billingDay) : null,
    cutoffDay:
      form.kind === 'card' && form.billingDay !== '' && form.cutoffDay !== ''
        ? Number(form.cutoffDay)
        : null,
    primaryUserId: form.primaryUserId === '' ? null : Number(form.primaryUserId),
    ...(auth.isAdmin ? { ownerUserId: form.ownerUserId } : {}),
  };
  const ok = await run(async () => {
    if (editing.value === 'new') await api.post('/accounts', body);
    else if (editing.value) await api.patch(`/accounts/${editing.value.id}`, body);
    await ledger.load(true);
  });
  if (ok) editing.value = null;
}

const setArchived = (a: AccountInfo, archived: boolean) =>
  run(async () => {
    await api.patch(`/accounts/${a.id}`, { archived });
    await ledger.load(true);
  });

const move = (a: AccountInfo, delta: number) =>
  run(async () => {
    const ids = ledger.accounts.map((x) => x.id);
    const i = ids.indexOf(a.id);
    const j = i + delta;
    if (j < 0 || j >= ids.length) return;
    ids.splice(j, 0, ...ids.splice(i, 1));
    ledger.setAccounts(await api.put<AccountInfo[]>('/accounts/order', { ids }));
  });
</script>

<template>
  <section class="page" data-testid="accounts-page">
    <h1>카드·계좌</h1>
    <p class="muted small">
      카드번호·계좌번호는 끝 4자리만 저장합니다. 카드는 명의자 외에 실제로 쓰는 사람을 지정할 수
      있습니다. 내가 명의자이거나 실제 사용자인 카드·계좌만 보입니다(관리자는 모두).
    </p>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <p v-if="linkedNotice" class="notice" role="status">{{ linkedNotice }}</p>

    <UnlinkedLabels @linked="labelsLinked" />

    <div class="card">
      <ul class="row-list" data-testid="account-list">
        <li v-for="a in visible" :key="a.id" :class="{ archived: a.archived }">
          <div class="row-main">
            <strong>{{ a.name }}</strong>
            <span class="badge">{{ ACCOUNT_KIND_LABELS[a.kind] }}</span>
            <span v-if="a.archived" class="badge">보관됨</span>
            <span
              v-if="a.kind === 'card' && !a.billingDay && !a.archived"
              class="badge"
              title="신용카드는 결제일을 넣으면 내역에서 결제월을 볼 수 있습니다 (체크카드는 비워 두세요)"
              >결제일 미입력</span
            >
            <div class="row-sub">
              {{
                [
                  issuerName(a.issuer),
                  a.last4 ? `····${a.last4}` : null,
                  a.billingDay
                    ? `결제일 ${a.billingDay}일` +
                      (a.cutoffDay ? ` (${usagePeriodText(a.billingDay, a.cutoffDay)} 사용분)` : '')
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ') || '—'
              }}
              · 명의 {{ a.ownerName
              }}<template v-if="a.primaryUserName"> · 사용 {{ a.primaryUserName }}</template>
            </div>
          </div>
          <div class="actions">
            <button
              type="button"
              class="btn btn-small"
              aria-label="위로"
              :disabled="busy"
              @click="move(a, -1)"
            >
              ↑
            </button>
            <button
              type="button"
              class="btn btn-small"
              aria-label="아래로"
              :disabled="busy"
              @click="move(a, 1)"
            >
              ↓
            </button>
            <template v-if="a.canEdit">
              <button type="button" class="btn btn-small" @click="open(a)">수정</button>
              <button
                type="button"
                class="btn btn-small"
                :disabled="busy"
                @click="setArchived(a, !a.archived)"
              >
                {{ a.archived ? '복원' : '보관' }}
              </button>
            </template>
          </div>
        </li>
        <li v-if="visible.length === 0" class="muted">등록된 카드·계좌가 없습니다.</li>
      </ul>
      <div class="foot">
        <button
          type="button"
          class="btn btn-primary"
          data-testid="add-account"
          @click="open('new')"
        >
          추가
        </button>
        <label v-if="archivedCount" class="check">
          <input v-model="showArchived" type="checkbox" /> 보관된 항목 보기 ({{ archivedCount }})
        </label>
      </div>
    </div>

    <BottomSheet
      v-if="editing"
      :title="editing === 'new' ? '카드·계좌 추가' : '카드·계좌 수정'"
      testid="account-sheet"
      @close="editing = null"
    >
      <form id="account-form" class="stack" @submit.prevent="save">
        <label class="field">
          <span>종류</span>
          <select v-model="form.kind">
            <option v-for="k in ACCOUNT_KINDS" :key="k" :value="k">
              {{ ACCOUNT_KIND_LABELS[k] }}
            </option>
          </select>
        </label>
        <label class="field">
          <span>이름</span>
          <input
            v-model="form.name"
            maxlength="40"
            required
            placeholder="예: 생활비 카드"
            data-testid="account-name"
          />
        </label>
        <template v-if="hasDigits">
          <label class="field">
            <span>{{ form.kind === 'card' ? '카드사' : '은행' }}</span>
            <select v-model="form.issuer">
              <option value="">선택 안 함</option>
              <option v-for="i in ISSUERS" :key="i.code" :value="i.code">{{ i.name }}</option>
            </select>
          </label>
          <label class="field">
            <span>끝 4자리</span>
            <input
              v-model="form.last4"
              inputmode="numeric"
              pattern="\d{4}"
              maxlength="4"
              placeholder="1234"
            />
          </label>
        </template>
        <template v-if="form.kind === 'card'">
          <label class="field">
            <span>결제일</span>
            <select v-model="form.billingDay" data-testid="billing-day" @change="billingDayChanged">
              <option value="">선택 안 함</option>
              <option v-for="d in 31" :key="d" :value="d">{{ d }}일</option>
            </select>
          </label>
          <label v-if="form.billingDay !== ''" class="field">
            <span>이용기간 마감일</span>
            <select v-model="form.cutoffDay" data-testid="cutoff-day">
              <option v-for="d in 30" :key="d" :value="d">{{ d }}일</option>
              <option :value="CUTOFF_MONTH_END">말일</option>
            </select>
            <small class="muted">
              {{ period }} 사용분이 {{ form.billingDay }}일에 결제됩니다. 카드사 앱의 「이용기간」과
              다르면 마감일을 고치세요.
            </small>
          </label>
        </template>
        <label v-if="auth.isAdmin" class="field">
          <span>명의자</span>
          <select v-model="form.ownerUserId">
            <option v-for="m in ledger.activeMembers" :key="m.id" :value="m.id">
              {{ m.displayName }}
            </option>
          </select>
        </label>
        <label class="field">
          <span>실제 사용자 (가족카드 등)</span>
          <select v-model="form.primaryUserId">
            <option value="">명의자와 같음</option>
            <option v-for="m in ledger.activeMembers" :key="m.id" :value="m.id">
              {{ m.displayName }}
            </option>
          </select>
        </label>
        <p v-if="error" class="error-text" role="alert">{{ error }}</p>
      </form>
      <template #footer>
        <button type="button" class="btn" @click="editing = null">취소</button>
        <button
          type="submit"
          form="account-form"
          class="btn btn-primary grow"
          :disabled="busy"
          data-testid="account-save"
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
.actions {
  display: flex;
  gap: 4px;
}
.archived {
  opacity: 0.6;
}
.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 8px;
}
.check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.85rem;
}
.check input {
  width: auto;
}
.grow {
  flex: 1;
}
</style>
