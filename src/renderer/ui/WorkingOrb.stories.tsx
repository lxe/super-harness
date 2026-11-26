import type { Meta, StoryObj } from '@storybook/react';
import { WorkingIndicator, WorkingOrb } from './WorkingOrb';

const meta: Meta<typeof WorkingIndicator> = {
  title: 'Primitives/WorkingOrb',
  component: WorkingIndicator,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof WorkingIndicator>;

export const HarnessGallery: Story = {
  render: () => (
    <div className="space-y-6 p-4 max-w-md">
      <div className="space-y-2">
        <div className="text-micro uppercase tracking-wider text-ink-faint">3D Orb Sizes</div>
        <div className="flex items-center gap-5">
          <WorkingOrb tone="antigravity" size="sm" />
          <WorkingOrb tone="antigravity" size="md" />
          <WorkingOrb tone="antigravity" size="lg" />
          <WorkingOrb tone="codex" size="lg" />
          <WorkingOrb tone="claude" size="lg" />
          <WorkingOrb tone="master" size="lg" />
        </div>
      </div>

      <div className="space-y-2.5 border-t border-line-hairline pt-4">
        <div className="text-micro uppercase tracking-wider text-ink-faint">
          Transcript Indicators
        </div>
        <WorkingIndicator tone="antigravity" focus="Inspecting transcript sync" />
        <WorkingIndicator tone="codex" focus="Codex turn in progress" />
        <WorkingIndicator tone="claude" focus="Running Bash" />
        <WorkingIndicator tone="master" label="Orchestrating" />
      </div>
    </div>
  ),
};
