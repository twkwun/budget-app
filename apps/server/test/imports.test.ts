/** File import: invented fixtures only. */
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CreatedWebhookToken,
  ImportBatchInfo,
  ImportPreview,
  ImportRowsPage,
  TransactionInfo,
  TransactionPage,
} from '@budget/shared';
import { importBatches, rawRecords, transactions } from '../src/db/schema.ts';
import { deleteExpiredPreviews } from '../src/importer/service.ts';
import {
  encryptXlsx,
  makeBanksalad,
  makeCsv,
  makeHtmlXls,
  makeXls,
  type FixtureCell,
} from './support/files.ts';
import { ORIGIN, type TestClient } from './support/client.ts';
import { addAccount, addTx, code, ledgerSetup } from './support/ledger.ts';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const CARD = '신한카드 1234';
const BANK = '우리 생활비 통장';
const row = (
  date: string,
  time: string,
  type: string,
  major: string,
  minor: string,
  merchant: string,
  amount: number,
  payment = CARD,
  currency = 'KRW',
  memo = '',
): FixtureCell[] => [date, time, type, major, minor, merchant, amount, currency, payment, memo];

const BASE: FixtureCell[][] = [
  row('2026-11-01', '12:30', '지출', '식비', '카페', '구름카페 강남점', -5500),
  row('2026-11-02', '19:10', '지출', '식비', '외식', '달빛분식', -12000),
  row('2026-11-03', '09:00', '수입', '급여', '', '회사급여', 3000000, BANK),
  row('2026-11-04', '10:00', '이체', '이체', '', '카드대금', -500000, BANK),
  row('2026-11-05', '15:00', '지출', '쇼핑', '온라인쇼핑', '초록온라인몰', -30000),
  row(
    '2026-11-06',
    '15:00',
    '지출',
    '쇼핑',
    '온라인쇼핑',
    '초록온라인몰',
    12000,
    CARD,
    'KRW',
    '부분환불',
  ),
  row('2026-11-07', '08:00', '지출', '교통', '택시', '하늘택시', -8000, '현금'),
  row('2026-11-08', '12:00', '지출', '식비', '카페', '구름카페 강남점', -4500),
  row('2026-11-08', '12:00', '지출', '식비', '카페', '구름카페 강남점', -4500),
  row('2026-11-09', '20:00', '지출', '여행', '', 'EXAMPLE HOTEL', -120, CARD, 'USD'),
];

async function setup() {
  const t = await ledgerSetup();
  close = () => t.app.close();
  const card = await addAccount(t.admin, { name: '신한카드', issuer: 'shinhan', last4: '1234' });
  const bank = await addAccount(t.admin, {
    kind: 'bank',
    name: '생활비 통장',
    issuer: 'woori',
    last4: '5678',
  });
  const upload = (
    client: TestClient,
    bytes: Buffer,
    opts: { password?: string; name?: string } = {},
  ) =>
    t.app.inject({
      method: 'POST',
      url: '/api/imports',
      headers: {
        origin: ORIGIN,
        cookie: (client as unknown as { cookie: string }).cookie,
        'content-type': 'application/octet-stream',
        'x-file-name': encodeURIComponent(opts.name ?? '가계부.xlsx'),
        ...(opts.password ? { 'x-file-password': encodeURIComponent(opts.password) } : {}),
      },
      payload: bytes,
    });
  const rows = async (id: number, outcome?: string) =>
    (
      await t.admin.get(`/api/imports/${id}/rows?limit=200${outcome ? `&outcome=${outcome}` : ''}`)
    ).json<ImportRowsPage>();
  const mapAccounts = (id: number) =>
    t.admin.put(`/api/imports/${id}/accounts`, {
      mappings: [
        { label: CARD, accountId: card.id },
        { label: BANK, accountId: bank.id },
      ],
    });
  const importFile = async (bytes: Buffer, opts: { password?: string } = {}) => {
    const res = await upload(t.admin, bytes, opts);
    expect(res.statusCode, res.body).toBe(201);
    const p = res.json<ImportPreview>();
    await mapAccounts(p.batch.id);
    return p.batch.id;
  };
  const apply = async (id: number) => {
    const res = await t.admin.post(`/api/imports/${id}/apply`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ result: Record<string, number> }>().result;
  };
  const txs = () => t.db.select().from(transactions).all();
  return { ...t, card, bank, upload, rows, importFile, apply, txs };
}

