/**
 * CSV export of the transactions the caller can see. UTF-8 with a BOM so Excel
 * opens Korean text correctly; every text cell that a spreadsheet could read as
 * a formula is prefixed with an apostrophe (CSV/formula injection).
 */
import { and, asc, eq, gte, lt } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import {
  TRANSACTION_STATUS_LABELS,
  TRANSACTION_TYPE_LABELS,
  dayRange,
  toZonedParts,
  type LocalDate,
} from '@budget/shared';
import type { AppDatabase } from '../db/client.ts';
import { accounts, categories, transactions, users } from '../db/schema.ts';
import { visibleTo } from '../ledger/queries.ts';

const BOM = '﻿';
const FORMULA_START = /^[=+\-@\t\r|]/;

const SOURCE_LABELS: Record<string, string> = {
  manual: '직접 입력',
  sms: '문자',
  file: '파일',
};

export const CSV_HEADER = [
  '날짜',
  '시간',
  '구분',
  '금액',
  '가맹점',
  '대분류',
  '소분류',
  '결제수단',
  '사용자',
  '상태',
  '메모',
  '비공개',
  '입력 경로',
];

/** One CSV cell: neutralise formula starters, quote when needed. */
export function csvCell(value: string | number | null): string {
  if (value === null) return '';
  if (typeof value === 'number') return String(value);
  let text = value;
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const parent = alias(categories, 'parent');

export function exportTransactionsCsv(
  db: AppDatabase,
  viewerId: number,
  from: LocalDate,
  to: LocalDate,
): { csv: string; count: number } {
  const rows = db
    .select({
      occurredAt: transactions.occurredAt,
      date: transactions.occurredDate,
      type: transactions.type,
      amount: transactions.amount,
      merchant: transactions.merchant,
      categoryName: categories.name,
      parentName: parent.name,
      accountName: accounts.name,
      ownerName: users.displayName,
      status: transactions.status,
      memo: transactions.memo,
      isPrivate: transactions.isPrivate,
      source: transactions.source,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .leftJoin(parent, eq(categories.parentId, parent.id))
    .leftJoin(accounts, eq(transactions.accountId, accounts.id))
    .innerJoin(users, eq(transactions.ownerUserId, users.id))
    .where(
      and(
        visibleTo(viewerId),
        gte(transactions.occurredAt, new Date(dayRange(from).start)),
        lt(transactions.occurredAt, new Date(dayRange(to).end)),
      ),
    )
    .orderBy(asc(transactions.occurredAt), asc(transactions.id))
    .all();

  const lines = [CSV_HEADER.map(csvCell).join(',')];
  for (const r of rows) {
    const p = toZonedParts(r.occurredAt);
    const time = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
    const top = r.parentName ?? r.categoryName;
    const sub = r.parentName ? r.categoryName : null;
    lines.push(
      [
        r.date,
        time,
        TRANSACTION_TYPE_LABELS[r.type],
        r.amount,
        r.merchant,
        top,
        sub,
        r.accountName,
        r.ownerName,
        TRANSACTION_STATUS_LABELS[r.status],
        r.memo,
        r.isPrivate ? '예' : '',
        SOURCE_LABELS[r.source] ?? r.source,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return { csv: BOM + lines.join('\r\n') + '\r\n', count: rows.length };
}
