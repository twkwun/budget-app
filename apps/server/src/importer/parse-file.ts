import { Worker } from 'node:worker_threads';
import { ImportFileError, type ImportFileErrorCode, type Workbook } from './types.ts';

export const PARSE_TIMEOUT_MS = 20_000;

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
    worker.once(
      'message',
      (
        msg:
          | { ok: true; workbook: Workbook }
          | { ok: false; code: ImportFileErrorCode; message: string },
      ) => {
        clearTimeout(timer);
        void worker.terminate();
        if (msg.ok) resolve(msg.workbook);
        else reject(new ImportFileError(msg.code, msg.message));
      },
    );
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
