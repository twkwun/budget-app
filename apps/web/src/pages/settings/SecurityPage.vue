<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  LOCK_TIMEOUT_CHOICES,
  PASSWORD_MIN_LENGTH,
  type LockTimeout,
  type Me,
  type PasskeyInfo,
  type RecoveryCodeIssued,
  type SessionInfo,
} from '@budget/shared';
import { api } from '../../api/client.ts';
import { describeUserAgent, formatDateTime } from '../../auth/format.ts';
import { errorMessage, isPasskeyCancel } from '../../auth/messages.ts';
import { passkeysSupported, registerPasskey } from '../../auth/passkey.ts';
import RecoveryCodeCard from '../../components/RecoveryCodeCard.vue';
import { useAuthStore } from '../../stores/auth.ts';

const auth = useAuthStore();
const passkeys = ref<PasskeyInfo[]>([]);
const sessions = ref<SessionInfo[]>([]);
const message = ref('');
const error = ref('');
const busy = ref(false);
const newPassword = ref('');
const confirmPassword = ref('');
const recoveryCode = ref('');
const lockTimeout = ref<LockTimeout>(auth.user?.lockTimeoutSeconds ?? 300);

async function load(): Promise<void> {
  [passkeys.value, sessions.value] = await Promise.all([
    api.get<PasskeyInfo[]>('/me/passkeys'),
    api.get<SessionInfo[]>('/me/sessions'),
  ]);
}

async function act(action: () => Promise<void>, success = ''): Promise<void> {
  busy.value = true;
  error.value = '';
  message.value = '';
  try {
    await action();
    message.value = success;
  } catch (e) {
    error.value = isPasskeyCancel(e) ? '' : errorMessage(e);
  } finally {
    busy.value = false;
  }
}

onMounted(() => void act(load));

const addPasskey = () =>
  act(async () => {
    const created = await registerPasskey();
    await load();
    message.value = created.backedUp
      ? '패스키를 추가했습니다. iCloud 키체인으로 같은 Apple 계정의 기기에 동기화됩니다.'
      : '패스키를 추가했습니다.';
  });

const rename = (p: PasskeyInfo) =>
  act(async () => {
    const name = window.prompt('패스키 이름', p.deviceName)?.trim();
    if (!name) return;
    await api.patch(`/me/passkeys/${encodeURIComponent(p.id)}`, { deviceName: name });
    await load();
  });

const remove = (p: PasskeyInfo) =>
  act(async () => {
    if (!window.confirm(`'${p.deviceName}' 패스키를 삭제할까요?`)) return;
    await api.delete(`/me/passkeys/${encodeURIComponent(p.id)}`);
    await load();
  }, '패스키를 삭제했습니다.');

const saveLockTimeout = () =>
  act(async () => {
    auth.updateUser(await api.patch<Me>('/me', { lockTimeoutSeconds: lockTimeout.value }));
  }, '잠금 설정을 저장했습니다.');

const changePassword = () =>
  act(async () => {
    if (newPassword.value !== confirmPassword.value) throw new Error('mismatch');
    await api.post('/me/password', { newPassword: newPassword.value });
    newPassword.value = '';
    confirmPassword.value = '';
    await load();
  }, '비밀번호를 바꿨습니다. 다른 기기의 로그인은 해제되었습니다.');

const newRecoveryCode = () =>
  act(async () => {
    if (!window.confirm('새 복구 코드를 만들면 이전 코드는 쓸 수 없습니다. 계속할까요?')) return;
    recoveryCode.value = (await api.post<RecoveryCodeIssued>('/me/recovery-code')).recoveryCode;
  });

const revoke = (s: SessionInfo) =>
  act(async () => {
    await api.delete(`/me/sessions/${encodeURIComponent(s.id)}`);
    await load();
  });

const revokeOthers = () =>
  act(async () => {
    await api.post('/me/sessions/revoke-others');
    await load();
  }, '다른 기기에서 모두 로그아웃했습니다.');
</script>

