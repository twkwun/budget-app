/**
 * File import: upload → (password) → (column mapping) → preview → apply,
 * plus undo and cleanup of stale previews.
 *
 * Re-import safety. Every source row gets an identity fingerprint (date,
 * time, sign, amount, normalised merchant, approval number, plus its
 * occurrence number among identical rows in the same file) stored in
 * `raw_records.content_hash`. Rows of applied batches are kept forever, even
 * when their transaction is edited or deleted (the link is nulled, the row
 * stays). A row whose fingerprint already belongs to an applied batch is
 * "이미 가져옴" and is never imported again, so re-uploading a file, or an
 * overlapping later export, adds nothing for those rows and cannot resurrect
 * a transaction the family deleted. Rows the person chose to skip are kept
 * as `ignored` for the same reason. Undo deletes the batch's rows, so an
 * undone file can be imported again.
 */
import { and, asc, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import {
  isAggregatorMerchant,
  merchantSimilarity,
  normalizeMerchant,
  toLocalDate,
  zonedTimeToUtc,
  type AccountMappingInfo,
  type CategoryMappingInfo,
  type ColumnMap,
  type ImportOutcome,
  type RowDecision,
  type TransactionType,
} from '@budget/shared';
import { createHash } from 'node:crypto';
import type { AppDatabase } from '../db/client.ts';
import {
  accounts,
  categories,
  importAccountMappings,
  importBatches,
  importCategoryMappings,
  importProfiles,
  rawRecords,
  transactions,
} from '../db/schema.ts';
import { createCategorizer } from '../ledger/categorize.ts';
import { findDuplicate, MATCH_THRESHOLD } from '../ledger/dedupe.ts';
import { applyCancel, findCancelTarget, type Tx } from '../sms/ingest.ts';
import { detectLayout, headerSignature, isBanksalad, missingRoles } from './layout.ts';
import { parseFileInWorker } from './parse-file.ts';
import { looksLikeTransfer, parseRow, rowIdentity, type ParsedRow } from './rows.ts';
import { ImportFileError, LIMITS, type Cell } from './types.ts';

export const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;
const CHUNK = 500;
/** Time given to date-only rows: midday KST, well clear of day boundaries. */
export const DATE_ONLY_TIME = '12:00:00';
const CANCEL_LOOKBACK_MS = 120 * 24 * 60 * 60 * 1000;

type Batch = typeof importBatches.$inferSelect;
type Raw = typeof rawRecords.$inferSelect;
type AccountRow = typeof accounts.$inferSelect;

/** Per-row analysis and decision, stored in raw_records.issue_data for file rows. */
export interface RowState {
  outcome: ImportOutcome;
  transactionId?: number | null;
  /** Cancellation of a new row in the same batch (its raw record id). */
  targetRow?: number;
  candidateIds?: number[];
  cancel?: boolean;
  suggestedTransfer?: boolean;
  transfer?: boolean | null;
  decision?: RowDecision | null;
  /** What apply did, for the result summary and undo. */
  action?: 'created' | 'attached' | 'cancelled' | 'linked' | 'skipped';
  filled?: { categoryId?: boolean; merchant?: string | null; accountId?: boolean; status?: string };
  previous?: { status: string; amount: number; originalAmount: number | null };
}

/** Typed view of the analysis stored on a file row. */
const stateOf = (data: unknown): RowState => (data ?? {}) as RowState;

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

function occurredAtOf(r: ParsedRow): Date {
  const [y, m, d] = (r.date ?? '1970-01-01').split('-').map(Number) as [number, number, number];
  const [h, mi, s] = (r.time ?? DATE_ONLY_TIME).split(':').map(Number) as [number, number, number];
  return new Date(zonedTimeToUtc({ year: y, month: m, day: d, hour: h, minute: mi, second: s }));
}

function fingerprint(identity: string, occurrence: number): string {
  return createHash('sha256').update(`file|${identity}#${occurrence}`).digest('hex');
}

const normLabel = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------- creation

export interface CreateImportInput {
  userId: number;
  fileName: string | null;
  bytes: Uint8Array;
  password?: string;
  now: number;
}

export async function createImport(db: AppDatabase, input: CreateImportInput): Promise<Batch> {
  const workbook = await parseFileInWorker(input.bytes, input.password);
  const layout = detectLayout(workbook.sheets);
  if (!layout) throw new ImportFileError('corrupt_file', 'No table found');
  const dataRows = layout.sheet.rows
    .slice(layout.headerIndex + 1)
    .map((cells, i) => ({ cells, row: layout.headerIndex + i + 2 }))
    .filter((r) => r.cells.some((c) => c !== null && c !== ''));
  if (dataRows.length === 0) throw new ImportFileError('corrupt_file', 'no_rows');
  if (dataRows.length > LIMITS.rows) throw new ImportFileError('too_many_rows', 'Too many rows');

  const signature = headerSignature(layout.header);
  const remembered = db
    .select()
    .from(importProfiles)
    .where(eq(importProfiles.headerSignature, signature))
    .get();
  const map: ColumnMap = remembered?.columnMap ?? layout.map;
  const banksalad = isBanksalad(map, layout.header);
  const batch = db
    .insert(importBatches)
    .values({
      userId: input.userId,
      format: banksalad ? 'banksalad' : 'generic',
      fileName: input.fileName?.slice(0, 200) ?? null,
      fileSha256: createHash('sha256').update(input.bytes).digest('hex'),
      status: 'needs_mapping',
      container: workbook.container,
      sheetName: layout.sheet.name,
      header: layout.header,
      headerSignature: signature,
      columnMap: map,
      rowCount: dataRows.length,
      createdAt: new Date(input.now),
      expiresAt: new Date(input.now + PREVIEW_TTL_MS),
    })
    .returning()
    .get();
  for (let i = 0; i < dataRows.length; i += CHUNK) {
    db.insert(rawRecords)
      .values(
        dataRows.slice(i, i + CHUNK).map((r) => ({
          source: 'file' as const,
          userId: input.userId,
          importBatchId: batch.id,
          receivedAt: new Date(input.now),
          rawText: JSON.stringify(r.cells),
          contentHash: `pending:${batch.id}:${r.row}`,
          parsed: { row: r.row },
          status: 'received' as const,
        })),
      )
      .run();
  }
  if (missingRoles(map).length === 0) await prepareBatch(db, batch.id, input.now);
  return db.select().from(importBatches).where(eq(importBatches.id, batch.id)).get() ?? batch;
}

/** Store a manual column mapping (remembered for this header) and analyse. */
export async function setColumnMap(
  db: AppDatabase,
  batchId: number,
  map: ColumnMap,
  now: number,
): Promise<void> {
  const batch = db.select().from(importBatches).where(eq(importBatches.id, batchId)).get();
  if (!batch?.headerSignature) return;
  db.insert(importProfiles)
    .values({ headerSignature: batch.headerSignature, columnMap: map })
    .onConflictDoUpdate({
      target: importProfiles.headerSignature,
      set: { columnMap: map, updatedAt: new Date(now) },
    })
    .run();
  db.update(importBatches)
    .set({ columnMap: map, format: isBanksalad(map, batch.header ?? []) ? 'banksalad' : 'generic' })
    .where(eq(importBatches.id, batchId))
    .run();
  await prepareBatch(db, batchId, now);
}

/** Parse every row with the batch's column map, fingerprint it, then analyse. */
async function prepareBatch(db: AppDatabase, batchId: number, now: number): Promise<void> {
  const batch = db.select().from(importBatches).where(eq(importBatches.id, batchId)).get();
  if (!batch) return;
  const map = batch.columnMap ?? {};
  const banksalad = batch.format === 'banksalad';
  const rows = db
    .select()
    .from(rawRecords)
    .where(eq(rawRecords.importBatchId, batchId))
    .orderBy(asc(rawRecords.id))
    .all();
  const seen = new Map<string, number>();
  // A reused prepared statement: this loop runs once per row of large files.
  const update = db.$client.prepare(
    'update raw_records set parsed = ?, content_hash = ? where id = ?',
  );
  for (let i = 0; i < rows.length; i += CHUNK) {
    db.$client.transaction(() => {
      for (const raw of rows.slice(i, i + CHUNK)) {
        const cells = JSON.parse(raw.rawText) as Cell[];
        const parsed = parseRow(cells, map, (raw.parsed as { row: number }).row, banksalad);
        const identity = rowIdentity(parsed);
        const n = seen.get(identity) ?? 0;
        seen.set(identity, n + 1);
        update.run(
          JSON.stringify({ ...parsed, row: (raw.parsed as { row: number }).row }),
          parsed.error ? `error:${batchId}:${raw.id}` : fingerprint(identity, n),
          raw.id,
        );
      }
    })();
    await yieldToLoop();
  }
  db.update(importBatches).set({ status: 'previewed' }).where(eq(importBatches.id, batchId)).run();
  await analyzeBatch(db, batchId, now);
}

// ---------------------------------------------------------------- mappings

const ISSUER_WORDS: [RegExp, string][] = [
  [/신한/, 'shinhan'],
  [/KB|국민/i, 'kb'],
  [/삼성/, 'samsung'],
  [/현대/, 'hyundai'],
  [/롯데/, 'lotte'],
  [/하나/, 'hana'],
  [/우리/, 'woori'],
  [/NH|농협/i, 'nh'],
  [/IBK|기업/i, 'ibk'],
  [/BC|비씨/i, 'bc'],
  [/카카오뱅크/, 'kakaobank'],
  [/토스/, 'toss'],
];

/** Suggest an account for a 결제수단 label: issuer and last digits, then name similarity. */
export function suggestAccount(label: string, all: AccountRow[]): AccountRow | null {
  const active = all.filter((a) => !a.archivedAt);
  if (/현금/.test(label)) return active.find((a) => a.kind === 'cash') ?? null;
  const issuer = ISSUER_WORDS.find(([re]) => re.test(label))?.[1];
  const digits = /(\d{4})(?!.*\d{4})/.exec(label.replace(/[*＊]/g, 'x'))?.[1];
  let pool = issuer ? active.filter((a) => a.issuer === issuer) : active;
  if (digits) {
    const byDigits = pool.filter((a) => a.last4 === digits);
    if (byDigits.length === 1) return byDigits[0] ?? null;
    if (byDigits.length > 1) pool = byDigits;
  }
  const kindHint = /카드/.test(label)
    ? 'card'
    : /통장|계좌|은행|입출금/.test(label)
      ? 'bank'
      : null;
  if (kindHint) pool = pool.filter((a) => a.kind === kindHint);
  if (pool.length === 1 && issuer) return pool[0] ?? null;
  const scored = active
    .map((a) => ({ a, s: merchantSimilarity(a.name, label) }))
    .filter((x) => x.s >= MATCH_THRESHOLD)
    .sort((x, y) => y.s - x.s);
  return scored[0]?.a ?? null;
}

function savedAccountMappings(db: Pick<AppDatabase, 'select'>) {
  return new Map(
    db
      .select()
      .from(importAccountMappings)
      .all()
      .map((m) => [m.label, m.accountId]),
  );
}

/** Account per label: the remembered mapping, else the suggestion. */
function accountResolver(db: Pick<AppDatabase, 'select'>) {
  const all = db.select().from(accounts).all();
  const byId = new Map(all.map((a) => [a.id, a]));
  const saved = savedAccountMappings(db);
  const cache = new Map<string, AccountRow | null>();
  return (label: string | null): AccountRow | null => {
    const key = normLabel(label ?? '');
    if (!cache.has(key)) {
      if (saved.has(key)) {
        const id = saved.get(key);
        cache.set(key, id ? (byId.get(id) ?? null) : null);
      } else cache.set(key, key ? suggestAccount(key, all) : null);
    }
    return cache.get(key) ?? null;
  };
}

const categoryKey = (r: ParsedRow) =>
  r.categoryMajor
    ? `${r.type === 'income' ? 'income' : 'expense'}:${r.categoryMajor}${r.categoryMinor ? `/${r.categoryMinor}` : ''}`
    : null;

/** Suggest one of our categories for a source category by name similarity. */
export function suggestCategory(
  key: string,
  rows: (typeof categories.$inferSelect)[],
): number | null {
  const [kindPart, path] = key.split(':') as [string, string];
  const [major, minor] = path.split('/') as [string, string | undefined];
  if (/미분류|기타/.test(minor ?? major)) return null;
  const pool = rows.filter((c) => c.kind === kindPart && !c.archivedAt);
  const best = (name: string, among: typeof pool) =>
    among
      .map((c) => ({
        c,
        s: merchantSimilarity(c.name.replace(/[·]/g, ''), name.replace(/[·/]/g, '')),
      }))
      .filter((x) => x.s >= 0.5)
      .sort((a, b) => b.s - a.s)[0]?.c;
  if (minor) {
    const child =
      best(
        minor,
        pool.filter((c) => c.parentId !== null),
      ) ?? best(minor, pool);
    if (child) return child.id;
  }
  return (
    (
      best(
        major,
        pool.filter((c) => c.parentId === null),
      ) ??
      best(
        major,
        pool.filter((c) => c.parentId !== null),
      )
    )?.id ?? null
  );
}

function categoryResolver(db: Pick<AppDatabase, 'select'>) {
  const saved = new Map(
    db
      .select()
      .from(importCategoryMappings)
      .all()
      .map((m) => [m.key, m.categoryId]),
  );
  const rows = db.select().from(categories).all();
  return (key: string | null): number | null => {
    if (!key) return null;
    if (saved.has(key)) return saved.get(key) ?? null;
    return suggestCategory(key, rows);
  };
}

// ---------------------------------------------------------------- analysis

interface AnalyzeState {
  claimed: Set<number>;
  pendingNew: {
    rawId: number;
    accountId: number | null;
    label: string | null;
    amount: number;
    merchant: string | null;
    at: number;
  }[];
}

type FileRow = Raw & { p: ParsedRow; at: number };

/** Rows of a batch in time order (errors last), each with its instant computed once. */
function fileRows(db: Pick<AppDatabase, 'select'>, batchId: number): FileRow[] {
  return db
    .select()
    .from(rawRecords)
    .where(eq(rawRecords.importBatchId, batchId))
    .all()
    .map((r) => {
      const p = r.parsed as ParsedRow;
      return {
        ...r,
        p,
        at: p.error || !p.date ? Number.MAX_SAFE_INTEGER : occurredAtOf(p).getTime(),
      };
    })
    .sort((a, b) => a.at - b.at || a.id - b.id);
}

/** Fingerprints already owned by rows of applied batches. */
function importedFingerprints(db: Pick<AppDatabase, 'select'>, hashes: string[]): Set<string> {
  const found = new Set<string>();
  for (let i = 0; i < hashes.length; i += CHUNK) {
    const chunk = hashes.slice(i, i + CHUNK);
    if (chunk.length === 0) continue;
    db.select({ h: rawRecords.contentHash })
      .from(rawRecords)
      .innerJoin(importBatches, eq(rawRecords.importBatchId, importBatches.id))
      .where(
        and(
          eq(rawRecords.source, 'file'),
          inArray(rawRecords.contentHash, chunk),
          eq(importBatches.status, 'applied'),
        ),
      )
      .all()
      .forEach((r) => found.add(r.h));
  }
  return found;
}

function classify(
  db: Tx,
  raw: FileRow,
  ctx: {
    batchId: number;
    signature: string | null;
    userId: number;
    account: AccountRow | null;
    already: boolean;
    state: AnalyzeState;
  },
): RowState {
  const p = raw.p;
  const previous = stateOf(raw.issueData);
  const keep = { decision: previous.decision ?? null, transfer: previous.transfer ?? null };
  if (p.error) return { outcome: 'error', ...keep };
  if (ctx.already) return { outcome: 'already', ...keep };
  const at = raw.at;
  const accountId = ctx.account?.id ?? null;
  const suggestedTransfer =
    !p.explicitType || p.bankLayout
      ? (p.bankLayout || ctx.account?.kind === 'bank') &&
        p.type !== 'transfer' &&
        looksLikeTransfer(p)
      : false;

  if (p.refund) {
    const pending = ctx.state.pendingNew.find(
      (n) =>
        n.amount >= p.amount &&
        n.at <= at + 3600_000 &&
        (n.accountId === accountId || n.label === p.paymentLabel) &&
        (!n.merchant ||
          !p.merchant ||
          merchantSimilarity(n.merchant, p.merchant) >= MATCH_THRESHOLD),
    );
    if (pending) return { outcome: 'cancel', targetRow: pending.rawId, ...keep };
    const target = findCancelTarget(db, {
      accountId,
      amount: p.amount,
      merchant: p.merchant,
      at,
      viewerId: ctx.userId,
    });
    if (target && !ctx.state.claimed.has(target.id)) {
      ctx.state.claimed.add(target.id);
      return { outcome: 'cancel', transactionId: target.id, ...keep };
    }
    const done = db
      .select({ id: transactions.id, merchant: transactions.merchant })
      .from(transactions)
      .where(
        and(
          eq(transactions.status, 'cancelled'),
          eq(transactions.amount, p.amount),
          sql`${transactions.occurredAt} between ${at - CANCEL_LOOKBACK_MS} and ${at + 3600_000}`,
          accountId === null ? undefined : eq(transactions.accountId, accountId),
          or(eq(transactions.isPrivate, false), eq(transactions.ownerUserId, ctx.userId)),
        ),
      )
      .all()
      .find(
        (t) =>
          !p.merchant ||
          !t.merchant ||
          merchantSimilarity(t.merchant, p.merchant) >= MATCH_THRESHOLD,
      );
    if (done) return { outcome: 'cancel_duplicate', transactionId: done.id, ...keep };
    const candidates = db
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(
          eq(transactions.type, 'expense'),
          ne(transactions.status, 'cancelled'),
          sql`${transactions.amount} >= ${p.amount}`,
          sql`${transactions.occurredAt} between ${at - CANCEL_LOOKBACK_MS} and ${at + 3600_000}`,
          or(eq(transactions.isPrivate, false), eq(transactions.ownerUserId, ctx.userId)),
        ),
      )
      .orderBy(sql`${transactions.amount} = ${p.amount} desc`, sql`${transactions.occurredAt} desc`)
      .limit(5)
      .all()
      .map((c) => c.id);
    return { outcome: 'review', cancel: true, candidateIds: candidates, ...keep };
  }

  const dup = findDuplicate(db, {
    type: p.type,
    amount: p.amount,
    occurredAt: at,
    accountId,
    merchant: p.merchant,
    approvalNo: p.approvalNo,
    excludeBatchId: ctx.batchId,
    excludeLayoutSignature: ctx.signature,
    excludeIds: ctx.state.claimed,
    viewerId: ctx.userId,
  });
  if (dup.kind === 'match') {
    ctx.state.claimed.add(dup.transactionId);
    return { outcome: 'duplicate', transactionId: dup.transactionId, suggestedTransfer, ...keep };
  }
  if (dup.kind === 'ambiguous') {
    return { outcome: 'review', candidateIds: dup.candidateIds, suggestedTransfer, ...keep };
  }
  ctx.state.pendingNew.push({
    rawId: raw.id,
    accountId,
    label: p.paymentLabel,
    amount: p.amount,
    merchant: p.merchant,
    at,
  });
  return { outcome: 'new', suggestedTransfer, ...keep };
}

