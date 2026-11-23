import CFB from 'cfb';
import { decryptAgile } from './containers/crypto.ts';
import { parseCsv } from './containers/csv.ts';
import { htmlCharset, looksLikeHtml, parseHtmlTables } from './containers/html.ts';
import { decodeText } from './containers/text.ts';
import { readXls } from './containers/xls.ts';
import { isZip, readXlsx } from './containers/xlsx.ts';
import { ImportFileError, LIMITS, type Workbook } from './types.ts';

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function entryBytes(container: CFB.CFB$Container, name: string): Buffer | null {
  const entry = CFB.find(container, name);
  if (!entry?.content) return null;
  return Buffer.from(entry.content as Uint8Array);
}

/**
 * Identify the container by its bytes (never by file name) and read it.
 * Supported: .xlsx (optionally password-protected, agile encryption),
 * .xls BIFF8 (unencrypted), HTML tables saved as .xls, CSV/TSV in UTF-8,
 * UTF-16 or CP949.
 */
export function readWorkbook(input: Uint8Array, password?: string): Workbook {
  if (input.byteLength > LIMITS.fileBytes)
    throw new ImportFileError('file_too_large', 'File is larger than 10 MB');
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length === 0) throw new ImportFileError('corrupt_file', 'Empty file');

  if (isZip(bytes)) return { container: 'xlsx', encrypted: false, sheets: readXlsx(bytes) };

  if (OLE_MAGIC.every((b, i) => bytes[i] === b)) {
    let container: CFB.CFB$Container;
    try {
      container = CFB.read(bytes, { type: 'buffer' });
    } catch {
      throw new ImportFileError('corrupt_file', 'Unreadable Office file');
    }
    const info = entryBytes(container, 'EncryptionInfo');
    const pkg = entryBytes(container, 'EncryptedPackage');
    if (info && pkg) {
      if (!password)
        throw new ImportFileError('password_required', 'This file is password-protected');
      const decrypted = decryptAgile(info, pkg, password);
      if (!isZip(decrypted)) throw new ImportFileError('password_invalid', 'Wrong password');
      return { container: 'xlsx', encrypted: true, sheets: readXlsx(decrypted) };
    }
    const stream = entryBytes(container, 'Workbook') ?? entryBytes(container, 'Book');
    if (!stream) throw new ImportFileError('unsupported_format', 'Not an Excel workbook');
    return { container: 'xls', encrypted: false, sheets: readXls(stream) };
  }

  const head = bytes.subarray(0, 4096).toString('latin1');
  if (looksLikeHtml(head)) {
    const html = decodeText(bytes, htmlCharset(head));
    const sheets = parseHtmlTables(html);
    if (sheets.length === 0) throw new ImportFileError('unsupported_format', 'No table found');
    return { container: 'html', encrypted: false, sheets };
  }

  // Binary junk is not a CSV.
  const sample = bytes.subarray(0, 2048);
  const controls = sample.filter((b) => b < 9 || (b > 13 && b < 32)).length;
  if (controls > sample.length * 0.05 && !(bytes[0] === 0xff || bytes[0] === 0xfe)) {
    throw new ImportFileError('unsupported_format', 'Unknown file type');
  }
  return {
    container: 'csv',
    encrypted: false,
    sheets: [{ name: 'CSV', rows: parseCsv(decodeText(bytes)) }],
  };
}
