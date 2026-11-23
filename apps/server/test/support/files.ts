/**
 * Generators for invented spreadsheet fixtures in every container the
 * importer reads. Nothing here comes from a real export.
 */
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import CFB from 'cfb';
import { strToU8, zipSync } from 'fflate';
import iconv from 'iconv-lite';

/** A cell: text, number, or a date/time shown with an Excel date format. */
export type FixtureCell = string | number | null | { date: string };
export interface FixtureSheet {
  name: string;
  rows: FixtureCell[][];
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function serial(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(date);
  if (!m) throw new Error(`bad fixture date ${date}`);
  const [y, mo, d, h, mi, s] = m.slice(1).map((x) => Number(x ?? 0)) as number[];
  return (Date.UTC(y!, mo! - 1, d!, h, mi, s) - Date.UTC(1899, 11, 30)) / 86400000;
}

function colName(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26))
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Minimal valid .xlsx with shared strings, a date style and an optional formula cell. */
export function makeXlsx(sheets: FixtureSheet[], opts: { formulaCell?: boolean } = {}): Buffer {
  const strings: string[] = [];
  const index = new Map<string, number>();
  const sst = (s: string) => {
    if (!index.has(s)) {
      index.set(s, strings.length);
      strings.push(s);
    }
    return index.get(s)!;
  };
  const files: Record<string, Uint8Array> = {};
  sheets.forEach((sheet, si) => {
    const rows = sheet.rows
      .map((row, r) => {
        const cells = row
          .map((cell, c) => {
            const ref = `${colName(c)}${r + 1}`;
            if (cell === null) return '';
            if (typeof cell === 'number') return `<c r="${ref}"><v>${cell}</v></c>`;
            if (typeof cell === 'object')
              return `<c r="${ref}" s="1"><v>${serial(cell.date)}</v></c>`;
            return `<c r="${ref}" t="s"><v>${sst(cell)}</v></c>`;
          })
          .join('');
        return `<row r="${r + 1}">${cells}</row>`;
      })
      .join('');
    const formula =
      opts.formulaCell && si === 0
        ? `<row r="${sheet.rows.length + 5}"><c r="A${sheet.rows.length + 5}"><f>SUM(1,1)+HYPERLINK("http://example.invalid")</f><v>2</v></c></row>`
        : '';
    files[`xl/worksheets/sheet${si + 1}.xml`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}${formula}</sheetData></worksheet>`,
    );
  });
  files['[Content_Types].xml'] = strToU8(
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  );
  files['_rels/.rels'] = strToU8(
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
  );
  files['xl/workbook.xml'] = strToU8(
    `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
      .map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}</sheets></workbook>`,
  );
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/>`,
      )
      .join('')}</Relationships>`,
  );
  files['xl/styles.xml'] = strToU8(
    '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd hh:mm"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>',
  );
  files['xl/sharedStrings.xml'] = strToU8(
    `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${strings.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`,
  );
  return Buffer.from(zipSync(files));
}

const BLOCKS = {
  verifierInput: Buffer.from('fea7d2763b4b9e79', 'hex'),
  verifierValue: Buffer.from('d7aa0f6d3061344e', 'hex'),
  keyValue: Buffer.from('146e0be7abacd0d6', 'hex'),
};

function sha512(...parts: Buffer[]): Buffer {
  const h = createHash('sha512');
  for (const p of parts) h.update(p);
  return h.digest();
}

function aes(key: Buffer, iv: Buffer, data: Buffer): Buffer {
  const pad =
    data.length % 16 ? Buffer.concat([data, Buffer.alloc(16 - (data.length % 16))]) : data;
  const c = createCipheriv('aes-256-cbc', key, iv);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(pad), c.final()]);
}

/** Encrypt an .xlsx with ECMA-376 agile encryption (AES-256, SHA-512), like Excel 2010+. */
export function encryptXlsx(plain: Buffer, password: string, spinCount = 100_000): Buffer {
  const keySalt = randomBytes(16);
  const encSalt = randomBytes(16);
  const secret = randomBytes(32);
  let h = sha512(encSalt, Buffer.from(password, 'utf16le'));
  const counter = Buffer.alloc(4);
  for (let i = 0; i < spinCount; i += 1) {
    counter.writeUInt32LE(i);
    h = sha512(counter, h);
  }
  const keyFor = (block: Buffer) => sha512(h, block).subarray(0, 32);
  const verifier = randomBytes(16);
  const b64 = (b: Buffer) => b.toString('base64');
  const xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
    `<encryption xmlns="http://schemas.microsoft.com/office/2006/encryption" xmlns:p="http://schemas.microsoft.com/office/2006/keyEncryptor/password">` +
    `<keyData saltSize="16" blockSize="16" keyBits="256" hashSize="64" cipherAlgorithm="AES" cipherChaining="ChainingModeCBC" hashAlgorithm="SHA512" saltValue="${b64(keySalt)}"/>` +
    `<dataIntegrity encryptedHmacKey="" encryptedHmacValue=""/>` +
    `<keyEncryptors><keyEncryptor uri="http://schemas.microsoft.com/office/2006/keyEncryptor/password">` +
    `<p:encryptedKey spinCount="${spinCount}" saltSize="16" blockSize="16" keyBits="256" hashSize="64" cipherAlgorithm="AES" cipherChaining="ChainingModeCBC" hashAlgorithm="SHA512" saltValue="${b64(encSalt)}" ` +
    `encryptedVerifierHashInput="${b64(aes(keyFor(BLOCKS.verifierInput), encSalt, verifier))}" ` +
    `encryptedVerifierHashValue="${b64(aes(keyFor(BLOCKS.verifierValue), encSalt, sha512(verifier)))}" ` +
    `encryptedKeyValue="${b64(aes(keyFor(BLOCKS.keyValue), encSalt, secret))}"/>` +
    `</keyEncryptor></keyEncryptors></encryption>`;
  const info = Buffer.concat([Buffer.from([4, 0, 4, 0, 0x40, 0, 0, 0]), Buffer.from(xml)]);
  const segments: Buffer[] = [];
  const index = Buffer.alloc(4);
  for (let i = 0, off = 0; off < plain.length; i += 1, off += 4096) {
    index.writeUInt32LE(i);
    segments.push(
      aes(secret, sha512(keySalt, index).subarray(0, 16), plain.subarray(off, off + 4096)),
    );
  }
  const size = Buffer.alloc(8);
  size.writeBigUInt64LE(BigInt(plain.length));
  const cfb = CFB.utils.cfb_new();
  CFB.utils.cfb_add(cfb, '/EncryptionInfo', info);
  CFB.utils.cfb_add(cfb, '/EncryptedPackage', Buffer.concat([size, ...segments]));
  return Buffer.from(CFB.write(cfb, { type: 'buffer' }) as Uint8Array);
}

/** BIFF8 .xls with an SST that spans CONTINUE records, RK and NUMBER cells and a date format. */
export function makeXls(rows: FixtureCell[][], sheetName = 'Sheet1'): Buffer {
  const rec = (type: number, data: Buffer) => {
    const h = Buffer.alloc(4);
    h.writeUInt16LE(type, 0);
    h.writeUInt16LE(data.length, 2);
    return Buffer.concat([h, data]);
  };
  const u16 = (n: number) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n);
    return b;
  };
  const strings: string[] = [];
  const idx = new Map<string, number>();
  for (const row of rows)
    for (const c of row) if (typeof c === 'string' && !idx.has(c)) idx.set(c, strings.push(c) - 1);

  // SST with CONTINUE at 8224 bytes, splitting long strings mid-characters.
  const MAX = 8224;
  const chunks: Buffer[][] = [
    [Buffer.from(new Uint32Array([strings.length, strings.length]).buffer)],
  ];
  let used = 8;
  const push = (b: Buffer) => {
    chunks.at(-1)!.push(b);
    used += b.length;
  };
  const newChunk = () => {
    chunks.push([]);
    used = 0;
  };
  for (const s of strings) {
    if (used + 3 > MAX) newChunk();
    push(Buffer.concat([u16(s.length), Buffer.from([0x01])]));
    let chars = Buffer.from(s, 'utf16le');
    while (chars.length) {
      const room = Math.floor((MAX - used) / 2) * 2;
      if (room <= 0) {
        newChunk();
        push(Buffer.from([0x01])); // continued character data restates its flags
        continue;
      }
      push(chars.subarray(0, room));
      chars = chars.subarray(room);
    }
  }
  const sstRecords = chunks.map((parts, i) => rec(i === 0 ? 0x00fc : 0x003c, Buffer.concat(parts)));

  const bof = (dt: number) => rec(0x0809, Buffer.concat([u16(0x0600), u16(dt), Buffer.alloc(12)]));
  const xf = (fmt: number) => rec(0x00e0, Buffer.concat([u16(0), u16(fmt), Buffer.alloc(16)]));
  const fmtName = 'yyyy-mm-dd hh:mm';
  const format = rec(
    0x041e,
    Buffer.concat([
      u16(164),
      u16(fmtName.length),
      Buffer.from([0]),
      Buffer.from(fmtName, 'latin1'),
    ]),
  );
  const nameBytes = Buffer.from(sheetName, 'utf16le');
  const boundsheet = (offset: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(offset);
    return rec(0x0085, Buffer.concat([b, Buffer.from([0, 0, sheetName.length, 1]), nameBytes]));
  };
  const globalsWithout = [
    bof(0x0005),
    format,
    xf(0),
    xf(164),
    ...sstRecords,
    rec(0x000a, Buffer.alloc(0)),
  ];
  const bsLen = boundsheet(0).length;
  const offset = globalsWithout.reduce((n, b) => n + b.length, 0) + bsLen;
  const globals = [
    globalsWithout[0]!,
    globalsWithout[1]!,
    globalsWithout[2]!,
    globalsWithout[3]!,
    boundsheet(offset),
    ...globalsWithout.slice(4),
  ];

  const cells: Buffer[] = [];
  rows.forEach((row, r) => {
    row.forEach((c, col) => {
      const head = Buffer.concat([u16(r), u16(col)]);
      if (typeof c === 'string') {
        const i = Buffer.alloc(4);
        i.writeUInt32LE(idx.get(c)!);
        cells.push(rec(0x00fd, Buffer.concat([head, u16(0), i])));
      } else if (typeof c === 'number' && Number.isInteger(c) && Math.abs(c) < 2 ** 29) {
        const v = Buffer.alloc(4);
        v.writeInt32LE((c << 2) | 2);
        cells.push(rec(0x027e, Buffer.concat([head, u16(0), v])));
      } else if (typeof c === 'number' || (c && typeof c === 'object')) {
        const v = Buffer.alloc(8);
        v.writeDoubleLE(typeof c === 'number' ? c : serial(c.date));
        cells.push(rec(0x0203, Buffer.concat([head, u16(typeof c === 'number' ? 0 : 1), v])));
      }
    });
  });
  const stream = Buffer.concat([...globals, bof(0x0010), ...cells, rec(0x000a, Buffer.alloc(0))]);
  const cfb = CFB.utils.cfb_new();
  CFB.utils.cfb_add(cfb, '/Workbook', stream);
  return Buffer.from(CFB.write(cfb, { type: 'buffer' }) as Uint8Array);
}

const cellText = (c: FixtureCell) => (c === null ? '' : typeof c === 'object' ? c.date : String(c));

export function makeCsv(
  rows: FixtureCell[][],
  encoding: 'utf8' | 'utf8bom' | 'cp949' = 'cp949',
  delimiter = ',',
): Buffer {
  const text = rows
    .map((r) =>
      r
        .map((c) => {
          const s = cellText(c);
          return /[",\n\t]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(delimiter),
    )
    .join('\r\n');
  if (encoding === 'cp949') return iconv.encode(text, 'cp949');
  return Buffer.concat([
    encoding === 'utf8bom' ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0),
    Buffer.from(text),
  ]);
}

/** An HTML table saved with an .xls extension, as some Korean sites export. */
export function makeHtmlXls(rows: FixtureCell[][], charset: 'euc-kr' | 'utf-8' = 'euc-kr'): Buffer {
  const html = `<html><head><meta http-equiv="Content-Type" content="text/html; charset=${charset}"><style>td{mso-number-format:"\\@"}</style></head><body><table border="1">${rows
    .map((r) => `<tr>${r.map((c) => `<td>${esc(cellText(c))}</td>`).join('')}</tr>`)
    .join('\n')}</table><script>alert(1)</script></body></html>`;
  return charset === 'euc-kr' ? iconv.encode(html, 'cp949') : Buffer.from(html);
}

/** A 뱅크샐러드-shaped two-sheet workbook (columns as recalled, unverified). */
export const BANKSALAD_HEADER = [
  '날짜',
  '시간',
  '타입',
  '대분류',
  '소분류',
  '내용',
  '금액',
  '화폐',
  '결제수단',
  '메모',
];

export function makeBanksalad(rows: FixtureCell[][]): Buffer {
  return makeXlsx([
    { name: '뱅샐현황', rows: [['자산 현황'], ['총자산', 123456789], ['순자산', 98765432]] },
    { name: '가계부 내역', rows: [BANKSALAD_HEADER, ...rows] },
  ]);
}