/** Classify every row (new / duplicate / review / already / cancel / error) and store counts. */
export async function analyzeBatch(db: AppDatabase, batchId: number, _now: number): Promise<void> {
  const batch = db.select().from(importBatches).where(eq(importBatches.id, batchId)).get();
  if (!batch) return;
  const rows = fileRows(db, batchId);
  const already = importedFingerprints(
    db,
    rows.map((r) => r.contentHash),
  );
  const account = accountResolver(db);
  const state: AnalyzeState = { claimed: new Set(), pendingNew: [] };
  const counts: Partial<Record<ImportOutcome, number>> = {};
  const saveState = db.$client.prepare('update raw_records set issue_data = ? where id = ?');
  for (let i = 0; i < rows.length; i += CHUNK) {
    db.transaction((tx) => {
      for (const raw of rows.slice(i, i + CHUNK)) {
        const result = classify(tx, raw, {
          batchId,
          signature: batch.headerSignature,
          userId: batch.userId,
          account: account(raw.p.paymentLabel),
          already: already.has(raw.contentHash),
          state,
        });
        counts[result.outcome] = (counts[result.outcome] ?? 0) + 1;
        saveState.run(JSON.stringify(result), raw.id);
      }
    });
    await yieldToLoop();
  }
  db.update(importBatches)
    .set({
      newCount: counts.new ?? 0,
      duplicateCount: counts.duplicate ?? 0,
      reviewCount: counts.review ?? 0,
      failedCount: counts.error ?? 0,
      skippedCount: counts.already ?? 0,
    })
    .where(eq(importBatches.id, batchId))
    .run();
}

