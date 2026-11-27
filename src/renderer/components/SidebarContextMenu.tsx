import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { HARNESS_TITLES } from '../utils/harnessMeta';
import {
  Archive,
  Check,
  ChevronRight,
  Columns2,
  ExternalLink,
  Folder,
  FolderInput,
  Inbox,
  Pin,
  PinOff,
  Plus,
  SquarePen,
  Trash2,
} from 'lucide-react';
import type { OrganizeAction, SessionFolder, UnifiedSession } from '../../shared/types';
import type { HarnessSectionOption } from '../utils/sidebarGrouping';
import { MenuDivider, MenuHeader, MenuItem, PopoverSurface } from '../ui';

function harnessLabelForPin(session: UnifiedSession): string {
  return session.harnessGroup === 'master' ? 'harness' : HARNESS_TITLES[session.harnessGroup] ?? 'harness';
}

const SUBMENU_GAP_PX = 4;
const SUBMENU_CLOSE_DELAY_MS = 160;
const SUBMENU_AIM_DWELL_MS = 280;

type SubmenuId = 'section' | 'folder';

interface Point {
  x: number;
  y: number;
}

interface SafeTriangleZone {
  owner: SubmenuId;
  a: Point;
  b: Point;
  c: Point;
  opensLeft: boolean;
  lastX: number;
  pendingNext: SubmenuId | null;
  cleanup: () => void;
}