describe('upload, password and preview', () => {
  it('reads an encrypted 뱅크샐러드 file, maps payment methods and categories, and classifies rows', async () => {
    const t = await setup();
    const file = encryptXlsx(makeBanksalad(BASE), '가계부1234', 1000);
    const noPw = await t.upload(t.admin, file);
    expect(noPw.statusCode).toBe(422);
    expect(code(noPw)).toBe('password_required');
    expect(code(await t.upload(t.admin, file, { password: 'wrong' }))).toBe('password_invalid');
    expect(t.db.select().from(importBatches).all()).toEqual([]);

    const res = await t.upload(t.admin, file, { password: '가계부1234' });
    expect(res.statusCode).toBe(201);
    const p = res.json<ImportPreview>();
    expect(p.batch).toMatchObject({
      format: 'banksalad',
      container: 'xlsx',
      status: 'previewed',
      rowCount: 10,
    });
    expect(p.sheetName).toBe('가계부 내역');
    expect(p.missing).toEqual([]);
    const byLabel = Object.fromEntries(p.accounts.map((a) => [a.label, a]));
    expect(byLabel[CARD]).toMatchObject({ rows: 7, accountId: t.card.id, saved: false });
    expect(byLabel['현금']).toMatchObject({ accountId: null });
    const cats = Object.fromEntries(p.categories.map((c) => [c.key, c.categoryId]));
    expect(cats['expense:식비/카페']).toBe(t.cat('식비/카페·간식'));
    expect(cats['expense:교통/택시']).toBe(t.cat('교통·차량/택시'));
    expect(cats['income:급여']).toBe(t.cat('근로소득/급여'));
    expect(p.batch.counts).toMatchObject({ new: 8, cancel: 1, error: 1 });
    const errorRow = (await t.rows(p.batch.id, 'error')).rows[0]!;
    expect(errorRow.error).toBe('foreign_currency');
    // The file itself is not stored anywhere.
    expect(JSON.stringify(t.db.select().from(importBatches).all())).not.toContain('가계부1234');
  });

  it('creates transactions with transfers, refunds, mapped categories and owners', async () => {
    const t = await setup();
    const id = await t.importFile(makeBanksalad(BASE));
    const result = await t.apply(id);
    expect(result).toMatchObject({ created: 8, cancelled: 1, errors: 1, already: 0 });
    const all = t.txs();
    const byMerchant = (m: string) => all.filter((x) => x.merchant === m);
    expect(byMerchant('카드대금')[0]).toMatchObject({
      type: 'transfer',
      categoryId: null,
      accountId: t.bank.id,
    });
    expect(byMerchant('회사급여')[0]).toMatchObject({
      type: 'income',
      categoryId: t.cat('근로소득/급여'),
    });
    expect(byMerchant('초록온라인몰')[0]).toMatchObject({
      amount: 18000,
      originalAmount: 30000,
      source: 'file',
    });
    expect(byMerchant('구름카페 강남점')).toHaveLength(3); // the two identical rows both survive
    expect(byMerchant('하늘택시')[0]).toMatchObject({
      accountId: null,
      categoryId: t.cat('교통·차량/택시'),
    });
    const first = byMerchant('구름카페 강남점')[0]!;
    expect(first.occurredDate).toBe('2026-11-01');
    expect(first.occurredAt.toISOString()).toBe('2026-11-01T03:30:00.000Z');
    const history = (await t.admin.get('/api/imports')).json<ImportBatchInfo[]>();
    expect(history[0]).toMatchObject({ status: 'applied', result: { created: 8 } });
  });
});

