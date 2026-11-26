import type { Meta, StoryObj } from '@storybook/react';
import React from 'react';
import { LiveStepsBar } from './LiveStepsBar';

const meta: Meta = {
  title: 'Domain/LiveStepsBar',
};
export default meta;

export const ActiveChecklist: StoryObj = {
  render: () => (
    <div className="max-w-[680px]">
      <LiveStepsBar
        steps={[
          { title: 'Build harness model and project catalog service', status: 'done' },
          { title: 'Redesign new-thread picker, selectors, and Claude dropdown', status: 'done' },
          { title: 'Apply app-wide typography and copy scale pass', status: 'in_progress' },
          { title: 'Add tests, verify live usage, push, and relaunch', status: 'pending' },
        ]}
      />
    </div>
  ),
};
