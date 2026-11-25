/**
 * 결제수단 labels of imported transactions that have no account yet.
 *
 * A file import keeps each row's 결제수단 text in its raw record. When the
 * person skipped account mapping at import time, the transactions stay without
 * a payment method; this module lists those labels and links them afterwards,
 * creating accounts where needed and remembering the mapping for later imports.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  ACCOUNT_NAME_MAX_LENGTH,
  inferAccountKind,
  type LabelLinkRequest,
  type LabelLinkResult,
  type UnlinkedLabelInfo,
} from '@budget/shared';
import type { AppDatabase } from '../db/client.ts';
import { accounts, importAccountMappings, rawRecords, transactions } from '../db/schema.ts';
import { errors } from '../http/errors.ts';
import type { ParsedRow } from './rows.ts';
import { labelLast4, normLabel, suggestAccount, suggestIssuer } from './service.ts';

type AccountRow = typeof accounts.$inferSelect;

/** Transaction ids without an account, by normalized 결제수단 label. */
function unlinkedByLabel(db: AppDatabase): Map<string, Set<number>> {
  const rows = db
    .select({ id: transactions.id, parsed: rawRecords.parsed })
    .from(rawRecords)
    .innerJoin(transactions, eq(rawRecords.transactionId, transactions.id))
    .where(and(eq(rawRecords.source, 'file'), isNull(transactions.accountId)))
    .all();
  const out = new Map<string, Set<number>>();
  for (const r of rows) {
    const label = normLabel((r.parsed as ParsedRow | null)?.paymentLabel ?? '');
    if (!label) continue;
    let ids = out.get(label);
    if (!ids) out.set(label, (ids = new Set()));
    ids.add(r.id);
  }
  return out;
}

export function unlinkedLabels(db: AppDatabase): UnlinkedLabelInfo[] {
  const all = db.select().from(accounts).all();
  return [...unlinkedByLabel(db).entries()]
    .map(([label, ids]) => {
      const kind = inferAccountKind(label) ?? 'other';
      return {
        label,
        rows: ids.size,
        suggestedKind: kind,
        suggestedIssuer: kind === 'cash' || kind === 'pay' ? null : suggestIssuer(label),
        last4: kind === 'cash' ? null : labelLast4(label),
        suggestedAccountId: suggestAccount(label, all)?.id ?? null,
      };
    })
    .sort((a, b) => b.rows - a.rows || a.label.localeCompare(b.label, 'ko'));
}

/**
 * Link labels to accounts (existing or created), fill the account of their
 * transactions that have none, and remember each label for later imports.
 * Returns the accounts it created, for follow-up work such as SMS matching.
 */
export function linkLabels(
  db: AppDatabase,
  items: LabelLinkRequest['items'],
  userId: number,
  now: number,
): LabelLinkResult & { createdAccounts: AccountRow[] } {
  const byLabel = unlinkedByLabel(db);
  const createdAccounts: AccountRow[] = [];
  let linked = 0;
  db.transaction((tx) => {
    let nextOrder = tx
      .select({ sortOrder: accounts.sortOrder })
      .from(accounts)
      .all()
      .reduce((m, r) => Math.max(m, r.sortOrder + 1), 0);
    for (const item of items) {
      const label = normLabel(item.label);
      let account: AccountRow | undefined;
      if (item.accountId !== undefined) {
        account = tx.select().from(accounts).where(eq(accounts.id, item.accountId)).get();
        if (!account || account.archivedAt) {
          throw errors.conflict('account_invalid', 'Unknown or archived account');
        }
      } else if (item.create) {
        account = tx
          .insert(accounts)
          .values({
            kind: item.create.kind,
            name: item.create.name.trim().slice(0, ACCOUNT_NAME_MAX_LENGTH) || label.slice(0, 40),
            issuer: item.create.issuer,
            last4: item.create.kind === 'cash' ? null : item.create.last4,
            ownerUserId: userId,
            sortOrder: nextOrder++,
          })
          .returning()
          .get();
        createdAccounts.push(account);
      } else {
        throw errors.validation('Each label needs an account or a new account');
      }
      tx.insert(importAccountMappings)
        .values({ label, accountId: account.id, createdByUserId: userId })
        .onConflictDoUpdate({
          target: importAccountMappings.label,
          set: { accountId: account.id, updatedAt: new Date(now) },
        })
        .run();
      const ids = [...(byLabel.get(label) ?? [])];
      for (let i = 0; i < ids.length; i += 500) {
        linked += tx
          .update(transactions)
          .set({ accountId: account.id, updatedAt: new Date(now) })
          .where(
            and(inArray(transactions.id, ids.slice(i, i + 500)), isNull(transactions.accountId)),
          )
          .run().changes;
      }
    }
  });
  return { created: createdAccounts.length, linked, createdAccounts };
}
