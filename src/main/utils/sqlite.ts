import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface NodeSqliteDb {
  prepare: (sql: string) => {
    all: (...params: unknown[]) => Record<string, unknown>[];
  };
  close: () => void;
}

interface NodeSqliteModule {
  DatabaseSync: new (
    location: string,
    options?: { readOnly?: boolean; open?: boolean; timeout?: number }
  ) => NodeSqliteDb;
}

interface PooledDb {
  db: NodeSqliteDb;
  idleTimer: NodeJS.Timeout | null;
}

let nodeSqliteCache: NodeSqliteModule | null | undefined;
const dbPool = new Map<string, PooledDb>();
const POOL_IDLE_MS = 30_000;

function tryLoadNodeSqlite(): NodeSqliteModule | null {
  if (nodeSqliteCache !== undefined) return nodeSqliteCache;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    nodeSqliteCache = require('node:sqlite') as NodeSqliteModule;
  } catch {
    nodeSqliteCache = null;
  }
  return nodeSqliteCache;
}

function evictPooledDb(dbPath: string): void {
  const entry = dbPool.get(dbPath);
  if (!entry) return;
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  dbPool.delete(dbPath);
  try {
    entry.db.close();
  } catch {
    // ignore close errors
  }
}

function getPooledDb(mod: NodeSqliteModule, dbPath: string): NodeSqliteDb {
  let entry = dbPool.get(dbPath);
  if (!entry) {
    const db = new mod.DatabaseSync(dbPath, {
      readOnly: true,
      timeout: 1500,
    });
    entry = { db, idleTimer: null };
    dbPool.set(dbPath, entry);
  }
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    evictPooledDb(dbPath);
  }, POOL_IDLE_MS);
  entry.idleTimer.unref?.();
  return entry.db;
}

/**
 * Closes all pooled read-only SQLite handles (call on app exit or test teardown).
 */
export function closeSqlitePool(): void {
  for (const key of Array.from(dbPool.keys())) {
    evictPooledDb(key);
  }
}

/**
 * Safely query a local SQLite database in read-only mode without ever writing
 * or blocking active harness WAL writers. Reuses pooled read-only handles so
 * repeated queries avoid schema/WAL-index re-initialization overhead.
 */
export async function querySqliteReadOnly<T = Record<string, unknown>>(
  dbPath: string,
  sql: string,
  params: (string | number | null)[] = []
): Promise<T[]> {
  if (!fs.existsSync(dbPath)) return [];

  const mod = tryLoadNodeSqlite();
  if (mod) {
    try {
      const db = getPooledDb(mod, dbPath);
      const stmt = db.prepare(sql);
      return stmt.all(...params) as T[];
    } catch {
      // Evict stale handle (e.g., if DB was recreated or rotated) and retry once
      evictPooledDb(dbPath);
      try {
        const db = getPooledDb(mod, dbPath);
        const stmt = db.prepare(sql);
        return stmt.all(...params) as T[];
      } catch {
        evictPooledDb(dbPath);
        // Fall through to sqlite3 CLI fallback if node:sqlite fails on WAL/version
      }
    }
  }

  // Fallback to sqlite3 CLI (read-only immutable/timeout)
  let renderedSql = sql;
  for (const p of params) {
    const escaped =
      p === null
        ? 'NULL'
        : typeof p === 'number'
          ? String(p)
          : `'${String(p).replace(/'/g, "''")}'`;
    renderedSql = renderedSql.replace('?', escaped);
  }
  try {
    const { stdout } = await execFileAsync(
      'sqlite3',
      ['-readonly', '-json', '-cmd', '.timeout 1500', dbPath, renderedSql],
      { maxBuffer: 25 * 1024 * 1024 }
    );
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    return JSON.parse(trimmed) as T[];
  } catch {
    return [];
  }
}
