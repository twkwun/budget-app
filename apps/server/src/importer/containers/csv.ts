import { LIMITS, clampText, ImportFileError, type Cell } from '../types.ts';

/** Comma or tab, whichever separates the first lines more consistently. */
function detectDelimiter(text: string): string {
  const lines = text.split(/\r?\n/, 10).filter(Boolean);
  const score = (d: string) => lines.reduce((n, l) => n + (l.split(d).length - 1), 0);
  return score('\t') > score(',') ? '\t' : ',';
}

/** RFC 4180 CSV (quoted fields, doubled quotes, CRLF), returning raw strings. */
export function parseCsv(text: string): Cell[][] {
  const delimiter = detectDelimiter(text);
  const rows: Cell[][] = [];
  let row: Cell[] = [];
  let field = '';
  let quoted = false;
  const pushField = () => {
    if (row.length < LIMITS.columns) row.push(clampText(field.trim()));
    field = '';
  };
  const pushRow = () => {
    pushField();
    if (row.some((c) => c !== '')) rows.push(row);
    if (rows.length > LIMITS.rowsPerSheet) {
      throw new ImportFileError('too_many_rows', `More than ${LIMITS.rows} rows`);
    }
    row = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field.trim() === '') {
      quoted = true;
      field = '';
    } else if (ch === delimiter) pushField();
    else if (ch === '\n') pushRow();
    else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length) pushRow();
  return rows;
}
