import type { Meta, StoryObj } from '@storybook/react';
import React from 'react';
import { Field, Input, Select, Textarea } from './Input';

const meta: Meta = {
  title: 'Primitives/Form Controls',
};
export default meta;

export const AllControls: StoryObj = {
  render: () => (
    <div className="w-[420px] p-5 bg-surface-popover rounded-2xl border border-line-subtle space-y-4">
      <Field label="Working Directory" hint="Absolute path">
        <Input defaultValue="~/projects/super-harness" mono />
      </Field>
      <Field label="Default Editor">
        <Select defaultValue="cursor">
          <option value="cursor">Cursor</option>
          <option value="nvim">Neovim</option>
          <option value="code">VS Code</option>
        </Select>
      </Field>
      <Field label="Compact Search Input">
        <Input inputSize="sm" placeholder="Filter conversations…" />
      </Field>
      <Field label="Initial Prompt">
        <Textarea rows={3} placeholder="Ask anything…" />
      </Field>
    </div>
  ),
};
