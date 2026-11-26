import React from 'react';
import { Archive, Columns2, Pin, PinOff, SquarePen, Trash2 } from 'lucide-react';
import type { OrganizeAction, UnifiedSession } from '../../shared/types';
import { MenuDivider, MenuHeader, MenuItem, PopoverSurface } from '../ui';

function harnessLabelForPin(session: UnifiedSession): string {
  if (session.harnessGroup === 'codex') return 'Codex';
  if (session.harnessGroup === 'claude') return 'Claude';
  if (session.harnessGroup === 'antigravity') return 'Antigravity';
  if (session.harnessGroup === 'muse') return 'Muse';
  return 'harness';
}

export interface SidebarContextMenuProps {
  x: number;
  y: number;
  targets: UnifiedSession[];
  /** When opened by right-clicking a section header (e.g. "Backend"), enables section-level actions. */
  sectionLabel?: string;
  onClose: () => void;
  onClearSelection: () => void;
  onOpenInSplit: (sessionId: string) => void;
  onStartRename: (session: UnifiedSession) => void;
  onOrganize: (actions: OrganizeAction[]) => void;
  onArchiveMany: (sessions: UnifiedSession[], killTmux?: boolean) => void;
}

/**
 * Shared floating action menu opened by right-click or `···` on sidebar
 * conversation rows, multi-selections, or entire section headers.
 */
export const SidebarContextMenu: React.FC<SidebarContextMenuProps> = ({
  x,
  y,
  targets,
  sectionLabel,
  onClose,
  onClearSelection,
  onOpenInSplit,
  onStartRename,
  onOrganize,
  onArchiveMany,
}) => {
  if (targets.length === 0) return null;

  const isSection = Boolean(sectionLabel);
  const isMulti = !isSection && targets.length > 1;
  const single = targets[0];
  const hasTmux = targets.some((t) => t.harness === 'claude-tmux' && t.tmuxSessionName);
  const allPinnedTop = targets.every((t) => t.pinnedToTop);
  const harnessPinnedTargets = targets.filter((t) => t.pinned);

  if (isSection) {
    return (
      <PopoverSurface
        width="md"
        onClose={onClose}
        style={{ left: x, top: y }}
        onClick={(e) => e.stopPropagation()}
        className="fixed z-50 space-y-0.5"
      >
        <MenuItem
          tone="warning"
          icon={<Archive className="w-3.5 h-3.5" />}
          onClick={() => {
            onClearSelection();
            onClose();
            onArchiveMany(targets, false);
          }}
        >
          Archive section
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
            Kill tmux & Archive
          </MenuItem>
        )}

        <MenuDivider />
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
            onClose();
          }}
        >
          {allPinnedTop ? 'Unpin all from top' : 'Pin all to top'}
        </MenuItem>

        {harnessPinnedTargets.length > 0 && (
          <MenuItem
            icon={<PinOff className="w-3.5 h-3.5 text-amber-400" />}
            onClick={() => {
              onOrganize(
                harnessPinnedTargets.map((t) => ({
                  type: 'unpin',
                  sessionId: t.id,
                }))
              );
              onClose();
            }}
          >
            Unpin harness pins
          </MenuItem>
        )}
      </PopoverSurface>
    );
  }

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

      {harnessPinnedTargets.length > 0 && (
        <MenuItem
          icon={<PinOff className="w-3.5 h-3.5 text-amber-400" />}
          onClick={() => {
            onOrganize(
              harnessPinnedTargets.map((t) => ({
                type: 'unpin',
                sessionId: t.id,
              }))
            );
            if (isMulti) onClearSelection();
            onClose();
          }}
        >
          {isMulti
            ? `Unpin ${harnessPinnedTargets.length} harness pins`
            : `Unpin from ${harnessLabelForPin(single)}`}
        </MenuItem>
      )}

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
