/// <reference types="node" />
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MANUAL_SECTIONS, QUICK_START } from '../src/manual.ts';
import { renderManualMarkdown } from '../src/manual-markdown.ts';

const routerSource = readFileSync(new URL('../src/router.ts', import.meta.url), 'utf8');
const ROUTE_PATHS = new Set([...routerSource.matchAll(/path: '([^']+)'/g)].map((m) => m[1]));

describe('user manual', () => {
  it('docs/user-manual.md is generated from src/manual.ts (run pnpm manual:md)', () => {
    const doc = readFileSync(new URL('../../../docs/user-manual.md', import.meta.url), 'utf8');
    expect(doc).toBe(renderManualMarkdown());
  });

  it('uses unique section ids', () => {
    const ids = MANUAL_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('links only to screens that exist', () => {
    const hrefs = [...MANUAL_SECTIONS.map((s) => s.href), ...QUICK_START.map((s) => s.href)];
    for (const href of hrefs) {
      if (href) expect(ROUTE_PATHS.has(href), href).toBe(true);
    }
  });

  it('has a screenshot file for every image', () => {
    for (const sec of MANUAL_SECTIONS) {
      if (!sec.image) continue;
      expect(sec.imageAlt, sec.id).toBeTruthy();
      expect(existsSync(new URL(`../public${sec.image}`, import.meta.url)), sec.image).toBe(true);
    }
  });
});
