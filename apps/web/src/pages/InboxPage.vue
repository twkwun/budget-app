<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import {
  PARSE_FAILURE_LABELS,
  formatKrw,
  isAggregatorMerchant,
  issuerName,
  suggestRulePattern,
  type InboxItem,
  type InboxList,
  type ParsedCardFields,
} from '@budget/shared';
import { api } from '../api/client.ts';
import { errorMessage } from '../auth/messages.ts';
import AmountInput from '../components/AmountInput.vue';
import CategorySelect from '../components/CategorySelect.vue';
import {
  dayLabel,
  fromLocalInput,
  signedAmount,
  timeLabel,
  toLocalInput,
} from '../ledger/format.ts';
import { useInboxStore } from '../stores/inbox.ts';
import { useLedgerStore } from '../stores/ledger.ts';

const ledger = useLedgerStore();
const inbox = useInboxStore();
const items = ref<InboxItem[]>([]);
const loading = ref(true);
const error = ref('');
const busyKey = ref<string | null>(null);
const notice = ref('');
/** "앞으로도 이렇게" per item key (default on for merchants that can be remembered). */
const remember = reactive<Record<string, boolean>>({});
const otherCategory = reactive<Record<string, number | null>>({});
const drafts = reactive<
  Record<string, { amount: number; when: string; merchant: string; accountId: number | null }>
>({});
const cardForms = reactive<Record<string, { name: string; last4: string } | undefined>>({});

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const [list] = await Promise.all([api.get<InboxList>('/inbox'), ledger.load()]);
    items.value = list.items;
    inbox.set(list.count);
    for (const item of list.items) {
      if (item.kind === 'uncategorized') {
        otherCategory[item.key] ??= null;
        remember[item.key] ??=
          !!item.transaction.merchant && !isAggregatorMerchant(item.transaction.merchant);
      }
      if (item.kind === 'unparsed' && !drafts[item.key]) {
        drafts[item.key] = {
          amount: item.parsed?.amount ?? 0,
          when: toLocalInput(item.parsed?.occurredAt ?? item.receivedAt),
          merchant: item.parsed?.merchant ?? '',
          accountId: null,
        };
      }
    }
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}

onMounted(() => void load());

async function act(key: string, action: () => Promise<unknown>, message = ''): Promise<void> {
  busyKey.value = key;
  error.value = '';
  try {
    await action();
    notice.value = message;
    items.value = items.value.filter((i) => i.key !== key);
    void load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busyKey.value = null;
  }
}

const label = (id: number) => ledger.categoryIndex.get(id)?.label ?? '';

function categorise(
  item: Extract<InboxItem, { kind: 'uncategorized' }>,
  categoryId: number | null,
): void {
  if (!categoryId) return;
  const t = item.transaction;
  const rule = remember[item.key] && t.merchant && !isAggregatorMerchant(t.merchant);
  void act(
    item.key,
    async () => {
      await api.patch(`/transactions/${t.id}`, { categoryId });
      if (rule && t.merchant) {
        await api.post('/rules', {
          pattern: suggestRulePattern(t.merchant),
          categoryId,
          applyToExisting: true,
        });
      }
    },
    rule ? `‘${t.merchant}’은 앞으로 ${label(categoryId)}(으)로 분류합니다.` : '',
  );
}

function enterUnparsed(item: Extract<InboxItem, { kind: 'unparsed' }>): void {
  const d = drafts[item.key];
  if (!d) return;
  void act(item.key, () =>
    api.post(`/inbox/raw/${item.rawRecordId}/transaction`, {
      amount: d.amount,
      occurredAt: fromLocalInput(d.when),
      merchant: d.merchant || null,
      accountId: d.accountId,
    }),
  );
}

const dismiss = (item: InboxItem & { rawRecordId: number }) =>
  act(item.key, () => api.post(`/inbox/raw/${item.rawRecordId}/dismiss`));

function openCardForm(item: Extract<InboxItem, { kind: 'unmatched_card' }>): void {
  const digits = item.digits && /^\d{4}$/.test(item.digits) ? item.digits : '';
  cardForms[item.key] = {
    name: `${issuerName(item.issuer) ?? ''}카드 ${digits}`.trim(),
    last4: digits,
  };
}

function registerCard(item: Extract<InboxItem, { kind: 'unmatched_card' }>): void {
  const form = cardForms[item.key];
  if (!form) return;
  void act(
    item.key,
    async () => {
      await api.post('/accounts', {
        kind: 'card',
        name: form.name,
        issuer: item.issuer,
        last4: form.last4,
      });
      await ledger.load(true);
    },
    '카드를 등록하고 이전 거래를 연결했습니다.',
  );
}

const describe = (p: ParsedCardFields) =>
  [
    p.merchant,
    p.amount != null
      ? formatKrw(p.amount)
      : p.foreignAmount
        ? `${p.currency} ${p.foreignAmount}`
        : null,
  ]
    .filter(Boolean)
    .join(' · ');

const empty = computed(() => !loading.value && items.value.length === 0);
</script>

