/** Timing of a 20,000-row 뱅크샐러드-shaped import (invented rows). Printed; generous limits. */
import { describe, expect, it } from 'vitest';
import type { ImportPreview } from '@budget/shared';
import { encryptXlsx, makeBanksalad, type FixtureCell } from './support/files.ts';
import { ORIGIN } from './support/client.ts';
import { addAccount, ledgerSetup } from './support/ledger.ts';

describe('import performance', () => {
  it('imports 20,000 rows and re-imports them as already imported', async () => {
    const t = await ledgerSetup();
    await addAccount(t.admin, { name: '신한카드', issuer: 'shinhan', last4: '1234' });
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const merchants = [
      '구름카페',
      '달빛분식',
      '행복마트',
      '초록약국',
      '바다주유소',
      '별빛서점',
      '하늘택시',
      '모노의류',
    ];
    const rows: FixtureCell[][] = Array.from({ length: 20_000 }, (_, i) => {
      const day = new Date(Date.UTC(2025, 0, 1) + Math.floor((i / 20_000) * 690) * 86400000);
      const date = day.toISOString().slice(0, 10);
      const time = `${String(8 + Math.floor(rnd() * 14)).padStart(2, '0')}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}`;
      return [
        date,
        time,
        '지출',
        '식비',
        '외식',
        `${merchants[i % merchants.length]} ${i % 37}호점`,
        -(1000 + Math.floor(rnd() * 99) * 100),
        'KRW',
        '신한카드 1234',
        '',
      ];
    });
    const plain = makeBanksalad(rows);
    let start = performance.now();
    const encrypted = encryptXlsx(plain, '가계부1234');
    const encryptMs = performance.now() - start;

    const upload = (bytes: Buffer, password?: string) =>
      t.app.inject({
        method: 'POST',
        url: '/api/imports',
        headers: {
          origin: ORIGIN,
          cookie: (t.admin as unknown as { cookie: string }).cookie,
          'content-type': 'application/octet-stream',
          ...(password ? { 'x-file-password': encodeURIComponent(password) } : {}),
        },
        payload: bytes,
      });

    start = performance.now();
    const res = await upload(encrypted, '가계부1234');
    const uploadMs = performance.now() - start;
    expect(res.statusCode, res.body).toBe(201);
    const p = res.json<ImportPreview>();
    expect(p.batch.counts.new).toBe(20_000);

    start = performance.now();
    const applied = await t.admin.post(`/api/imports/${p.batch.id}/apply`);
    const applyMs = performance.now() - start;
    expect(applied.json<{ result: { created: number } }>().result.created).toBe(20_000);

    start = performance.now();
    const again = (await upload(plain)).json<ImportPreview>();
    const reuploadMs = performance.now() - start;
    expect(again.batch.counts).toEqual({ already: 20_000 });

    // The server keeps answering while a large file is processed.
    const [, health] = await Promise.all([
      upload(plain),
      t.app.inject({ method: 'GET', url: '/api/health' }),
    ]);
    expect(health.statusCode).toBe(200);

    const timings = {
      'file size (bytes, encrypted)': encrypted.length,
      'fixture encryption (ms)': Math.round(encryptMs),
      'upload: decrypt + parse + store + analyse (ms)': Math.round(uploadMs),
      'apply 20,000 new rows (ms)': Math.round(applyMs),
      're-upload same rows → all 이미 가져옴 (ms)': Math.round(reuploadMs),
    };
    console.table(timings);
    expect(uploadMs + applyMs).toBeLessThan(120_000);
    await t.app.close();
  }, 300_000);
});
