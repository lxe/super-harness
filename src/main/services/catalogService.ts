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
import { runPiRpcQuery } from './piRpcClient';

const execFileAsync = promisify(execFile);

const HOME = os.homedir();
const CODEX_DIR = path.join(HOME, '.codex');
const CODEX_MODELS_CACHE = path.join(CODEX_DIR, 'models_cache.json');
const CODEX_CONFIG_TOML = path.join(CODEX_DIR, 'config.toml');
const CODEX_STATE_DB = path.join(CODEX_DIR, 'state_5.sqlite');
const CLAUDE_SETTINGS_PATH = path.join(HOME, '.claude', 'settings.json');
const AGY_APP_DB = path.join(HOME, '.gemini', 'antigravity', 'conversation_summaries.db');
const AGY_CLI_DB = path.join(HOME, '.gemini', 'antigravity-cli', 'conversation_summaries.db');
const MUSE_SETTINGS_PATH = path.join(
  process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'),
  'muse',
  'settings.json'
);
const MUSE_MODEL_EFFORT_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
];

const PI_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Maps Pi RPC `get_available_models` Model objects into picker options (`provider/id`).
 * Thinking levels come from the model's `thinkingLevelMap`, where `null` marks a level
 * the provider does not support; reasoning models without a map get Pi's standard set.
 */
export function parsePiModels(
  models: unknown,
  defaultRef?: string,
  defaultThinking?: string
): HarnessModelOption[] {
  const out: HarnessModelOption[] = [];
  for (const raw of Array.isArray(models) ? models : []) {
    const m = (raw ?? {}) as Record<string, unknown>;
    if (typeof m.provider !== 'string' || typeof m.id !== 'string') continue;
    const id = `${m.provider}/${m.id}`;
    let levels: string[] | undefined;
    if (m.reasoning === true) {
      const map = m.thinkingLevelMap as Record<string, unknown> | undefined;
      levels = map
        ? PI_LEVELS.filter((l) => l === 'off' || (l in map && map[l] !== null))
        : ['off', 'minimal', 'low', 'medium', 'high'];
    }
    const ctx = typeof m.contextWindow === 'number' ? `${Math.round(m.contextWindow / 1024)}K context` : undefined;
    out.push({
      id,
      label: typeof m.name === 'string' && m.name ? `${m.name}` : String(m.id),
      description: [id, ctx].filter(Boolean).join(' · '),
      group: m.provider,
      isDefault: id === defaultRef,
      reasoningLevels: levels,
      defaultReasoningLevel: id === defaultRef && defaultThinking && levels?.includes(defaultThinking) ? defaultThinking : undefined,
    });
  }
  out.sort((a, b) => Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)));
  return out;
}

const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const AGY_EFFORT_SUFFIX_RE = /^(.*)-(low|medium|high|xhigh|max)$/i;

/**
 * Parses `agy models` stdout lines (`<slug>\t<Display Name>`) into HarnessModelOption[],
 * annotating sibling thinking/effort variants (e.g. `-low`, `-medium`, `-high`, `-xhigh`).
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

  // Group sibling effort suffixes by base model stem so UI can switch thinking mode cleanly
  const levelsByBase = new Map<string, Set<string>>();
  for (const item of out) {
    const m = item.id.match(AGY_EFFORT_SUFFIX_RE);
    if (!m) continue;
    const base = m[1];
    const eff = m[2].toLowerCase();
    if (!levelsByBase.has(base)) levelsByBase.set(base, new Set());
    levelsByBase.get(base)!.add(eff);
  }
  for (const item of out) {
    const m = item.id.match(AGY_EFFORT_SUFFIX_RE);
    if (!m) continue;
    const set = levelsByBase.get(m[1]);
    if (set && set.size > 0) {
      item.reasoningLevels = Array.from(set).sort(
        (a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b)
      );
      item.defaultReasoningLevel = m[2].toLowerCase();
    }
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
        default_reasoning_level?: string;
        supported_reasoning_levels?: Array<{ effort?: string }>;
      }>;
    };
    const rawModels = Array.isArray(parsed.models) ? parsed.models : [];
    const visible = rawModels
      .filter((m) => m.slug && (!m.visibility || m.visibility === 'list'))
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));

    return visible.map((m) => {
      const levels = Array.isArray(m.supported_reasoning_levels)
        ? m.supported_reasoning_levels
            .map((l) => l.effort?.trim().toLowerCase())
            .filter((x): x is string => Boolean(x))
        : undefined;
      return {
        id: m.slug!,
        label: m.display_name || m.slug!,
        description: m.description,
        isDefault: Boolean(defaultSlug && m.slug === defaultSlug),
        reasoningLevels: levels && levels.length > 0 ? levels : undefined,
        defaultReasoningLevel: m.default_reasoning_level?.trim().toLowerCase() || undefined,
      };
    });
  } catch {
    return [];
  }
}

/**
 * Parses `muse exec --list-models` stdout (one model id per line, with
 * human `muse:` notices filtered out) into picker options.
 */