describe('re-import safety', () => {
  it('adds nothing when the same file is imported again, even after edits and deletions', async () => {
    const t = await setup();
    await t.apply(await t.importFile(makeBanksalad(BASE)));
    const before = t.txs().length;
    // The family edits one and deletes another on purpose.
    const cafe = t.txs().find((x) => x.merchant === '달빛분식')!;
    await t.admin.patch(`/api/transactions/${cafe.id}`, {
      amount: 13000,
      categoryId: t.cat('식비/배달'),
      merchant: '달빛 분식 (수정)',
    });
    const taxi = t.txs().find((x) => x.merchant === '하늘택시')!;
    await t.admin.delete(`/api/transactions/${taxi.id}`);

    const again = await t.importFile(makeBanksalad(BASE));
    const p = (await t.admin.get(`/api/imports/${again}`)).json<ImportPreview>();
    expect(p.batch.counts).toEqual({ already: 9, error: 1 });
    expect(await t.apply(again)).toMatchObject({
      created: 0,
      attached: 0,
      cancelled: 0,
      already: 9,
    });
    expect(t.txs()).toHaveLength(before - 1);
    expect(t.txs().find((x) => x.id === cafe.id)).toMatchObject({
      amount: 13000,
      categoryId: t.cat('식비/배달'),
    });
    expect(t.txs().some((x) => x.merchant === '하늘택시')).toBe(false);
  });

  it('imports only the new rows of an overlapping later export', async () => {
    const t = await setup();
    await t.apply(await t.importFile(makeBanksalad(BASE.slice(0, 8))));
    const later = [
      ...BASE.slice(4, 10),
      row('2026-11-10', '10:00', '지출', '식비', '외식', '골목국수', -9000),
      row('2026-11-11', '11:00', '지출', '생활', '편의점', '별빛편의점', -3300),
    ];
    const id = await t.importFile(makeBanksalad(later));
    const p = (await t.admin.get(`/api/imports/${id}`)).json<ImportPreview>();
    // Rows 5–8 were imported before (incl. the refund); the second identical café row is new.
    expect(p.batch.counts).toMatchObject({ already: 4, new: 3, error: 1 });
    expect(await t.apply(id)).toMatchObject({ created: 3, already: 4 });
    expect(t.txs().filter((x) => x.merchant === '구름카페 강남점')).toHaveLength(3);
  });

  it('keeps rows the person skipped from coming back', async () => {
    const t = await setup();
    await addTx(t.admin, { amount: 12000, occurredAt: '2026-11-02T18:00:00+09:00' }); // no merchant → ambiguous
    const id = await t.importFile(makeBanksalad(BASE.slice(0, 2)));
    expect(
      (await t.admin.get(`/api/imports/${id}`)).json<ImportPreview>().batch.counts,
    ).toMatchObject({ review: 1, new: 1 });
    const blocked = await t.admin.post(`/api/imports/${id}/apply`);
    expect(blocked.statusCode).toBe(409);
    expect(code(blocked)).toBe('import_invalid');
    await t.admin.put(`/api/imports/${id}/decisions`, {
      bulk: { outcome: 'review', decision: 'skip' },
    });
    expect(await t.apply(id)).toMatchObject({ created: 1, skipped: 1 });
    const again = await t.importFile(makeBanksalad(BASE.slice(0, 2)));
    expect((await t.admin.get(`/api/imports/${again}`)).json<ImportPreview>().batch.counts).toEqual(
      { already: 2 },
    );
  });
});

