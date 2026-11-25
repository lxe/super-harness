import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  HarnessCatalog,
  HarnessGroup,
  HarnessModelOption,
  HarnessProjectOption,
  UnifiedSession,
} from '../../shared/types';
import { querySqliteReadOnly } from '../utils/sqlite';
import { projectNameFromCwd, whichBinary } from '../utils/system';

const execFileAsync = promisify(execFile);

const HOME = os.homedir();
const CODEX_DIR = path.join(HOME, '.codex');
const CODEX_MODELS_CACHE = path.join(CODEX_DIR, 'models_cache.json');
const CODEX_CONFIG_TOML = path.join(CODEX_DIR, 'config.toml');
const CODEX_STATE_DB = path.join(CODEX_DIR, 'state_5.sqlite');
const CLAUDE_DESKTOP_SESSIONS_DIR = path.join(
  HOME,
  '.config',
  'Claude',
  'claude-code-sessions'
);
const CLAUDE_SETTINGS_PATH = path.join(HOME, '.claude', 'settings.json');
const AGY_APP_DB = path.join(HOME, '.gemini', 'antigravity', 'conversation_summaries.db');
const AGY_CLI_DB = path.join(HOME, '.gemini', 'antigravity-cli', 'conversation_summaries.db');

/**
 * Parses `agy models` stdout lines (`<slug>   <Display Name>`) into HarnessModelOption[].
 */
export function parseAgyModelsOutput(stdout: string): HarnessModelOption[] {
  const out: HarnessModelOption[] = [];
  const seen = new Set<string>();
  // Strip ANSI escape codes & carriage returns from spinner output
  const clean = stdout
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\r/g, '\n');
  for (const rawLine of clean.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.includes('Fetching available models')) continue;
    const m = line.match(/^([a-z0-9][a-z0-9._-]+)(?:\t+|\s{2,})(.+)$/i);
    if (!m) continue;
    const id = m[1].trim();
    const label = m[2].trim();
    if (seen.has(id)) continue;
    seen.add(id);
    const group = /claude/i.test(id)
      ? 'Claude'
      : /gpt/i.test(id)
        ? 'GPT'
        : /orchestrator/i.test(id)
          ? 'Orchestrator'
          : 'Gemini';
    out.push({ id, label, group });
  }
  return out;
}

/**
 * Parses `~/.codex/models_cache.json` (plus optional default slug from `config.toml`).
 */
export function parseCodexModelsCache(
  rawJson: string,
  defaultSlug?: string
): HarnessModelOption[] {
  try {
    const parsed = JSON.parse(rawJson) as {
      models?: Array<{
        slug?: string;
        display_name?: string;
        description?: string;
        visibility?: string;
        priority?: number;
      }>;
    };
    const rawModels = Array.isArray(parsed.models) ? parsed.models : [];
    const visible = rawModels
      .filter((m) => m.slug && (!m.visibility || m.visibility === 'list'))
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));

    return visible.map((m) => ({
      id: m.slug!,
      label: m.display_name || m.slug!,
      description: m.description,
      isDefault: Boolean(defaultSlug && m.slug === defaultSlug),
    }));
  } catch {
    return [];
  }
}

function readCodexDefaultModel(): string | undefined {
  try {
    if (!fs.existsSync(CODEX_CONFIG_TOML)) return undefined;
    const raw = fs.readFileSync(CODEX_CONFIG_TOML, 'utf8');
    const m = raw.match(/^\s*model\s*=\s*"([^"]+)"/m);
    return m?.[1];
  } catch {
    return undefined;
  }
}

function formatClaudeModelLabel(id: string): string {
  if (id === 'opus') return 'Opus (latest alias)';
  if (id === 'sonnet') return 'Sonnet (latest alias)';
  if (id === 'haiku') return 'Haiku (latest alias)';
  const ctxMatch = id.match(/\[([^\]]+)\]$/);
  const base = id.replace(/\[[^\]]+\]$/, '');
  const nice = base
    .replace(/^claude-/, 'Claude ')
    .replace(/-/g, ' ')
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .replace(/(\d)\s+(\d)/g, '$1.$2');
  return ctxMatch ? `${nice} (${ctxMatch[1].toUpperCase()})` : nice;
}

