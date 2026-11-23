/** Stage 4 DTOs: SMS webhook tokens, category rules, the 인박스 and the paste test. */
import type { RuleMatchType, TransactionType } from './domain.ts';
import type { TransactionInfo } from './ledger.ts';

export interface WebhookTokenInfo {
  id: number;
  deviceName: string;
  /** Last characters of the token, to tell tokens apart. */
  hint: string | null;
  createdAt: string;
  lastReceivedAt: string | null;
  receivedCount: number;
  /** Messages discarded unstored (not card notifications). */
  ignoredCount: number;
  lastIgnoredAt: string | null;
  revoked: boolean;
}

export interface CreatedWebhookToken {
  token: string;
  info: WebhookTokenInfo;
  /** Full webhook URL to paste into the shortcut. */
  url: string;
}

export interface RuleInfo {
  id: number;
  pattern: string;
  matchType: RuleMatchType;
  categoryId: number;
  categoryLabel: string;
  kind: 'expense' | 'income';
  priority: number;
  isSystem: boolean;
  disabled: boolean;
}

export interface RuleList {
  user: RuleInfo[];
  system: RuleInfo[];
}

/** Parsed fields of a card message, as stored on the raw record. */
export interface ParsedCardFields {
  issuer?: string;
  kind?: 'approval' | 'cancel';
  cardDigits?: string | null;
  cardType?: 'credit' | 'check';
  amount?: number | null;
  currency?: string | null;
  foreignAmount?: string | null;
  installmentMonths?: number | null;
  merchant?: string | null;
  occurredAt?: string;
  month?: number;
  day?: number;
  hour?: number;
  minute?: number;
}

export type InboxItem =
  | {
      kind: 'uncategorized';
      key: string;
      transaction: TransactionInfo;
      /** Suggested categories, best first. */
      suggestions: number[];
    }
  | {
      kind: 'unparsed';
      key: string;
      rawRecordId: number;
      receivedAt: string;
      rawText: string;
      reason: string;
      parsed: ParsedCardFields | null;
    }
  | {
      kind: 'unmatched_card';
      key: string;
      issuer: string;
      digits: string | null;
      count: number;
      total: number;
      latest: TransactionInfo | null;
    }
  | {
      kind: 'unmatched_cancel';
      key: string;
      rawRecordId: number;
      receivedAt: string;
      parsed: ParsedCardFields;
      candidates: TransactionInfo[];
    }
  | {
      kind: 'ambiguous_duplicate';
      key: string;
      rawRecordId: number;
      receivedAt: string;
      parsed: ParsedCardFields;
      candidates: TransactionInfo[];
    };

export interface InboxList {
  count: number;
  items: InboxItem[];
}

export interface WebhookResponse {
  ok: boolean;
  result: 'created' | 'attached' | 'cancelled' | 'inbox' | 'duplicate' | 'ignored';
  transactionId?: number;
  message: string;
}

export type SmsPreview =
  | { recognized: false }
  | { recognized: true; ok: false; parser: string; reason: string; partial: ParsedCardFields }
  | {
      recognized: true;
      ok: true;
      parser: string;
      value: ParsedCardFields & { occurredAt: string };
      account: { id: number; name: string } | null;
      categoryId: number | null;
      categoryReason: 'rule' | 'history' | 'keyword' | null;
    };

export const PARSE_FAILURE_LABELS: Record<string, string> = {
  no_datetime: '날짜·시간을 찾지 못함',
  bad_datetime: '날짜·시간이 올바르지 않음',
  no_amount: '금액을 찾지 못함',
  zero_amount: '금액이 0원',
  no_merchant: '가맹점을 찾지 못함',
  foreign_currency: '해외 결제(원화 금액 없음)',
  not_recognized: '카드 결제 문자 형식이 아님',
};

export const RULE_MATCH_LABELS: Record<RuleMatchType, string> = {
  contains: '포함',
  exact: '일치',
  prefix: '시작',
};

export type { TransactionType };