describe('SMS and file agree on one transaction', () => {
  async function sms(t: Awaited<ReturnType<typeof setup>>, text: string, at: string) {
    const token = (
      await t.admin.post('/api/me/webhook-tokens', { deviceName: 'p' })
    ).json<CreatedWebhookToken>().token;
    return t.app.inject({
      method: 'POST',
      url: '/api/webhook/sms',
      headers: { authorization: `Bearer ${token}` },
      payload: { text, receivedAt: at },
    });
  }

  it('SMS first, then import: the row attaches and the transaction is 확인됨', async () => {
    const t = await setup();
    await sms(
      t,
      '신한카드(1234)승인 홍*동 12,000원(일시불)11/02 19:10 달빛분식',
      '2026-11-02T19:11:00+09:00',
    );
    const id = await t.importFile(makeBanksalad(BASE.slice(0, 2)));
    expect((await t.rows(id, 'duplicate')).rows[0]!.match?.merchant).toBe('달빛분식');
    expect(await t.apply(id)).toMatchObject({ created: 1, attached: 1 });
    expect(t.txs()).toHaveLength(2);
    const page = (await t.admin.get('/api/transactions?month=2026-11')).json<TransactionPage>();
    const tx = page.items.find((x) => x.merchant === '달빛분식')!;
    expect(tx).toMatchObject({ confirmed: true, hasSms: true });
    expect(tx.sources.sort()).toEqual(['file', 'sms']);
  });

  it('import first, then SMS: the SMS attaches to the imported transaction', async () => {
    const t = await setup();
    await t.apply(await t.importFile(makeBanksalad(BASE.slice(0, 1))));
    const res = await sms(
      t,
      '신한카드(1234)승인 홍*동 5,500원(일시불)11/01 12:30 구름카페강남점',
      '2026-11-01T12:31:00+09:00',
    );
    expect(res.json()).toMatchObject({ result: 'attached' });
    expect(t.txs()).toHaveLength(1);
  });

  it('fills the real merchant and category into a 간편결제 placeholder, never the amount', async () => {
    const t = await setup();
    const placeholder = await addTx(t.admin, {
      amount: 30000,
      merchant: '네이버페이',
      accountId: t.card.id,
      occurredAt: '2026-11-05T14:00:00+09:00',
    });
    expect(placeholder.categoryId).toBeNull();
    const id = await t.importFile(makeBanksalad(BASE.slice(4, 5)));
    expect(await t.apply(id)).toMatchObject({ attached: 1, created: 0 });
    const tx = (await t.admin.get(`/api/transactions/${placeholder.id}`)).json<TransactionInfo>();
    expect(tx).toMatchObject({
      merchant: '초록온라인몰',
      amount: 30000,
      categoryId: t.cat('쇼핑/온라인쇼핑'),
      confirmed: true,
    });
  });

  it('date-only rows still match an SMS with a real time', async () => {
    const t = await setup();
    await sms(
      t,
      '신한카드(1234)승인 홍*동 9,000원(일시불)11/10 23:40 골목국수',
      '2026-11-10T23:41:00+09:00',
    );
    const csv = makeCsv(
      [
        ['카드 이용내역'],
        ['이용일자', '이용가맹점', '이용금액'],
        ['2026.11.11', '골목국수', '9,000'],
      ],
      'cp949',
    );
    const res = await t.upload(t.admin, csv, { name: '이용내역.csv' });
    const p = res.json<ImportPreview>();
    await t.admin.put(`/api/imports/${p.batch.id}/accounts`, {
      mappings: [{ label: '', accountId: t.card.id }],
    });
    expect(
      (await t.admin.get(`/api/imports/${p.batch.id}`)).json<ImportPreview>().batch.counts,
    ).toEqual({ duplicate: 1 });
  });
});

describe('undo', () => {
  it('removes created rows, detaches attachments, restores cancels, and allows re-import', async () => {
    const t = await setup();
    const manual = await addTx(t.admin, {
      amount: 12000,
      merchant: '달빛분식',
      occurredAt: '2026-11-02T19:00:00+09:00',
    });
    const id = await t.importFile(makeBanksalad(BASE.slice(0, 6)));
    await t.apply(id);
    expect(t.txs()).toHaveLength(5);
    const undo = await t.admin.post(`/api/imports/${id}/undo`, {});
    expect(undo.statusCode).toBe(200);
    expect(undo.json<{ report: Record<string, number> }>().report).toMatchObject({
      deleted: 4,
      detached: 1,
      edited: 0,
    });
    expect(t.txs().map((x) => x.id)).toEqual([manual.id]);
    expect(t.db.select().from(rawRecords).all()).toEqual([]);
    const again = await t.importFile(makeBanksalad(BASE.slice(0, 6)));
    expect(
      (await t.admin.get(`/api/imports/${again}`)).json<ImportPreview>().batch.counts,
    ).toMatchObject({ new: 4, duplicate: 1, cancel: 1 });
  });

  it('asks before touching transactions edited after the import', async () => {
    const t = await setup();
    const id = await t.importFile(makeBanksalad(BASE.slice(0, 2)));
    await t.apply(id);
    t.clock.advance(1000);
    const one = t.txs()[0]!;
    await t.admin.patch(`/api/transactions/${one.id}`, { memo: '확인함' });
    const blocked = await t.admin.post(`/api/imports/${id}/undo`, {});
    expect(blocked.statusCode).toBe(409);
    expect(code(blocked)).toBe('undo_conflict');
    expect(t.txs()).toHaveLength(2);
    const forced = await t.admin.post(`/api/imports/${id}/undo`, { confirm: true });
    expect(forced.json<{ report: Record<string, number> }>().report).toMatchObject({
      deleted: 2,
      edited: 1,
    });
    expect(t.txs()).toHaveLength(0);
  });
});

