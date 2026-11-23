/** Stage 5 DTOs: file import (가져오기). */
import type { ImportBatchStatus, TransactionType } from './domain.ts';
import type { TransactionInfo } from './ledger.ts';

/** Column roles the importer understands. */
export const COLUMN_ROLES = [
  'date',
  'time',
  'merchant',
  'amount',
  'withdrawal',
  'deposit',
  'type',
  'category',
  'subcategory',
  'payment',
  'approval',
  'installment',
  'cancel',
  'memo',
  'currency',
] as const;
export type ColumnRole = (typeof COLUMN_ROLES)[number];
export type ColumnMap = Partial<Record<ColumnRole, number>>;

export const COLUMN_ROLE_LABELS: Record<ColumnRole, string> = {
  date: '날짜(필수)',
  time: '시간',
  merchant: '가맹점·내용',
  amount: '금액',
  withdrawal: '출금액',
  deposit: '입금액',
  type: '유형(지출/수입/이체)',
  category: '대분류',
  subcategory: '소분류',
  payment: '결제수단·카드',
  approval: '승인번호',
  installment: '할부',
  cancel: '취소 여부',
  memo: '메모',
  currency: '통화',
};

export type ImportOutcome =
  'new' | 'duplicate' | 'review' | 'already' | 'cancel' | 'cancel_duplicate' | 'error';

export const IMPORT_GROUP_LABELS: Record<ImportOutcome, string> = {
  new: '신규',
  duplicate: '중복',
  review: '확인 필요',
  already: '이미 가져옴',
  cancel: '취소 반영',
  cancel_duplicate: '취소 이미 반영됨',
  error: '읽지 못함',
};

export type RowDecision = 'create' | 'skip' | { attach: number };

export interface ImportRowInfo {
  id: number;
  row: number;
  date: string;
  time: string | null;
  type: TransactionType;
  amount: number;
  refund: boolean;
  merchant: string | null;
  paymentLabel: string | null;
  sourceCategory: string | null;
  outcome: ImportOutcome;
  /** For review rows that are cancellations: what to cancel. */
  cancel: boolean;
  error: string | null;
  /** Existing transaction it matches (duplicate / cancel target). */
  match: TransactionInfo | null;
  candidates: TransactionInfo[];
  suggestedTransfer: boolean;
  /** Effective transfer choice (suggestion unless the person changed it). */
  transfer: boolean;
  decision: RowDecision | null;
}

export interface AccountMappingInfo {
  label: string;
  rows: number;
  accountId: number | null;
  /** True once remembered (confirmed by a person); false while only suggested. */
  saved: boolean;
  suggestedAccountId: number | null;
}

export interface CategoryMappingInfo {
  key: string;
  kind: 'expense' | 'income';
  label: string;
  rows: number;
  categoryId: number | null;
  saved: boolean;
}

export interface ImportBatchInfo {
  id: number;
  fileName: string | null;
  format: string;
  container: string | null;
  status: ImportBatchStatus;
  rowCount: number;
  counts: Partial<Record<ImportOutcome, number>>;
  transferSuggestions: number;
  /** 확인 필요 rows without a decision yet (apply needs zero). */
  undecided: number;
  result: Record<string, number> | null;
  createdAt: string;
  appliedAt: string | null;
  expiresAt: string | null;
  undoneAt: string | null;
}

export interface ImportPreview {
  batch: ImportBatchInfo;
  sheetName: string | null;
  header: string[];
  columnMap: ColumnMap;
  /** First rows under the header, for the column-mapping step. */
  sample: (string | number | boolean | null)[][];
  missing: ColumnRole[];
  accounts: AccountMappingInfo[];
  categories: CategoryMappingInfo[];
}

export interface ImportRowsPage {
  rows: ImportRowInfo[];
  total: number;
}

export const IMPORT_ERROR_MESSAGES: Record<string, string> = {
  password_required: '비밀번호가 걸린 파일입니다. 비밀번호를 입력하세요.',
  password_invalid: '비밀번호가 맞지 않습니다.',
  unsupported_encryption:
    '이 방식으로 암호화된 파일은 읽을 수 없습니다. 비밀번호를 풀어 저장한 뒤 올려 주세요.',
  unsupported_format: '읽을 수 없는 파일 형식입니다. .xlsx, .xls, .csv 파일을 올려 주세요.',
  file_too_large: '파일이 너무 큽니다 (최대 10MB).',
  too_many_rows: '행이 너무 많습니다 (최대 20,000행). 기간을 나눠 받아 주세요.',
  corrupt_file: '파일이 손상되었거나 읽을 수 없습니다.',
  parse_timeout: '파일을 읽는 데 너무 오래 걸립니다.',
  no_rows: '가져올 거래 행을 찾지 못했습니다.',
};

export const ROW_ERROR_LABELS: Record<string, string> = {
  bad_date: '날짜를 읽지 못함',
  bad_amount: '금액을 읽지 못함',
  zero_amount: '금액이 0원',
  foreign_currency: '원화가 아닌 거래',
};
