/** Writes docs/user-manual.md from src/manual.ts (`pnpm manual:md`). */
import { writeFileSync } from 'node:fs';
import { renderManualMarkdown } from '../src/manual-markdown.ts';

const target = new URL('../../../docs/user-manual.md', import.meta.url);
writeFileSync(target, renderManualMarkdown());
process.stdout.write(`wrote ${target.pathname}\n`);
