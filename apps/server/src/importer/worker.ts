/** Worker entry: parse one uploaded file off the main thread. */
import { parentPort, workerData } from 'node:worker_threads';
import { readWorkbook } from './read.ts';
import { ImportFileError } from './types.ts';

const { bytes, password } = workerData as { bytes: Uint8Array; password?: string };
try {
  parentPort?.postMessage({ ok: true, workbook: readWorkbook(bytes, password) });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    code: error instanceof ImportFileError ? error.code : 'corrupt_file',
    message: error instanceof Error ? error.message : 'parse failed',
  });
}
