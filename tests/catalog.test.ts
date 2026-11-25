import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createProjectDirectory,
  mergeHarnessProjects,
  parseAgyModelsOutput,
  parseCodexModelsCache,
} from '../src/main/services/catalogService';

describe('catalogService parsers & project helpers', () => {
  it('parses `agy models` output (both tab-separated non-TTY and space-padded TTY)', () => {
    const raw = [
      '\x1b[2K\r⠋ Fetching available models...',
      'gemini-4-neon-high\tGemini 4 Neon (High)',
      '\x1b[2K\r  claude-opus-5-5-high     Claude Opus 5.5 (High)',
      'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
      'gemini-4-neon-high\tGemini 4 Neon (High)',
    ].join('\n');

    const models = parseAgyModelsOutput(raw);
    expect(models).toEqual([
      { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)', group: 'Gemini' },
      { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)', group: 'Claude' },
      { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)', group: 'GPT' },
    ]);
  });

  it('filters Codex models_cache.json by visibility, sorts by priority, and marks default', () => {
    const raw = JSON.stringify({
      models: [
        { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hide', priority: 0 },
        { slug: 'gpt-6.2-astra', display_name: 'GPT-6.2 Astra', visibility: 'list', priority: 2 },
        {
          slug: 'gpt-6.2-sol',
          display_name: 'GPT-6.2 Sol',
          description: 'Flagship coding model',
          visibility: 'list',
          priority: 1,
        },
      ],
    });

    const models = parseCodexModelsCache(raw, 'gpt-6.2-sol');
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      id: 'gpt-6.2-sol',
      label: 'GPT-6.2 Sol',
      description: 'Flagship coding model',
      isDefault: true,
    });
    expect(models[1]).toMatchObject({
      id: 'gpt-6.2-astra',
      label: 'GPT-6.2 Astra',
      isDefault: false,
    });
  });

  it('merges and deduplicates projects across harnesses and ranks home dir below repos', () => {
    const base = fs.mkdtempSync(path.join(os.homedir(), '.sh-test-proj-'));
    const repoA = path.join(base, 'alpha-repo');
    const repoB = path.join(base, 'beta-repo');
    fs.mkdirSync(repoA, { recursive: true });
    fs.mkdirSync(repoB, { recursive: true });

    try {
      const merged = mergeHarnessProjects([
        { path: os.homedir(), harness: 'codex', lastUsedAt: 9999 },
        { path: `file://${repoA}`, harness: 'antigravity', lastUsedAt: 1000 },
        { name: 'Alpha Custom', path: repoA, harness: 'codex', lastUsedAt: 2000 },
        { path: repoB, harness: 'claude', lastUsedAt: 3000 },
        { path: '/tmp/ephemeral-skip', harness: 'claude', lastUsedAt: 5000 },
        { path: path.join(base, 'does-not-exist'), harness: 'codex', lastUsedAt: 5000 },
      ]);

      expect(merged.map((p) => p.path)).toEqual([repoB, repoA, os.homedir()]);
      const alpha = merged.find((p) => p.path === repoA)!;
      expect(alpha.name).toBe('Alpha Custom');
      expect(alpha.harnesses.sort()).toEqual(['antigravity', 'codex']);
      expect(alpha.lastUsedAt).toBe(2000);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('creates new project directories safely and rejects invalid names', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-create-proj-'));
    try {
      expect(createProjectDirectory(tmpBase, '   ').ok).toBe(false);
      expect(createProjectDirectory(tmpBase, '..').ok).toBe(false);
      expect(createProjectDirectory(path.join(tmpBase, 'missing-parent'), 'demo').ok).toBe(false);

      const created = createProjectDirectory(tmpBase, 'my-new-app');
      expect(created.ok).toBe(true);
      expect(created.path).toBe(path.join(tmpBase, 'my-new-app'));
      expect(fs.existsSync(created.path!)).toBe(true);
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});
