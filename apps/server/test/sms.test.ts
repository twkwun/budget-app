/** All message texts are invented. */
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CreatedWebhookToken,
  InboxList,
  MonthSummary,
  RuleList,
  SmsPreview,
  TransactionInfo,
  TransactionPage,
  WebhookResponse,
  WebhookTokenInfo,
} from '@budget/shared';
import { rawRecords, transactions } from '../src/db/schema.ts';
import { reprocessRawRecords } from '../src/sms/ingest.ts';
import { ORIGIN } from './support/client.ts';
import { addAccount, addTx, code, ledgerSetup } from './support/ledger.ts';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const SHINHAN = (amount: string, time: string, merchant: string, kind = '승인', digits = '1234') =>
  `[Web발신]\n신한카드(${digits})${kind} 홍*동 ${amount}원(일시불)${time} ${merchant} 누적1,234,567원`;

async function setup() {
  const t = await ledgerSetup();
  close = () => t.app.close();
  const created = (
    await t.admin.post('/api/me/webhook-tokens', { deviceName: '엄마 아이폰' })
  ).json<CreatedWebhookToken>();
  const send = (
    text: string,
    extra: Record<string, unknown> = {},
    opts: { token?: string; ip?: string } = {},
  ) =>
    t.app.inject({
      method: 'POST',
      url: '/api/webhook/sms',
      headers: { authorization: `Bearer ${opts.token ?? created.token}` },
      remoteAddress: opts.ip ?? '100.64.0.10',
      payload: { text, ...extra },
    });
  const at = (iso: string) => ({ receivedAt: iso });
  const txs = () => t.db.select().from(transactions).all();
  const inbox = async () => (await t.admin.get('/api/inbox')).json<InboxList>();
  return { ...t, token: created, send, at, txs, inbox };
}

describe('webhook authentication and limits', () => {
  it('needs a valid, unrevoked token and no session or Origin', async () => {
    const t = await setup();
    expect(t.token.token).toMatch(/^bgt_[\w-]{43}$/);
    expect(t.token.url).toBe(`${ORIGIN}/api/webhook/sms`);
    const bad = await t.send('x', {}, { token: 'bgt_wrong' });
    expect(bad.statusCode).toBe(401);
    expect(code(bad)).toBe('invalid_token');
    const none = await t.app.inject({
      method: 'POST',
      url: '/api/webhook/sms',
      payload: { text: 'x' },
    });
    expect(none.statusCode).toBe(401);

    const ok = await t.send(
      SHINHAN('12,300', '11/22 14:05', '구름카페강남점'),
      t.at('2026-11-22T14:05:30+09:00'),
    );
    expect(ok.statusCode).toBe(201);
    expect(ok.json<WebhookResponse>()).toMatchObject({
      ok: true,
      result: 'created',
      message: expect.stringContaining('12,300원'),
    });

    const list = (await t.admin.get('/api/me/webhook-tokens')).json<WebhookTokenInfo[]>();
    expect(list[0]).toMatchObject({
      deviceName: '엄마 아이폰',
      receivedCount: 1,
      revoked: false,
      hint: t.token.token.slice(-4),
    });
    expect((await t.admin.delete(`/api/me/webhook-tokens/${list[0]!.id}`)).statusCode).toBe(204);
    expect((await t.send(SHINHAN('1,000', '11/22 14:06', '구름카페강남점'))).statusCode).toBe(401);
  });

  it('requires re-auth to create tokens and hides other members’ tokens', async () => {
    const t = await setup();
    t.clock.advance(6 * 60_000); // past the 5-minute re-auth window (app lock is off here)
    expect(code(await t.admin.post('/api/me/webhook-tokens', { deviceName: 'x' }))).toBe(
      'reauth_required',
    );
    expect((await t.member.get('/api/me/webhook-tokens')).json()).toEqual([]);
    const id = (await t.admin.get('/api/me/webhook-tokens')).json<WebhookTokenInfo[]>()[0]!.id;
    expect((await t.member.delete(`/api/me/webhook-tokens/${id}`)).statusCode).toBe(404);
  });

  it('enforces body size and per-token rate limits', async () => {
    const t = await setup();
    expect((await t.send('가'.repeat(5000))).statusCode).toBe(413);
    expect((await t.send('a'.repeat(2001))).statusCode).toBe(400);
    let last;
    for (let i = 0; i < 61; i += 1) last = await t.send(`hello ${i}`, {}, { ip: `100.64.1.${i}` });
    expect(last!.statusCode).toBe(429);
  });

  it('accepts a plain-text body', async () => {
    const t = await setup();
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/webhook/sms',
      headers: { authorization: `Bearer ${t.token.token}`, 'content-type': 'text/plain' },
      payload: SHINHAN('5,000', '11/22 10:00', '달빛분식'),
    });
    expect(res.json<WebhookResponse>().result).toBe('created');
  });
});

