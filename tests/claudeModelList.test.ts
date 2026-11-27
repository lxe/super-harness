import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const homes: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

async function modelsFor(settings: object, claudeJson: object) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-claude-models-'));
  homes.push(home);
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(settings));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(claudeJson));
  vi.stubEnv('HOME', home);
  vi.resetModules();
  const { collectClaudeModels } = await import('../src/main/services/catalogService');
  return collectClaudeModels();
}

describe('Claude model list mirrors the Claude Code /model picker', () => {
  it('lists Opus, the account extras (Fable), Sonnet, Haiku; the default tier keeps its exact ID', async () => {
    const models = await modelsFor(
      { model: 'opus[1m]' },
      {
        additionalModelOptionsCache: [
          {
            value: 'claude-fable-5-2[1m]',
            label: 'Fable',
            description: 'Fable 5.2 · Most capable for your hardest and longest-running tasks',
          },
        ],
      }
    );
    expect(models.map((m) => m.label)).toEqual(['Opus 5.5', 'Fable 5.2', 'Sonnet 5.5', 'Haiku 5.5']);
    expect(models[0]).toMatchObject({ id: 'opus[1m]', isDefault: true });
    expect(models[0].aliases).toEqual(
      expect.arrayContaining(['claude-opus-5-5', 'claude-opus-5-5[1m]', 'opus', 'opus[1m]'])
    );
    expect(models[1]).toMatchObject({
      id: 'claude-fable-5-2[1m]',
      description: 'Most capable for your hardest and longest-running tasks',
      isDefault: false,
    });
    expect(models[2].id).toBe('claude-sonnet-5-5');
  });

  it('works with no settings default and no extras', async () => {
    const models = await modelsFor({}, {});
    expect(models.map((m) => m.id)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
    expect(models.some((m) => m.isDefault)).toBe(false);
  });
});
