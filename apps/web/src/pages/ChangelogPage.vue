<script setup lang="ts">
import { computed, ref } from 'vue';
import AppIcon from '../components/AppIcon.vue';
import { APP_VERSION, CHANGE_KIND_LABELS, CHANGELOG, type ChangeKind } from '../changelog.ts';

type Filter = 'all' | ChangeKind;

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: '전체' },
  { key: 'new', label: '신규' },
  { key: 'improved', label: '개선' },
  { key: 'fixed', label: '수정' },
];

const filter = ref<Filter>('all');
const latest = CHANGELOG[0];

const releases = computed(() =>
  CHANGELOG.map((release) => ({
    ...release,
    visible:
      filter.value === 'all'
        ? release.changes
        : release.changes.filter((change) => change.kind === filter.value),
  })),
);
</script>

<template>
  <section class="page" data-testid="changelog-page">
    <div class="page-head">
      <div>
        <h1>버전 이력</h1>
        <p class="muted subtitle">가계부의 업데이트 내역을 버전별로 정리했습니다.</p>
      </div>
      <RouterLink to="/manual" class="btn btn-small">
        <AppIcon name="book" :size="16" />
        <span>사용자 설명서 보기</span>
      </RouterLink>
    </div>

    <div class="card hero">
      <div class="hero-top">
        <div>
          <span class="kicker muted">현재 버전</span>
          <div class="ver-row">
            <strong class="ver-num tabular" data-testid="current-version"
              >v{{ APP_VERSION }}</strong
            >
            <span class="badge badge-accent">최신</span>
          </div>
        </div>
        <p class="muted meta">
          기준일 <strong class="tabular">{{ latest?.date }}</strong> · 기록된 릴리스
          <strong class="tabular">{{ CHANGELOG.length }}건</strong>
        </p>
      </div>
      <p class="muted hero-desc">
        버전 번호는 <strong>메이저 · 마이너 · 패치</strong> 순서입니다. 새 기능이나 화면이 생기면
        가운데 숫자가, 고친 것만 있으면 마지막 숫자가 올라갑니다.
      </p>
    </div>

    <div class="toolbar" role="group" aria-label="변경 유형 필터">
      <button
        v-for="f in FILTERS"
        :key="f.key"
        type="button"
        class="seg"
        :class="{ selected: filter === f.key }"
        :aria-pressed="filter === f.key"
        @click="filter = f.key"
      >
        {{ f.label }}
      </button>
    </div>

    <div class="timeline">
      <article
        v-for="(release, index) in releases"
        :key="release.version"
        class="card release"
        :data-testid="`release-${release.version}`"
      >
        <header class="rel-head">
          <div class="rel-title">
            <span class="rel-ver tabular">v{{ release.version }}</span>
            <span v-if="index === 0" class="badge badge-accent">현재</span>
            <h2>{{ release.title }}</h2>
          </div>
          <time class="muted rel-date tabular" :datetime="release.date">{{ release.date }}</time>
        </header>

        <p class="rel-summary">{{ release.summary }}</p>

        <div v-if="filter === 'all' && release.highlights.length" class="highlights">
          <h3>주요 포인트</h3>
          <ul>
            <li v-for="h in release.highlights" :key="h">
              <AppIcon name="check" :size="16" class="check" />
              <span>{{ h }}</span>
            </li>
          </ul>
        </div>

        <div>
          <h3>상세 변경 내역</h3>
          <p v-if="release.visible.length === 0" class="muted empty">
            이 버전에는 '{{ CHANGE_KIND_LABELS[filter as ChangeKind] }}' 항목이 없습니다.
          </p>
          <ul v-else class="changes">
            <li v-for="item in release.visible" :key="item.category + item.text">
              <span class="pill" :class="item.kind">{{ CHANGE_KIND_LABELS[item.kind] }}</span>
              <span class="cat">{{ item.category }}</span>
              <span class="muted txt">{{ item.text }}</span>
            </li>
          </ul>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.page-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px 16px;
  margin-bottom: 16px;
}
.page-head h1 {
  margin-bottom: 2px;
}
.subtitle {
  margin: 0;
  font-size: 0.92rem;
}
.hero {
  margin-bottom: 16px;
}
.hero-top {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 8px 20px;
}
.kicker {
  display: block;
  font-size: 0.78rem;
  font-weight: 600;
}
.ver-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ver-num {
  font-size: 1.65rem;
  font-weight: 750;
  letter-spacing: -0.02em;
}
.meta {
  margin: 0;
  font-size: 0.86rem;
}
.meta strong,
.hero-desc strong {
  color: var(--text);
}
.hero-desc {
  margin: 12px 0 0;
  padding-top: 12px;
  border-top: 1px solid var(--border);
  font-size: 0.88rem;
}
.toolbar {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  margin-bottom: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
}
.seg {
  min-height: 32px;
  padding: 4px 14px;
  border: 0;
  border-radius: 8px;
  background: none;
  color: var(--text-muted);
  font-weight: 600;
  cursor: pointer;
}
.seg.selected {
  background: var(--accent-soft);
  color: var(--accent);
}
.timeline {
  display: grid;
  gap: 16px;
}
.release {
  display: grid;
  gap: 14px;
}
.rel-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.rel-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.rel-ver {
  font-size: 1.05rem;
  font-weight: 750;
  color: var(--accent);
}
.rel-head h2 {
  margin: 0;
}
.rel-date {
  font-size: 0.84rem;
}
.rel-summary {
  margin: 0;
  font-size: 0.92rem;
  line-height: 1.6;
}
h3 {
  margin: 0 0 8px;
  font-size: 0.84rem;
  color: var(--text-muted);
}
.highlights {
  padding: 12px 16px;
  border-radius: 10px;
  background: var(--surface-hover);
}
.highlights ul,
.changes {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 8px;
}
.highlights li {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 0.9rem;
}
.check {
  flex-shrink: 0;
  margin-top: 3px;
  color: var(--ok);
}
.changes li {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr);
  align-items: baseline;
  gap: 6px 10px;
  font-size: 0.9rem;
  line-height: 1.55;
}
.pill {
  min-width: 2.6rem;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 0.74rem;
  font-weight: 700;
  text-align: center;
}
.pill.new {
  background: color-mix(in srgb, var(--ok) 15%, transparent);
  color: var(--ok);
}
.pill.improved {
  background: var(--accent-soft);
  color: var(--accent);
}
.pill.fixed {
  background: color-mix(in srgb, var(--warn) 15%, transparent);
  color: var(--warn);
}
.cat {
  font-weight: 700;
  white-space: nowrap;
}
.empty {
  margin: 0;
  font-size: 0.88rem;
}
@media (max-width: 640px) {
  .changes li {
    grid-template-columns: auto minmax(0, 1fr);
  }
  .txt {
    grid-column: 1 / -1;
  }
}
</style>