export function parseMuseModelsOutput(
  stdout: string,
  defaultModelId?: string
): HarnessModelOption[] {
  const out: HarnessModelOption[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split('\n')) {
    const id = rawLine.trim();
    if (!id || id.startsWith('muse:')) continue;
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      label: id,
      isDefault: Boolean(defaultModelId && id === defaultModelId),
      reasoningLevels: MUSE_MODEL_EFFORT_LEVELS,
    });
  }
  return out;
}

function readMuseSettingsDefaults(): { model?: string; reasoningEffort?: string } {
  try {
    if (!fs.existsSync(MUSE_SETTINGS_PATH)) return {};
    const s = JSON.parse(fs.readFileSync(MUSE_SETTINGS_PATH, 'utf8')) as {
      model?: string;
      model_reasoning_efforts?: Record<string, string>;
    };
    const model = typeof s.model === 'string' && s.model.trim() ? s.model.trim() : undefined;
    const efforts = s.model_reasoning_efforts ?? {};
    const reasoningEffort =
      (model && typeof efforts[model] === 'string' ? efforts[model] : efforts['*'])?.toLowerCase();
    return { model, reasoningEffort: reasoningEffort || undefined };
  } catch {
    return {};
  }
}

function readCodexConfigDefaults(): { model?: string; reasoningEffort?: string } {
  try {
    if (!fs.existsSync(CODEX_CONFIG_TOML)) return {};
    const raw = fs.readFileSync(CODEX_CONFIG_TOML, 'utf8');
    const model = raw.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1];
    const reasoningEffort = raw
      .match(/^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m)?.[1]
      ?.toLowerCase();
    return { model, reasoningEffort };
  } catch {
    return {};
  }
}

function readClaudeDefaultEffort(): string | undefined {
  try {
    if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) return undefined;
    const s = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8')) as {
      effortLevel?: string;
    };
    return typeof s.effortLevel === 'string' && s.effortLevel.trim()
      ? s.effortLevel.trim().toLowerCase()
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Claude Code's own /model picker, main section: one row per tier, newest
 * model first. Update when Claude Code's picker changes (its built-in list
 * lives in the CLI; extra rows such as Fable come from ~/.claude.json).
 */
const CLAUDE_PICKER_TIERS: Array<{ family: string; id: string; label: string; description: string }> = [
  { family: 'opus', id: 'claude-opus-5-5', label: 'Opus 5.5', description: 'For complex work and everyday tasks' },
  { family: 'sonnet', id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', description: 'Most efficient for everyday tasks' },
  { family: 'haiku', id: 'claude-haiku-5-5', label: 'Haiku 5.5', description: 'Fastest for quick answers' },
];

const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** `opus`, `opus[1m]`, `claude-opus-5-5[1m]` → `opus`; null when it isn't a Claude tier ID. */
function claudeFamily(id: string): string | null {
  const m = id.toLowerCase().match(/^(?:claude-)?(opus|sonnet|haiku|fable)\b/);
  return m ? m[1] : null;
}

/** Same ID with and without the `[1m]` context suffix. */
function withContextVariants(id: string): string[] {
  const base = id.replace(/\[[^\]]+\]$/, '');
  return Array.from(new Set([id, base, `${base}[1m]`]));
}

