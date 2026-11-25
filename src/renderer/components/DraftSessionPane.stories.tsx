import type { Meta, StoryObj } from '@storybook/react';
import React, { useState } from 'react';
import type { HarnessCatalog } from '../../shared/types';
import { DraftSessionPane, type DraftConversation } from './DraftSessionPane';

const MOCK_CATALOG: HarnessCatalog = {
  updatedAt: Date.now(),
  models: {
    antigravity: [
      { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)', group: 'Gemini', isDefault: true },
      { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)', group: 'Claude' },
    ],
    codex: [
      { id: 'gpt-6.2-sol', label: 'gpt-6.2-sol', group: 'Codex', isDefault: true },
      { id: 'gpt-6.2-astra', label: 'gpt-6.2-astra', group: 'Codex' },
    ],
    claude: [
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', group: 'Claude', isDefault: true },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', group: 'Claude' },
      { id: 'opus', label: 'Opus (latest alias)', group: 'Aliases' },
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
