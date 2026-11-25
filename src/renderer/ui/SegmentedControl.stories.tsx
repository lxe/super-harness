import type { Meta, StoryObj } from '@storybook/react';
import React, { useState } from 'react';
import { HarnessLogo } from '../components/HarnessLogo';
import { SegmentedControl } from './SegmentedControl';

const meta: Meta = {
  title: 'Primitives/SegmentedControl',
};
export default meta;

export const HarnessSwitcher: StoryObj = {
  render: () => {
    const [val, setVal] = useState<'all' | 'antigravity' | 'codex' | 'claude'>('all');
    return (
      <div className="w-[300px] p-3 bg-surface-rail rounded-2xl border border-line-hairline">
        <SegmentedControl
          value={val}
          onChange={setVal}
          items={[
            { id: 'all', label: 'All', progress: { value: 35, tone: 'neutral', estimated: true } },
            {
              id: 'antigravity',
              label: 'AGY',
              icon: <HarnessLogo harness="antigravity" size={13} />,
              working: true,
              progress: { value: 70, tone: 'antigravity', estimated: true },
            },
            {
              id: 'codex',
              label: 'Codex',
              icon: <HarnessLogo harness="codex" size={13} />,
              progress: { value: 35, tone: 'codex' },
            },
            {
              id: 'claude',
              label: 'Claude',
              icon: <HarnessLogo harness="claude" size={13} />,
              working: true,
              progress: { value: 82, tone: 'claude' },
            },
          ]}
        />
      </div>
    );
  },
};
