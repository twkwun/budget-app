<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  PARSE_FAILURE_LABELS,
  formatKrw,
  issuerName,
  type CreatedWebhookToken,
  type SmsPreview,
  type WebhookTokenInfo,
} from '@budget/shared';
import { api } from '../../api/client.ts';
import { formatDateTime } from '../../auth/format.ts';
import { errorMessage } from '../../auth/messages.ts';
import { guessDeviceName } from '../../auth/passkey.ts';
import CopyField from '../../components/CopyField.vue';
import { useLedgerStore } from '../../stores/ledger.ts';

const ledger = useLedgerStore();
const tokens = ref<WebhookTokenInfo[]>([]);
const created = ref<CreatedWebhookToken | null>(null);
const deviceName = ref(`${guessDeviceName()} 문자 전달`);
const busy = ref(false);
const error = ref('');
const pasted = ref('');
const preview = ref<SmsPreview | null>(null);

const url = computed(() => created.value?.url ?? `${window.location.origin}/api/webhook/sms`);
const bodyTemplate = `{
  "text": [단축어 입력의 '내용'],
  "sender": [단축어 입력의 '발신자'],
  "receivedAt": [포맷된 날짜]
}`;
const curlExample = computed(
  () =>
    `curl -X POST ${url.value} \\\n  -H "Authorization: Bearer ${created.value?.token ?? '<토큰>'}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"text":"신한카드(0000)승인 테스트 1,000원 11/22 12:00 테스트가게"}'`,
);

async function load(): Promise<void> {
  tokens.value = await api.get<WebhookTokenInfo[]>('/me/webhook-tokens');
}

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

onMounted(() => void run(async () => Promise.all([load(), ledger.load()]).then(() => undefined)));

const create = () =>
  run(async () => {
    created.value = await api.post<CreatedWebhookToken>('/me/webhook-tokens', {
      deviceName: deviceName.value,
    });
    await load();
  });

const revoke = (t: WebhookTokenInfo) =>
  run(async () => {
    if (
      !window.confirm(
        `'${t.deviceName}' 토큰을 폐기할까요? 그 기기의 단축어는 더 이상 동작하지 않습니다.`,
      )
    )
      return;
    await api.delete(`/me/webhook-tokens/${t.id}`);
    if (created.value?.info.id === t.id) created.value = null;
    await load();
  });

const test = () =>
  run(async () => {
    preview.value = await api.post<SmsPreview>('/sms/test', { text: pasted.value });
  });

const categoryLabel = (id: number | null) =>
  id ? (ledger.categoryIndex.get(id)?.label ?? '') : '미분류';
const REASONS: Record<string, string> = {
  rule: '규칙',
  history: '같은 가맹점의 이전 분류',
  keyword: '기본 키워드',
};
</script>

