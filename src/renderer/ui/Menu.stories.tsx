import type { Meta, StoryObj } from '@storybook/react';
import React, { useRef, useState } from 'react';
import { Archive, ChevronDown, Columns2, Pin, SquarePen, Trash2 } from 'lucide-react';
import { HarnessLogo } from '../components/HarnessLogo';
import { Button } from './Button';
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

export const DismissablePopover: StoryObj = {
  render: () => {
    const [open, setOpen] = useState(true);
    const [selected, setSelected] = useState('GPT-6.2-Sol');
    const triggerRef = useRef<HTMLSpanElement | null>(null);

    return (
      <div className="min-h-[320px] p-6 rounded-xl border border-line-hairline bg-surface-canvas flex flex-col justify-between gap-6">
        <p className="text-caption text-ink-muted">
          Click anywhere outside the menu (or press <kbd className="font-mono">Esc</kbd>) to verify
          outside-click dismissal. Clicking the trigger toggles cleanly without reopening.
        </p>

        <div className="relative inline-block self-start">
          <span ref={triggerRef} className="inline-flex">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setOpen((v) => !v)}
              iconRight={<ChevronDown className="w-3.5 h-3.5" />}
            >
              {selected} ({open ? 'open' : 'closed'})
            </Button>
          </span>

          {open && (
            <PopoverSurface
              width="md"
              onClose={() => setOpen(false)}
              ignoreRef={triggerRef}
              className="absolute left-0 bottom-[calc(100%+8px)] z-40"
            >
              <MenuSectionLabel>Models</MenuSectionLabel>
              {['GPT-6.2-Sol', 'GPT-6.2-Astra', 'Claude Opus 5.5', 'Gemini 4 Neon (High)'].map(
                (m) => (
                  <MenuItem
                    key={m}
                    active={selected === m}
                    onClick={() => {
                      setSelected(m);
                      setOpen(false);
                    }}
                  >
                    {m}
                  </MenuItem>
                )
              )}
            </PopoverSurface>
          )}
        </div>
      </div>
    );
  },
};
