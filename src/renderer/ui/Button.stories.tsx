import type { Meta, StoryObj } from '@storybook/react';
import React from 'react';
import { Archive, Columns2, Pin, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Button, IconButton } from './Button';

const meta: Meta<typeof Button> = {
  title: 'Primitives/Button',
  component: Button,
  argTypes: {
    variant: { control: 'select', options: ['primary', 'secondary', 'subtle', 'ghost', 'danger'] },
    size: { control: 'select', options: ['xs', 'sm', 'md'] },
    loading: { control: 'boolean' },
    disabled: { control: 'boolean' },
  },
};
export default meta;

type Story = StoryObj<typeof Button>;

export const Playground: Story = {
  args: {
    variant: 'primary',
    size: 'md',
    children: 'New Conversation',
    iconLeft: <Plus className="w-3.5 h-3.5" />,
  },
};

export const VariantsAndSizes: Story = {
  render: () => (
    <div className="space-y-5 p-4 bg-surface-canvas rounded-xl border border-line-hairline">
      <div className="space-y-2">
        <div className="text-micro text-ink-muted uppercase tracking-wider">Variants</div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" iconLeft={<Plus className="w-3.5 h-3.5" />}>Primary</Button>
          <Button variant="secondary" iconLeft={<RefreshCw className="w-3.5 h-3.5" />}>Secondary</Button>
          <Button variant="subtle">Subtle</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger" iconLeft={<Trash2 className="w-3.5 h-3.5" />}>Danger</Button>
          <Button variant="primary" loading>Saving</Button>
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-micro text-ink-muted uppercase tracking-wider">Sizes</div>
        <div className="flex items-center gap-2">
          <Button size="xs" variant="secondary">Extra Small</Button>
          <Button size="sm" variant="secondary">Small</Button>
          <Button size="md" variant="secondary">Medium</Button>
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-micro text-ink-muted uppercase tracking-wider">Icon Buttons</div>
        <div className="flex items-center gap-2">
          <IconButton label="Pin" size="xs"><Pin className="w-3 h-3" /></IconButton>
          <IconButton label="Pinned" size="sm" tone="warning"><Pin className="w-3.5 h-3.5" /></IconButton>
          <IconButton label="Split" size="sm" active><Columns2 className="w-3.5 h-3.5" /></IconButton>
          <IconButton label="Archive" size="md"><Archive className="w-4 h-4" /></IconButton>
          <IconButton label="Delete" size="md" tone="danger"><Trash2 className="w-4 h-4" /></IconButton>
        </div>
      </div>
    </div>
  ),
};
