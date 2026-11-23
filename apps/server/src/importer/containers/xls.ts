/**
 * Minimal BIFF8 (.xls, Excel 97-2003) reader: shared strings (with CONTINUE),
 * labels, numbers, RK/MULRK, cached formula results, and number formats for
 * date detection. Encrypted .xls (FILEPASS) is not supported.
 */
import {
  LIMITS,
  clampText,
  excelSerialToText,
  ImportFileError,
  isDateFormat,
  type Cell,
  type Sheet,
} from '../types.ts';

const R = {
  BOF: 0x0809,
  EOF: 0x000a,
  BOUNDSHEET: 0x0085,
  SST: 0x00fc,
  CONTINUE: 0x003c,
  FORMAT: 0x041e,
  XF: 0x00e0,
  FILEPASS: 0x002f,
  DATEMODE: 0x0022,
  LABELSST: 0x00fd,
  LABEL: 0x0204,
  NUMBER: 0x0203,
  RK: 0x027e,
  MULRK: 0x00bd,
  FORMULA: 0x0006,
  STRING: 0x0207,
  BOOLERR: 0x0205,
};

interface Record {
  type: number;
  data: Buffer;
  /** CONTINUE payloads that follow this record. */
  continues: Buffer[];
}

function records(stream: Buffer, from: number): Record[] {
  const out: Record[] = [];
  let pos = from;
  while (pos + 4 <= stream.length) {
    const type = stream.readUInt16LE(pos);
    const len = stream.readUInt16LE(pos + 2);
    const data = stream.subarray(pos + 4, pos + 4 + len);
    pos += 4 + len;
    if (type === R.CONTINUE && out.length) out.at(-1)!.continues.push(data);
    else out.push({ type, data, continues: [] });
    if (type === R.EOF) break;
  }
  return out;
}

function rk(value: number): number {
  let n: number;
  if (value & 0x02) {
    n = value >> 2;
  } else {
    const buf = Buffer.alloc(8);
    buf.writeUInt32LE(value & 0xfffffffc, 4);
    n = buf.readDoubleLE(0);
  }
  return value & 0x01 ? n / 100 : n;
}

/** XLUnicodeString with a 16-bit length (LABEL, FORMAT). */
function unicodeString(
  data: Buffer,
  offset: number,
  lengthBytes: 1 | 2,
): { text: string; end: number } {
  const cch = lengthBytes === 2 ? data.readUInt16LE(offset) : data.readUInt8(offset);
  const flags = data.readUInt8(offset + lengthBytes);
  const start = offset + lengthBytes + 1;
  if (flags & 0x01)
    return { text: data.toString('utf16le', start, start + cch * 2), end: start + cch * 2 };
  return { text: data.toString('latin1', start, start + cch), end: start + cch };
}

/** Shared string table, handling strings split across CONTINUE records. */
function readSst(rec: Record): string[] {
  const parts = [rec.data, ...rec.continues];
  let part = 0;
  let pos = 8;
  const strings: string[] = [];
  const unique = rec.data.readUInt32LE(4);
  const need = (n: number) => {
    if (pos + n > parts[part]!.length && part + 1 < parts.length) {
      part += 1;
      pos = 0;
    }
  };
  const u8 = () => {
    need(1);
    const v = parts[part]!.readUInt8(pos);
    pos += 1;
    return v;
  };
  const u16 = () => {
    need(2);
    const v = parts[part]!.readUInt16LE(pos);
    pos += 2;
    return v;
  };
  const u32 = () => {
    need(4);
    const v = parts[part]!.readUInt32LE(pos);
    pos += 4;
    return v;
  };
  const skip = (n: number) => {
    while (n > 0) {
      const avail = parts[part]!.length - pos;
      if (n <= avail) {
        pos += n;
        return;
      }
      n -= avail;
      if (part + 1 >= parts.length) return;
      part += 1;
      pos = 0;
    }
  };
  for (let i = 0; i < unique && part < parts.length; i += 1) {
    const cch = u16();
    let flags = u8();
    const runs = flags & 0x08 ? u16() : 0;
    const ext = flags & 0x04 ? u32() : 0;
    let text = '';
    let remaining = cch;
    while (remaining > 0) {
      if (pos >= parts[part]!.length) {
        if (part + 1 >= parts.length) break;
        part += 1;
        pos = 0;
        // A continued character array starts with a fresh flags byte.
        flags = parts[part]!.readUInt8(0);
        pos = 1;
      }
      const wide = (flags & 0x01) === 1;
      const avail = Math.floor((parts[part]!.length - pos) / (wide ? 2 : 1));
      const take = Math.min(remaining, avail);
      text += parts[part]!.toString(wide ? 'utf16le' : 'latin1', pos, pos + take * (wide ? 2 : 1));
      pos += take * (wide ? 2 : 1);
      remaining -= take;
      if (take === 0 && avail === 0 && part + 1 >= parts.length) break;
    }
    skip(runs * 4 + ext);
    strings.push(clampText(text));
  }
  return strings;
}

