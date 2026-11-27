import type { Meta, StoryObj } from '@storybook/react';
import React, { useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { Button } from './Button';
import { Select } from './Input';
import {
  Checkbox,
  ChoicePills,
  SettingsGroup,
  SettingsRow,
  Switch,
  UnitNumberInput,
} from './Switch';

const meta: Meta = {
  title: 'Primitives/Switch & Settings Layout',
};
export default meta;

export const HouseRulesSettingsLayout: StoryObj = {
  render: () => {
    const [groupBy, setGroupBy] = useState('native');
    const [archived, setArchived] = useState(false);
    const [hidden, setHidden] = useState(false);
    const [maxSessions, setMaxSessions] = useState(80);
    const [pollMs, setPollMs] = useState(5000);
    const [enabled, setEnabled] = useState(true);

    return (
      <div className="w-[600px] p-6 bg-surface-canvas rounded-2xl border border-line-hairline space-y-7">
        <SettingsGroup title="Sidebar">
          <SettingsRow
            label="Group conversations by"
            description="How the left rail is organized"
            control={
              <Select
                inputSize="sm"
                className="w-44"
                value={groupBy}
                onChange={(e) => setGroupBy(e.target.value)}
              >
                <option value="native">Harness</option>
                <option value="project">Project</option>
                <option value="recent">Recent</option>
              </Select>
            }
          />
          <SettingsRow
            label="Also show"
            description="Hidden here means hidden in Superharness"
            control={
              <div className="flex items-center gap-5">
                <Checkbox checked={archived} onChange={setArchived} label="Archived" />
                <Checkbox checked={hidden} onChange={setHidden} label="Hidden" />
              </div>
            }
          />
          <SettingsRow
            label="Sessions per harness"
            description="Older ones load on scroll"
            control={
              <UnitNumberInput
                value={maxSessions}
                onChange={setMaxSessions}
                unit="max"
                min={10}
                max={300}
                step={10}
              />
            }
          />
        </SettingsGroup>

        <SettingsGroup title="New conversations">
          <SettingsRow
            label="Start in"
            description={<span className="font-mono text-ink-muted">~/projects</span>}
            control={
              <Button size="sm" variant="secondary" iconLeft={<FolderOpen className="w-3.5 h-3.5" />}>
                Change
              </Button>
            }
          />
        </SettingsGroup>

        <SettingsGroup title="Advanced" collapsible defaultOpen={true}>
          <SettingsRow
            label="Fallback refresh"
            description="File watching is instant; this is the backup poll"
            control={
              <ChoicePills
                value={pollMs}
                onChange={setPollMs}
                options={[
                  { value: 1000, label: '1s' },
                  { value: 5000, label: '5s' },
                  { value: 30000, label: '30s' },
                  { value: 0, label: 'Off' },
                ]}
              />
            }
          />
          <SettingsRow
            label="Enable harness"
            description="Accessible toggle switch aligned to the right edge"
            control={<Switch checked={enabled} onChange={setEnabled} label="Enable harness" />}
          />
        </SettingsGroup>
      </div>
    );
  },
};
