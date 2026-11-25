import type { Meta, StoryObj } from '@storybook/react';
import React from 'react';
import { Archive, Columns2, Pin, SquarePen, Trash2 } from 'lucide-react';
import { HarnessLogo } from '../components/HarnessLogo';
import { MenuDivider, MenuHeader, MenuItem, MenuSectionLabel, PopoverSurface } from './Menu';

const meta: Meta = {
  title: 'Primitives/Menu & Popover',
};
export default meta;

export const ContextMenu: StoryObj = {
  render: () => (
    <PopoverSurface width="md">
      <MenuHeader icon={<HarnessLogo harness="claude" size={13} />}>PhoneUse Dev 0</MenuHeader>
      <MenuItem icon={<Columns2 className="w-3.5 h-3.5" />}>Open in Split View</MenuItem>
      <MenuItem icon={<Pin className="w-3.5 h-3.5 text-amber-400" />} active>
        Unpin from top
      </MenuItem>
      <MenuItem icon={<SquarePen className="w-3.5 h-3.5" />}>Rename</MenuItem>
      <MenuDivider />
      <MenuSectionLabel>Lifecycle</MenuSectionLabel>
      <MenuItem icon={<Archive className="w-3.5 h-3.5" />} tone="warning">
        Archive in Claude
      </MenuItem>
      <MenuItem icon={<Trash2 className="w-3.5 h-3.5" />} tone="danger">
        Kill tmux & Archive
      </MenuItem>
    </PopoverSurface>
  ),
};