<template>
  <section class="page inbox" data-testid="inbox-page">
    <h1>인박스</h1>
    <p class="muted intro">분류가 필요하거나 확인이 필요한 항목입니다. 한 번 누르면 처리됩니다.</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <p v-if="loading && items.length === 0" class="muted">불러오는 중…</p>
    <div v-if="empty" class="card empty" data-testid="inbox-empty">
      <strong>모두 처리했습니다</strong>
      <p class="muted">새 문자나 미분류 거래가 생기면 여기에 나타납니다.</p>
    </div>

    <TransitionGroup tag="div" name="list" class="items">
      <article
        v-for="item in items"
        :key="item.key"
        class="card item"
        :data-kind="item.kind"
        data-testid="inbox-item"
      >
        <!-- 미분류 -->
        <template v-if="item.kind === 'uncategorized'">
          <header class="item-head">
            <span class="badge">미분류</span>
            <span class="muted small"
              >{{ dayLabel(item.transaction.occurredDate) }}
              {{ timeLabel(item.transaction.occurredAt) }}</span
            >
            <span v-if="item.transaction.hasSms" class="badge">문자</span>
          </header>
          <div class="headline">
            <strong>{{ item.transaction.merchant || '가맹점 없음' }}</strong>
            <strong class="tabular">{{
              signedAmount(item.transaction.type, item.transaction.amount)
            }}</strong>
          </div>
          <p class="muted small">
            {{ item.transaction.accountName ?? '수단 없음' }} · {{ item.transaction.ownerName }}
          </p>
          <div class="chips">
            <button
              v-for="id in item.suggestions"
              :key="id"
              type="button"
              class="chip"
              :disabled="busyKey === item.key"
              data-testid="suggestion"
              @click="categorise(item, id)"
            >
              {{ label(id) }}
            </button>
          </div>
          <div class="row">
            <CategorySelect
              v-model="otherCategory[item.key]!"
              :kind="item.transaction.type === 'income' ? 'income' : 'expense'"
              class="grow"
              empty-label="다른 분류 고르기…"
              :testid="`inbox-category-${item.transaction.id}`"
            />
            <button
              type="button"
              class="btn btn-small"
              :disabled="!otherCategory[item.key] || busyKey === item.key"
              @click="categorise(item, otherCategory[item.key] ?? null)"
            >
              적용
            </button>
          </div>
          <label
            v-if="item.transaction.merchant && !isAggregatorMerchant(item.transaction.merchant)"
            class="check"
          >
            <input v-model="remember[item.key]" type="checkbox" data-testid="inbox-remember" />
            앞으로도 이렇게 (‘{{ suggestRulePattern(item.transaction.merchant) }}’ 자동 분류)
          </label>
          <p v-else-if="item.transaction.merchant" class="muted small">
            간편결제는 실제 가맹점을 알 수 없어 규칙을 만들지 않습니다.
          </p>
        </template>

        <!-- 해석 실패 -->
        <template v-else-if="item.kind === 'unparsed'">
          <header class="item-head">
            <span class="badge warn">해석 실패</span>
            <span class="muted small">{{ PARSE_FAILURE_LABELS[item.reason] ?? item.reason }}</span>
          </header>
          <pre class="raw" data-testid="raw-text">{{ item.rawText }}</pre>
          <div v-if="drafts[item.key]" class="form-grid">
            <label class="field"
              ><span>금액(원)</span><AmountInput v-model="drafts[item.key]!.amount"
            /></label>
            <label class="field"
              ><span>날짜·시간</span><input v-model="drafts[item.key]!.when" type="datetime-local"
            /></label>
            <label class="field"
              ><span>가맹점</span><input v-model="drafts[item.key]!.merchant" maxlength="100"
            /></label>
            <label class="field">
              <span>수단</span>
              <select v-model="drafts[item.key]!.accountId">
                <option :value="null">선택 안 함</option>
                <option v-for="a in ledger.activeAccounts" :key="a.id" :value="a.id">
                  {{ a.name }}
                </option>
              </select>
            </label>
          </div>
          <div class="actions">
            <button
              type="button"
              class="btn btn-primary"
              :disabled="busyKey === item.key || !drafts[item.key]?.amount"
              @click="enterUnparsed(item)"
            >
              거래로 등록
            </button>
            <button
              type="button"
              class="btn"
              :disabled="busyKey === item.key"
              @click="dismiss(item)"
            >
              무시
            </button>
          </div>
        </template>

        <!-- 등록되지 않은 카드 -->
        <template v-else-if="item.kind === 'unmatched_card'">
          <header class="item-head"><span class="badge warn">새 카드</span></header>
          <p>
            <strong
              >{{ issuerName(item.issuer) }} {{ item.digits ? `····${item.digits}` : '' }}</strong
            >
            카드가 등록되어 있지 않습니다.
            <span class="muted">{{ item.count }}건 · {{ formatKrw(item.total) }}</span>
          </p>
          <form v-if="cardForms[item.key]" class="form-grid" @submit.prevent="registerCard(item)">
            <label class="field"
              ><span>카드 이름</span
              ><input v-model="cardForms[item.key]!.name" required maxlength="40"
            /></label>
            <label class="field"
              ><span>끝 4자리</span
              ><input
                v-model="cardForms[item.key]!.last4"
                inputmode="numeric"
                pattern="\d{4}"
                maxlength="4"
                required
            /></label>
            <div class="actions span">
              <button type="submit" class="btn btn-primary" :disabled="busyKey === item.key">
                등록하고 연결
              </button>
              <button type="button" class="btn" @click="cardForms[item.key] = undefined">
                취소
              </button>
            </div>
          </form>
          <div v-else class="actions">
            <button
              type="button"
              class="btn btn-primary"
              data-testid="register-card"
              @click="openCardForm(item)"
            >
              이 카드 등록
            </button>
            <button
              type="button"
              class="btn"
              :disabled="busyKey === item.key"
              @click="
                act(item.key, () =>
                  api.post('/inbox/cards/dismiss', { issuer: item.issuer, digits: item.digits }),
                )
              "
            >
              등록 안 함
            </button>
          </div>
        </template>

        <!-- 원래 거래를 찾지 못한 취소 -->
        <template v-else-if="item.kind === 'unmatched_cancel'">
          <header class="item-head"><span class="badge warn">취소 문자</span></header>
          <p>
            <strong>{{ describe(item.parsed) }}</strong> 취소 — 원래 거래를 찾지 못했습니다. 어느
            거래를 취소할까요?
          </p>
          <ul class="candidates">
            <li v-for="c in item.candidates" :key="c.id">
              <span>{{ c.merchant ?? '가맹점 없음' }} · {{ dayLabel(c.occurredDate) }}</span>
              <span class="tabular">{{ formatKrw(c.amount) }}</span>
              <button
                type="button"
                class="btn btn-small"
                :disabled="busyKey === item.key"
                @click="
                  act(item.key, () =>
                    api.post(`/inbox/raw/${item.rawRecordId}/attach`, { transactionId: c.id }),
                  )
                "
              >
                이 거래 취소
              </button>
            </li>
            <li v-if="item.candidates.length === 0" class="muted">
              비슷한 금액의 거래가 없습니다.
            </li>
          </ul>
          <div class="actions">
            <button
              type="button"
              class="btn"
              :disabled="busyKey === item.key"
              @click="dismiss(item)"
            >
              무시
            </button>
          </div>
        </template>

        <!-- 중복 의심 -->
        <template v-else-if="item.kind === 'ambiguous_duplicate'">
          <header class="item-head"><span class="badge warn">중복 확인</span></header>
          <p>
            <strong>{{ describe(item.parsed) }}</strong> 문자가 왔습니다. 이미 입력한 거래와 같은
            건가요?
          </p>
          <ul class="candidates">
            <li v-for="c in item.candidates" :key="c.id">
              <span
                >{{ c.merchant ?? '가맹점 없음' }} · {{ dayLabel(c.occurredDate) }} ·
                {{ c.accountName ?? '수단 없음' }}</span
              >
              <span class="tabular">{{ formatKrw(c.amount) }}</span>
              <button
                type="button"
                class="btn btn-small"
                :disabled="busyKey === item.key"
                @click="
                  act(item.key, () =>
                    api.post(`/inbox/raw/${item.rawRecordId}/attach`, { transactionId: c.id }),
                  )
                "
              >
                같은 거래
              </button>
            </li>
          </ul>
          <div class="actions">
            <button
              type="button"
              class="btn btn-primary"
              :disabled="busyKey === item.key"
              @click="act(item.key, () => api.post(`/inbox/raw/${item.rawRecordId}/create`))"
            >
              다른 거래로 등록
            </button>
          </div>
        </template>
      </article>
    </TransitionGroup>
  </section>
