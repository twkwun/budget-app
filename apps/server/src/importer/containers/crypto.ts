/**
 * Decryption of password-protected .xlsx files (ECMA-376 "Agile" encryption,
 * Excel 2010 and later, which is what current exporters produce). The
 * password is only used in memory for key derivation and never stored.
 */
import { createDecipheriv, createHash } from 'node:crypto';
import { ImportFileError } from '../types.ts';
import { attrs } from './xml.ts';

const BLOCK_VERIFIER_INPUT = Buffer.from('fea7d2763b4b9e79', 'hex');
const BLOCK_VERIFIER_VALUE = Buffer.from('d7aa0f6d3061344e', 'hex');
const BLOCK_KEY_VALUE = Buffer.from('146e0be7abacd0d6', 'hex');
const SEGMENT = 4096;
const MAX_SPIN = 10_000_000;

interface KeyParams {
  saltValue: Buffer;
  hashAlgorithm: string;
  keyBits: number;
  blockSize: number;
  hashSize: number;
}

function nodeHash(name: string): string {
  const map: Record<string, string> = {
    SHA512: 'sha512',
    SHA384: 'sha384',
    SHA256: 'sha256',
    SHA1: 'sha1',
    'SHA-1': 'sha1',
  };
  const h = map[name.toUpperCase()];
  if (!h) throw new ImportFileError('unsupported_encryption', `Unsupported hash ${name}`);
  return h;
}

function hash(alg: string, ...parts: Buffer[]): Buffer {
  const h = createHash(alg);
  for (const p of parts) h.update(p);
  return h.digest();
}

function fit(buf: Buffer, length: number, pad: number): Buffer {
  if (buf.length >= length) return buf.subarray(0, length);
  return Buffer.concat([buf, Buffer.alloc(length - buf.length, pad)]);
}

function aesCbc(key: Buffer, iv: Buffer, data: Buffer): Buffer {
  const algo = `aes-${key.length * 8}-cbc`;
  const d = createDecipheriv(algo, key, iv);
  d.setAutoPadding(false);
  return Buffer.concat([d.update(data), d.final()]);
}

function readParams(a: Record<string, string>): KeyParams {
  return {
    saltValue: Buffer.from(a.saltValue ?? '', 'base64'),
    hashAlgorithm: nodeHash(a.hashAlgorithm ?? ''),
    keyBits: Number(a.keyBits),
    blockSize: Number(a.blockSize),
    hashSize: Number(a.hashSize),
  };
}

/** Decrypt the EncryptedPackage stream of an encrypted OOXML file. */
export function decryptAgile(info: Buffer, pkg: Buffer, password: string): Buffer {
  const major = info.readUInt16LE(0);
  const minor = info.readUInt16LE(2);
  if (!(major === 4 && minor === 4)) {
    throw new ImportFileError(
      'unsupported_encryption',
      'Only Excel 2010+ (agile) encryption is supported',
    );
  }
  const xml = info.subarray(8).toString('utf8');
  const keyData = readParams(attrs(/<keyData\b([^>]*)\/?>/.exec(xml)?.[1] ?? ''));
  const encAttrs = attrs(/<p:encryptedKey\b([^>]*)\/?>/.exec(xml)?.[1] ?? '');
  const enc = readParams(encAttrs);
  const spinCount = Number(encAttrs.spinCount);
  if (!Number.isInteger(spinCount) || spinCount < 0 || spinCount > MAX_SPIN) {
    throw new ImportFileError('unsupported_encryption', 'Unexpected key derivation settings');
  }
  if (encAttrs.cipherAlgorithm !== 'AES' || ![128, 192, 256].includes(enc.keyBits)) {
    throw new ImportFileError('unsupported_encryption', 'Only AES encryption is supported');
  }

  // Password hash: H0 = H(salt + password), Hn = H(n + Hn-1).
  let h = hash(enc.hashAlgorithm, enc.saltValue, Buffer.from(password, 'utf16le'));
  const counter = Buffer.alloc(4);
  for (let i = 0; i < spinCount; i += 1) {
    counter.writeUInt32LE(i, 0);
    h = hash(enc.hashAlgorithm, counter, h);
  }
  const keyFor = (block: Buffer) => fit(hash(enc.hashAlgorithm, h, block), enc.keyBits / 8, 0x36);
  const iv = fit(enc.saltValue, enc.blockSize, 0x36);

  const verifierInput = aesCbc(
    keyFor(BLOCK_VERIFIER_INPUT),
    iv,
    Buffer.from(encAttrs.encryptedVerifierHashInput ?? '', 'base64'),
  );
  const verifierHash = aesCbc(
    keyFor(BLOCK_VERIFIER_VALUE),
    iv,
    Buffer.from(encAttrs.encryptedVerifierHashValue ?? '', 'base64'),
  );
  const expected = hash(enc.hashAlgorithm, verifierInput.subarray(0, enc.saltValue.length));
  if (!expected.equals(verifierHash.subarray(0, expected.length))) {
    throw new ImportFileError('password_invalid', 'Wrong password');
  }
  const secret = aesCbc(
    keyFor(BLOCK_KEY_VALUE),
    iv,
    Buffer.from(encAttrs.encryptedKeyValue ?? '', 'base64'),
  ).subarray(0, keyData.keyBits / 8);

  const size = Number(pkg.readBigUInt64LE(0));
  const body = pkg.subarray(8);
  if (size > body.length || size > 200 * 1024 * 1024)
    throw new ImportFileError('corrupt_file', 'Bad encrypted package');
  const out: Buffer[] = [];
  const index = Buffer.alloc(4);
  for (let i = 0, offset = 0; offset < body.length && offset < size; i += 1, offset += SEGMENT) {
    index.writeUInt32LE(i, 0);
    const segIv = fit(
      hash(keyData.hashAlgorithm, keyData.saltValue, index),
      keyData.blockSize,
      0x36,
    );
    let chunk = body.subarray(offset, offset + SEGMENT);
    if (chunk.length % keyData.blockSize)
      chunk = fit(chunk, chunk.length + keyData.blockSize - (chunk.length % keyData.blockSize), 0);
    out.push(aesCbc(secret, segIv, chunk));
  }
  return Buffer.concat(out).subarray(0, size);
}

/** Read the version of an EncryptionInfo stream, to tell agile from older schemes. */
export function encryptionVersion(info: Buffer): string {
  return `${info.readUInt16LE(0)}.${info.readUInt16LE(2)}`;
}
