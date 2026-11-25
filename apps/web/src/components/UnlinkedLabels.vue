<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  ACCOUNT_KINDS,
  ACCOUNT_KIND_LABELS,
  type LabelLinkRequest,
  type LabelLinkResult,
  type UnlinkedLabelInfo,
} from '@budget/shared';
import { api } from '../api/client.ts';
import { errorMessage } from '../auth/messages.ts';
import { useLedgerStore } from '../stores/ledger.ts';

/**
 * 결제수단 names from imported files whose transactions have no card or
 * account yet. Linking creates the accounts (or uses existing ones), fills
 * those transactions, and remembers the name for the next import.
 */
const emit = defineEmits<{ linked: [result: LabelLinkResult] }>();
const ledger = useLedgerStore();
const labels = ref<UnlinkedLabelInfo[]>([]);
/** Per label: `new:<kind>`, `<account id>` or `skip`. */
const choice = ref<Record<string, string>>({});
const busy = ref(false);
const error = ref('');

const total = computed(() => labels.value.reduce((n, l) => n + l.rows, 0));
const chosen = computed(() => labels.value.filter((l) => choice.value[l.label] !== 'skip'));

async function load(): Promise<void> {
  try {
    labels.value = await api.get<UnlinkedLabelInfo[]>('/accounts/unlinked-labels');
    choice.value = Object.fromEntries(
      labels.value.map((l) => [
        l.label,
        l.suggestedAccountId ? String(l.suggestedAccountId) : `new:${l.suggestedKind}`,
      ]),
    );
  } catch (e) {
    error.value = errorMessage(e);
  }
}
onMounted(load);

async function link(): Promise<void> {
  const items: LabelLinkRequest['items'] = chosen.value.map((l) => {
    const c = choice.value[l.label] ?? 'skip';
    if (c.startsWith('new:')) {
      const kind = c.slice(4) as UnlinkedLabelInfo['suggestedKind'];
      const card = kind === 'card' || kind === 'bank';
      return {
        label: l.label,
        create: {
          kind,
          name: l.label.slice(0, 40),
          issuer: card ? l.suggestedIssuer : null,
          last4: card ? l.last4 : null,
        },
      };
    }
    return { label: l.label, accountId: Number(c) };
  });
  if (!items.length) return;
  busy.value = true;
  error.value = '';
  try {
    const result = await api.post<LabelLinkResult>('/accounts/link-labels', { items });
    await load();
    emit('linked', result);
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="labels.length" class="card linker" data-testid="unlinked-labels">
    <h2>가져온 파일의 결제수단 연결</h2>
    <p class="muted small">
      파일로 가져온 거래 {{ total.toLocaleString() }}건에 카드·계좌가 비어 있습니다. 이름을 보고
      종류를 고른 뒤 「연결」을 누르면 카드·계좌가 만들어지고 해당 거래에 한꺼번에 연결됩니다. 다음
      가져오기부터는 같은 이름이 자동으로 연결됩니다.
    </p>
    <ul class="row-list">
      <li v-for="l in labels" :key="l.label" class="label-row">
        <div class="row-main">
          <strong>{{ l.label }}</strong>
          <div class="row-sub">{{ l.rows.toLocaleString() }}건</div>
        </div>
        <select v-model="choice[l.label]" :data-testid="`link-${l.label}`">
          <optgroup label="새로 만들기">
            <option v-for="k in ACCOUNT_KINDS" :key="k" :value="`new:${k}`">
              새 {{ ACCOUNT_KIND_LABELS[k] }}
            </option>
          </optgroup>
          <optgroup v-if="ledger.activeAccounts.length" label="이미 등록된 카드·계좌">
            <option v-for="a in ledger.activeAccounts" :key="a.id" :value="String(a.id)">
              {{ a.name }} ({{ ACCOUNT_KIND_LABELS[a.kind] }})
            </option>
          </optgroup>
          <option value="skip">연결 안 함</option>
        </select>
      </li>
    </ul>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <div class="foot">
      <button
        type="button"
        class="btn btn-primary"
        :disabled="busy || !chosen.length"
        data-testid="link-labels"
        @click="link"
      >
        {{ chosen.length }}개 연결
      </button>
    </div>
  </div>
</template>

<style scoped>
.linker {
  margin-bottom: 16px;
}
.small {
  font-size: 0.85rem;
}
.label-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.label-row select {
  width: auto;
  max-width: 50%;
  flex: none;
}
.foot {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
}
</style>
