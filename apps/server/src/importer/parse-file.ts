import { Worker } from 'node:worker_threads';
import { ImportFileError, type ImportFileErrorCode, type Workbook } from './types.ts';

export const PARSE_TIMEOUT_MS = 20_000;

export type ParseResult =
  { ok: true; workbook: Workbook } | { ok: false; code: ImportFileErrorCode; message: string };

/**
 * True for the worker's own result message. Under `node --watch` (pnpm dev)
 * Node also posts `{ "watch:import": [...] }` / `{ "watch:require": [...] }`
 * from every worker to report its dependencies; those must be ignored rather
 * than taken as a failed parse.
 */
export function isParseResult(msg: unknown): msg is ParseResult {
  return (
    typeof msg === 'object' && msg !== null && typeof (msg as { ok?: unknown }).ok === 'boolean'
  );
}

/**
 * Parse an uploaded file in a worker thread with a memory cap and a timeout,
 * so a hostile or pathological file can never block the server or exhaust
 * its memory. Works from TypeScript sources (dev, tests) and compiled dist.
 */
export function parseFileInWorker(
  bytes: Uint8Array,
  password?: string,
  timeoutMs = PARSE_TIMEOUT_MS,
): Promise<Workbook> {
  const ext = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const worker = new Worker(new URL(`./worker.${ext}`, import.meta.url), {
    workerData: { bytes, password },
    resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64 },
  });
  return new Promise<Workbook>((resolve, reject) => {
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new ImportFileError('parse_timeout', 'File took too long to read'));
    }, timeoutMs);
    const onMessage = (msg: unknown) => {
      if (!isParseResult(msg)) return;
      worker.off('message', onMessage);
      clearTimeout(timer);
      void worker.terminate();
      if (msg.ok) resolve(msg.workbook);
      else reject(new ImportFileError(msg.code, msg.message));
    };
    worker.on('message', onMessage);
    worker.once('error', (error) => {
      clearTimeout(timer);
      reject(
        error instanceof Error && /memory/i.test(error.message)
          ? new ImportFileError('file_too_large', 'File needs too much memory to read')
          : new ImportFileError('corrupt_file', 'File could not be read'),
      );
    });
  });
}
