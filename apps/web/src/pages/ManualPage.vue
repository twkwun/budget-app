<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import AppIcon from '../components/AppIcon.vue';
import { APP_VERSION } from '../changelog.ts';
import { FAQS, GLOSSARY, MANUAL_SECTIONS, QUICK_START } from '../manual.ts';

interface Zoomed {
  src: string;
  alt: string;
  title: string;
}

const zoomed = ref<Zoomed | null>(null);

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') zoomed.value = null;
}

watch(zoomed, (value) => {
  if (value) window.addEventListener('keydown', onKeydown);
  else window.removeEventListener('keydown', onKeydown);
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

function jump(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
</script>

<template>
  <section class="page manual" data-testid="manual-page">
    <div class="page-head">
      <div>
        <h1>사용자 설명서</h1>
        <p class="muted subtitle">
          처음 쓰는 가족도 3분이면 익숙해지도록, 실제 화면과 함께 쉬운 말로 정리했습니다.
        </p>
      </div>
      <RouterLink to="/changelog" class="btn btn-small">
        <AppIcon name="history" :size="16" />
        <span class="tabular">v{{ APP_VERSION }} 버전 이력</span>
      </RouterLink>
    </div>

    <div class="card quickstart" aria-label="처음 3분 시작하기">
      <span class="badge badge-accent">처음이라면 여기부터!</span>
      <h2>3분 만에 시작하기</h2>
      <ol class="steps">
        <li v-for="(step, i) in QUICK_START" :key="step.title">
          <RouterLink :to="step.href" class="step">
            <span class="step-num tabular">{{ i + 1 }}</span>
            <span>
              <strong>{{ step.title }}</strong>
              <span class="muted step-desc">{{ step.desc }}</span>
            </span>
          </RouterLink>
        </li>
      </ol>
    </div>

    <nav class="card toc" aria-label="설명서 목차">
      <span class="muted toc-label">바로가기</span>
      <div class="toc-links">
        <button
          v-for="s in MANUAL_SECTIONS"
          :key="s.id"
          type="button"
          class="link-button"
          @click="jump(s.id)"
        >
          {{ s.menu }}
        </button>
        <button type="button" class="link-button" @click="jump('glossary')">용어 풀이</button>
        <button type="button" class="link-button" @click="jump('faq')">자주 묻는 질문</button>
      </div>
    </nav>

    <article
      v-for="sec in MANUAL_SECTIONS"
      :id="sec.id"
      :key="sec.id"
      class="card guide"
      :data-testid="`manual-${sec.id}`"
    >
      <header class="guide-head">
        <div>
          <h2>{{ sec.title }}</h2>
          <p class="muted tagline">{{ sec.tagline }}</p>
        </div>
        <RouterLink v-if="sec.href" :to="sec.href" class="btn btn-small go">
          <span>{{ sec.menu }} 열기</span>
          <AppIcon name="chevron" :size="16" />
        </RouterLink>
      </header>

      <p class="when">
        <span class="badge badge-accent">언제 쓰나요?</span>
        <span>{{ sec.whenToUse }}</span>
      </p>

      <button
        v-if="sec.image"
        type="button"
        class="shot"
        :aria-label="`${sec.title} 화면 크게 보기`"
        @click="zoomed = { src: sec.image, alt: sec.imageAlt ?? '', title: sec.title }"
      >
        <img :src="sec.image" :alt="sec.imageAlt" loading="lazy" />
        <span class="zoom-hint">누르면 크게 봅니다</span>
      </button>

      <ul class="points">
        <li v-for="p in sec.points" :key="p.label">
          <strong>{{ p.label }}</strong>
          <p class="muted">{{ p.desc }}</p>
        </li>
      </ul>

      <p v-if="sec.tip" class="tip">
        <AppIcon name="spark" :size="16" class="tip-icon" />
        <span><strong>알아 두면 좋아요:</strong> {{ sec.tip }}</span>
      </p>
    </article>

    <section id="glossary" class="card extra">
      <h2>용어 풀이</h2>
      <p class="muted extra-sub">가계부에서 자주 보는 말을 짧게 풀었습니다.</p>
      <dl class="glossary">
        <div v-for="g in GLOSSARY" :key="g.term" class="term">
          <dt>{{ g.term }}</dt>
          <dd class="muted">{{ g.desc }}</dd>
        </div>
      </dl>
    </section>

    <section id="faq" class="card extra">
      <h2>자주 묻는 질문</h2>
      <details v-for="f in FAQS" :key="f.q" class="faq">
        <summary>{{ f.q }}</summary>
        <p class="muted">{{ f.a }}</p>
      </details>
    </section>

    <div
      v-if="zoomed"
      class="lightbox"
      role="dialog"
      aria-modal="true"
      :aria-label="zoomed.title"
      @click="zoomed = null"
    >
      <figure @click.stop>
        <img :src="zoomed.src" :alt="zoomed.alt" />
        <figcaption>
          <span>{{ zoomed.title }}</span>
          <button type="button" class="btn btn-small" @click="zoomed = null">닫기</button>
        </figcaption>
      </figure>
    </div>
  </section>
</template>

<style scoped>
.manual {
  display: grid;
  gap: 16px;
}
.page-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px 16px;
}
.page-head h1 {
  margin-bottom: 2px;
}
.subtitle {
  margin: 0;
  font-size: 0.92rem;
}
.quickstart h2 {
  margin: 8px 0 12px;
}
.steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
}
.step {
  display: flex;
  gap: 12px;
  height: 100%;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  color: inherit;
  text-decoration: none;
}
.step:hover {
  background: var(--surface-hover);
}
.step-num {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 700;
}
.step-desc {
  display: block;
  margin-top: 2px;
  font-size: 0.86rem;
  line-height: 1.5;
}
.toc {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px 16px;
}
.toc-label {
  font-size: 0.84rem;
  font-weight: 600;
}
.toc-links {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
}
.guide {
  display: grid;
  gap: 14px;
  scroll-margin-top: calc(16px + var(--safe-top));
}
.guide-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px 16px;
}
.guide-head h2 {
  margin-bottom: 2px;
  font-size: 1.15rem;
}
.tagline {
  margin: 0;
  font-size: 0.9rem;
}
.go {
  flex-shrink: 0;
}
.when {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px 10px;
  margin: 0;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--surface-hover);
  font-size: 0.9rem;
}
.shot {
  position: relative;
  display: block;
  width: 100%;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
  background: var(--bg);
  cursor: zoom-in;
}
.shot img {
  display: block;
  width: 100%;
  height: auto;
  aspect-ratio: 1280 / 820;
  object-fit: cover;
  object-position: top left;
}
.zoom-hint {
  position: absolute;
  right: 8px;
  bottom: 8px;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgb(0 0 0 / 60%);
  color: #fff;
  font-size: 0.75rem;
}
.points {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 12px;
}
.points strong {
  font-size: 0.95rem;
}
.points p {
  margin: 2px 0 0;
  font-size: 0.9rem;
  line-height: 1.6;
}
.tip {
  display: flex;
  gap: 8px;
  margin: 0;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--accent-soft);
  font-size: 0.9rem;
  line-height: 1.55;
}
.tip-icon {
  flex-shrink: 0;
  margin-top: 3px;
  color: var(--accent);
}
.extra {
  scroll-margin-top: calc(16px + var(--safe-top));
}
.extra-sub {
  margin: 0 0 12px;
  font-size: 0.9rem;
}
.glossary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 10px;
  margin: 0;
}
.term {
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
}
.term dt {
  font-weight: 700;
}
.term dd {
  margin: 2px 0 0;
  font-size: 0.88rem;
  line-height: 1.55;
}
.faq {
  border-top: 1px solid var(--border);
}
.faq summary {
  padding: 10px 0;
  font-weight: 600;
  cursor: pointer;
}
.faq p {
  margin: 0 0 12px;
  font-size: 0.9rem;
  line-height: 1.6;
}
.lightbox {
  position: fixed;
  inset: 0;
  z-index: 35; /* above sheets and the tab bar, below the lock screen */
  display: grid;
  place-items: center;
  padding: calc(16px + var(--safe-top)) 16px calc(16px + var(--safe-bottom));
  background: rgb(0 0 0 / 75%);
}
.lightbox figure {
  margin: 0;
  max-width: min(1280px, 100%);
  max-height: 100%;
  display: grid;
  gap: 8px;
}
.lightbox img {
  max-width: 100%;
  max-height: calc(100dvh - 120px);
  border-radius: 8px;
  background: var(--surface);
}
.lightbox figcaption {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: #fff;
  font-size: 0.9rem;
}
</style>