describe('privacy: non-card messages', () => {
  it.each([
    '[Web발신]\n[신한카드] 인증번호 [482913]를 입력해 주세요.',
    '[Web발신]\n고객님의 택배가 오늘 14~16시 도착 예정입니다.',
    '오늘 저녁 7시에 만나자! 12,000원짜리 케이크 사갈게',
  ])('discards %j without storing its text', async (text) => {
    const t = await setup();
    const res = await t.send(text);
    expect(res.statusCode).toBe(200);
    expect(res.json<WebhookResponse>().result).toBe('ignored');
    expect(t.db.select().from(rawRecords).all()).toEqual([]);
    const dump = t.sqlite
      .prepare("select count(*) n from raw_records where raw_text like '%' || ? || '%'")
      .get(text.slice(-8)) as { n: number };
    expect(dump.n).toBe(0);
    const info = (await t.admin.get('/api/me/webhook-tokens')).json<WebhookTokenInfo[]>()[0]!;
    expect(info).toMatchObject({ ignoredCount: 1, receivedCount: 0 });
    expect(info.lastIgnoredAt).not.toBeNull();
  });
});

describe('redelivery versus separate identical purchases', () => {
  it('keeps one transaction for a redelivery and two for two real purchases', async () => {
    const t = await setup();
    const msg = SHINHAN('4,500', '11/22 08:10', '구름카페');
    const first = await t.send(msg, t.at('2026-11-22T08:10:05+09:00'));
    const again = await t.send(msg, t.at('2026-11-22T08:10:05+09:00'));
    expect(first.json<WebhookResponse>().result).toBe('created');
    expect(again.json<WebhookResponse>()).toMatchObject({
      result: 'duplicate',
      transactionId: first.json<WebhookResponse>().transactionId,
    });
    // Same text, a different receive time: a second identical purchase.
    const second = await t.send(msg, t.at('2026-11-22T08:10:41+09:00'));
    expect(second.json<WebhookResponse>().result).toBe('created');
    expect(t.txs()).toHaveLength(2);

    // Without client times, copies within 2 minutes are redeliveries.
    const other = SHINHAN('7,700', '11/22 12:00', '달빛분식');
    await t.send(other);
    t.clock.advance(60_000);
    expect((await t.send(other)).json<WebhookResponse>().result).toBe('duplicate');
    t.clock.advance(3 * 60_000);
    expect((await t.send(other)).json<WebhookResponse>().result).toBe('created');
  });
});

