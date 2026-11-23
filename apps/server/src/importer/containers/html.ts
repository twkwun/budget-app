import { LIMITS, clampText, ImportFileError, type Cell } from '../types.ts';

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code =
        e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function looksLikeHtml(head: string): boolean {
  return (
    /^\s*(<!doctype html|<html|<table|<\?xml[^>]*>\s*<html|<meta)/i.test(head) ||
    /<table[\s>]/i.test(head.slice(0, 4096))
  );
}

export function htmlCharset(head: string): string | null {
  return /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1] ?? null;
}

/**
 * Rows of every <table> in an HTML document ("엑셀 저장" pages saved with an
 * .xls extension). Scripts and styles are dropped; only text is kept.
 */
export function parseHtmlTables(html: string): { name: string; rows: Cell[][] }[] {
  const cleaned = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const tables = cleaned.match(/<table[\s\S]*?<\/table>/gi) ?? [];
  return tables.map((table, index) => {
    const rows: Cell[][] = [];
    for (const tr of table.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
      const cells = (tr.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) ?? [])
        .slice(0, LIMITS.columns)
        .map((td) =>
          clampText(
            decodeEntities(
              td
                .replace(/<br\s*\/?>/gi, ' ')
                .replace(/<[^>]+>/g, '')
                .replace(/\s+/g, ' '),
            ).trim(),
          ),
        );
      if (cells.some((c) => c !== '')) rows.push(cells);
      if (rows.length > LIMITS.rowsPerSheet)
        throw new ImportFileError('too_many_rows', 'Too many rows');
    }
    return { name: `표 ${index + 1}`, rows };
  });
}