export function batchCounts(db: Pick<AppDatabase, 'select'>, batchId: number) {
  const counts: Partial<Record<ImportOutcome, number>> = {};
  let transfers = 0;
  let undecided = 0;
  for (const r of db
    .select({ d: rawRecords.issueData })
    .from(rawRecords)
    .where(eq(rawRecords.importBatchId, batchId))
    .all()) {
    const s = stateOf(r.d);
    if (!s.outcome) continue;
    counts[s.outcome] = (counts[s.outcome] ?? 0) + 1;
    if (
      s.suggestedTransfer &&
      (s.outcome === 'new' || s.outcome === 'review' || s.outcome === 'duplicate')
    )
      transfers += 1;
    if (s.outcome === 'review' && !s.decision) undecided += 1;
  }
  return { counts, transfers, undecided };
}

export function accountMappings(
  db: Pick<AppDatabase, 'select'>,
  batchId: number,
): AccountMappingInfo[] {
  const all = db.select().from(accounts).all();
  const saved = savedAccountMappings(db);
  const labels = new Map<string, number>();
  for (const r of db
    .select({ p: rawRecords.parsed })
    .from(rawRecords)
    .where(eq(rawRecords.importBatchId, batchId))
    .all()) {
    const label = normLabel((r.p as ParsedRow).paymentLabel ?? '');
    labels.set(label, (labels.get(label) ?? 0) + 1);
  }
  return [...labels.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, rows]) => {
      const suggested = label ? (suggestAccount(label, all)?.id ?? null) : null;
      return {
        label,
        rows,
        accountId: saved.has(label) ? (saved.get(label) ?? null) : suggested,
        saved: saved.has(label),
        suggestedAccountId: suggested,
      };
    });
}

