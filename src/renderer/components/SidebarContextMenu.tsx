import React from 'react';
import { Archive, Columns2, Pin, SquarePen, Trash2 } from 'lucide-react';
import type { OrganizeAction, UnifiedSession } from '../../shared/types';
import { MenuDivider, MenuHeader, MenuItem, PopoverSurface } from '../ui';

export interface SidebarContextMenuProps {
  x: number;
  y: number;
  targets: UnifiedSession[];
  onClose: () => void;
  onClearSelection: () => void;
  onOpenInSplit: (sessionId: string) => void;
  onStartRename: (session: UnifiedSession) => void;
  onOrganize: (actions: OrganizeAction[]) => void;
  onArchiveMany: (sessions: UnifiedSession[], killTmux?: boolean) => void;
}

/**
 * Shared floating action menu opened by both right-click and the `···` button
 * on sidebar conversation rows (supports single-row and multi-select batch actions).
 */
export const SidebarContextMenu: React.FC<SidebarContextMenuProps> = ({
  x,
  y,
  targets,
  onClose,
  onClearSelection,
  onOpenInSplit,
  onStartRename,
  onOrganize,
  onArchiveMany,
}) => {
  if (targets.length === 0) return null;

  const isMulti = targets.length > 1;
  const single = targets[0];
  const hasTmux = targets.some((t) => t.harness === 'claude-tmux' && t.tmuxSessionName);
  const allPinnedTop = targets.every((t) => t.pinnedToTop);

  return (
    <PopoverSurface
      width="md"
      onClose={onClose}
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
      className="fixed z-50 space-y-0.5"
    >
      {isMulti && (
        <MenuHeader>
          {targets.length} sessions selected
        </MenuHeader>
      )}

      {!isMulti && (
        <MenuItem
          icon={<Columns2 className="w-3.5 h-3.5" />}
          onClick={() => {
            onOpenInSplit(single.id);
            onClose();
          }}
        >
          Open in Split View
        </MenuItem>
      )}

      <MenuItem
        icon={
          <Pin
            className={`w-3.5 h-3.5 ${allPinnedTop ? 'text-amber-400' : 'text-ink-muted'}`}
          />
        }
        onClick={() => {
          onOrganize(
            targets.map((t) => ({
              type: allPinnedTop ? 'unpin_top' : 'pin_top',
              sessionId: t.id,
            }))
          );
          if (isMulti) onClearSelection();
          onClose();
        }}
      >
        {isMulti
          ? allPinnedTop
            ? `Unpin ${targets.length} from top`
            : `Pin ${targets.length} to Super Harness top`
          : single.pinnedToTop
            ? 'Unpin from top'
            : 'Pin to Super Harness top'}
      </MenuItem>

      {!isMulti && (
        <MenuItem
          icon={<SquarePen className="w-3.5 h-3.5" />}
          onClick={() => {
            onStartRename(single);
            onClose();
          }}
        >
          Rename
        </MenuItem>
      )}

      <MenuDivider />
      <MenuItem
        tone="warning"
        icon={<Archive className="w-3.5 h-3.5" />}
        onClick={() => {
          onClearSelection();
          onClose();
          onArchiveMany(targets, false);
        }}
      >
        {isMulti
          ? `Archive ${targets.length} sessions`
          : single.harness === 'codex'
            ? 'Archive in Codex'
            : single.harness === 'claude-desktop'
              ? 'Archive in Claude'
              : 'Archive'}
      </MenuItem>

      {hasTmux && (
        <MenuItem
          tone="danger"
          icon={<Trash2 className="w-3.5 h-3.5" />}
          onClick={() => {
            onClearSelection();
            onClose();
            onArchiveMany(targets, true);
          }}
        >
          {isMulti ? `Kill tmux & Archive (${targets.length})` : 'Kill tmux & Archive'}
        </MenuItem>
      )}

      {isMulti && (
        <>
          <MenuDivider />
          <MenuItem
            onClick={() => {
              onClearSelection();
              onClose();
            }}
          >
            Clear selection
          </MenuItem>
        </>
      )}
    </PopoverSurface>
  );
};