describe('layouts and mapping', () => {
  it('asks for columns it cannot identify and remembers the mapping for the next file', async () => {
    const t = await setup();
    const rows: FixtureCell[][] = [
      ['When', 'Where', 'How much', 'Note'],
      ['2026-11-12 10:00', '바다주유소', '50,000', ''],
      ['2026-11-13 11:00', '하늘택시', '7,000', ''],
    ];
    const first = (
      await t.upload(t.admin, makeCsv(rows, 'utf8'), { name: 'x.csv' })
    ).json<ImportPreview>();
    expect(first.batch.status).toBe('needs_mapping');
    expect(first.missing).toEqual(['date', 'amount']);
    expect(first.sample[0]).toEqual(['2026-11-12 10:00', '바다주유소', '50,000', '']);
    expect((await t.admin.post(`/api/imports/${first.batch.id}/apply`)).statusCode).toBe(409);
    const mapped = (
      await t.admin.put(`/api/imports/${first.batch.id}/columns`, {
        columnMap: { date: 0, merchant: 1, amount: 2, memo: 3 },
      })
    ).json<ImportPreview>();
    expect(mapped.batch).toMatchObject({ status: 'previewed', counts: { new: 2 } });
    const second = (
      await t.upload(
        t.admin,
        makeCsv([...rows.slice(0, 1), ['2026-11-14 09:00', '별빛서점', '15,000', '']], 'cp949'),
        { name: 'y.csv' },
      )
    ).json<ImportPreview>();
    expect(second.batch.status).toBe('previewed');
    expect(second.columnMap).toEqual({ date: 0, merchant: 1, amount: 2, memo: 3 });
  });

  it('recognises common Korean column names without asking', async () => {
    const t = await setup();
    const csv = makeCsv(
      [
        ['일시', '상점', '결제액'],
        ['2026-11-12 10:00', '바다주유소', '50,000'],
      ],
      'cp949',
    );
    const p = (await t.upload(t.admin, csv)).json<ImportPreview>();
    expect(p.batch.status).toBe('previewed');
    expect(p.columnMap).toEqual({ date: 0, merchant: 1, amount: 2 });
  });

  it('reads a card .xls with title rows, approval numbers and a cancellation', async () => {
    const t = await setup();
    const xls = makeXls([
      ['신한카드 이용대금 명세 (테스트)'],
      ['조회기간', '2026.11.01 ~ 2026.11.30'],
      [],
      ['이용일자', '이용가맹점', '이용금액', '할부', '승인번호', '취소여부'],
      [{ date: '2026-11-15 13:00' }, '모노가전', 360000, '3개월', '11112222', ''],
      [{ date: '2026-11-16 09:30' }, '모노가전', 360000, '3개월', '11112223', '취소'],
      [{ date: '2026-11-17 09:30' }, '별빛편의점', 4200, '일시불', '11112224', ''],
    ]);
    const p = (await t.upload(t.admin, xls, { name: '이용내역.xls' })).json<ImportPreview>();
    expect(p.batch).toMatchObject({ container: 'xls', status: 'previewed', format: 'generic' });
    await t.admin.put(`/api/imports/${p.batch.id}/accounts`, {
      mappings: [{ label: '', accountId: t.card.id }],
    });
    expect(await t.apply(p.batch.id)).toMatchObject({ created: 2, cancelled: 1 });
    const gadget = t.txs().find((x) => x.merchant === '모노가전')!;
    expect(gadget).toMatchObject({
      status: 'cancelled',
      installmentMonths: 3,
      approvalNo: '11112222',
      accountId: t.card.id,
    });
  });

  it('proposes bank card-bill payments as 이체, decided in bulk', async () => {
    const t = await setup();
    const html = makeHtmlXls([
      ['거래내역 조회'],
      ['거래일시', '적요', '출금액', '입금액', '거래후잔액'],
      ['2026-11-14 06:00:00', '신한카드 대금', '1,240,000', '', '3,000,000'],
      ['2026-11-20 09:00:00', '행복마트', '23,000', '', '2,977,000'],
      ['2026-11-25 09:00:00', '급여 (테스트회사)', '', '3,850,000', '6,827,000'],
    ]);
    const p = (await t.upload(t.admin, html, { name: '거래내역.xls' })).json<ImportPreview>();
    expect(p.batch).toMatchObject({ container: 'html', transferSuggestions: 1 });
    await t.admin.put(`/api/imports/${p.batch.id}/accounts`, {
      mappings: [{ label: '', accountId: t.bank.id }],
    });
    const transfers = await t.rows(p.batch.id, 'transfer');
    expect(transfers.rows.map((r) => r.merchant)).toEqual(['신한카드 대금']);
    expect(transfers.rows[0]).toMatchObject({ transfer: true, suggestedTransfer: true });
    await t.apply(p.batch.id);
    const types = Object.fromEntries(t.txs().map((x) => [x.merchant, x.type]));
    expect(types).toEqual({
      '신한카드 대금': 'transfer',
      행복마트: 'expense',
      '급여 (테스트회사)': 'income',
    });
  });
});

