import type { Meta, StoryObj } from '@storybook/react';
import React, { useState } from 'react';
import { Select } from './Input';
import { SettingsGroup, SettingsRow, Switch } from './Switch';

const meta: Meta = {
  title: 'Primitives/Switch & Settings Layout',
};
export default meta;

export const SettingsGroupExample: StoryObj = {
  render: () => {
    const [archived, setArchived] = useState(false);
    const [remote, setRemote] = useState(true);
    return (
      <div className="w-[540px] p-4 bg-surface-canvas rounded-2xl border border-line-hairline">
        <SettingsGroup
          title="Discovery & Sidebar"
          description="Grouped settings rows with custom accessible switches."
        >
          <SettingsRow
            label="Default Grouping"
            description="How conversations are organized in the left rail"
            control={
              <Select inputSize="sm" className="w-48" defaultValue="native">
                <option value="native">Harness & Native Sections</option>
                <option value="recent">Recent Flat List</option>
              </Select>
            }
          />
          <SettingsRow
            label="Enable Remote Control"
            description="Automatically expose live sessions for remote attachment"
            control={<Switch checked={remote} onChange={setRemote} label="Remote" />}
          />
          <SettingsRow
            label="Show Archived Sessions"
            description="Include archived Codex and Claude Desktop threads"
            control={<Switch checked={archived} onChange={setArchived} label="Archived" />}
          />
        </SettingsGroup>
      </div>
    );
  },
};