function pointInTriangle(p: Point, a: Point, b: Point, c: Point): boolean {
  const sign = (p1: Point, p2: Point, p3: Point) =>
    (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
  const d1 = sign(p, a, b);
  const d2 = sign(p, b, c);
  const d3 = sign(p, c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/**
 * A context-menu row that opens its children in a second-level menu beside
 * the parent, flipping left or upward when it would leave the window.
 * Uses a geometric safe hover triangle (aim-cone) so moving diagonally toward
 * the secondary menu across neighboring rows or the gap keeps it open.
 */
const MenuSubmenu: React.FC<{
  id: SubmenuId;
  icon: React.ReactNode;
  label: string;
  open: boolean;
  safeZoneRef: React.MutableRefObject<SafeTriangleZone | null>;
  onSelectSubmenu: (next: SubmenuId | null) => void;
  children: React.ReactNode;
}> = ({ id, icon, label, open, safeZoneRef, onSelectSubmenu, children }) => {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const flyRef = useRef<HTMLDivElement | null>(null);
  const closeTimer = useRef<number | null>(null);
  const [placement, setPlacement] = useState({ left: false, up: false });

  const cancelClose = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const clearOwnSafeZone = () => {
    if (safeZoneRef.current?.owner === id) {
      safeZoneRef.current.cleanup();
      safeZoneRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      cancelClose();
      if (safeZoneRef.current?.owner === id) {
        safeZoneRef.current.cleanup();
        safeZoneRef.current = null;
      }
    };
  }, [id, safeZoneRef]);

  useLayoutEffect(() => {
    if (!open) return;
    const row = wrapRef.current?.getBoundingClientRect();
    const fly = flyRef.current?.getBoundingClientRect();
    if (!row || !fly) return;
    setPlacement({
      left: row.right + SUBMENU_GAP_PX + fly.width > window.innerWidth - 8,
      up: row.top + fly.height > window.innerHeight - 8,
    });
  }, [open]);

  const startAimGrace = (exitX: number, exitY: number) => {
    const fly = flyRef.current?.getBoundingClientRect();
    if (!fly) return false;
    const opensLeft = placement.left;
    // Only engage the aim triangle when exiting from the parent-menu side toward the flyout
    const onParentSide = opensLeft ? exitX >= fly.right - 2 : exitX <= fly.left + 2;
    if (!onParentSide) return false;

    clearOwnSafeZone();

    const nearX = opensLeft ? fly.right - 4 : fly.left + 4;
    const a: Point = { x: opensLeft ? exitX + 4 : exitX - 4, y: exitY };
    const b: Point = { x: nearX, y: fly.top - 12 };
    const c: Point = { x: nearX, y: fly.bottom + 12 };

    let dwellTimer: number | null = null;
    const finishGrace = () => {
      const z = safeZoneRef.current;
      if (!z || z.owner !== id) return;
      const next = z.pendingNext;
      z.cleanup();
      safeZoneRef.current = null;
      if (wrapRef.current?.contains(document.activeElement)) return;
      onSelectSubmenu(next);
    };

    const resetDwell = () => {
      if (dwellTimer !== null) window.clearTimeout(dwellTimer);
      dwellTimer = window.setTimeout(finishGrace, SUBMENU_AIM_DWELL_MS);
    };

    const onMouseMove = (ev: MouseEvent) => {
      const z = safeZoneRef.current;
      if (!z || z.owner !== id) return;
      const target = ev.target as Node | null;
      if (target && wrapRef.current?.contains(target)) {
        z.cleanup();
        safeZoneRef.current = null;
        return;
      }
      const pt: Point = { x: ev.clientX, y: ev.clientY };
      if (!pointInTriangle(pt, z.a, z.b, z.c)) {
        finishGrace();
        return;
      }
      const movingTowardFlyout = z.opensLeft ? ev.clientX < z.lastX : ev.clientX > z.lastX;
      z.lastX = ev.clientX;
      if (movingTowardFlyout) {
        resetDwell();
      }
    };

    const cleanup = () => {
      if (dwellTimer !== null) {
        window.clearTimeout(dwellTimer);
        dwellTimer = null;
      }
      window.removeEventListener('mousemove', onMouseMove, true);
    };

    safeZoneRef.current = {
      owner: id,
      a,
      b,
      c,
      opensLeft,
      lastX: exitX,
      pendingNext: null,
      cleanup,
    };

    window.addEventListener('mousemove', onMouseMove, true);
    resetDwell();
    return true;
  };

  return (
    <div
      ref={wrapRef}
      className="relative"
      onMouseEnter={(e) => {
        cancelClose();
        const activeZone = safeZoneRef.current;
        if (
          activeZone &&
          activeZone.owner !== id &&
          pointInTriangle({ x: e.clientX, y: e.clientY }, activeZone.a, activeZone.b, activeZone.c)
        ) {
          // Pointer is cutting diagonally across this row toward the open sibling submenu
          activeZone.pendingNext = id;
          return;
        }
        if (activeZone) {
          activeZone.cleanup();
          safeZoneRef.current = null;
        }
        onSelectSubmenu(id);
      }}
      onMouseLeave={(e) => {
        cancelClose();
        if (safeZoneRef.current && safeZoneRef.current.pendingNext === id) {
          safeZoneRef.current.pendingNext = null;
        }
        if (!open) return;
        if (wrapRef.current?.contains(document.activeElement)) return;
        if (startAimGrace(e.clientX, e.clientY)) return;
        closeTimer.current = window.setTimeout(() => {
          if (wrapRef.current?.contains(document.activeElement)) return;
          onSelectSubmenu(null);
        }, SUBMENU_CLOSE_DELAY_MS);
      }}
    >
      <MenuItem
        icon={icon}
        active={open}
        rightSlot={<ChevronRight className="w-3.5 h-3.5 text-ink-faint" />}
        onClick={() => {
          if (safeZoneRef.current) {
            safeZoneRef.current.cleanup();
            safeZoneRef.current = null;
          }
          onSelectSubmenu(open ? null : id);
        }}
      >
        {label}
      </MenuItem>

      {open && (
        <>
          {/* Invisible hover bridge across the gap between parent menu and secondary menu */}
          <div
            aria-hidden="true"
            className="absolute top-0 bottom-0 z-10"
            style={
              placement.left
                ? { right: '100%', width: SUBMENU_GAP_PX + 2 }
                : { left: '100%', width: SUBMENU_GAP_PX + 2 }
            }
          />
          <div
            ref={flyRef}
            className="absolute z-10"
            onMouseEnter={() => {
              cancelClose();
              clearOwnSafeZone();
            }}
            style={{
              ...(placement.left
                ? { right: '100%', marginRight: SUBMENU_GAP_PX }
                : { left: '100%', marginLeft: SUBMENU_GAP_PX }),
              ...(placement.up ? { bottom: -6 } : { top: -6 }),
            }}
          >
            <PopoverSurface width="md" className="space-y-0.5 max-h-[70vh] overflow-y-auto">
              {children}
            </PopoverSurface>
          </div>
        </>
      )}
    </div>
  );
};

export interface SidebarContextMenuProps {
  x: number;
  y: number;
  targets: UnifiedSession[];
  /** When opened by right-clicking a section header (e.g. "Backend"), enables section-level actions. */
  sectionLabel?: string;
  /** Sections available for the target session(s)' harness group (when all targets share one harness). */
  availableSections?: HarnessSectionOption[];
  /** Custom folders the target session(s) can be filed into. */
  folders?: SessionFolder[];
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
  folders = [],
  onClose,
  onClearSelection,
  onOpenInSplit,
  onStartRename,
  onOrganize,
  onArchiveMany,
}) => {
  const [openSubmenu, setOpenSubmenu] = useState<SubmenuId | null>(null);
  const safeZoneRef = useRef<SafeTriangleZone | null>(null);
  const [creatingSection, setCreatingSection] = useState(false);
  const [newSectionName, setNewSectionName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const showMoveSections = openSubmenu === 'section';
  const showMoveFolders = openSubmenu === 'folder';

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

  const currentSingleFolder = !isMulti ? (single.folderId ?? null) : undefined;
  const sortedFolders = [...folders].sort((a, b) => a.order - b.order);

  /** Files every target into a folder: an existing one by ID, a new one by name, or Unfiled (both null). */
  const moveTargetsToFolder = (folderId: string | null, folderName?: string) => {
    onOrganize(
      targets.map((t) => ({
        type: 'assign_folder' as const,
        sessionId: t.id,
        folderId,
        ...(folderName ? { folderName } : {}),
      }))
    );
    if (isMulti) onClearSelection();
    onClose();
  };

  const commitNewFolder = () => {
    const trimmed = newFolderName.trim();
    if (!trimmed) return;
    const existing = folders.find((f) => f.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) moveTargetsToFolder(existing.id);
    else moveTargetsToFolder(null, trimmed);
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

      {!isMulti && single.harness !== 'master' && (
        <MenuItem
          icon={<ExternalLink className="w-3.5 h-3.5" />}
          onClick={() => {
            onClose();
            void window.superHarness.openInHarness(single.id);
          }}
        >
          {single.tmuxSessionName
            ? 'Open in tmux'
            : single.harness === 'antigravity'
              ? 'Open in Antigravity'
              : single.harness === 'codex'
                ? 'Open in Codex'
                : single.harness === 'claude-desktop' || single.harness === 'claude-cli'
                  ? 'Open in Claude'
                  : single.harness === 'muse'
                    ? 'Open in Muse'
                    : single.harness === 'pi'
                      ? 'Open in Pi'
                      : 'Open in Harness'}
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
            : `Pin ${targets.length} to Superharness top`
          : single.pinnedToTop
            ? 'Unpin from top'
            : 'Pin to Superharness top'}
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
        <MenuSubmenu
          id="section"
          icon={<FolderInput className="w-3.5 h-3.5" />}
          label={
            isMulti
              ? `Move ${targets.length} to section`
              : `Move to ${harnessLabelForPin(single)} section`
          }
          open={showMoveSections}
          safeZoneRef={safeZoneRef}
          onSelectSubmenu={setOpenSubmenu}
        >
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
        </MenuSubmenu>
      )}

      <MenuSubmenu
        id="folder"
        icon={<FolderInput className="w-3.5 h-3.5" />}
        label={isMulti ? `Move ${targets.length} to folder` : 'Move to folder'}
        open={showMoveFolders}
        safeZoneRef={safeZoneRef}
        onSelectSubmenu={setOpenSubmenu}
      >
        {sortedFolders.map((f) => (
          <MenuItem
            key={f.id}
            icon={<Folder className="w-3.5 h-3.5" style={{ color: f.color }} />}
            rightSlot={
              currentSingleFolder === f.id ? (
                <Check className="w-3.5 h-3.5 text-ink-primary" />
              ) : undefined
            }
            onClick={() => moveTargetsToFolder(f.id)}
          >
            <span className="truncate">{f.name}</span>
          </MenuItem>
        ))}

        <MenuItem
          icon={<Inbox className="w-3.5 h-3.5 text-ink-muted" />}
          rightSlot={
            currentSingleFolder === null ? (
              <Check className="w-3.5 h-3.5 text-ink-primary" />
            ) : undefined
          }
          onClick={() => moveTargetsToFolder(null)}
        >
          Unfiled
        </MenuItem>

        {creatingFolder ? (
          <div className="px-1.5 py-1 flex items-center gap-1">
            <input
              autoFocus
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') commitNewFolder();
                if (e.key === 'Escape') {
                  setCreatingFolder(false);
                  setNewFolderName('');
                }
              }}
              placeholder="Folder name..."
              className="w-full px-2 py-1 text-caption rounded-md bg-surface-base border border-line-subtle text-ink-primary placeholder:text-ink-faint focus:outline-none focus:border-line-strong"
            />
          </div>
        ) : (
          <MenuItem
            icon={<Plus className="w-3.5 h-3.5 text-ink-muted" />}
            onClick={() => setCreatingFolder(true)}
          >
            New folder…
          </MenuItem>
        )}
      </MenuSubmenu>

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