export function categoryMappings(
  db: Pick<AppDatabase, 'select'>,
  batchId: number,
): CategoryMappingInfo[] {
  const resolve = categoryResolver(db);
  const saved = new Set(
    db
      .select({ k: importCategoryMappings.key })
      .from(importCategoryMappings)
      .all()
      .map((m) => m.k),
  );
  const keys = new Map<string, number>();
  for (const r of db
    .select({ p: rawRecords.parsed })
    .from(rawRecords)
    .where(eq(rawRecords.importBatchId, batchId))
    .all()) {
    const p = r.p as ParsedRow;
    if (p.type === 'transfer') continue;
    const key = categoryKey(p);
    if (key) keys.set(key, (keys.get(key) ?? 0) + 1);
  }
  return [...keys.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, rows]) => ({
      key,
      kind: key.startsWith('income:') ? ('income' as const) : ('expense' as const),
      label: key.slice(key.indexOf(':') + 1).replace('/', ' > '),
      rows,
      categoryId: resolve(key),
      saved: saved.has(key),
    }));
}

export function saveAccountMappings(
  db: AppDatabase,
  items: { label: string; accountId: number | null }[],
  userId: number,
  now: number,
): void {
  db.transaction((tx) => {
    for (const m of items) {
      const label = normLabel(m.label);
      tx.insert(importAccountMappings)
        .values({ label, accountId: m.accountId, createdByUserId: userId })
        .onConflictDoUpdate({
          target: importAccountMappings.label,
          set: { accountId: m.accountId, updatedAt: new Date(now) },
        })
        .run();
    }
  });
}

