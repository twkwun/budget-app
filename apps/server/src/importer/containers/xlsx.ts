import { unzipSync } from 'fflate';
import {
  LIMITS,
  clampText,
  excelSerialToText,
  ImportFileError,
  isDateFormat,
  type Cell,
  type Sheet,
} from '../types.ts';
import { attrs, decodeXml } from './xml.ts';

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

export function isZip(bytes: Uint8Array): boolean {
  return ZIP_MAGIC.every((b, i) => bytes[i] === b);
}

function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/** Read the first-level text of <t> elements, skipping phonetic runs (<rPh>). */
function richText(xml: string): string {
  const withoutPhonetic = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  for (const m of withoutPhonetic.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g))
    out += decodeXml(m[1] ?? '');
  return out;
}

/**
 * Read an .xlsx (OOXML) workbook. Only the parts needed for values are
 * unzipped, with a cap on their total uncompressed size. Formulas are not
 * evaluated: their cached results are used. External links are never read.
 */
export function readXlsx(bytes: Uint8Array): Sheet[] {
  let total = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        const wanted =
          f.name === 'xl/workbook.xml' ||
          f.name === 'xl/_rels/workbook.xml.rels' ||
          f.name === 'xl/sharedStrings.xml' ||
          f.name === 'xl/styles.xml' ||
          /^xl\/worksheets\/sheet\d+\.xml$/.test(f.name);
        if (!wanted) return false;
        total += f.originalSize;
        if (total > LIMITS.unzippedBytes) {
          throw new ImportFileError('file_too_large', 'Workbook expands too much');
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof ImportFileError) throw error;
    throw new ImportFileError('corrupt_file', 'Not a readable .xlsx file');
  }
  const text = (name: string) => (files[name] ? new TextDecoder().decode(files[name]) : '');
  const workbook = text('xl/workbook.xml');
  if (!workbook) throw new ImportFileError('unsupported_format', 'Not an Excel workbook');
  const date1904 = /<workbookPr\b[^>]*date1904\s*=\s*"(1|true)"/i.test(workbook);

  const rels = new Map<string, string>();
  for (const m of text('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const a = attrs(m[1] ?? '');
    if (a.Id && a.Target) rels.set(a.Id, a.Target.replace(/^\/?xl\//, '').replace(/^\//, ''));
  }

  const shared: string[] = [];
  for (const m of text('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g))
    shared.push(clampText(richText(m[1] ?? '')));

  const styles = text('xl/styles.xml');
  const formats = new Map<number, string>();
  for (const m of styles.matchAll(/<numFmt\b([^>]*)\/?>/g)) {
    const a = attrs(m[1] ?? '');
    formats.set(Number(a.numFmtId), a.formatCode ?? '');
  }
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? '';
  const dateStyles = [...cellXfs.matchAll(/<xf\b([^>]*?)(\/>|>)/g)].map((m) => {
    const id = Number(attrs(m[1] ?? '').numFmtId ?? 0);
    return isDateFormat(id, formats.get(id));
  });

  const sheets: Sheet[] = [];
  for (const m of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const a = attrs(m[1] ?? '');
    const target = rels.get(a['r:id'] ?? '') ?? '';
    const xml = text(`xl/${target}`);
    if (!xml) continue;
    const rows: Cell[][] = [];
    for (const rowMatch of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const rowAttrs = attrs(rowMatch[1] ?? '');
      const rowNumber = Number(rowAttrs.r ?? rows.length + 1) - 1;
      const row: Cell[] = [];
      let next = 0;
      for (const c of (rowMatch[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ca = attrs(c[1] ?? '');
        const col = ca.r ? colIndex(ca.r) : next;
        next = col + 1;
        if (col < 0 || col >= LIMITS.columns) continue;
        const body = c[2] ?? '';
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let value: Cell = null;
        switch (ca.t) {
          case 's':
            value = v === undefined ? null : (shared[Number(v)] ?? null);
            break;
          case 'inlineStr':
            value = clampText(richText(body));
            break;
          case 'str':
          case 'e':
            value = v === undefined ? null : clampText(decodeXml(v));
            break;
          case 'b':
            value = v === '1';
            break;
          default: {
            if (v === undefined) break;
            const num = Number(v);
            if (!Number.isFinite(num)) value = clampText(decodeXml(v));
            else if (dateStyles[Number(ca.s ?? 0)]) value = excelSerialToText(num, date1904) ?? num;
            else value = num;
          }
        }
        row[col] = value;
      }
      if (row.some((x) => x !== null && x !== undefined && x !== '')) {
        if (rowNumber > LIMITS.rowsPerSheet * 2) break;
        rows.push(Array.from(row, (x) => x ?? null));
        if (rows.length > LIMITS.rowsPerSheet)
          throw new ImportFileError('too_many_rows', 'Too many rows');
      }
    }
    sheets.push({ name: a.name ?? `Sheet${sheets.length + 1}`, rows });
  }
  return sheets;
}