function collectClaudeModels(sessions: UnifiedSession[]): HarnessModelOption[] {
  const counts = new Map<string, number>();
  let settingsDefault: string | undefined;

  try {
    if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
      const s = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8')) as { model?: string };
      if (typeof s.model === 'string' && s.model.trim()) {
        settingsDefault = s.model.trim();
      }
    }
  } catch {
    // ignore
  }

  for (const s of sessions) {
    if (s.harnessGroup === 'claude' && s.model) {
      counts.set(s.model, (counts.get(s.model) ?? 0) + 1);
    }
  }

  // Also scan recent Claude Desktop metadata for observed models
  if (fs.existsSync(CLAUDE_DESKTOP_SESSIONS_DIR)) {
    const walk = (dir: string, depth: number) => {
      if (depth > 3) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.isFile() && e.name.startsWith('local_') && e.name.endsWith('.json')) {
          try {
            const j = JSON.parse(fs.readFileSync(p, 'utf8')) as { model?: string };
            if (typeof j.model === 'string' && j.model.trim()) {
              counts.set(j.model.trim(), (counts.get(j.model.trim()) ?? 0) + 1);
            }
          } catch {
            // ignore
          }
        }
      }
    };
    walk(CLAUDE_DESKTOP_SESSIONS_DIR, 0);
  }

  const out: HarnessModelOption[] = [];
  const seen = new Set<string>();

  const pushModel = (id: string, isDefault?: boolean) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ id, label: formatClaudeModelLabel(id), isDefault });
  };

  if (settingsDefault) pushModel(settingsDefault, true);

  const sortedObserved = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  for (const [id] of sortedObserved.slice(0, 10)) {
    pushModel(id, !settingsDefault && out.length === 0);
  }

  // Always include Claude CLI's official shorthand aliases as reliable fallbacks
  for (const alias of ['opus', 'sonnet', 'haiku']) {
    pushModel(alias, false);
  }

  return out;
}

/**
 * Deduplicates and ranks project directories discovered across Codex, Claude,
 * and Antigravity into one clean list.
 */
