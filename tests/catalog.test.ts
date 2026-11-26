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
  it('parses `agy models` output (both tab-separated non-TTY and space-padded TTY) with thinking levels', () => {
    const raw = [
      '\x1b[2K\r⠋ Fetching available models...',
      'gemini-2.5-pro-high\tGemini 2.5 Pro (High)',
      'gemini-2.5-pro-xhigh\tGemini 2.5 Pro (XHigh)',
      '\x1b[2K\r  claude-opus-4-6-high     Claude Opus 4.6 (High)',
      'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
      'gemini-2.5-pro-high\tGemini 2.5 Pro (High)',
    ].join('\n');

    const models = parseAgyModelsOutput(raw);
    expect(models).toEqual([
      {
        id: 'gemini-2.5-pro-high',
        label: 'Gemini 2.5 Pro (High)',
        group: 'Gemini',
        reasoningLevels: ['high', 'xhigh'],
        defaultReasoningLevel: 'high',
      },
      {
        id: 'gemini-2.5-pro-xhigh',
        label: 'Gemini 2.5 Pro (XHigh)',
        group: 'Gemini',
        reasoningLevels: ['high', 'xhigh'],
        defaultReasoningLevel: 'xhigh',
      },
      {
        id: 'claude-opus-4-6-high',
        label: 'Claude Opus 4.6 (High)',
        group: 'Claude',
        reasoningLevels: ['high'],
        defaultReasoningLevel: 'high',
      },
      {
        id: 'gpt-oss-120b-medium',
        label: 'GPT-OSS 120B (Medium)',
        group: 'GPT',
        reasoningLevels: ['medium'],
        defaultReasoningLevel: 'medium',
      },
    ]);
  });

  it('filters Codex models_cache.json by visibility, sorts by priority, and extracts reasoning levels', () => {
    const raw = JSON.stringify({
      models: [
        { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hide', priority: 0 },
        { slug: 'gpt-5.3-codex', display_name: 'GPT-5.3 Codex', visibility: 'list', priority: 2 },
        {
          slug: 'gpt-5.4',
          display_name: 'GPT-5.4',
          description: 'Flagship coding model',
          visibility: 'list',
          priority: 1,
          default_reasoning_level: 'low',
          supported_reasoning_levels: [
            { effort: 'low' },
            { effort: 'medium' },
            { effort: 'high' },
            { effort: 'xhigh' },
          ],
        },
      ],
    });

    const models = parseCodexModelsCache(raw, 'gpt-5.4');
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      id: 'gpt-5.4',
      label: 'GPT-5.4',
      description: 'Flagship coding model',
      isDefault: true,
      defaultReasoningLevel: 'low',
      reasoningLevels: ['low', 'medium', 'high', 'xhigh'],
    });
    expect(models[1]).toMatchObject({
      id: 'gpt-5.3-codex',
      label: 'GPT-5.3 Codex',
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
