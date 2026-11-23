/**
 * A spreadsheet reduced to plain values. Dates that the file marks as dates
 * (Excel number formats) are turned into `YYYY-MM-DD HH:mm:ss` wall-clock
 * strings; everything else stays as written. Formulas are never evaluated:
 * only cached values are read.
 */
export type Cell = string | number | boolean | null;

export interface Sheet {
  name: string;
  rows: Cell[][];
}

export interface Workbook {
  container: 'xlsx' | 'xls' | 'csv' | 'html';
  encrypted: boolean;
  sheets: Sheet[];
}

export type ImportFileErrorCode =
  | 'password_required'
  | 'password_invalid'
  | 'unsupported_encryption'
  | 'unsupported_format'
  | 'file_too_large'
  | 'too_many_rows'
  | 'corrupt_file'
  | 'parse_timeout';

export class ImportFileError extends Error {
  readonly code: ImportFileErrorCode;

  constructor(code: ImportFileErrorCode, message: string) {
    super(message);
    this.name = 'ImportFileError';
    this.code = code;
  }
}

/** Hard limits for untrusted uploads. */
export const LIMITS = {
  fileBytes: 10 * 1024 * 1024,
  /** Total uncompressed size of the parts of an .xlsx we read (zip-bomb guard). */
  unzippedBytes: 150 * 1024 * 1024,
  rows: 20_000,
  /** Rows read per sheet before giving up (a little above the import limit for title rows). */
  rowsPerSheet: 20_100,
  columns: 200,
  cellChars: 2_000,
};

export function clampText(value: string): string {
  return value.length > LIMITS.cellChars ? value.slice(0, LIMITS.cellChars) : value;
}

/** Excel serial date (1900 or 1904 system) to `YYYY-MM-DD HH:mm:ss`. */
export function excelSerialToText(serial: number, date1904 = false): string | null {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2958465) return null;
  // 1900 system: day 60 is the fictitious 1900-02-29; days after it are shifted by one.
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const ms = Math.round(serial * 86400) * 1000;
  const d = new Date(base + ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** Whether an Excel number format string formats dates or times. */
export function isDateFormat(id: number, code?: string): boolean {
  if (
    (id >= 14 && id <= 22) ||
    (id >= 45 && id <= 47) ||
    (id >= 27 && id <= 36) ||
    (id >= 50 && id <= 58)
  ) {
    return true;
  }
  if (!code) return false;
  const stripped = code
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '');
  return /[ymdhs]/i.test(stripped) && !/^[#0.,%E+-]*$/i.test(stripped);
}
