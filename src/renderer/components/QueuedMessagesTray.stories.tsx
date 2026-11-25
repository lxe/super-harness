import type { Meta, StoryObj } from '@storybook/react';
import React, { useState } from 'react';
import type { QueuedMessageItem } from '../../shared/types';
import { QueuedMessagesTray } from './QueuedMessagesTray';

const meta: Meta = {
  title: 'Domain/QueuedMessagesTray',
};
export default meta;

export const InteractiveQueue: StoryObj = {
  render: () => {
    const [items, setItems] = useState<QueuedMessageItem[]>([
      {
        id: 'q-1',
        text: 'If I already answered the questions in the main harness, they should also be marked as answered in the super harness.',
        createdAt: Date.now() - 12000,
        source: 'super-harness',
      },
      {
        id: 'q-2',
        text: 'Do a design pass on the settings page and make sure queued messages are shown across all harnesses.',
        createdAt: Date.now() - 4000,
        source: 'super-harness',
      },
      {
        id: 'q-3',
        text: 'Verify Codex queue_1.sqlite sync after rollout completes.',
        createdAt: Date.now(),
        source: 'native',
      },
    ]);

    return (
      <div className="w-[680px] p-4 bg-surface-canvas rounded-2xl border border-line-hairline">
        <QueuedMessagesTray
          items={items}
          onSendNow={(id) => setItems((prev) => prev.filter((x) => x.id !== id))}
          onEdit={(id) => setItems((prev) => prev.filter((x) => x.id !== id))}
          onRemove={(id) => setItems((prev) => prev.filter((x) => x.id !== id))}
        />
      </div>
    );
  },
};
