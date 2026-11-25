import type { Meta, StoryObj } from '@storybook/react';
import React, { useState } from 'react';
import { DraftSessionPane, type DraftConversation } from './DraftSessionPane';

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
      <div className="h-[620px] flex">
        <DraftSessionPane
          draft={draft}
          onUpdateDraft={(p) => setDraft((prev) => ({ ...prev, ...p }))}
          onDiscard={() => {}}
          onLaunched={() => {}}
        />
      </div>
    );
  },
};