describe('dates, accounts and owners', () => {
  it('infers the year across the year boundary', async () => {
    const t = await setup();
    const res = await t.send(
      SHINHAN('9,000', '12/31 23:58', '달빛분식'),
      t.at('2027-01-01T00:02:00+09:00'),
    );
    const tx = (
      await t.admin.get(`/api/transactions/${res.json<WebhookResponse>().transactionId}`)
    ).json<TransactionInfo>();
    expect(tx.occurredDate).toBe('2026-12-31');
    expect(tx.occurredAt).toBe('2026-12-31T14:58:00.000Z');
  });

  it('matches issuer and (masked) digits; the primary user owns family-card spending', async () => {
    const t = await setup();
    const card = await addAccount(t.admin, {
      name: '가족카드',
      issuer: 'shinhan',
      last4: '1234',
      primaryUserId: t.memberId,
    });
    const kb = await addAccount(t.admin, { name: 'KB카드', issuer: 'kb', last4: '1534' });
    const a = await t.send(
      SHINHAN('12,300', '11/22 14:05', '구름카페'),
      t.at('2026-11-22T14:06:00+09:00'),
    );
    const txA = (
      await t.admin.get(`/api/transactions/${a.json<WebhookResponse>().transactionId}`)
    ).json<TransactionInfo>();
    expect(txA).toMatchObject({
      accountId: card.id,
      ownerUserId: t.memberId,
      source: 'sms',
      hasSms: true,
    });
    const b = await t.send(
      'KB국민카드1*3*승인\n홍*동\n8,000원 일시불\n11/22 15:00\n골목국수',
      t.at('2026-11-22T15:01:00+09:00'),
    );
    const txB = (
      await t.admin.get(`/api/transactions/${b.json<WebhookResponse>().transactionId}`)
    ).json<TransactionInfo>();
    expect(txB).toMatchObject({ accountId: kb.id, ownerUserId: t.adminId });
  });

  it('registers unmatched cards later and links the earlier entries', async () => {
    const t = await setup();
    await t.send(
      SHINHAN('3,000', '11/20 09:00', '별빛편의점', '승인', '9876'),
      t.at('2026-11-20T09:01:00+09:00'),
    );
    await t.send(
      SHINHAN('6,000', '11/21 09:00', '구름카페', '승인', '9876'),
      t.at('2026-11-21T09:01:00+09:00'),
    );
    let box = await t.inbox();
    const card = box.items.find((i) => i.kind === 'unmatched_card');
    expect(card).toMatchObject({ issuer: 'shinhan', digits: '9876', count: 2, total: 9000 });
    expect((await t.admin.get('/api/inbox/count')).json()).toEqual({ count: box.count });

    const account = await addAccount(t.admin, {
      name: '신한 새카드',
      issuer: 'shinhan',
      last4: '9876',
    });
    expect(t.txs().every((x) => x.accountId === account.id)).toBe(true);
    box = await t.inbox();
    expect(box.items.some((i) => i.kind === 'unmatched_card')).toBe(false);
  });
});