<template>
  <section class="page sms" data-testid="sms-page">
    <h1>문자 전달</h1>
    <p class="muted small">
      아이폰 단축어가 카드 결제 문자를 이 가계부로 보내면 자동으로 등록됩니다. 인증번호나 개인
      문자처럼 카드 결제 문자가 아닌 것은 저장하지 않고 버리며, 버린 건수만 셉니다.
    </p>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>

    <h2 class="section-title">1. 기기별 토큰</h2>
    <div class="card stack">
      <ul class="row-list" data-testid="token-list">
        <li v-for="t in tokens" :key="t.id" :class="{ revoked: t.revoked }">
          <div class="row-main">
            <strong>{{ t.deviceName }}</strong>
            <span v-if="t.revoked" class="badge">폐기됨</span>
            <span v-else-if="t.hint" class="badge">…{{ t.hint }}</span>
            <div class="row-sub">
              받은 문자 {{ t.receivedCount }}건 · 마지막 {{ formatDateTime(t.lastReceivedAt) }}
              <template v-if="t.ignoredCount">
                · 무시된 문자 {{ t.ignoredCount }}건 (마지막
                {{ formatDateTime(t.lastIgnoredAt) }})</template
              >
            </div>
          </div>
          <button
            v-if="!t.revoked"
            type="button"
            class="btn btn-small btn-danger"
            :disabled="busy"
            @click="revoke(t)"
          >
            폐기
          </button>
        </li>
        <li v-if="tokens.length === 0" class="muted">아직 만든 토큰이 없습니다.</li>
      </ul>
      <form class="new-token" @submit.prevent="create">
        <input
          v-model="deviceName"
          maxlength="40"
          required
          aria-label="기기 이름"
          data-testid="token-device"
        />
        <button type="submit" class="btn btn-primary" :disabled="busy" data-testid="create-token">
          토큰 만들기
        </button>
      </form>
      <div v-if="created" class="notice stack" data-testid="token-created">
        <strong
          >토큰을 만들었습니다. 이 화면을 벗어나면 다시 볼 수 없으니 지금 단축어에
          입력하세요.</strong
        >
        <CopyField label="토큰" :value="created.token" testid="token-value" />
      </div>
    </div>

    <h2 class="section-title">2. 아이폰 단축어 만들기</h2>
    <div class="card stack steps">
      <ol>
        <li>
          <strong>단축어</strong> 앱 → 아래 <strong>자동화</strong> 탭 →
          <strong>새로운 자동화</strong>(＋) → <strong>메시지</strong>를 고릅니다.
        </li>
        <li>
          <strong>메시지 내용 포함</strong>에 <code>승인</code>을 입력합니다(취소 문자도
          ‘승인취소’로 오는 경우가 많습니다. 취소가 따로 오면 자동화를 하나 더 만들어
          <code>취소</code>를 넣으세요). <strong>즉시 실행</strong>을 고르고
          <strong>실행 시 알림</strong>은 꺼도 됩니다.
        </li>
        <li>
          <strong>새로운 빈 단축어</strong>로 시작해 <strong>날짜 포맷</strong> 동작을 추가합니다:
          날짜는 <strong>현재 날짜</strong>, 형식은 <strong>ISO 8601</strong>, 시간 포함.
        </li>
        <li>
          <strong>URL 콘텐츠 가져오기</strong> 동작을 추가하고 아래 값을 넣습니다.
          <div class="stack fields">
            <CopyField label="URL" :value="url" testid="webhook-url" />
            <CopyField label="방법" value="POST" />
            <CopyField label="헤더 이름" value="Authorization" />
            <CopyField
              label="헤더 값"
              :value="`Bearer ${created?.token ?? '<위에서 만든 토큰>'}`"
            />
            <CopyField
              label="요청 본문: JSON, 필드 세 개 (텍스트 형식)"
              :value="bodyTemplate"
              multiline
            />
          </div>
          <p class="muted small">
            <code>text</code>에는 단축어 입력의 <strong>내용</strong>, <code>sender</code>에는
            <strong>발신자</strong>, <code>receivedAt</code>에는 3단계의
            <strong>포맷된 날짜</strong> 변수를 넣습니다. receivedAt이 있어야 같은 문자가 두 번
            전달돼도 한 건으로 처리하면서, 같은 가게에서 같은 금액을 두 번 결제한 경우는 두 건으로
            남깁니다.
          </p>
        </li>
        <li>
          필요하면 <strong>결과 보기</strong> 동작을 추가해 응답 문구(예: “등록했습니다: …”)를
          확인할 수 있습니다.
        </li>
      </ol>
      <div class="notice">
        밖에서 결제할 때도 전달되려면 아이폰의 <strong>Tailscale</strong>이 항상 연결돼 있어야
        합니다. Tailscale 앱 설정에서 <strong>VPN On Demand</strong>를 켜세요. 연결이 끊긴 동안 온
        문자는 전달되지 않으니, 그런 건은 월 1회 파일 대조로 채웁니다.
      </div>
      <details>
        <summary>맥·PC에서 시험해 보기 (curl)</summary>
        <CopyField label="명령" :value="curlExample" multiline />
      </details>
    </div>

    <h2 class="section-title">3. 문자 붙여넣기 테스트</h2>
    <form class="card stack" @submit.prevent="test">
      <p class="muted small">
        받은 카드 문자를 붙여넣으면 어떻게 해석되는지 보여 줍니다. 저장하지 않습니다.
      </p>
      <textarea
        v-model="pasted"
        rows="5"
        maxlength="2000"
        placeholder="[Web발신]&#10;신한카드(1234)승인 …"
        data-testid="paste-text"
      />
      <button type="submit" class="btn" :disabled="busy || !pasted.trim()" data-testid="paste-test">
        해석해 보기
      </button>
      <div v-if="preview" class="result" data-testid="paste-result">
        <template v-if="!preview.recognized">
          <p>
            <strong>카드 결제 문자로 인식하지 않았습니다.</strong> 이런 문자는 저장하지 않고
            버립니다.
          </p>
        </template>
        <template v-else-if="!preview.ok">
          <p>
            <strong>인식했지만 해석하지 못했습니다</strong> ({{
              PARSE_FAILURE_LABELS[preview.reason] ?? preview.reason
            }}). 인박스에 원문과 함께 보관되고 직접 입력할 수 있습니다.
          </p>
          <p class="muted small">해석기: {{ preview.parser }}</p>
        </template>
        <template v-else>
          <p>
            <strong
              >{{ preview.value.kind === 'cancel' ? '취소' : '승인' }} 문자로 해석했습니다.</strong
            >
          </p>
          <dl class="parsed">
            <dt>카드사</dt>
            <dd>
              {{ issuerName(preview.value.issuer ?? null) }}
              {{ preview.value.cardType === 'check' ? '체크' : '' }}
              {{ preview.value.cardDigits ? `(${preview.value.cardDigits})` : '' }}
            </dd>
            <dt>금액</dt>
            <dd class="tabular">
              {{ preview.value.amount != null ? formatKrw(preview.value.amount) : '—'
              }}{{
                preview.value.installmentMonths
                  ? ` · ${preview.value.installmentMonths}개월`
                  : ' · 일시불'
              }}
            </dd>
            <dt>일시</dt>
            <dd>{{ formatDateTime(preview.value.occurredAt) }}</dd>
            <dt>가맹점</dt>
            <dd>{{ preview.value.merchant }}</dd>
            <dt>수단</dt>
            <dd>{{ preview.account?.name ?? '등록된 카드와 맞지 않음 (인박스에서 등록)' }}</dd>
            <dt>분류</dt>
            <dd>
              {{ categoryLabel(preview.categoryId)
              }}<span v-if="preview.categoryReason" class="muted">
                ({{ REASONS[preview.categoryReason] }})</span
              >
            </dd>
          </dl>
          <p class="muted small">해석기: {{ preview.parser }}</p>
        </template>
      </div>
    </form>
  </section>
</template>

<style scoped>
.sms {
  max-width: 760px;
}
.small {
  font-size: 0.85rem;
  margin: 0;
}
.new-token {
  display: flex;
  gap: 8px;
}
.revoked {
  opacity: 0.6;
}
.steps ol {
  margin: 0;
  padding-left: 1.2em;
  display: grid;
  gap: 12px;
}
.fields {
  margin-top: 8px;
}
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.85em;
  padding: 0 4px;
  border-radius: 4px;
  background: var(--surface-hover);
}
textarea {
  font: inherit;
  font-size: 1rem;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  color: var(--text);
}
.result {
  padding: 12px;
  border-radius: 10px;
  background: var(--surface-hover);
}
.result p {
  margin: 0 0 6px;
}
.parsed {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 12px;
  margin: 0 0 6px;
  font-size: 0.9rem;
}
.parsed dt {
  color: var(--text-muted);
}
.parsed dd {
  margin: 0;
}
details summary {
  cursor: pointer;
  color: var(--accent);
  font-size: 0.85rem;
}
</style>
