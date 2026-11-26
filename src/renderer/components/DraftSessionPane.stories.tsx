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
        id: 'gemini-4-neon-high',
        label: 'Gemini 4 Neon (High)',
        group: 'Gemini',
        isDefault: true,
        reasoningLevels: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningLevel: 'high',
      },
      {
        id: 'gemini-4-neon-xhigh',
        label: 'Gemini 4 Neon (XHigh)',
        group: 'Gemini',
        reasoningLevels: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningLevel: 'xhigh',
      },
      {
        id: 'claude-opus-5-5-high',
        label: 'Claude Opus 5.5 (High)',
        group: 'Claude',
        reasoningLevels: ['low', 'medium', 'high'],
        defaultReasoningLevel: 'high',
      },
    ],
    codex: [
      {
        id: 'gpt-6.2-sol',
        label: 'GPT-6.2-Sol',
        group: 'Codex',
        isDefault: true,
        reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        defaultReasoningLevel: 'low',
      },
      {
        id: 'gpt-6.2-astra',
        label: 'GPT-6.2-Astra',
        group: 'Codex',
        reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        defaultReasoningLevel: 'low',
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
        id: 'claude-sonnet-5',
        label: 'Claude Sonnet 5',
        group: 'Claude',
        reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
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
      path: '~/projects/yapyap',
      name: 'yapyap',
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
      model: 'gpt-6.2-sol',
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
      cwd: '~/projects/yapyap',
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