export function mergeHarnessProjects(
  entries: Array<{ name?: string; path: string; harness: HarnessGroup; lastUsedAt?: number }>
): HarnessProjectOption[] {
  const byPath = new Map<
    string,
    { name: string; path: string; harnesses: Set<HarnessGroup>; lastUsedAt: number }
  >();

  for (const item of entries) {
    const rawPath = item.path?.trim();
    if (!rawPath) continue;
    const normalized = path.resolve(rawPath.replace(/^file:\/\//, ''));
    // Skip non-existent or ephemeral /tmp directories
    if (normalized.startsWith('/tmp/')) continue;
    const existing = byPath.get(normalized);
    const derivedName =
      item.name?.trim() || (normalized === HOME ? '~ (Home)' : projectNameFromCwd(normalized));

    if (!existing) {
      byPath.set(normalized, {
        name: derivedName,
        path: normalized,
        harnesses: new Set([item.harness]),
        lastUsedAt: item.lastUsedAt ?? 0,
      });
    } else {
      existing.harnesses.add(item.harness);
      if (item.name?.trim() && existing.name === projectNameFromCwd(normalized)) {
        existing.name = item.name.trim();
      }
      existing.lastUsedAt = Math.max(existing.lastUsedAt, item.lastUsedAt ?? 0);
    }
  }

  return Array.from(byPath.values())
    .filter((p) => {
      try {
        return fs.existsSync(p.path) && fs.statSync(p.path).isDirectory();
      } catch {
        return false;
      }
    })
    .map((p) => ({
      name: p.name,
      path: p.path,
      harnesses: Array.from(p.harnesses),
      lastUsedAt: p.lastUsedAt || undefined,
    }))
    .sort((a, b) => {
      // Push bare home dir below real project repos
      const aHome = a.path === HOME ? 1 : 0;
      const bHome = b.path === HOME ? 1 : 0;
      if (aHome !== bHome) return aHome - bHome;
      // More harnesses or more recently used first
      if ((b.lastUsedAt ?? 0) !== (a.lastUsedAt ?? 0)) {
        return (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0);
      }
      return a.name.localeCompare(b.name);
    });
}

const CATALOG_TTL_MS = 5 * 60_000;

export class HarnessCatalogService {
  private cache: HarnessCatalog | null = null;
  private inFlight: Promise<HarnessCatalog> | null = null;

  async getCatalog(
    sessions: UnifiedSession[],
    force = false
  ): Promise<HarnessCatalog> {
    if (!force && this.cache && Date.now() - this.cache.updatedAt < CATALOG_TTL_MS) {
      return this.cache;
    }
    if (this.inFlight) return this.inFlight;

    this.inFlight = (async () => {
      const [agyModels, codexProjects, agyProjects] = await Promise.all([
        this.fetchAgyModels(),
        this.fetchCodexProjects(),
        this.fetchAgyProjects(),
      ]);

      const codexDefault = readCodexDefaultModel();
      const codexModels = fs.existsSync(CODEX_MODELS_CACHE)
        ? parseCodexModelsCache(fs.readFileSync(CODEX_MODELS_CACHE, 'utf8'), codexDefault)
        : [];
      const claudeModels = collectClaudeModels(sessions);

      const rawProjects: Array<{
        name?: string;
        path: string;
        harness: HarnessGroup;
        lastUsedAt?: number;
      }> = [...codexProjects, ...agyProjects];

      for (const s of sessions) {
        if (s.harnessGroup === 'master' || !s.cwd) continue;
        rawProjects.push({
          name:
            s.nativeSection && s.nativeSection !== 'Ungrouped' && s.nativeSection !== 'Pinned'
              ? s.nativeSection
              : undefined,
          path: s.cwd,
          harness: s.harnessGroup,
          lastUsedAt: s.updatedAt,
        });
      }

      const catalog: HarnessCatalog = {
        models: {
          antigravity: agyModels,
          codex: codexModels,
          claude: claudeModels,
        },
        projects: mergeHarnessProjects(rawProjects),
        updatedAt: Date.now(),
      };
      this.cache = catalog;
      return catalog;
    })();

    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  invalidate(): void {
    this.cache = null;
  }

  private async fetchAgyModels(): Promise<HarnessModelOption[]> {
    try {
      const bin = await whichBinary('agy');
      if (!bin) return [];
      const { stdout } = await execFileAsync(bin, ['models'], {
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
      return parseAgyModelsOutput(stdout);
    } catch {
      return [];
    }
  }

  private async fetchCodexProjects(): Promise<
    Array<{ name?: string; path: string; harness: HarnessGroup }>
  > {
    if (!fs.existsSync(CODEX_STATE_DB)) return [];
    const rows = await querySqliteReadOnly<{ name: string | null; path: string | null }>(
      CODEX_STATE_DB,
      `SELECT p.name, r.path
       FROM projects p
       JOIN project_roots r ON r.project_id = p.id
       WHERE r.path IS NOT NULL`
    );
    return rows
      .filter((r) => Boolean(r.path))
      .map((r) => ({
        name: r.name || undefined,
        path: r.path!,
        harness: 'codex' as const,
      }));
  }

  private async fetchAgyProjects(): Promise<
    Array<{ name?: string; path: string; harness: HarnessGroup }>
  > {
    const out: Array<{ name?: string; path: string; harness: HarnessGroup }> = [];
    for (const dbPath of [AGY_APP_DB, AGY_CLI_DB]) {
      if (!fs.existsSync(dbPath)) continue;
      const rows = await querySqliteReadOnly<{ workspace_uris: string | null }>(
        dbPath,
        'SELECT DISTINCT workspace_uris FROM conversation_summaries WHERE workspace_uris IS NOT NULL'
      );
      for (const r of rows) {
        if (!r.workspace_uris) continue;
        try {
          const arr = JSON.parse(r.workspace_uris) as unknown;
          if (Array.isArray(arr)) {
            for (const uri of arr) {
              if (typeof uri === 'string' && uri.trim()) {
                out.push({
                  path: uri.replace(/^file:\/\//, ''),
                  harness: 'antigravity',
                });
              }
            }
          }
        } catch {
          // ignore
        }
      }
    }
    return out;
  }
}

/**
 * Safely creates a new project directory under `parentDir` and returns its resolved path.
 */
export function createProjectDirectory(
  parentDir: string,
  name: string
): { ok: boolean; path?: string; error?: string } {
  const cleanName = name.trim().replace(/[\\/]+/g, '-');
  if (!cleanName || cleanName === '.' || cleanName === '..') {
    return { ok: false, error: 'Please enter a valid folder name.' };
  }
  const base = parentDir.trim() ? parentDir.trim().replace(/^~(?=\/|$)/, HOME) : HOME;
  const resolvedParent = path.resolve(base);
  if (!fs.existsSync(resolvedParent)) {
    return { ok: false, error: `Parent directory does not exist: ${resolvedParent}` };
  }
  const target = path.join(resolvedParent, cleanName);
  try {
    fs.mkdirSync(target, { recursive: true });
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