export function saveCategoryMappings(
  db: AppDatabase,
  items: { key: string; categoryId: number | null }[],
  now: number,
): void {
  db.transaction((tx) => {
    for (const m of items) {
      tx.insert(importCategoryMappings)
        .values({ key: m.key, categoryId: m.categoryId })
        .onConflictDoUpdate({
          target: importCategoryMappings.key,
          set: { categoryId: m.categoryId, updatedAt: new Date(now) },
        })
        .run();
    }
  });
}

/** Store per-row decisions (확인 필요) and transfer choices. */
export function setDecisions(
  db: AppDatabase,
  batchId: number,
  items: { id: number; decision?: RowDecision | null; transfer?: boolean | null }[],
): void {
  db.transaction((tx) => {
    for (const item of items) {
      const raw = tx
        .select()
        .from(rawRecords)
        .where(and(eq(rawRecords.id, item.id), eq(rawRecords.importBatchId, batchId)))
        .get();
      if (!raw) continue;
      const s = { ...stateOf(raw.issueData) };
      if (item.decision !== undefined) s.decision = item.decision;
      if (item.transfer !== undefined) s.transfer = item.transfer;
      tx.update(rawRecords)
        .set({ issueData: s as unknown as Record<string, unknown> })
        .where(eq(rawRecords.id, raw.id))
        .run();
    }
  });
}