describe('cancellations', () => {
  it('cancels the original fully, or partially keeping original_amount', async () => {
    const t = await setup();
    await addAccount(t.admin, { name: '신한', issuer: 'shinhan', last4: '1234' });
    const full = await t.send(
      SHINHAN('59,000', '11/21 15:00', '모노의류'),
      t.at('2026-11-21T15:01:00+09:00'),
    );
    const cancel = await t.send(
      SHINHAN('59,000', '11/21 16:00', '모노의류', '승인취소'),
      t.at('2026-11-21T16:01:00+09:00'),
    );
    expect(cancel.json<WebhookResponse>()).toMatchObject({
      result: 'cancelled',
      transactionId: full.json<WebhookResponse>().transactionId,
    });
    const cancelled = (
      await t.admin.get(`/api/transactions/${full.json<WebhookResponse>().transactionId}`)
    ).json<TransactionInfo>();
    expect(cancelled.status).toBe('cancelled');

    const big = await t.send(
      SHINHAN('30,000', '11/22 10:00', '행복마트'),
      t.at('2026-11-22T10:01:00+09:00'),
    );
    await t.send(
      SHINHAN('12,000', '11/22 11:00', '행복마트', '취소'),
      t.at('2026-11-22T11:01:00+09:00'),
    );
    const partial = (
      await t.admin.get(`/api/transactions/${big.json<WebhookResponse>().transactionId}`)
    ).json<TransactionInfo>();
    expect(partial).toMatchObject({ amount: 18000, originalAmount: 30000, status: 'confirmed' });
    const s = (await t.admin.get('/api/summary?month=2026-11')).json<MonthSummary>();
    expect(s.expense).toBe(18000);
  });

  it('sends an unmatched cancellation to the inbox and resolves it by picking the original', async () => {
    const t = await setup();
    const manual = await addTx(t.admin, {
      amount: 20000,
      merchant: '바다가구',
      occurredAt: '2026-11-10T12:00:00+09:00',
    });
    const res = await t.send(
      SHINHAN('20,000', '11/22 09:00', '전혀다른가게', '승인취소'),
      t.at('2026-11-22T09:01:00+09:00'),
    );
    expect(res.json<WebhookResponse>().result).toBe('inbox');
    const item = (await t.inbox()).items.find((i) => i.kind === 'unmatched_cancel');
    if (item?.kind !== 'unmatched_cancel') throw new Error('missing item');
    expect(item.candidates.map((c) => c.id)).toContain(manual.id);
    await t.admin.post(`/api/inbox/raw/${item.rawRecordId}/attach`, { transactionId: manual.id });
    expect(
      (await t.admin.get(`/api/transactions/${manual.id}`)).json<TransactionInfo>().status,
    ).toBe('cancelled');
    expect((await t.inbox()).items.some((i) => i.kind === 'unmatched_cancel')).toBe(false);
  });
});

describe('duplicate detection with manual entries', () => {
  it('attaches an SMS to the matching manual entry instead of creating a second one', async () => {
    const t = await setup();
    const manual = await addTx(t.admin, {
      amount: 12300,
      merchant: '구름카페',
      occurredAt: '2026-11-22T14:00:00+09:00',
    });
    const res = await t.send(
      SHINHAN('12,300', '11/22 14:05', '(주)구름카페 강남점'),
      t.at('2026-11-22T14:06:00+09:00'),
    );
    expect(res.json<WebhookResponse>()).toMatchObject({
      result: 'attached',
      transactionId: manual.id,
    });
    expect(t.txs()).toHaveLength(1);
    expect(
      (await t.admin.get(`/api/transactions/${manual.id}`)).json<TransactionInfo>().hasSms,
    ).toBe(true);
  });

  it('creates a new transaction when the same amount is clearly a different merchant', async () => {
    const t = await setup();
    await addTx(t.admin, {
      amount: 4500,
      merchant: '하늘택시',
      occurredAt: '2026-11-22T08:00:00+09:00',
    });
    const res = await t.send(
      SHINHAN('4,500', '11/22 08:30', '구름카페'),
      t.at('2026-11-22T08:31:00+09:00'),
    );
    expect(res.json<WebhookResponse>().result).toBe('created');
  });

  it('asks in the inbox when the match is ambiguous, and can create or attach', async () => {
    const t = await setup();
    const manual = await addTx(t.admin, { amount: 15000, occurredAt: '2026-11-21T20:00:00+09:00' }); // no merchant
    const res = await t.send(
      SHINHAN('15,000', '11/22 19:00', '달빛분식'),
      t.at('2026-11-22T19:01:00+09:00'),
    );
    expect(res.json<WebhookResponse>().result).toBe('inbox');
    let item = (await t.inbox()).items.find((i) => i.kind === 'ambiguous_duplicate');
    if (item?.kind !== 'ambiguous_duplicate') throw new Error('missing');
    expect(item.candidates.map((c) => c.id)).toEqual([manual.id]);
    await t.admin.post(`/api/inbox/raw/${item.rawRecordId}/attach`, { transactionId: manual.id });
    expect(t.txs()).toHaveLength(1);

    await addTx(t.admin, { amount: 8000, occurredAt: '2026-11-22T12:00:00+09:00' });
    await t.send(SHINHAN('8,000', '11/22 12:10', '골목국수'), t.at('2026-11-22T12:11:00+09:00'));
    item = (await t.inbox()).items.find((i) => i.kind === 'ambiguous_duplicate');
    if (item?.kind !== 'ambiguous_duplicate') throw new Error('missing');
    expect((await t.admin.post(`/api/inbox/raw/${item.rawRecordId}/create`)).statusCode).toBe(201);
    expect(t.txs()).toHaveLength(3);
  });
});

