import fs from 'node:fs';

interface Entry {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  value: unknown;
}

const cache = new Map<string, Entry>();
const MAX_ENTRIES = 2000;

/**
 * JSON.parse(fs.readFileSync(file)) memoized on (mtime, ctime, size), for files
 * that discovery re-reads every couple of seconds but that rarely change (e.g.
 * Codex's 4.8 MB global state, ~130 Claude Desktop session metas). Callers get
 * the same object back while the file is unchanged and must treat it as
 * read-only. Throws exactly like the uncached read when the file is missing or
 * not valid JSON.
 */
export function readJsonFileCached<T = unknown>(file: string, st?: fs.Stats): T {
  const stat = st ?? fs.statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.ctimeMs === stat.ctimeMs && hit.size === stat.size) {
    return hit.value as T;
  }
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  if (cache.size >= MAX_ENTRIES && !cache.has(file)) cache.delete(cache.keys().next().value as string);
  cache.set(file, { mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size, value });
  return value as T;
}
