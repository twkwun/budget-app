<script setup lang="ts">
import AppIcon from '../components/AppIcon.vue';
import { useAuthStore } from '../stores/auth.ts';

const auth = useAuthStore();
const later = [
  { label: '예산', stage: '6단계' },
  { label: '백업', stage: '이후 단계' },
];
</script>

<template>
  <section class="page">
    <h1>설정</h1>
    <ul class="card list">
      <li>
        <RouterLink to="/settings/security" class="row" data-testid="settings-security-link">
          <span>보안</span>
          <span class="muted small">패스키, 잠금, 비밀번호, 로그인 기기</span>
          <AppIcon name="chevron" :size="18" class="chevron" />
        </RouterLink>
      </li>
      <li>
        <RouterLink to="/settings/accounts" class="row" data-testid="settings-accounts-link">
          <span>카드·계좌</span>
          <span class="muted small">결제 수단, 결제일, 실제 사용자</span>
          <AppIcon name="chevron" :size="18" class="chevron" />
        </RouterLink>
      </li>
      <li>
        <RouterLink to="/settings/categories" class="row" data-testid="settings-categories-link">
          <span>분류</span>
          <span class="muted small">지출·수입 분류 추가, 이름 변경, 정리</span>
          <AppIcon name="chevron" :size="18" class="chevron" />
        </RouterLink>
      </li>
      <li>
        <RouterLink to="/settings/sms" class="row" data-testid="settings-sms-link">
          <span>문자 전달</span>
          <span class="muted small">아이폰 단축어 설정, 토큰, 문자 테스트</span>
          <AppIcon name="chevron" :size="18" class="chevron" />
        </RouterLink>
      </li>
      <li>
        <RouterLink to="/settings/rules" class="row" data-testid="settings-rules-link">
          <span>분류 규칙</span>
          <span class="muted small">가맹점별 자동 분류, 기본 키워드</span>
          <AppIcon name="chevron" :size="18" class="chevron" />
        </RouterLink>
      </li>
      <li v-if="auth.isAdmin">
        <RouterLink to="/settings/members" class="row" data-testid="settings-members-link">
          <span>구성원</span>
          <span class="muted small">초대, 역할, 사용 중지</span>
          <AppIcon name="chevron" :size="18" class="chevron" />
        </RouterLink>
      </li>
      <li v-for="item in later" :key="item.label">
        <div class="row disabled">
          <span>{{ item.label }}</span>
          <span class="muted small">{{ item.stage }}에서 제공</span>
        </div>
      </li>
    </ul>
    <p class="account muted">
      {{ auth.user?.displayName }} ({{ auth.user?.loginName }}) ·
      {{ auth.isAdmin ? '관리자' : '구성원' }}
    </p>
    <button type="button" class="btn btn-block" data-testid="logout" @click="auth.logout()">
      로그아웃
    </button>
  </section>
</template>

<style scoped>
.list {
  list-style: none;
  margin: 0;
  padding: 4px 0;
}
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  color: inherit;
  text-decoration: none;
}
.row.disabled {
  opacity: 0.6;
}
li + li .row {
  border-top: 1px solid var(--border);
}
.small {
  font-size: 0.8rem;
}
.chevron {
  margin-left: auto;
  color: var(--text-muted);
}
.account {
  margin: 24px 0 8px;
  font-size: 0.85rem;
  text-align: center;
}
</style>
