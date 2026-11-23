import iconv from 'iconv-lite';

/**
 * Decode bytes of a text-based export: UTF-8 (with or without BOM), UTF-16
 * with BOM, otherwise CP949 (EUC-KR superset), the usual encoding of Korean
 * bank and card downloads.
 */
export function decodeText(bytes: Uint8Array, declared?: string | null): string {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)
    return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return iconv.decode(buf.subarray(2), 'utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return iconv.decode(buf.subarray(2), 'utf16be');
  const label = declared?.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (label && /^(euckr|cp949|ksc56011987|ks_c_5601|mscp949|windows949)/.test(label)) {
    return iconv.decode(buf, 'cp949');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return iconv.decode(buf, 'cp949');
  }
}
