import type { Meta, StoryObj } from '@storybook/react';
import React, { useState } from 'react';
import type { HarnessCatalog } from '../../shared/types';
import { DraftSessionPane, type DraftConversation } from './DraftSessionPane';

const MOCK_CATALOG: HarnessCatalog = {
  updatedAt: Date.now(),
  defaultReasoningEffort: {
    antigravity: 'high',
    codex: 'high',
    claude: 'medium',
  },
  models: {
    antigravity: [
      {
        id: 'gemini-2.5-pro-high',
        label: 'Gemini 2.5 Pro (High)',
        group: 'Gemini',
        isDefault: true,
        reasoningLevels: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningLevel: 'high',
      },
      {
        id: 'gemini-2.5-pro-xhigh',
        label: 'Gemini 2.5 Pro (XHigh)',
        group: 'Gemini',
        reasoningLevels: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningLevel: 'xhigh',
      },
      {
        id: 'claude-opus-4-6-high',
        label: 'Claude Opus 4.6 (High)',
        group: 'Claude',
        reasoningLevels: ['low', 'medium', 'high'],
        defaultReasoningLevel: 'high',
      },
    ],
    codex: [
      {
        id: 'gpt-5.4',
        label: 'GPT-5.4',
        group: 'Codex',
        isDefault: true,
        reasoningLevels: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningLevel: 'medium',
      },
      {
        id: 'gpt-5.3-codex',
        label: 'GPT-5.3 Codex',
        group: 'Codex',
        reasoningLevels: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningLevel: 'medium',
      },
    ],
    claude: [
      {
        id: 'opus[1m]',
        label: 'Opus (1M)',
        group: 'Claude',
        isDefault: true,
        reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      {
        id: 'claude-sonnet-4-6',
        label: 'Claude Sonnet 4.6',
        group: 'Claude',
        reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
    ],
    muse: [
      {
        id: 'muse-wonder-full-1.0',
        label: 'muse-wonder-full-1.0',
        group: 'Muse',
        isDefault: true,
        reasoningLevels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      },
      {
        id: 'muse-spark-1.3',
        label: 'muse-spark-1.3',
        group: 'Muse',
        reasoningLevels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      },
    ],
    pi: [
      {
        id: 'ds41/deepseek-v4.1-flash',
        label: 'DeepSeek V4.1 Flash',
        group: 'ds41',
        isDefault: true,
        reasoningLevels: ['off', 'low', 'high', 'max'],
      },
    ],
  },
  projects: [
    {
      path: '~/projects/super-harness',
      name: 'super-harness',
      harnesses: ['antigravity', 'codex', 'claude'],
      lastUsedAt: Date.now(),
    },
    {
      path: '~/projects/acme-cli',
      name: 'acme-cli',
      harnesses: ['claude', 'codex'],
      lastUsedAt: Date.now() - 3600_000,
    },
  ],
};

const meta: Meta = {
  title: 'Domain/DraftSessionPane',
  parameters: { layout: 'fullscreen' },
};
export default meta;

export const UndecidedHarness: StoryObj = {
  render: () => {
    const [draft, setDraft] = useState<DraftConversation>({
      id: 'draft:demo',
      harness: null,
      cwd: '~/projects/super-harness',
      model: '',
      reasoningEffort: '',
      remoteControl: true,
      prompt: '',
      createdAt: Date.now(),
    });
    return (
      <div className="h-[680px] flex">
        <DraftSessionPane
          draft={draft}
          catalog={MOCK_CATALOG}
          onUpdateDraft={(p) => setDraft((prev) => ({ ...prev, ...p }))}
          onDiscard={() => {}}
          onLaunched={() => {}}
        />
      </div>
    );
  },
};

export const CodexWithModelAndThinking: StoryObj = {
  render: () => {
    const [draft, setDraft] = useState<DraftConversation>({
      id: 'draft:codex',
      harness: 'codex',
      cwd: '~/projects/super-harness',
      model: 'gpt-5.4',
      reasoningEffort: 'xhigh',
      remoteControl: true,
      prompt: '',
      createdAt: Date.now(),
    });
    return (
      <div className="h-[680px] flex">
        <DraftSessionPane
          draft={draft}
          catalog={MOCK_CATALOG}
          onUpdateDraft={(p) => setDraft((prev) => ({ ...prev, ...p }))}
          onDiscard={() => {}}
          onLaunched={() => {}}
        />
      </div>
    );
  },
};

export const ClaudeTmuxSelected: StoryObj = {
  render: () => {
    const [draft, setDraft] = useState<DraftConversation>({
      id: 'draft:claude',
      harness: 'claude-tmux',
      cwd: '~/projects/acme-cli',
      model: 'opus[1m]',
      reasoningEffort: 'high',
      remoteControl: true,
      prompt: '',
      createdAt: Date.now(),
    });
    return (
      <div className="h-[680px] flex">
        <DraftSessionPane
          draft={draft}
          catalog={MOCK_CATALOG}
          onUpdateDraft={(p) => setDraft((prev) => ({ ...prev, ...p }))}
          onDiscard={() => {}}
          onLaunched={() => {}}
        />
      </div>
    );
  },
};
