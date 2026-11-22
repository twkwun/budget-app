<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { CreatedInvite, InviteInfo, MemberInfo } from '@budget/shared';
import { api } from '../../api/client.ts';
import { formatDateTime } from '../../auth/format.ts';
import { errorMessage } from '../../auth/messages.ts';
import { useAuthStore } from '../../stores/auth.ts';

const auth = useAuthStore();
const members = ref<MemberInfo[]>([]);
const invites = ref<InviteInfo[]>([]);
const created = ref<CreatedInvite | null>(null);
const copied = ref(false);
const busy = ref(false);
const error = ref('');

const STATUS: Record<InviteInfo['status'], string> = {
  pending: '대기 중',
  used: '사용됨',
  expired: '만료',
  revoked: '취소됨',
};
const pendingInvites = computed(() => invites.value.filter((i) => i.status === 'pending'));
const pastInvites = computed(() => invites.value.filter((i) => i.status !== 'pending').slice(0, 5));

async function load(): Promise<void> {
  [members.value, invites.value] = await Promise.all([
    api.get<MemberInfo[]>('/members'),
    api.get<InviteInfo[]>('/invites'),
  ]);
}

async function act(action: () => Promise<void>): Promise<void> {
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

onMounted(() => void act(load));

const createInvite = () =>
  act(async () => {
    created.value = await api.post<CreatedInvite>('/invites', { role: 'member' });
    copied.value = false;
    await load();
  });

async function share(url: string): Promise<void> {
  if (navigator.share) {
    await navigator.share({ title: '가계부 초대', url }).catch(() => {});
    return;
  }
  await navigator.clipboard
    .writeText(url)
    .then(() => (copied.value = true))
    .catch(() => {});
}

const revokeInvite = (i: InviteInfo) =>
  act(async () => {
    await api.delete(`/invites/${i.id}`);
    if (created.value?.invite.id === i.id) created.value = null;
    await load();
  });

const setRole = (m: MemberInfo, role: MemberInfo['role']) =>
  act(async () => {
    await api.patch(`/members/${m.id}`, { role });
    await load();
    if (m.id === auth.user?.id) await auth.refresh();
  });

const setDisabled = (m: MemberInfo, disabled: boolean) =>
  act(async () => {
    if (
      disabled &&
      !window.confirm(`${m.displayName}님을 사용 중지할까요? 모든 기기에서 로그아웃됩니다.`)
    )
      return;
    await api.patch(`/members/${m.id}`, { disabled });
    await load();
  });
</script>

<template>
  <section class="page" data-testid="members-page">
    <h1>구성원</h1>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>

    <div class="card">
      <ul class="row-list" data-testid="member-list">
        <li v-for="m in members" :key="m.id">
          <div class="row-main">
            <strong>{{ m.displayName }}</strong>
            <span class="badge" :class="{ 'badge-accent': m.role === 'admin' }">{{
              m.role === 'admin' ? '관리자' : '구성원'
            }}</span>
            <span v-if="m.disabled" class="badge">사용 중지</span>
            <span v-if="m.id === auth.user?.id" class="badge">나</span>
            <div class="row-sub">
              {{ m.loginName }} · 패스키 {{ m.passkeyCount }}개 · 가입
              {{ formatDateTime(m.createdAt) }}
            </div>
          </div>
          <button
            type="button"
            class="btn btn-small"
            :disabled="busy"
            @click="setRole(m, m.role === 'admin' ? 'member' : 'admin')"
          >
            {{ m.role === 'admin' ? '구성원으로' : '관리자로' }}
          </button>
          <button
            type="button"
            class="btn btn-small"
            :class="{ 'btn-danger': !m.disabled }"
            :disabled="busy"
            @click="setDisabled(m, !m.disabled)"
          >
            {{ m.disabled ? '다시 사용' : '사용 중지' }}
          </button>
        </li>
      </ul>
    </div>

    <h2 class="section-title">초대</h2>
    <div class="card stack">
      <p class="muted small">
        초대 링크는 한 번만 쓸 수 있고 7일 뒤 만료됩니다. 받는 사람도 Tailscale로 이 주소에 접속할
        수 있어야 합니다.
      </p>
      <div v-if="created" class="notice stack" data-testid="invite-created">
        <strong>초대 링크를 만들었습니다. 지금 복사해 전달하세요. 다시 볼 수 없습니다.</strong>
        <input
          :value="created.url"
          readonly
          data-testid="invite-url"
          @focus="($event.target as HTMLInputElement).select()"
        />
        <button type="button" class="btn btn-small" @click="share(created.url)">
          {{ copied ? '복사됨' : '공유·복사' }}
        </button>
      </div>
      <button
        type="button"
        class="btn btn-primary"
        :disabled="busy"
        data-testid="create-invite"
        @click="createInvite"
      >
        초대 링크 만들기
      </button>
      <ul v-if="pendingInvites.length || pastInvites.length" class="row-list">
        <li v-for="i in [...pendingInvites, ...pastInvites]" :key="i.id">
          <div class="row-main">
            <span class="badge" :class="{ 'badge-accent': i.status === 'pending' }">{{
              STATUS[i.status]
            }}</span>
            <div class="row-sub">
              {{ i.createdBy }} · {{ formatDateTime(i.createdAt) }}
              <template v-if="i.status === 'pending'">
                · {{ formatDateTime(i.expiresAt) }}까지</template
              >
              <template v-if="i.usedBy"> · {{ i.usedBy }}님 가입</template>
            </div>
          </div>
          <button
            v-if="i.status === 'pending'"
            type="button"
            class="btn btn-small"
            :disabled="busy"
            @click="revokeInvite(i)"
          >
            취소
          </button>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.small {
  font-size: 0.85rem;
  margin: 0;
}
</style>