export function readXls(stream: Buffer): Sheet[] {
  const globals = records(stream, 0);
  if (globals[0]?.type !== R.BOF) throw new ImportFileError('corrupt_file', 'Not a BIFF8 workbook');
  let sst: string[] = [];
  let date1904 = false;
  const formats = new Map<number, string>();
  const xfDate: boolean[] = [];
  const sheetsInfo: { name: string; offset: number }[] = [];
  for (const r of globals) {
    switch (r.type) {
      case R.FILEPASS:
        throw new ImportFileError(
          'unsupported_encryption',
          'Password-protected .xls files are not supported',
        );
      case R.SST:
        sst = readSst(r);
        break;
      case R.DATEMODE:
        date1904 = r.data.readUInt16LE(0) === 1;
        break;
      case R.FORMAT: {
        const id = r.data.readUInt16LE(0);
        formats.set(id, unicodeString(r.data, 2, 2).text);
        break;
      }
      case R.XF: {
        const ifmt = r.data.readUInt16LE(2);
        xfDate.push(isDateFormat(ifmt, formats.get(ifmt)));
        break;
      }
      case R.BOUNDSHEET: {
        const offset = r.data.readUInt32LE(0);
        const kind = r.data.readUInt8(5);
        if (kind === 0) sheetsInfo.push({ name: unicodeString(r.data, 6, 1).text, offset });
        break;
      }
    }
  }

  return sheetsInfo.map(({ name, offset }) => {
    const grid: Cell[][] = [];
    const set = (row: number, col: number, value: Cell) => {
      if (row > LIMITS.rowsPerSheet * 2 || col >= LIMITS.columns) return;
      (grid[row] ??= [])[col] = value;
    };
    const num = (xf: number, n: number): Cell =>
      xfDate[xf] ? (excelSerialToText(n, date1904) ?? n) : n;
    const recs = records(stream, offset);
    for (let i = 0; i < recs.length; i += 1) {
      const { type, data } = recs[i]!;
      if (data.length < 6 && type !== R.EOF) continue;
      switch (type) {
        case R.LABELSST:
          set(data.readUInt16LE(0), data.readUInt16LE(2), sst[data.readUInt32LE(6)] ?? null);
          break;
        case R.LABEL:
          set(
            data.readUInt16LE(0),
            data.readUInt16LE(2),
            clampText(unicodeString(data, 6, 2).text),
          );
          break;
        case R.NUMBER:
          set(
            data.readUInt16LE(0),
            data.readUInt16LE(2),
            num(data.readUInt16LE(4), data.readDoubleLE(6)),
          );
          break;
        case R.RK:
          set(
            data.readUInt16LE(0),
            data.readUInt16LE(2),
            num(data.readUInt16LE(4), rk(data.readInt32LE(6))),
          );
          break;
        case R.MULRK: {
          const row = data.readUInt16LE(0);
          const first = data.readUInt16LE(2);
          const count = (data.length - 6) / 6;
          for (let k = 0; k < count; k += 1) {
            set(row, first + k, num(data.readUInt16LE(4 + k * 6), rk(data.readInt32LE(6 + k * 6))));
          }
          break;
        }
        case R.FORMULA: {
          const row = data.readUInt16LE(0);
          const col = data.readUInt16LE(2);
          const xf = data.readUInt16LE(4);
          if (data.readUInt16LE(12) === 0xffff) {
            const kind = data.readUInt8(6);
            if (kind === 0 && recs[i + 1]?.type === R.STRING)
              set(row, col, clampText(unicodeString(recs[i + 1]!.data, 0, 2).text));
            else if (kind === 1) set(row, col, data.readUInt8(8) === 1);
          } else {
            set(row, col, num(xf, data.readDoubleLE(6)));
          }
          break;
        }
        case R.BOOLERR:
          if (data.readUInt8(7) === 0)
            set(data.readUInt16LE(0), data.readUInt16LE(2), data.readUInt8(6) === 1);
          break;
      }
    }
    const rows = grid
      .filter((r) => r && r.some((c) => c !== null && c !== undefined && c !== ''))
      .map((r) => Array.from(r, (c) => c ?? null));
    if (rows.length > LIMITS.rowsPerSheet)
      throw new ImportFileError('too_many_rows', 'Too many rows');
    return { name, rows };
  });
}