<template>
  <section class="page" data-testid="security-page">
    <h1>보안</h1>
    <p v-if="message" class="notice" role="status">{{ message }}</p>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>

    <h2 class="section-title">패스키</h2>
    <div class="card">
      <p class="muted small">
        Face ID·Touch ID·Windows Hello로 로그인합니다. 애플 기기에서 만든 패스키는 iCloud 키체인으로
        동기화되고, PC에서는 따로 추가하거나 로그인 화면의 QR을 아이폰으로 찍으면 됩니다.
      </p>
      <ul class="row-list" data-testid="passkey-list">
        <li v-for="p in passkeys" :key="p.id">
          <div class="row-main">
            <strong>{{ p.deviceName }}</strong>
            <span v-if="p.backedUp" class="badge">동기화됨</span>
            <div class="row-sub">
              등록 {{ formatDateTime(p.createdAt) }} · 마지막 사용
              {{ formatDateTime(p.lastUsedAt) }}
            </div>
          </div>
          <button type="button" class="btn btn-small" :disabled="busy" @click="rename(p)">
            이름 변경
          </button>
          <button
            type="button"
            class="btn btn-small btn-danger"
            :disabled="busy"
            @click="remove(p)"
          >
            삭제
          </button>
        </li>
        <li v-if="passkeys.length === 0" class="muted">등록된 패스키가 없습니다.</li>
      </ul>
      <button
        v-if="passkeysSupported()"
        type="button"
        class="btn btn-primary"
        :disabled="busy"
        data-testid="add-passkey"
        @click="addPasskey"
      >
        이 기기에 패스키 추가
      </button>
    </div>

    <h2 class="section-title">앱 잠금</h2>
    <div class="card stack">
      <p class="muted small">
        마지막으로 사용한 뒤 이 시간이 지나면 잠기고, Face ID나 비밀번호로 풀어야 합니다. ‘즉시’는
        앱을 다른 앱으로 전환하는 순간 잠급니다.
      </p>
      <label class="field">
        <span>잠금 시간</span>
        <select v-model="lockTimeout" data-testid="lock-timeout" @change="saveLockTimeout">
          <option v-for="c in LOCK_TIMEOUT_CHOICES" :key="String(c.value)" :value="c.value">
            {{ c.label }}
          </option>
        </select>
      </label>
      <button type="button" class="btn" data-testid="lock-now" @click="auth.lock()">
        지금 잠그기
      </button>
    </div>

    <h2 class="section-title">비밀번호</h2>
    <form class="card stack" @submit.prevent="changePassword">
      <label class="field">
        <span>새 비밀번호 ({{ PASSWORD_MIN_LENGTH }}자 이상)</span>
        <input
          v-model="newPassword"
          type="password"
          autocomplete="new-password"
          :minlength="PASSWORD_MIN_LENGTH"
          required
        />
      </label>
      <label class="field">
        <span>새 비밀번호 확인</span>
        <input v-model="confirmPassword" type="password" autocomplete="new-password" required />
      </label>
      <p v-if="confirmPassword && confirmPassword !== newPassword" class="error-text">
        비밀번호가 서로 다릅니다.
      </p>
      <button
        type="submit"
        class="btn"
        :disabled="busy || !newPassword || newPassword !== confirmPassword"
      >
        비밀번호 변경
      </button>
    </form>

    <h2 class="section-title">복구 코드</h2>
    <div class="card stack">
      <RecoveryCodeCard v-if="recoveryCode" :code="recoveryCode" @done="recoveryCode = ''" />
      <template v-else>
        <p class="muted small">
          패스키와 비밀번호를 모두 잃었을 때 비밀번호를 재설정하는 코드입니다. 잃어버렸다면 새로
          만드세요.
        </p>
        <button type="button" class="btn" :disabled="busy" @click="newRecoveryCode">
          새 복구 코드 만들기
        </button>
      </template>
    </div>

    <h2 class="section-title">로그인된 기기</h2>
    <div class="card">
      <ul class="row-list" data-testid="session-list">
        <li v-for="s in sessions" :key="s.id">
          <div class="row-main">
            <strong>{{ describeUserAgent(s.userAgent) }}</strong>
            <span v-if="s.current" class="badge badge-accent">이 기기</span>
            <div class="row-sub">
              마지막 사용 {{ formatDateTime(s.lastSeenAt)
              }}<template v-if="s.ip"> · {{ s.ip }}</template>
            </div>
          </div>
          <button
            v-if="!s.current"
            type="button"
            class="btn btn-small"
            :disabled="busy"
            @click="revoke(s)"
          >
            로그아웃
          </button>
        </li>
      </ul>
      <button
        type="button"
        class="btn"
        :disabled="busy || sessions.length < 2"
        @click="revokeOthers"
      >
        다른 기기 모두 로그아웃
      </button>
    </div>
  </section>
</template>

<style scoped>
.small {
  font-size: 0.85rem;
  margin: 0;
}
.card > .btn {
  margin-top: 8px;
}
</style>