describe('categorisation history is by transaction time', () => {
  it('old imported rows never override a newer choice', async () => {
    const t = await setup();
    await addTx(t.admin, {
      amount: 20000,
      merchant: '모노의류',
      categoryId: t.cat('쇼핑/의류·잡화'),
      occurredAt: '2026-11-20T12:00:00+09:00',
    });
    const old = makeBanksalad([row('2026-06-01', '12:00', '지출', '선물', '', '모노의류', -50000)]);
    const id = await t.importFile(old);
    await t.admin.put(`/api/imports/${id}/categories`, {
      mappings: [{ key: 'expense:선물', categoryId: t.cat('경조사·선물/선물') }],
    });
    await t.apply(id);
    expect(t.txs().find((x) => x.occurredDate === '2026-06-01')!.categoryId).toBe(
      t.cat('경조사·선물/선물'),
    );
    const fresh = await addTx(t.admin, {
      amount: 10000,
      merchant: '모노의류',
      occurredAt: '2026-11-22T12:00:00+09:00',
    });
    expect(fresh.categoryId).toBe(t.cat('쇼핑/의류·잡화'));
  });
});

describe('limits, hostile files and housekeeping', () => {
  it('rejects oversized, overlong, unknown and empty files', async () => {
    const t = await setup();
    expect((await t.upload(t.admin, Buffer.alloc(10 * 1024 * 1024 + 10, 0x41))).statusCode).toBe(
      413,
    );
    const many = makeCsv(
      [
        ['날짜', '내용', '금액'],
        ...Array.from({ length: 20_001 }, (_, i) => ['2026-11-01', `가게${i}`, 1000]),
      ],
      'utf8',
    );
    expect(code(await t.upload(t.admin, many))).toBe('too_many_rows');
    expect(
      code(
        await t.upload(t.admin, Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 13) % 7))),
      ),
    ).toBe('unsupported_format');
    expect(code(await t.upload(t.admin, makeCsv([['날짜', '내용', '금액']], 'utf8')))).toBe(
      'no_rows',
    );
    expect(code(await t.upload(t.admin, Buffer.from('PK\u0003\u0004 not really a zip')))).toBe(
      'corrupt_file',
    );
  });

  it('keeps batches private to the uploader and deletes stale previews after 24h', async () => {
    const t = await setup();
    const p = (await t.upload(t.admin, makeBanksalad(BASE.slice(0, 2)))).json<ImportPreview>();
    expect((await t.member.get(`/api/imports/${p.batch.id}`)).statusCode).toBe(404);
    expect((await t.member.get('/api/imports')).json()).toEqual([]);
    expect(deleteExpiredPreviews(t.db, t.clock.now() + 23 * 3600_000)).toBe(0);
    expect(deleteExpiredPreviews(t.db, t.clock.now() + 25 * 3600_000)).toBe(1);
    expect(
      t.db.select().from(rawRecords).where(eq(rawRecords.importBatchId, p.batch.id)).all(),
    ).toEqual([]);
  });
});

describe('undo keeps what other sources also reported', () => {
  it('hands a transaction to the SMS that later attached to it instead of deleting it', async () => {
    const t = await setup();
    const id = await t.importFile(makeBanksalad(BASE.slice(0, 1)));
    await t.apply(id);
    const token = (
      await t.admin.post('/api/me/webhook-tokens', { deviceName: 'p' })
    ).json<CreatedWebhookToken>().token;
    await t.app.inject({
      method: 'POST',
      url: '/api/webhook/sms',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        text: '신한카드(1234)승인 홍*동 5,500원(일시불)11/01 12:30 구름카페강남점',
        receivedAt: '2026-11-01T12:31:00+09:00',
      },
    });
    const forced = await t.admin.post(`/api/imports/${id}/undo`, { confirm: true });
    expect(forced.statusCode).toBe(200);
    expect(t.txs()).toHaveLength(1);
    expect(t.txs()[0]).toMatchObject({ source: 'sms', merchant: '구름카페 강남점' });
  });
});
