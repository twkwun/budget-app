/**
 * Renders docs/user-manual.md from the in-app manual (src/manual.ts), so the
 * two never drift. Regenerate with `pnpm manual:md`; a test checks it.
 */
import { APP_VERSION } from './changelog.ts';
import { FAQS, GLOSSARY, MANUAL_SECTIONS, QUICK_START } from './manual.ts';

/** GitHub-style heading anchor. */
function anchor(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');
}

export function renderManualMarkdown(): string {
  const out: string[] = [];
  out.push(`# 가계부 사용자 설명서 (v${APP_VERSION})`, '');
  out.push(
    '> 처음 쓰는 가족도 3분이면 익숙해지도록, 실제 화면과 함께 쉬운 말로 정리했습니다.  ',
    '> 앱에서는 사이드바 아래쪽(휴대폰은 **더보기 → 도움말**)의 **사용자 설명서**에서 같은 내용을 볼 수 있습니다.',
    '',
    '<!-- 이 파일은 apps/web/src/manual.ts에서 만듭니다. 직접 고치지 말고 manual.ts를 고친 뒤 `pnpm manual:md`를 실행하세요. -->',
    '',
    '---',
    '',
    '## 처음이라면 여기부터! (3분 빠른 시작)',
    '',
  );
  QUICK_START.forEach((step, i) => {
    out.push(`${i + 1}. **${step.title}**  `, `   ${step.desc}`);
  });
  out.push('', '---', '', '## 목차', '');
  const toc = [...MANUAL_SECTIONS.map((s) => s.title), '용어 풀이', '자주 묻는 질문'];
  for (const title of toc) out.push(`- [${title}](#${anchor(title)})`);
  out.push('', '---');

  for (const sec of MANUAL_SECTIONS) {
    out.push('', `## ${sec.title}`, '', `_${sec.tagline}_`, '');
    out.push(`**언제 쓰나요?** ${sec.whenToUse}`, '');
    if (sec.image) {
      out.push(`![${sec.imageAlt ?? sec.title}](../apps/web/public${sec.image})`, '');
    }
    for (const p of sec.points) out.push(`- **${p.label}**: ${p.desc}`);
    if (sec.tip) out.push('', `> **알아 두면 좋아요**: ${sec.tip}`);
    out.push('', '---');
  }

  out.push('', '## 용어 풀이', '', '| 용어 | 뜻 |', '| --- | --- |');
  for (const g of GLOSSARY) out.push(`| **${g.term}** | ${g.desc} |`);
  out.push('', '---', '', '## 자주 묻는 질문', '');
  for (const f of FAQS) out.push(`**Q. ${f.q}**  `, `A. ${f.a}`, '');
  return `${out.join('\n').trimEnd()}\n`;
}