</template>

<style scoped>
.inbox {
  max-width: 720px;
}
.intro {
  margin-top: -8px;
}
.items {
  display: grid;
  gap: 12px;
}
.item {
  display: grid;
  gap: 8px;
}
.item p {
  margin: 0;
}
.item-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.headline {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 1.05rem;
}
.small {
  font-size: 0.8rem;
}
.badge.warn {
  background: color-mix(in srgb, var(--warn) 18%, transparent);
  color: var(--warn);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chip {
  min-height: 40px;
  padding: 8px 12px;
  border: 1px solid var(--accent);
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
  cursor: pointer;
}
.row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.grow {
  flex: 1;
}
.check {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 0.85rem;
}
.check input {
  width: auto;
}
.raw {
  margin: 0;
  padding: 10px;
  border-radius: 8px;
  background: var(--surface-hover);
  font-size: 0.85rem;
  white-space: pre-wrap;
  word-break: break-all;
}
.form-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
}
@media (min-width: 560px) {
  .form-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
.span {
  grid-column: 1 / -1;
}
.actions {
  display: flex;
  gap: 8px;
}
.candidates {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
}
.candidates li {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: space-between;
  font-size: 0.9rem;
}
.empty {
  text-align: center;
}
.list-leave-active {
  transition:
    opacity 0.2s,
    transform 0.2s;
}
.list-leave-to {
  opacity: 0;
  transform: translateX(20px);
}
</style>