/** Extra picker rows Claude Code caches for this account (e.g. Fable). */
function readClaudeAdditionalModels(): Array<{ value: string; label: string; description?: string }> {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8')) as {
      additionalModelOptionsCache?: Array<{ value?: string; label?: string; description?: string }>;
    };
    return (j.additionalModelOptionsCache ?? [])
      .filter((o): o is { value: string; label: string; description?: string } =>
        typeof o?.value === 'string' && typeof o?.label === 'string'
      );
  } catch {
    return [];
  }
}

/**
 * The Claude model list mirrors Claude Code's /model picker: Opus, then any
 * extra rows the account has (Fable), then Sonnet and Haiku. A row whose tier
 * matches the default in ~/.claude/settings.json launches that exact ID (so
 * `opus[1m]` keeps its 1M context) and carries the Default badge.
 */
export function collectClaudeModels(): HarnessModelOption[] {
  let settingsDefault: string | undefined;
  try {
    if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
      const s = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8')) as { model?: string };
      if (typeof s.model === 'string' && s.model.trim()) settingsDefault = s.model.trim();
    }
  } catch {
    // ignore
  }
  const defaultFamily = settingsDefault ? claudeFamily(settingsDefault) : null;

  const row = (family: string, id: string, label: string, description?: string): HarnessModelOption => {
    const isDefault = Boolean(defaultFamily && defaultFamily === family);
    const launchId = isDefault ? settingsDefault! : id;
    return {
      id: launchId,
      label,
      description,
      isDefault,
      reasoningLevels: CLAUDE_EFFORT_LEVELS,
      aliases: Array.from(new Set([...withContextVariants(id), ...withContextVariants(launchId), family])),
    };
  };

  const [opus, ...rest] = CLAUDE_PICKER_TIERS;
  const out: HarnessModelOption[] = [row(opus.family, opus.id, opus.label, opus.description)];
  for (const extra of readClaudeAdditionalModels()) {
    const family = claudeFamily(extra.value) ?? extra.value;
    // "Fable 5.2 · Most capable for…" → label "Fable 5.2", description after the dot
    const [head, ...tail] = (extra.description ?? '').split(' · ');
    out.push(row(family, extra.value, head?.trim() || extra.label, tail.join(' · ').trim() || undefined));
  }
  for (const t of rest) out.push(row(t.family, t.id, t.label, t.description));
  return out;
}

let claudeRowsCache: { at: number; rows: HarnessModelOption[] } | null = null;

/**
 * The Claude picker row ID for a model a session reports, e.g. `claude-opus-5-5` → `opus[1m]`
 * when that is the Opus row. Sessions log bare model names; clients (the iOS app in particular)
 * match the current model to a row by exact ID, so an unmapped name shows no checkmark and no
 * effort levels. Unknown models (e.g. an older Opus) are returned unchanged.
 */
