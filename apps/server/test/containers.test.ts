/** Container readers against generated, invented fixtures. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readWorkbook } from '../src/importer/read.ts';
import { isParseResult, parseFileInWorker } from '../src/importer/parse-file.ts';
import { ImportFileError } from '../src/importer/types.ts';
import {
  encryptXlsx,
  makeBanksalad,
  makeCsv,
  makeHtmlXls,
  makeXls,
  makeXlsx,
  type FixtureCell,
} from './support/files.ts';

const ROWS: FixtureCell[][] = [
  ['신한카드 이용내역 (2026.11.01 ~ 2026.11.30)'],
  [],
  ['이용일자', '이용가맹점', '이용금액', '승인번호'],
  [{ date: '2026-11-22 14:05' }, '구름카페 강남점', 12300, '00012345'],
  ['2026.11.23', '달빛분식, 본점', 9000.5, '00012346'],
];

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof ImportFileError ? e.code : 'other';
  }
  return undefined;
}

describe('container readers', () => {
  it('reads .xlsx values, date-formatted cells and cached formula values only', () => {
    const wb = readWorkbook(makeXlsx([{ name: '이용내역', rows: ROWS }], { formulaCell: true }));
    expect(wb.container).toBe('xlsx');
    const rows = wb.sheets[0]!.rows;
    expect(rows[0]).toEqual(['신한카드 이용내역 (2026.11.01 ~ 2026.11.30)']);
    expect(rows[2]).toEqual(['2026-11-22 14:05:00', '구름카페 강남점', 12300, '00012345']);
    expect(rows.at(-1)).toEqual([2]);
  });

  it('decrypts an agile-encrypted .xlsx with the right password only', () => {
    const encrypted = encryptXlsx(
      makeBanksalad([
        ['2026-11-22', '14:05', '지출', '식비', '카페', '구름카페', -4500, 'KRW', '신한카드', ''],
      ]),
      '비밀번호1234',
      1000,
    );
    expect(errorCode(() => readWorkbook(encrypted))).toBe('password_required');
    expect(errorCode(() => readWorkbook(encrypted, 'wrong'))).toBe('password_invalid');
    const wb = readWorkbook(encrypted, '비밀번호1234');
    expect(wb).toMatchObject({ container: 'xlsx', encrypted: true });
    expect(wb.sheets.map((s) => s.name)).toEqual(['뱅샐현황', '가계부 내역']);
    expect(wb.sheets[1]!.rows[1]).toEqual([
      '2026-11-22',
      '14:05',
      '지출',
      '식비',
      '카페',
      '구름카페',
      -4500,
      'KRW',
      '신한카드',
      '',
    ]);
  });

  it('reads BIFF8 .xls including CONTINUE-split shared strings, RK and dates', () => {
    const long = '가'.repeat(5000);
    const many: FixtureCell[][] = Array.from({ length: 400 }, (_, i) => [
      `가맹점${i}번지점입니다`,
      i * 100,
    ]);
    const wb = readWorkbook(makeXls([...ROWS, [long, 1], ...many]));
    expect(wb.container).toBe('xls');
    const rows = wb.sheets[0]!.rows;
    expect(rows[2]).toEqual(['2026-11-22 14:05:00', '구름카페 강남점', 12300, '00012345']);
    expect(rows[3]).toEqual(['2026.11.23', '달빛분식, 본점', 9000.5, '00012346']);
    // The 10,000-byte string spans CONTINUE records; cells are capped at 2,000 characters.
    expect(rows[4]).toEqual([long.slice(0, 2000), 1]);
    expect(rows.at(-1)).toEqual(['가맹점399번지점입니다', 39900]);
  });

  it.each(['cp949', 'utf8', 'utf8bom'] as const)('reads CSV in %s', (enc) => {
    const wb = readWorkbook(makeCsv(ROWS, enc));
    expect(wb.container).toBe('csv');
    expect(wb.sheets[0]!.rows[2]).toEqual([
      '2026-11-22 14:05',
      '구름카페 강남점',
      '12300',
      '00012345',
    ]);
    expect(wb.sheets[0]!.rows[3]![1]).toBe('달빛분식, 본점');
  });

  it('reads tab-separated text', () => {
    expect(readWorkbook(makeCsv(ROWS, 'utf8', '\t')).sheets[0]!.rows[2]![1]).toBe(
      '구름카페 강남점',
    );
  });

  it.each(['euc-kr', 'utf-8'] as const)('reads an HTML table saved as .xls (%s)', (charset) => {
    const wb = readWorkbook(makeHtmlXls(ROWS, charset));
    expect(wb.container).toBe('html');
    expect(wb.sheets[0]!.rows[2]).toEqual([
      '2026-11-22 14:05',
      '구름카페 강남점',
      '12300',
      '00012345',
    ]);
  });

  it('rejects hostile or malformed files', () => {
    expect(errorCode(() => readWorkbook(Buffer.alloc(0)))).toBe('corrupt_file');
    expect(errorCode(() => readWorkbook(Buffer.alloc(11 * 1024 * 1024)))).toBe('file_too_large');
    expect(errorCode(() => readWorkbook(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])))).toBe(
      'corrupt_file',
    );
    expect(
      errorCode(() =>
        readWorkbook(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])),
      ),
    ).toBe('corrupt_file');
    expect(
      errorCode(() =>
        readWorkbook(Buffer.from(Array.from({ length: 4000 }, (_, i) => (i * 7) % 9))),
      ),
    ).toBe('unsupported_format');
    const tooMany = makeCsv(
      Array.from({ length: 20_200 }, (_, i) => [`2026-11-01`, `가게${i}`, 1000]),
      'utf8',
    );
    expect(errorCode(() => readWorkbook(tooMany))).toBe('too_many_rows');
  });
});

describe('worker isolation', () => {
  it('parses in a worker and reports errors with codes', async () => {
    const wb = await parseFileInWorker(makeXlsx([{ name: 'a', rows: ROWS }]));
    expect(wb.sheets[0]!.rows[2]![1]).toBe('구름카페 강남점');
    await expect(
      parseFileInWorker(encryptXlsx(makeXlsx([{ name: 'a', rows: ROWS }]), 'pw', 10)),
    ).rejects.toMatchObject({ code: 'password_required' });
  });

  it('ignores watch-mode dependency messages from the worker', () => {
    expect(isParseResult({ 'watch:import': ['file:///x.ts'] })).toBe(false);
    expect(isParseResult({ 'watch:require': [null] })).toBe(false);
    expect(isParseResult(null)).toBe(false);
    expect(isParseResult({ ok: true, workbook: { sheets: [] } })).toBe(true);
    expect(isParseResult({ ok: false, code: 'corrupt_file', message: 'x' })).toBe(true);
  });

  it('parses in a worker under node --watch (pnpm dev)', async () => {
    const script = fileURLToPath(new URL('./support/watch-parse.ts', import.meta.url));
    const child = spawn(
      process.execPath,
      ['--conditions=@budget/source', '--watch', '--no-warnings', script],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    try {
      const line = await new Promise<string>((resolve, reject) => {
        let out = '';
        const timer = setTimeout(() => reject(new Error(`no result: ${out}`)), 15_000);
        child.stdout.on('data', (chunk: Buffer) => {
          out += chunk.toString();
          const found = out.split('\n').find((l) => l.startsWith('{'));
          if (found) {
            clearTimeout(timer);
            resolve(found);
          }
        });
        child.once('error', reject);
      });
      expect(JSON.parse(line)).toEqual({ ok: true, sheets: ['a'] });
    } finally {
      // --watch keeps waiting for file changes after the script ends.
      child.kill();
    }
  }, 20_000);

  it('times out instead of blocking', async () => {
    // A tiny timeout stands in for a pathological file.
    await expect(
      parseFileInWorker(makeXlsx([{ name: 'a', rows: ROWS }]), undefined, 1),
    ).rejects.toMatchObject({ code: 'parse_timeout' });
  });
});