// ---------------------------------------------------------------- apply

export interface ApplyResult {
  created: number;
  attached: number;
  cancelled: number;
  skipped: number;
  already: number;
  errors: number;
}

export class ImportStateError extends Error {}

export async function applyBatch(
  db: AppDatabase,
  batchId: number,
  userId: number,
  now: number,
): Promise<ApplyResult> {
  const batch = db.select().from(importBatches).where(eq(importBatches.id, batchId)).get();
  if (!batch || batch.userId !== userId) throw new ImportStateError('not_found');
  if (batch.status !== 'previewed') throw new ImportStateError('not_previewed');
  const rows = fileRows(db, batchId);
  const undecided = rows.filter(
    (r) => stateOf(r.issueData).outcome === 'review' && !stateOf(r.issueData).decision,
  );
  if (undecided.length) throw new ImportStateError('undecided');

  db.update(importBatches).set({ status: 'applying' }).where(eq(importBatches.id, batchId)).run();
  // Remember the mappings the preview showed (suggestions become confirmed choices).
  saveAccountMappings(
    db,
    accountMappings(db, batchId).map((m) => ({ label: m.label, accountId: m.accountId })),
    userId,
    now,
  );
  saveCategoryMappings(
    db,
    categoryMappings(db, batchId).map((m) => ({ key: m.key, categoryId: m.categoryId })),
    now,
  );

  const account = accountResolver(db);
  const category = categoryResolver(db);
  const categorizeRow = createCategorizer(db);
  /** Only recent rows can have gained an SMS twin since the preview. */
  const recheckSince = now - 7 * 24 * 60 * 60 * 1000;
  // Re-check against batches applied since the preview (e.g. the same file in another tab).
  const already = importedFingerprints(
    db,
    rows.map((r) => r.contentHash),
  );
  const createdByRow = new Map<number, number>();
  const claimed = new Set<number>();
  const result: ApplyResult = {
    created: 0,
    attached: 0,
    cancelled: 0,
    skipped: 0,
    already: 0,
    errors: 0,
  };
  const stamp = new Date(now);

  for (let i = 0; i < rows.length; i += CHUNK) {
    db.transaction((tx) => {
      for (const raw of rows.slice(i, i + CHUNK)) {
        const p = raw.p;
        const s = {
          ...(raw.issueData ? stateOf(raw.issueData) : ({ outcome: 'error' } as RowState)),
        };
        const done = (values: Partial<typeof rawRecords.$inferInsert>, state: RowState) =>
          tx
            .update(rawRecords)
            .set({
              processedAt: stamp,
              issueData: state as unknown as Record<string, unknown>,
              ...values,
            })
            .where(eq(rawRecords.id, raw.id))
            .run();
        const acct = account(p.paymentLabel);
        const isTransfer = s.transfer ?? s.suggestedTransfer ?? false;
        const type: TransactionType = isTransfer ? 'transfer' : p.type;

        if (s.outcome === 'error') {
          result.errors += 1;
          done({ status: 'ignored', transactionId: null }, { ...s, action: 'skipped' });
          continue;
        }
        if (already.has(raw.contentHash) || s.outcome === 'already') {
          result.already += 1;
          // Not kept: an earlier batch already owns this row.
          tx.delete(rawRecords).where(eq(rawRecords.id, raw.id)).run();
          continue;
        }
        if (s.decision === 'skip') {
          result.skipped += 1;
          done({ status: 'ignored', transactionId: null }, { ...s, action: 'skipped' });
          continue;
        }

        const visible = (id: number | null | undefined) =>
          id
            ? tx
                .select()
                .from(transactions)
                .where(
                  and(
                    eq(transactions.id, id),
                    or(eq(transactions.isPrivate, false), eq(transactions.ownerUserId, userId)),
                  ),
                )
                .get()
            : undefined;

        // Cancellations (refund rows).
        if (p.refund) {
          const attachTo = typeof s.decision === 'object' && s.decision ? s.decision.attach : null;
          const targetId =
            attachTo ?? (s.targetRow ? createdByRow.get(s.targetRow) : s.transactionId);
          const target = visible(targetId ?? null);
          if (s.outcome === 'cancel_duplicate' && target) {
            done({ status: 'linked', transactionId: target.id }, { ...s, action: 'linked' });
            result.attached += 1;
            continue;
          }
          if (target && target.status !== 'cancelled') {
            const previous = {
              status: target.status,
              amount: target.amount,
              originalAmount: target.originalAmount,
            };
            applyCancel(tx, target, p.amount, now);
            done(
              { status: 'linked', transactionId: target.id },
              { ...s, action: 'cancelled', previous },
            );
            result.cancelled += 1;
          } else {
            done({ status: 'ignored', transactionId: null }, { ...s, action: 'skipped' });
            result.skipped += 1;
          }
          continue;
        }

        // Attach to an existing transaction (duplicate, or the person's pick).
        let targetId: number | null = null;
        if (typeof s.decision === 'object' && s.decision) targetId = s.decision.attach;
        else if (s.outcome === 'duplicate' && s.decision !== 'create')
          targetId = s.transactionId ?? null;
        else if (s.outcome === 'new' && s.decision !== 'create' && raw.at >= recheckSince) {
          // Something may have arrived since the preview (an SMS): check again.
          const late = findDuplicate(tx, {
            type,
            amount: p.amount,
            occurredAt: raw.at,
            accountId: acct?.id ?? null,
            merchant: p.merchant,
            approvalNo: p.approvalNo,
            excludeBatchId: batchId,
            excludeLayoutSignature: batch.headerSignature,
            excludeIds: claimed,
            viewerId: userId,
          });
          if (late.kind === 'match') targetId = late.transactionId;
        }
        const target = visible(targetId);
        if (target) {
          claimed.add(target.id);
          const filled: RowState['filled'] = {};
          const patch: Partial<typeof transactions.$inferInsert> = { updatedAt: stamp };
          if (target.categoryId === null && target.type !== 'transfer') {
            const guess = categorizeRow({
              merchant: p.merchant,
              type: target.type,
              viewerId: userId,
              mappedCategoryId: category(categoryKey(p)),
            }).categoryId;
            if (guess) {
              patch.categoryId = guess;
              filled.categoryId = true;
            }
          }
          if (
            p.merchant &&
            !isAggregatorMerchant(p.merchant) &&
            (!target.merchant || isAggregatorMerchant(target.merchant))
          ) {
            patch.merchant = p.merchant;
            patch.merchantKey = normalizeMerchant(p.merchant);
            filled.merchant = target.merchant;
          }
          if (target.accountId === null && acct) {
            patch.accountId = acct.id;
            filled.accountId = true;
          }
          if (target.status === 'needs_review' || target.status === 'pending') {
            patch.status = 'confirmed';
            filled.status = target.status;
          }
          tx.update(transactions).set(patch).where(eq(transactions.id, target.id)).run();
          done(
            { status: 'linked', transactionId: target.id },
            { ...s, action: 'attached', filled },
          );
          result.attached += 1;
          continue;
        }

        // Create.
        const occurredAt = new Date(raw.at);
        const created = tx
          .insert(transactions)
          .values({
            type,
            amount: p.amount,
            occurredAt,
            occurredDate: toLocalDate(occurredAt),
            merchant: p.merchant,
            merchantKey: p.merchant ? normalizeMerchant(p.merchant) : null,
            memo: p.memo,
            categoryId:
              type === 'transfer'
                ? null
                : categorizeRow({
                    merchant: p.merchant,
                    type,
                    viewerId: userId,
                    mappedCategoryId: category(categoryKey(p)),
                  }).categoryId,
            accountId: acct?.id ?? null,
            ownerUserId: acct?.primaryUserId ?? userId,
            createdByUserId: userId,
            status: 'confirmed',
            source: 'file',
            installmentMonths: p.installmentMonths,
            approvalNo: p.approvalNo,
            createdAt: stamp,
            updatedAt: stamp,
          })
          .returning({ id: transactions.id })
          .get();
        claimed.add(created.id);
        createdByRow.set(raw.id, created.id);
        done({ status: 'linked', transactionId: created.id }, { ...s, action: 'created' });
        result.created += 1;
      }
    });
    await yieldToLoop();
  }

  const counts = batchCounts(db, batchId);
  db.update(importBatches)
    .set({
      status: 'applied',
      appliedAt: stamp,
      expiresAt: null,
      result: result as unknown as Record<string, number>,
      newCount: counts.counts.new ?? 0,
      duplicateCount: counts.counts.duplicate ?? 0,
      reviewCount: counts.counts.review ?? 0,
      failedCount: counts.counts.error ?? 0,
      skippedCount: result.already,
    })
    .where(eq(importBatches.id, batchId))
    .run();
  return result;
}

