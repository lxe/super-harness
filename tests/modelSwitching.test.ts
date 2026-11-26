import { describe, expect, it } from 'vitest';
import { buildClaudeResumeArgs } from '../src/main/adapters/claudeAdapter';
import {
  resolveEffortSelectionChange,
  resolveModelSelectionChange,
  resolveSessionModelControls,
} from '../src/renderer/utils/modelOptions';
import type { HarnessCatalog } from '../src/shared/types';

const SAMPLE_CATALOG: HarnessCatalog = {
  updatedAt: 1700000000000,
  projects: [],
  defaultReasoningEffort: {
    codex: 'high',
    claude: 'medium',
  },
  models: {
    codex: [
      {
        id: 'gpt-6.2-sol',
        label: 'GPT-6.2 Sol',
        isDefault: true,
        reasoningLevels: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningLevel: 'medium',
      },
      {
        id: 'gpt-5.4-mini',
        label: 'GPT-5.4 Mini',
        reasoningLevels: ['low', 'medium'],
        defaultReasoningLevel: 'low',
      },
    ],
    claude: [
      {
        id: 'claude-opus-5-5',
        label: 'Claude Opus 5.5',
        isDefault: true,
        reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      {
        id: 'sonnet',
        label: 'Sonnet (latest alias)',
        reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
    ],
    antigravity: [
      {
        id: 'gemini-3.1-pro-low',
        label: 'Gemini 3.1 Pro (Low)',
        group: 'Gemini',
        reasoningLevels: ['low', 'medium', 'high'],
        defaultReasoningLevel: 'low',
      },
      {
        id: 'gemini-3.1-pro-high',
        label: 'Gemini 3.1 Pro (High)',
        group: 'Gemini',
        isDefault: true,
        reasoningLevels: ['low', 'medium', 'high'],
        defaultReasoningLevel: 'high',
      },
    ],
  },
};

describe('Harness CLI model & thinking effort resume arguments', () => {
  it('passes --model and valid --effort on Claude resume', () => {
    expect(
      buildClaudeResumeArgs(
        {
          nativeId: 'sess-1',
          model: 'claude-opus-5-5',
          reasoningEffort: 'max',
          permissionMode: 'auto',
        },
        'Refactor'
      )
    ).toEqual([
      '--resume',
      'sess-1',
      '-p',
      'Refactor',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'claude-opus-5-5',
      '--effort',
      'max',
      '--permission-mode',
      'auto',
    ]);

    // Ignores unsupported effort strings
    const invalidEffortArgs = buildClaudeResumeArgs(
      { nativeId: 'sess-2', model: 'sonnet', reasoningEffort: 'bogus' },
      'Hi'
    );
    expect(invalidEffortArgs).toContain('--model');
    expect(invalidEffortArgs).not.toContain('--effort');
  });
});

describe('Composer model & thinking option resolution per harness', () => {
  it('resolves harness-specific models, thinking levels, and clears unsupported efforts on model switch', () => {
    const codexControls = resolveSessionModelControls(
      'codex',
      'gpt-6.2-sol',
      'xhigh',
      SAMPLE_CATALOG,
      'Codex'
    );
    expect(codexControls.displayModelLabel).toBe('GPT-6.2 Sol');
    expect(codexControls.thinkingLevels).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(codexControls.activeEffort).toBe('xhigh');

    // Switching from xhigh to gpt-5.4-mini (only supports low/medium) resets effort cleanly
    expect(
      resolveModelSelectionChange('codex', 'gpt-5.4-mini', 'xhigh', codexControls.models)
    ).toEqual({
      model: 'gpt-5.4-mini',
      reasoningEffort: '',
    });
  });

  it('switches Antigravity sibling effort slugs when changing thinking level', () => {
    const agyControls = resolveSessionModelControls(
      'antigravity',
      'gemini-3.1-pro-low',
      undefined,
      SAMPLE_CATALOG,
      'Antigravity'
    );
    expect(agyControls.activeEffort).toBe('low');
    expect(agyControls.thinkingLevels).toEqual(['low', 'medium', 'high']);

    expect(
      resolveEffortSelectionChange(
        'antigravity',
        'high',
        'gemini-3.1-pro-low',
        agyControls.models
      )
    ).toEqual({
      model: 'gemini-3.1-pro-high',
      reasoningEffort: 'high',
    });
  });

  it('includes observed non-catalog models so the active model is never hidden', () => {
    const claudeControls = resolveSessionModelControls(
      'claude',
      'claude-custom-preview',
      undefined,
      SAMPLE_CATALOG,
      'Claude'
    );
    expect(claudeControls.displayModelLabel).toBe('claude-custom-preview');
    expect(claudeControls.models[0]?.id).toBe('claude-custom-preview');
    expect(claudeControls.activeEffort).toBe('medium');
  });
});