describe('categorisation engine', () => {
  it('applies user rule > same-merchant history > keyword rule, and leaves aggregators 미분류', async () => {
    const t = await setup();
    const send = async (merchant: string, minute: number) => {
      const res = await t.send(
        SHINHAN('5,000', `11/22 10:${String(minute).padStart(2, '0')}`, merchant),
        t.at(`2026-11-22T10:${String(minute).padStart(2, '0')}:30+09:00`),
      );
      return (
        await t.admin.get(`/api/transactions/${res.json<WebhookResponse>().transactionId}`)
      ).json<TransactionInfo>();
    };
    // Keyword: 카페 → 식비 > 카페·간식.
    expect((await send('구름카페', 1)).categoryId).toBe(t.cat('식비/카페·간식'));
    // History beats keyword: the family filed this café under 외식 last time.
    const prior = await addTx(t.admin, {
      amount: 1000,
      merchant: '달빛카페',
      categoryId: t.cat('식비/외식'),
      occurredAt: '2026-11-01T10:00:00+09:00',
    });
    expect(prior.categoryId).toBe(t.cat('식비/외식'));
    expect((await send('달빛 카페', 2)).categoryId).toBe(t.cat('식비/외식'));
    // A user rule beats history.
    await t.admin.post('/api/rules', { pattern: '달빛', categoryId: t.cat('생활/생활용품') });
    expect((await send('달빛카페', 3)).categoryId).toBe(t.cat('생활/생활용품'));
    // Aggregators stay 미분류 despite keywords and history.
    await addTx(t.admin, { amount: 1000, merchant: '네이버페이', categoryId: t.cat('쇼핑') });
    expect((await send('네이버페이', 4)).categoryId).toBeNull();
    // No signal: 미분류.
    expect((await send('알수없는가게', 5)).categoryId).toBeNull();
  });

  it('categorises manual entries that have a merchant but no category', async () => {
    const t = await setup();
    const tx = await addTx(t.admin, { amount: 6000, merchant: '스타벅스 역삼점' });
    expect(tx.categoryId).toBe(t.cat('식비/카페·간식'));
    const income = await addTx(t.admin, { type: 'income', amount: 100, merchant: '스타벅스' });
    expect(income.categoryId).toBeNull();
  });

  it('ignores private history of other members', async () => {
    const t = await setup();
    await addTx(t.member, {
      amount: 1000,
      merchant: '비밀가게',
      categoryId: t.cat('쇼핑'),
      isPrivate: true,
      occurredAt: '2026-11-01T10:00:00+09:00',
    });
    const res = await t.send(
      SHINHAN('2,000', '11/22 10:00', '비밀가게'),
      t.at('2026-11-22T10:01:00+09:00'),
    );
    const tx = (
      await t.admin.get(`/api/transactions/${res.json<WebhookResponse>().transactionId}`)
    ).json<TransactionInfo>();
    expect(tx.categoryId).toBeNull();
  });
});