// ---------------------------------------------------------------- undo

export interface UndoReport {
  deleted: number;
  detached: number;
  restored: number;
  /** Transactions changed after the import (kept unless confirmed). */
  edited: number;
}

/**
 * Remove what a batch created, detach what it attached, and restore what it
 * cancelled. Transactions edited after the import (or that other sources now
 * also back) are left alone unless `force` is set; the report counts them.
 */
export function undoBatch(
  db: AppDatabase,
  batchId: number,
  userId: number,
  now: number,
  force: boolean,
): UndoReport {
  const batch = db.select().from(importBatches).where(eq(importBatches.id, batchId)).get();
  if (!batch || batch.userId !== userId) throw new ImportStateError('not_found');
  if (batch.status !== 'applied' || !batch.appliedAt) throw new ImportStateError('not_applied');
  const appliedAt = batch.appliedAt.getTime();
  const rows = db.select().from(rawRecords).where(eq(rawRecords.importBatchId, batchId)).all();
  const report: UndoReport = { deleted: 0, detached: 0, restored: 0, edited: 0 };

  // Other sources backing a transaction: anything not from this batch.
  const notThisBatch = or(isNull(rawRecords.importBatchId), ne(rawRecords.importBatchId, batchId));
  const plan = rows.map((raw) => {
    const s = stateOf(raw.issueData);
    const t = raw.transactionId
      ? db.select().from(transactions).where(eq(transactions.id, raw.transactionId)).get()
      : undefined;
    const others = t
      ? (db
          .select({ n: sql<number>`count(*)` })
          .from(rawRecords)
          .where(and(eq(rawRecords.transactionId, t.id), notThisBatch))
          .get()?.n ?? 0)
      : 0;
    const edited =
      !!t && (t.updatedAt.getTime() > appliedAt || (s.action === 'created' && others > 0));
    return { raw, s, t, edited };
  });
  report.edited = plan.filter((x) => x.edited).length;
  if (report.edited > 0 && !force) return report;

  db.transaction((tx) => {
    for (const { s, t, edited } of plan) {
      if (t && s.action === 'created') {
        const others = tx
          .select({ source: rawRecords.source })
          .from(rawRecords)
          .where(and(eq(rawRecords.transactionId, t.id), notThisBatch))
          .all();
        if (others[0]) {
          // Another source (an SMS, another file) also reported it: keep it, now owned by that source.
          tx.update(transactions)
            .set({ source: others[0].source })
            .where(eq(transactions.id, t.id))
            .run();
          report.detached += 1;
          continue;
        }
        if (edited && !force) continue;
        tx.delete(transactions).where(eq(transactions.id, t.id)).run();
        report.deleted += 1;
      } else if (t && s.action === 'attached') {
        if (!edited) {
          const f = s.filled ?? {};
          tx.update(transactions)
            .set({
              ...(f.categoryId ? { categoryId: null } : {}),
              ...(f.merchant !== undefined
                ? {
                    merchant: f.merchant,
                    merchantKey: f.merchant ? normalizeMerchant(f.merchant) : null,
                  }
                : {}),
              ...(f.accountId ? { accountId: null } : {}),
              ...(f.status ? { status: f.status as typeof t.status } : {}),
            })
            .where(eq(transactions.id, t.id))
            .run();
        }
        report.detached += 1;
      } else if (t && s.action === 'cancelled' && s.previous) {
        if (!edited || force) {
          tx.update(transactions)
            .set({
              status: s.previous.status as typeof t.status,
              amount: s.previous.amount,
              originalAmount: s.previous.originalAmount,
            })
            .where(eq(transactions.id, t.id))
            .run();
          report.restored += 1;
        }
      }
    }
    // Forget the rows so the same file can be imported again later.
    tx.delete(rawRecords).where(eq(rawRecords.importBatchId, batchId)).run();
    tx.update(importBatches)
      .set({ status: 'undone', undoneAt: new Date(now) })
      .where(eq(importBatches.id, batchId))
      .run();
  });
  return report;
}

// ---------------------------------------------------------------- cleanup

/** Delete previews (and their rows) not applied within PREVIEW_TTL_MS. */
export function deleteExpiredPreviews(db: AppDatabase, now: number): number {
  const stale = db
    .select({ id: importBatches.id })
    .from(importBatches)
    .where(
      and(
        inArray(importBatches.status, ['needs_mapping', 'previewed']),
        lt(importBatches.expiresAt, new Date(now)),
      ),
    )
    .all()
    .map((b) => b.id);
  if (stale.length === 0) return 0;
  db.transaction((tx) => {
    tx.delete(rawRecords).where(inArray(rawRecords.importBatchId, stale)).run();
    tx.delete(importBatches).where(inArray(importBatches.id, stale)).run();
  });
  return stale.length;
}

/** Discard a preview now (the person cancelled it). */
export function discardBatch(db: AppDatabase, batchId: number): void {
  db.transaction((tx) => {
    tx.delete(rawRecords).where(eq(rawRecords.importBatchId, batchId)).run();
    tx.delete(importBatches).where(eq(importBatches.id, batchId)).run();
  });
}
