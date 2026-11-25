import type { Meta, StoryObj } from '@storybook/react';
import React from 'react';
import { GitBranch, Sparkles } from 'lucide-react';
import { Badge } from './Badge';

const meta: Meta<typeof Badge> = {
  title: 'Primitives/Badge',
  component: Badge,
  argTypes: {
    tone: { control: 'select', options: ['neutral', 'accent', 'success', 'warning', 'danger'] },
    size: { control: 'select', options: ['xs', 'sm'] },
    mono: { control: 'boolean' },
  },
};
export default meta;

export const AllTones: StoryObj<typeof Badge> = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2 p-4 bg-surface-canvas rounded-xl border border-line-hairline">
      <Badge tone="neutral">Codex Pro</Badge>
      <Badge tone="neutral" mono icon={<GitBranch className="w-3 h-3" />}>main</Badge>
      <Badge tone="accent" size="sm" icon={<Sparkles className="w-3 h-3" />}>3 subagents</Badge>
      <Badge tone="success">Connected</Badge>
      <Badge tone="warning">78% weekly</Badge>
      <Badge tone="danger" mono>exit 1</Badge>
    </div>
  ),
};