export function canonicalClaudeModelId(model: string | undefined): string | undefined {
  if (!model) return model;
  const now = Date.now();
  if (!claudeRowsCache || now - claudeRowsCache.at > 30_000) {
    claudeRowsCache = { at: now, rows: collectClaudeModels() };
  }
  for (const row of claudeRowsCache.rows) {
    if (row.id === model || row.aliases?.includes(model)) return row.id;
  }
  return model;
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
      const museCfg = readMuseSettingsDefaults();
      const [agyModels, museModels, pi, codexProjects, agyProjects] = await Promise.all([
        this.fetchAgyModels(sessions),
        this.fetchMuseModels(museCfg.model),
        this.fetchPiModels(),
        this.fetchCodexProjects(),
        this.fetchAgyProjects(),
      ]);

      const codexCfg = readCodexConfigDefaults();
      const codexModels = fs.existsSync(CODEX_MODELS_CACHE)
        ? parseCodexModelsCache(fs.readFileSync(CODEX_MODELS_CACHE, 'utf8'), codexCfg.model)
        : [];
      const claudeModels = collectClaudeModels();
      const claudeEffort = readClaudeDefaultEffort();

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
          muse: museModels,
          pi: pi.models,
        },
        defaultReasoningEffort: {
          codex: codexCfg.reasoningEffort,
          claude: claudeEffort,
          antigravity: agyModels[0]?.defaultReasoningLevel || 'high',
          muse: museCfg.reasoningEffort,
          pi: pi.thinking,
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

  private async fetchAgyModels(sessions: UnifiedSession[] = []): Promise<HarnessModelOption[]> {
    try {
      const bin = await whichBinary('agy');
      if (bin) {
        const { stdout } = await execFileAsync(bin, ['models'], {
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
        });
        const parsed = parseAgyModelsOutput(stdout);
        if (parsed.length > 0) return parsed;
      }
    } catch {
      // Fall through to fallback list when `agy` CLI is not independently signed in
    }
    return this.collectAgyFallbackModels(sessions);
  }

  private collectAgyFallbackModels(sessions: UnifiedSession[]): HarnessModelOption[] {
    const knownLines = [
      'gemini-4-neon-high\tGemini 4 Neon (High)',
      'gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)',
      'gemini-4-neon-medium\tGemini 4 Neon (Medium)',
      'gemini-4-neon-low\tGemini 4 Neon (Low)',
      'gemini-4-carbon-high\tGemini 4 Carbon (High)',
      'gemini-4-carbon-medium\tGemini 4 Carbon (Medium)',
      'gemini-4-carbon-low\tGemini 4 Carbon (Low)',
      'gemini-4-argon-high\tGemini 4 Argon (High)',
      'gemini-4-argon-medium\tGemini 4 Argon (Medium)',
      'gemini-4-argon-low\tGemini 4 Argon (Low)',
      'gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)',
      'gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)',
      'gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)',
      'gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)',
      'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
      'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
      'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
      'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
      'claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)',
      'claude-opus-5-5-low\tClaude Opus 5.5 (Low)',
      'claude-sonnet-5-5-high\tClaude Sonnet 5.5 (High)',
      'claude-sonnet-5-5-medium\tClaude Sonnet 5.5 (Medium)',
      'claude-sonnet-5-5-low\tClaude Sonnet 5.5 (Low)',
      'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
    ];
    for (const s of sessions) {
      if (s.harnessGroup !== 'antigravity') continue;
      const m = (s.model || '').trim();
      if (m && !knownLines.some((l) => l.startsWith(`${m}\t`))) {
        knownLines.push(`${m}\t${m}`);
      }
    }
    return parseAgyModelsOutput(knownLines.join('\n'));
  }

  private async fetchPiModels(): Promise<{ models: HarnessModelOption[]; thinking?: string }> {
    try {
      const bin = await whichBinary('pi');
      if (!bin) return { models: [] };
      const [models, state] = await runPiRpcQuery(bin, [{ type: 'get_available_models' }, { type: 'get_state' }]);
      const model = (state?.model ?? {}) as Record<string, unknown>;
      const defaultRef =
        typeof model.provider === 'string' && typeof model.id === 'string' ? `${model.provider}/${model.id}` : undefined;
      const thinking = typeof state?.thinkingLevel === 'string' ? state.thinkingLevel : undefined;
      return { models: parsePiModels(models?.models, defaultRef, thinking), thinking };
    } catch {
      return { models: [] };
    }
  }

  private async fetchMuseModels(defaultModelId?: string): Promise<HarnessModelOption[]> {
    try {
      const bin = await whichBinary('muse');
      if (!bin) return [];
      const { stdout } = await execFileAsync(bin, ['exec', '--list-models'], {
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
      return parseMuseModelsOutput(stdout, defaultModelId);
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