describe('rules API', () => {
  it('creates, applies to existing 미분류, reorders, toggles built-ins and protects them', async () => {
    const t = await setup();
    await addTx(t.admin, { amount: 1000, merchant: '솔방울 공방 2호점' });
    await addTx(t.admin, { amount: 2000, merchant: '솔방울공방' });
    const created = await t.admin.post('/api/rules', {
      pattern: '솔방울 공방',
      categoryId: t.cat('문화·여가/취미'),
      applyToExisting: true,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<{ applied: number }>().applied).toBe(2);
    const second = (
      await t.admin.post('/api/rules', {
        pattern: '모노',
        matchType: 'prefix',
        categoryId: t.cat('쇼핑'),
      })
    ).json<{ rules: RuleList }>();
    expect(second.rules.user.map((r) => r.pattern)).toEqual(['모노', '솔방울공방']);
    const ids = second.rules.user.map((r) => r.id).reverse();
    const reordered = (await t.admin.put('/api/rules/order', { ids })).json<RuleList>();
    expect(reordered.user.map((r) => r.id)).toEqual(ids);
    expect((await t.admin.put('/api/rules/order', { ids: [ids[0]] })).statusCode).toBe(400);

    const system = reordered.system[0]!;
    expect(code(await t.admin.delete(`/api/rules/${system.id}`))).toBe('rule_invalid');
    expect(code(await t.admin.patch(`/api/rules/${system.id}`, { pattern: 'x' }))).toBe(
      'rule_invalid',
    );
    const off = (
      await t.admin.patch(`/api/rules/${system.id}`, { disabled: true })
    ).json<RuleList>();
    expect(off.system.find((r) => r.id === system.id)?.disabled).toBe(true);
    expect((await t.member.delete(`/api/rules/${ids[0]}`)).statusCode).toBe(204);
    expect(
      (await t.admin.post('/api/rules', { pattern: '  ', categoryId: t.cat('쇼핑') })).statusCode,
    ).toBe(400);
  });
});

describe('inbox: unparsed messages', () => {
  it('keeps the raw text, lets the person enter it, or dismiss it', async () => {
    const t = await setup();
    const res = await t.send(
      '신한카드(1234)승인 홍*동 USD 12.50 11/22 14:05 EXAMPLE STORE',
      t.at('2026-11-22T14:06:00+09:00'),
    );
    expect(res.json<WebhookResponse>().result).toBe('inbox');
    const item = (await t.inbox()).items.find((i) => i.kind === 'unparsed');
    if (item?.kind !== 'unparsed') throw new Error('missing');
    expect(item).toMatchObject({
      reason: 'foreign_currency',
      parsed: { currency: 'USD', merchant: 'EXAMPLE STORE' },
    });
    // Not visible to other members.
    expect(
      (await t.member.get('/api/inbox')).json<InboxList>().items.some((i) => i.kind === 'unparsed'),
    ).toBe(false);
    expect((await t.member.post(`/api/inbox/raw/${item.rawRecordId}/dismiss`)).statusCode).toBe(
      404,
    );

    const created = await t.admin.post(`/api/inbox/raw/${item.rawRecordId}/transaction`, {
      amount: 17200,
      occurredAt: '2026-11-22T14:05:00+09:00',
      merchant: 'EXAMPLE STORE',
    });
    expect(created.json<TransactionInfo>()).toMatchObject({
      amount: 17200,
      source: 'sms',
      hasSms: true,
    });
    expect((await t.inbox()).items.some((i) => i.kind === 'unparsed')).toBe(false);

    await t.send(
      'KB국민카드1*3*승인\n홍*동\n12,300원 일시불\n11/22 14:05',
      t.at('2026-11-22T14:07:00+09:00'),
    );
    const second = (await t.inbox()).items.find((i) => i.kind === 'unparsed');
    if (second?.kind !== 'unparsed') throw new Error('missing');
    expect((await t.admin.post(`/api/inbox/raw/${second.rawRecordId}/dismiss`)).statusCode).toBe(
      204,
    );
    expect((await t.inbox()).items.some((i) => i.kind === 'unparsed')).toBe(false);
  });

  it('lists 미분류 with suggestions', async () => {
    const t = await setup();
    await addTx(t.admin, { amount: 1000, categoryId: t.cat('식비/외식') });
    await addTx(t.admin, { amount: 3000, merchant: '이름없는가게' });
    const box = await t.inbox();
    const u = box.items.find((i) => i.kind === 'uncategorized');
    if (u?.kind !== 'uncategorized') throw new Error('missing');
    expect(u.suggestions).toContain(t.cat('식비/외식'));
    expect(box.count).toBeGreaterThanOrEqual(1);
  });
});

describe('paste test and reprocessing', () => {
  it('previews without storing anything', async () => {
    const t = await setup();
    await addAccount(t.admin, { name: '신한', issuer: 'shinhan', last4: '1234' });
    const ok = (
      await t.admin.post('/api/sms/test', {
        text: SHINHAN('12,300', '11/22 14:05', '구름카페강남점'),
      })
    ).json<SmsPreview>();
    expect(ok).toMatchObject({
      recognized: true,
      ok: true,
      parser: 'shinhan-sms@1',
      account: { name: '신한' },
      categoryReason: 'keyword',
    });
    const no = (
      await t.admin.post('/api/sms/test', { text: '인증번호 123456' })
    ).json<SmsPreview>();
    expect(no).toEqual({ recognized: false });
    expect(t.db.select().from(rawRecords).all()).toEqual([]);
    expect(t.txs()).toEqual([]);
  });

  it('reprocesses failed and outdated records without duplicating transactions', async () => {
    const t = await setup();
    const linked = await t.send(
      SHINHAN('5,000', '11/22 10:00', '달빛분식'),
      t.at('2026-11-22T10:01:00+09:00'),
    );
    // Pretend these were handled by an older parser version that failed.
    t.db.update(rawRecords).set({ parser: 'shinhan-sms@0' }).run();
    const raw = t.db
      .insert(rawRecords)
      .values({
        source: 'sms',
        userId: t.adminId,
        rawText: SHINHAN('7,000', '11/22 11:00', '골목국수'),
        contentHash: 'test',
        status: 'failed',
        parser: 'shinhan-sms@0',
        issue: 'unparsed',
        receivedAt: new Date('2026-11-22T11:01:00+09:00'),
      })
      .returning()
      .get();
    const first = reprocessRawRecords(t.db, t.clock.now());
    expect(first).toMatchObject({ checked: 2, reparsed: 1, created: 1, stillFailing: 0 });
    expect(t.txs()).toHaveLength(2);
    const second = reprocessRawRecords(t.db, t.clock.now());
    expect(second.checked).toBe(0);
    expect(t.txs()).toHaveLength(2);
    const fixed = t.db.select().from(rawRecords).where(eq(rawRecords.id, raw.id)).get()!;
    expect(fixed).toMatchObject({
      status: 'linked',
      parser: 'shinhan-sms@1',
      issue: 'unmatched_card',
    });
    expect(linked.statusCode).toBe(201);

    // Admin endpoint (needs re-auth like other sensitive actions).
    expect((await t.admin.post('/api/admin/reprocess')).json()).toMatchObject({ checked: 0 });
    expect((await t.member.post('/api/admin/reprocess')).statusCode).toBe(403);
  });
});

describe('list shows the SMS source', () => {
  it('flags hasSms on list items', async () => {
    const t = await setup();
    await t.send(SHINHAN('5,000', '11/22 10:00', '달빛분식'), t.at('2026-11-22T10:01:00+09:00'));
    await addTx(t.admin, { amount: 1000, occurredAt: '2026-11-22T09:00:00+09:00' });
    const page = (await t.admin.get('/api/transactions?month=2026-11')).json<TransactionPage>();
    expect(page.items.map((i) => i.hasSms).sort()).toEqual([false, true]);
    expect(t.sqlite.prepare('select count(*) n from raw_records').get()).toEqual({ n: 1 });
  });
});
