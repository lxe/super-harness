import type { Meta, StoryObj } from '@storybook/react';
import React from 'react';
import { RecencyClock } from './RecencyClock';

const meta: Meta = {
  title: 'Primitives/RecencyClock',
};
export default meta;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const FreshnessScale: StoryObj = {
  render: () => {
    const now = Date.now();
    const samples = [
      { label: 'Just now (2m)', ts: now - 2 * MINUTE },
      { label: 'Very recent (25m)', ts: now - 25 * MINUTE },
      { label: 'Recent (2h)', ts: now - 2 * HOUR },
      { label: 'Today (10h)', ts: now - 10 * HOUR },
      { label: 'This week (3d)', ts: now - 3 * DAY },
      { label: 'Older (14d)', ts: now - 14 * DAY },
    ];
    return (
      <div className="w-[320px] p-4 rounded-xl bg-surface-rail border border-line-hairline space-y-2.5">
        {samples.map((s) => (
          <div
            key={s.label}
            className="flex items-center justify-between px-2.5 py-1.5 rounded-lg hover:bg-white/[0.04]"
          >
            <span className="text-body text-ink-secondary">{s.label}</span>
            <RecencyClock updatedAt={s.ts} />
          </div>
        ))}
      </div>
    );
  },
};
