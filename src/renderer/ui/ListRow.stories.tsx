import type { Meta, StoryObj } from '@storybook/react';
import React, { useState } from 'react';
import { Folder, Laptop, MoreHorizontal, Pin } from 'lucide-react';
import { HarnessLogo } from '../components/HarnessLogo';
import { IconButton } from './Button';
import { NavRow, SectionHeader } from './ListRow';

const meta: Meta = {
  title: 'Primitives/Sidebar Rows & Headers',
};
export default meta;

export const SidebarTree: StoryObj = {
  render: () => {
    const [closed, setClosed] = useState(false);
    const [active, setActive] = useState('s1');

    return (
      <div className="w-[300px] p-2.5 bg-surface-rail rounded-2xl border border-line-hairline space-y-2">
        <SectionHeader
          level={1}
          collapsed={closed}
          onToggle={() => setClosed((v) => !v)}
          icon={<Pin className="w-4 h-4 text-amber-400" />}
          label="Pinned"
          count={3}
          working
          sticky={false}
        />
        {!closed && (
          <div className="space-y-0.5 pl-1">
            <NavRow
              icon={<HarnessLogo harness="antigravity" size={15} />}
              title="Super Harness MVP Development"
              active={active === 's1'}
              working
              onClick={() => setActive('s1')}
              hoverActions={
                <IconButton size="xs" label="Conversation actions">
                  <MoreHorizontal className="w-3.5 h-3.5" />
                </IconButton>
              }
            />
            <NavRow
              icon={<HarnessLogo harness="claude-tmux" size={15} />}
              title="PhoneUse Dev 0"
              active={active === 's2'}
              meta={
                <>
                  <Laptop className="w-3.5 h-3.5 text-ink-muted" />
                  <span className="text-caption text-ink-faint">3m</span>
                </>
              }
              onClick={() => setActive('s2')}
            />
            <NavRow
              icon={<HarnessLogo harness="codex" size={15} />}
              title="Build H3 Studio Lite"
              selected
              meta={<span className="text-caption text-ink-faint">2h</span>}
              onClick={() => setActive('s3')}
            />
          </div>
        )}

        <div className="pl-2">
          <SectionHeader
            level={2}
            onToggle={() => {}}
            icon={<Folder className="w-3.5 h-3.5 text-ink-secondary" />}
            label="PhoneUse"
            count={4}
            sticky={false}
          />
        </div>
      </div>
    );
  },
};
