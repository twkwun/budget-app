/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APP_VERSION, CHANGELOG } from '../src/changelog.ts';
import { activeTabFor, HELP_ITEMS } from '../src/nav.ts';

const PACKAGES = [
  '../../../package.json',
  '../package.json',
  '../../server/package.json',
  '../../../packages/shared/package.json',
];

function packageVersion(relative: string): string {
  const raw = readFileSync(new URL(relative, import.meta.url), 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

function compare(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

describe('changelog', () => {
  it('starts with the current version', () => {
    expect(CHANGELOG[0]?.version).toBe(APP_VERSION);
  });

  it('matches the version in every package.json', () => {
    for (const relative of PACKAGES) {
      expect(packageVersion(relative), relative).toBe(APP_VERSION);
    }
  });

  it('lists releases newest first with unique Major.Minor.Patch versions', () => {
    const versions = CHANGELOG.map((r) => r.version);
    expect(new Set(versions).size).toBe(versions.length);
    for (const version of versions) expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    for (let i = 1; i < CHANGELOG.length; i += 1) {
      const newer = CHANGELOG[i - 1]!;
      const older = CHANGELOG[i]!;
      expect(compare(newer.version, older.version)).toBeGreaterThan(0);
      expect(newer.date >= older.date).toBe(true);
    }
  });

  it('gives every release a date, title, summary and at least one change', () => {
    for (const release of CHANGELOG) {
      expect(release.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(release.title.trim()).not.toBe('');
      expect(release.summary.trim()).not.toBe('');
      expect(release.changes.length).toBeGreaterThan(0);
    }
  });
});

describe('help navigation', () => {
  it('offers the manual and the changelog under 더보기', () => {
    expect(HELP_ITEMS.map((i) => i.label)).toEqual(['사용자 설명서', '버전 이력']);
    expect(activeTabFor('manual')).toBe('more');
    expect(activeTabFor('changelog')).toBe('more');
  });
});
