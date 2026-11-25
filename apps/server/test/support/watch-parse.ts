/**
 * Run by containers.test.ts under `node --watch` (as `pnpm dev` does): parses
 * an invented workbook in the worker and prints the outcome as one JSON line.
 */
import { parseFileInWorker } from '../../src/importer/parse-file.ts';
import { makeXlsx } from './files.ts';

try {
  const wb = await parseFileInWorker(makeXlsx([{ name: 'a', rows: [['이용일자', '이용금액']] }]));
  console.log(JSON.stringify({ ok: true, sheets: wb.sheets.map((s) => s.name) }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error) }));
}
