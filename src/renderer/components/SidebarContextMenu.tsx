import React, { useState } from 'react';
import { HARNESS_TITLES } from '../utils/harnessMeta';
import {
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  Columns2,
  Folder,
  FolderInput,
  Inbox,
  Pin,
  PinOff,
  Plus,
  SquarePen,
  Trash2,
} from 'lucide-react';
import type { OrganizeAction, UnifiedSession } from '../../shared/types';
import type { HarnessSectionOption } from '../utils/sidebarGrouping';
import { MenuDivider, MenuHeader, MenuItem, PopoverSurface } from '../ui';

function harnessLabelForPin(session: UnifiedSession): string {
  return session.harnessGroup === 'master' ? 'harness' : HARNESS_TITLES[session.harnessGroup] ?? 'harness';
}

export interface SidebarContextMenuProps {
  x: number;
  y: number;
  targets: UnifiedSession[];
  /** When opened by right-clicking a section header (e.g. "Backend"), enables section-level actions. */
  sectionLabel?: string;
  /** Sections available for the target session(s)' harness group (when all targets share one harness). */
  availableSections?: HarnessSectionOption[];
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
  availableSections,
  onClose,
  onClearSelection,
  onOpenInSplit,
  onStartRename,
  onOrganize,
  onArchiveMany,
}) => {
  const [showMoveSections, setShowMoveSections] = useState(false);
  const [creatingSection, setCreatingSection] = useState(false);
  const [newSectionName, setNewSectionName] = useState('');

  if (targets.length === 0) return null;

  const isSection = Boolean(sectionLabel);
  const isMulti = !isSection && targets.length > 1;
  const single = targets[0];
  const hasTmux = targets.some((t) => t.harness === 'claude-tmux' && t.tmuxSessionName);
  const allPinnedTop = targets.every((t) => t.pinnedToTop);
  const harnessPinnedTargets = targets.filter((t) => t.pinned);
  const canMoveSection = Boolean(availableSections && availableSections.length > 0);

  const currentSingleSection =
    !isMulti && !single.pinned
      ? !single.nativeSection || single.nativeSection === 'Ungrouped'
        ? 'Ungrouped'
        : single.nativeSection
      : null;

  const moveTargetsToSection = (section: string | null, sectionOrder: number) => {
    const actions: OrganizeAction[] = targets.flatMap((t) => {
      const list: OrganizeAction[] = [];
      if (t.pinned) {
        list.push({ type: 'unpin', sessionId: t.id });
      }
      list.push({
        type: 'move_section',
        sessionId: t.id,
        sectionName: section,
        sectionOrder,
      });
      return list;
    });
    onOrganize(actions);
    if (isMulti) onClearSelection();
    onClose();
  };

  const commitNewSection = () => {
    const trimmed = newSectionName.trim();
    if (!trimmed) return;
    moveTargetsToSection(trimmed, 500);
  };

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

      {canMoveSection && (
        <div>
          <MenuItem
            icon={<FolderInput className="w-3.5 h-3.5" />}
            rightSlot={
              showMoveSections ? (
                <ChevronDown className="w-3.5 h-3.5 text-ink-faint" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-ink-faint" />
              )
            }
            onClick={() => setShowMoveSections((v) => !v)}
          >
            {isMulti
              ? `Move ${targets.length} to section`
              : `Move to ${harnessLabelForPin(single)} section`}
          </MenuItem>

          {showMoveSections && (
            <div className="mt-1 ml-2 pl-2 border-l border-line-hairline space-y-0.5 max-h-48 overflow-y-auto">
              {availableSections!.map((sec) => {
                const isCurrent = currentSingleSection === sec.label;
                return (
                  <MenuItem
                    key={sec.label}
                    icon={
                      sec.isUngrouped ? (
                        <Inbox className="w-3.5 h-3.5 text-ink-muted" />
                      ) : (
                        <Folder className="w-3.5 h-3.5 text-ink-secondary" />
                      )
                    }
                    rightSlot={
                      isCurrent ? (
                        <Check className="w-3.5 h-3.5 text-ink-primary" />
                      ) : undefined
                    }
                    onClick={() =>
                      moveTargetsToSection(
                        sec.isUngrouped ? null : sec.label,
                        sec.isUngrouped ? 9999 : sec.order
                      )
                    }
                  >
                    <span className="truncate">{sec.label}</span>
                  </MenuItem>
                );
              })}

              {creatingSection ? (
                <div className="px-1.5 py-1 flex items-center gap-1">
                  <input
                    autoFocus
                    value={newSectionName}
                    onChange={(e) => setNewSectionName(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') commitNewSection();
                      if (e.key === 'Escape') {
                        setCreatingSection(false);
                        setNewSectionName('');
                      }
                    }}
                    placeholder="Section name..."
                    className="w-full px-2 py-1 text-caption rounded-md bg-surface-base border border-line-subtle text-ink-primary placeholder:text-ink-faint focus:outline-none focus:border-line-strong"
                  />
                </div>
              ) : (
                <MenuItem
                  icon={<Plus className="w-3.5 h-3.5 text-ink-muted" />}
                  onClick={() => setCreatingSection(true)}
                >
                  New section…
                </MenuItem>
              )}
            </div>
          )}
        </div>
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
