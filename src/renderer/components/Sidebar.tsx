import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  Columns2,
  Folder,
  FolderGit2,
  FolderPlus,
  HelpCircle,
  Inbox,
  Laptop,
  Layers,
  MoreHorizontal,
  Pin,
  RotateCw,
  Search,
  Settings,
  SlidersHorizontal,
  SquarePen,
  X,
} from 'lucide-react';
import type {
  HarnessDetection,
  HarnessGroup,
  OrganizeAction,
  SessionFolder,
  SidebarGroupBy,
  UnifiedSession,
  UsageSnapshot,
} from '../../shared/types';
import {
  Button,
  IconButton,
  Input,
  MenuDivider,
  MenuItem,
  MenuSectionLabel,
  NavRow,
  PopoverSurface,
  SectionHeader,
  SegmentedControl,
  resolveHarnessOrbTone,
} from '../ui';
import {
  canDropSessionIntoSection,
  computeThreadRecencyOpacity,
  filterSidebarSessions,
  flattenVisibleSessions,
  getGlobalPinnedSessions,
  groupSessionsForSidebar,
  isSingleHarnessFilter,
  SIDEBAR_SORT_OPTIONS,
  sortSidebarGroups,
  moveHarness,
  normalizeHarnessOrder,
  type SidebarSortBy,
  type DragSectionTarget,
  type SidebarFilterTab,
} from '../utils/sidebarGrouping';
import { prefetchSessionTranscript } from '../utils/transcriptCache';
import type { DraftConversation } from './DraftSessionPane';
import { HarnessLogo } from './HarnessLogo';
import { HarnessUsageHoverCard } from './HarnessUsageHoverCard';
import { SidebarContextMenu } from './SidebarContextMenu';

export type { SidebarFilterTab };
type FilterTab = SidebarFilterTab;

interface Props {
  width: number;
  harnesses: HarnessDetection[];
  sessions: UnifiedSession[];
  draftConversations: DraftConversation[];
  usage: UsageSnapshot | null;
  folders: SessionFolder[];
  groupBy: SidebarGroupBy;
  activeSessionId: string;
  splitSessionId: string | null;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  refreshing: boolean;
  onSelectSession: (id: string) => void;
  onOpenInSplit: (id: string) => void;
  onNewSession: (activeFilter: SidebarFilterTab, opts?: { cwd?: string }) => void;
  onDiscardDraft: (draftId: string) => void;
  onOpenSettings: () => void;
  onRefresh: () => void;
  onChangeGroupBy: (g: SidebarGroupBy) => void;
  /** Saved harness order (gauge strip and All-view sections); see settings.harnessOrder. */
  harnessOrder?: HarnessGroup[];
  onChangeHarnessOrder?: (order: HarnessGroup[]) => void;
  onOrganize: (actions: OrganizeAction[]) => void;
  onArchiveSession: (session: UnifiedSession, killTmux?: boolean) => void;
  onArchiveMany: (sessions: UnifiedSession[], killTmux?: boolean) => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  sessions: UnifiedSession[];
  sectionLabel?: string;
}

const REMOTE_HOST_ICON_COLORS = [
  'text-sky-400',
  'text-emerald-400',
  'text-amber-400',
  'text-rose-400',
  'text-violet-400',
  'text-teal-400',
];

function remoteHostColorClass(hostKey: string): string {
  let h = 0;
  for (let i = 0; i < hostKey.length; i += 1) {
    h = (h * 31 + hostKey.charCodeAt(i)) | 0;
  }
  return REMOTE_HOST_ICON_COLORS[Math.abs(h) % REMOTE_HOST_ICON_COLORS.length];
}

function resolveGroupCwd(items: UnifiedSession[], isUngrouped = false): string | undefined {
  if (isUngrouped || items.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.cwd) counts.set(item.cwd, (counts.get(item.cwd) ?? 0) + 1);
  }
  let bestCwd: string | undefined;
  let bestCount = 0;
  for (const [cwd, count] of counts.entries()) {
    if (count > bestCount) {
      bestCwd = cwd;
      bestCount = count;
    }
  }
  return bestCwd;
}

/** Keeps "All" first and puts harness gauges in lxe's saved order. */
function orderGaugeItems<T extends { id: string }>(items: T[], order?: readonly string[] | null): T[] {
  const rank = new Map(normalizeHarnessOrder(order).map((h, i) => [h as string, i]));
  return [...items].sort((a, b) => (rank.get(a.id) ?? -1) - (rank.get(b.id) ?? -1));
}

export const Sidebar: React.FC<Props> = React.memo(({
  width,
  sessions,
  draftConversations,
  usage,
  folders,
  groupBy,
  activeSessionId,
  splitSessionId,
  searchInputRef,
  onSelectSession,
  onOpenInSplit,
  onNewSession,
  onDiscardDraft,
  onOpenSettings,
  onChangeGroupBy,
  harnessOrder,
  onChangeHarnessOrder,
  onOrganize,
  onArchiveSession,
  onArchiveMany,
}) => {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterTab>(() => {
    try {
      const saved = localStorage.getItem('sh:sidebarFilter') as FilterTab | null;
      if (saved && ['all', 'live', 'codex', 'claude', 'tmux', 'antigravity', 'muse'].includes(saved)) {
        return saved;
      }
    } catch {
      // ignore
    }
    return 'all';
  });
  const [sortBy, setSortBy] = useState<SidebarSortBy>(() => {
    try {
      const saved = localStorage.getItem('sh:sidebarSort') as SidebarSortBy | null;
      if (saved && SIDEBAR_SORT_OPTIONS.some(([v]) => v === saved)) return saved;
    } catch {
      // ignore
    }
    return 'native';
  });
  useEffect(() => {
    try {
      localStorage.setItem('sh:sidebarSort', sortBy);
    } catch {
      // ignore
    }
  }, [sortBy]);
  const [showFilterMenu, setShowFilterMenu] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem('sh:sidebarCollapsed');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return parsed as Record<string, boolean>;
      }
    } catch {
      // ignore
    }
    return {};
  });
  const [creatingFolder, setCreatingFolder] = useState(false);

  // Persist sidebar collapse state and active harness tab across restarts
  useEffect(() => {
    try {
      localStorage.setItem('sh:sidebarCollapsed', JSON.stringify(collapsed));
    } catch {
      // ignore
    }
  }, [collapsed]);

  useEffect(() => {
    try {
      localStorage.setItem('sh:sidebarFilter', filter);
    } catch {
      // ignore
    }
  }, [filter]);
  const [newFolderName, setNewFolderName] = useState('');
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [activeDrag, setActiveDrag] = useState<{
    sessions: UnifiedSession[];
    harnessGroup: HarnessGroup;
    x: number;
    y: number;
    overTargetId: string | null;
    overValid: boolean;
    overLabel: string | null;
  } | null>(null);
  const activeDragRef = useRef<typeof activeDrag>(null);
  activeDragRef.current = activeDrag;
  const pendingDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    sessions: UnifiedSession[];
    harnessGroup: HarnessGroup;
  } | null>(null);
  const suppressNextClickRef = useRef(false);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const onOrganizeRef = useRef(onOrganize);
  onOrganizeRef.current = onOrganize;
  const [hoveredUsage, setHoveredUsage] = useState<{
    target: HarnessGroup | 'all';
    rect: { left: number; bottom: number; width: number };
  } | null>(null);
  const hoverCloseTimerRef = useRef<number | null>(null);
  const prefetchTimerRef = useRef<number | null>(null);
  const filterTriggerRef = useRef<HTMLSpanElement | null>(null);
  const asideRef = useRef<HTMLElement | null>(null);
  const didRevealInitialRef = useRef(false);

  const scheduleHoverPrefetch = (sessionId: string) => {
    if (prefetchTimerRef.current !== null) {
      window.clearTimeout(prefetchTimerRef.current);
    }
    prefetchTimerRef.current = window.setTimeout(() => {
      prefetchTimerRef.current = null;
      prefetchSessionTranscript(sessionId);
    }, 75);
  };

  const cancelHoverPrefetch = () => {
    if (prefetchTimerRef.current !== null) {
      window.clearTimeout(prefetchTimerRef.current);
      prefetchTimerRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      if (prefetchTimerRef.current !== null) {
        window.clearTimeout(prefetchTimerRef.current);
      }
    };
  }, []);

  const openUsageHover = (
    target: HarnessGroup | 'all',
    el: HTMLElement
  ) => {
    if (hoverCloseTimerRef.current !== null) {
      window.clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
    const r = el.getBoundingClientRect();
    setHoveredUsage({
      target,
      rect: { left: r.left, bottom: r.bottom, width: r.width },
    });
  };

  const scheduleCloseUsageHover = () => {
    if (hoverCloseTimerRef.current !== null) {
      window.clearTimeout(hoverCloseTimerRef.current);
    }
    hoverCloseTimerRef.current = window.setTimeout(() => {
      setHoveredUsage(null);
      hoverCloseTimerRef.current = null;
    }, 150);
  };

  const cancelCloseUsageHover = () => {
    if (hoverCloseTimerRef.current !== null) {
      window.clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
  };

  const dismissUsageHover = () => {
    cancelCloseUsageHover();
    setHoveredUsage(null);
  };

  // Close context menu on outside click; Escape clears menu or multi-selection
  useEffect(() => {
    const close = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (ctxMenu) setCtxMenu(null);
        else if (selectedIds.size > 0) setSelectedIds(new Set());
      }
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [ctxMenu, selectedIds.size]);

  const masterSession = useMemo(
    () => sessions.find((s) => s.harness === 'master'),
    [sessions]
  );

  // Track which harnesses currently have at least one running thread (including subagents)
  const workingByHarness = useMemo(() => {
    const map: Record<HarnessGroup, boolean> = {
      antigravity: false,
      codex: false,
      claude: false,
      muse: false,
    };
    for (const s of sessions) {
      if (s.harnessGroup !== 'master' && s.status === 'running') {
        map[s.harnessGroup] = true;
      }
    }
    return map;
  }, [sessions]);

  // Exclude nested subagents from the main sidebar
  const workerSessions = useMemo(
    () => sessions.filter((s) => s.harness !== 'master' && !s.isSubagent),
    [sessions]
  );

  // Global Super Harness top-pinned chats across ALL harnesses (always shown below Master Orchestrator)
  const globalPinnedSessions = useMemo(
    () => getGlobalPinnedSessions(workerSessions),
    [workerSessions]
  );

  const filtered = useMemo(
    () => filterSidebarSessions(workerSessions, filter, query),
    [workerSessions, filter, query]
  );

  const topGroups = useMemo(
    () => sortSidebarGroups(groupSessionsForSidebar(filtered, groupBy, folders, filter, harnessOrder), sortBy),
    [filtered, groupBy, folders, filter, sortBy, harnessOrder]
  );

  // Map every droppable section container ID to its DragSectionTarget metadata
  const dropTargetMap = useMemo(() => {
    const map = new Map<string, DragSectionTarget>();
    for (const grp of topGroups) {
      if (grp.headless) continue;
      if (grp.sections) {
        for (const sec of grp.sections) {
          map.set(sec.id, {
            kind: 'native-section',
            sectionLabel: sec.label,
            harnessGroup: sec.harnessGroup,
            sectionOrder: sec.order,
          });
        }
      } else if (grp.harnessGroup) {
        map.set(grp.id, {
          kind: 'native-section',
          sectionLabel: grp.label,
          harnessGroup: grp.harnessGroup,
          sectionOrder: grp.sectionOrder,
        });
      } else if (grp.folderId !== undefined) {
        map.set(grp.id, {
          kind: 'folder',
          sectionLabel: grp.label,
          folderId: grp.folderId,
        });
      }
    }
    return map;
  }, [topGroups]);
  const dropTargetMapRef = useRef(dropTargetMap);
  dropTargetMapRef.current = dropTargetMap;

  // Pointer-event drag-and-drop (avoids Chromium/Electron Wayland Ozone HTML5 DnD hangs)
  useEffect(() => {
    const clearDragVisuals = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    const resolveHitTarget = (
      clientX: number,
      clientY: number,
      draggedSessions: UnifiedSession[]
    ): { id: string | null; valid: boolean; label: string | null } => {
      if (typeof document.elementsFromPoint !== 'function') {
        return { id: null, valid: false, label: null };
      }
      const els = document.elementsFromPoint(clientX, clientY);
      for (const el of els) {
        const htmlEl = el as HTMLElement;
        if (htmlEl.closest?.('[data-harness-separator="true"]')) {
          return { id: null, valid: false, label: null };
        }
        const dropEl = htmlEl.closest?.('[data-drop-section-id]') as HTMLElement | null;
        if (!dropEl) continue;
        const id = dropEl.getAttribute('data-drop-section-id');
        if (!id) continue;
        const target = dropTargetMapRef.current.get(id);
        if (!target) continue;
        const valid = draggedSessions.some((s) => canDropSessionIntoSection(s, target));
        return { id, valid, label: target.sectionLabel };
      }
      return { id: null, valid: false, label: null };
    };

    const cancelDrag = () => {
      pendingDragRef.current = null;
      if (activeDragRef.current) {
        activeDragRef.current = null;
        setActiveDrag(null);
      }
      clearDragVisuals();
    };

    const onPointerMove = (e: PointerEvent) => {
      if (e.buttons === 0) {
        cancelDrag();
        return;
      }
      const pending = pendingDragRef.current;
      let current = activeDragRef.current;

      if (!current) {
        if (!pending || e.pointerId !== pending.pointerId) return;
        const dist = Math.hypot(e.clientX - pending.startX, e.clientY - pending.startY);
        if (dist < 6) return;
        document.body.style.userSelect = 'none';
        current = {
          sessions: pending.sessions,
          harnessGroup: pending.harnessGroup,
          x: e.clientX,
          y: e.clientY,
          overTargetId: null,
          overValid: false,
          overLabel: null,
        };
      }

      // Gentle edge auto-scroll inside the sidebar list while dragging
      const scroller = scrollContainerRef.current;
      if (scroller) {
        const rect = scroller.getBoundingClientRect();
        if (e.clientY < rect.top + 36 && e.clientY >= rect.top - 20) {
          scroller.scrollTop -= 10;
        } else if (e.clientY > rect.bottom - 36 && e.clientY <= rect.bottom + 20) {
          scroller.scrollTop += 10;
        }
      }

      const hit = resolveHitTarget(e.clientX, e.clientY, current.sessions);
      document.body.style.cursor = hit.id ? (hit.valid ? 'grabbing' : 'not-allowed') : 'grabbing';

      const next = {
        ...current,
        x: e.clientX,
        y: e.clientY,
        overTargetId: hit.id,
        overValid: hit.valid,
        overLabel: hit.label,
      };
      activeDragRef.current = next;
      setActiveDrag(next);
    };

    const onPointerUp = (e: PointerEvent) => {
      const pending = pendingDragRef.current;
      const current = activeDragRef.current;
      if (pending && e.pointerId !== pending.pointerId && !current) return;

      pendingDragRef.current = null;
      clearDragVisuals();

      if (!current) return;

      suppressNextClickRef.current = true;
      window.setTimeout(() => {
        suppressNextClickRef.current = false;
      }, 120);

      const hit = resolveHitTarget(e.clientX, e.clientY, current.sessions);
      const target = hit.id ? dropTargetMapRef.current.get(hit.id) : undefined;
      if (hit.id && hit.valid && target) {
        const movable = current.sessions.filter((d) => canDropSessionIntoSection(d, target));
        if (movable.length > 0) {
          if (target.kind === 'native-section') {
            onOrganizeRef.current(
              movable.map((d) => ({
                type: 'move_section',
                sessionId: d.id,
                sectionName: target.sectionLabel,
                sectionOrder: target.sectionOrder,
              }))
            );
          } else {
            onOrganizeRef.current(
              movable.map((d) => ({
                type: 'assign_folder',
                sessionId: d.id,
                folderId: target.folderId ?? null,
              }))
            );
          }
          const targetId = hit.id;
          setCollapsed((prev) => (prev[targetId] ? { ...prev, [targetId]: false } : prev));
        }
      }

      activeDragRef.current = null;
      setActiveDrag(null);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && (pendingDragRef.current || activeDragRef.current)) {
        cancelDrag();
      }
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', cancelDrag);
    window.addEventListener('blur', cancelDrag);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', cancelDrag);
      window.removeEventListener('blur', cancelDrag);
      window.removeEventListener('keydown', onKeyDown);
      clearDragVisuals();
    };
  }, []);

  // Flat list of currently visible session IDs in exact rendered top-to-bottom order (for Shift+Click range select)
  const visibleOrderedSessions = useMemo(
    () => flattenVisibleSessions(topGroups, collapsed, globalPinnedSessions),
    [topGroups, collapsed, globalPinnedSessions]
  );

  // On initial startup restore, ensure the preserved active chat is visible (not hidden by a mismatched
  // harness filter or collapsed section) and scrolled cleanly into view in the sidebar.
  useEffect(() => {
    if (didRevealInitialRef.current) return;
    if (!activeSessionId || activeSessionId === 'master:root' || activeSessionId.startsWith('draft:')) {
      if (sessions.length > 0) didRevealInitialRef.current = true;
      return;
    }
    const target = workerSessions.find((s) => s.id === activeSessionId);
    if (!target) return;

    const inGlobalPins = globalPinnedSessions.some((s) => s.id === target.id);
    if (!inGlobalPins) {
      const matchesFilter =
        filter === 'all' ||
        (filter === 'antigravity' && target.harnessGroup === 'antigravity') ||
        (filter === 'codex' && target.harnessGroup === 'codex') ||
        (filter === 'claude' && target.harnessGroup === 'claude') ||
        (filter === 'muse' && target.harnessGroup === 'muse') ||
        (filter === 'live' && target.isLive) ||
        (filter === 'tmux' && target.harness === 'claude-tmux');

      if (!matchesFilter) {
        setFilter('all');
        return; // Next effect pass will expand & scroll once topGroups updates
      }

      // Auto-expand the containing group / subsection if it was collapsed
      const keysToExpand: string[] = [];
      for (const grp of topGroups) {
        if (grp.pinnedItems?.some((s) => s.id === target.id)) {
          if (collapsed[grp.id]) keysToExpand.push(grp.id);
          break;
        }
        if (grp.sections) {
          const sec = grp.sections.find((s) => s.items.some((it) => it.id === target.id));
          if (sec) {
            if (collapsed[grp.id]) keysToExpand.push(grp.id);
            if (collapsed[sec.id]) keysToExpand.push(sec.id);
            break;
          }
        } else if (grp.items?.some((s) => s.id === target.id)) {
          if (collapsed[grp.id]) keysToExpand.push(grp.id);
          break;
        }
      }
      if (keysToExpand.length > 0) {
        setCollapsed((prev) => {
          const next = { ...prev };
          for (const k of keysToExpand) next[k] = false;
          return next;
        });
        return;
      }
    }

    didRevealInitialRef.current = true;
    requestAnimationFrame(() => {
      const root = asideRef.current;
      if (!root) return;
      const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(activeSessionId) : activeSessionId;
      const row = root.querySelector<HTMLElement>(`[data-session-id="${escaped}"]`);
      row?.scrollIntoView({ block: 'nearest' });
    });
  }, [activeSessionId, sessions.length, workerSessions, globalPinnedSessions, filter, topGroups, collapsed]);

  const handleRowClick = (e: React.MouseEvent, s: UnifiedSession) => {
    if (suppressNextClickRef.current) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.shiftKey) {
      e.preventDefault();
      const ids = visibleOrderedSessions.map((x) => x.id);
      const startAnchor = anchorId || activeSessionId;
      const a = ids.indexOf(startAnchor);
      const b = ids.indexOf(s.id);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        const next = new Set(e.ctrlKey || e.metaKey ? selectedIds : []);
        for (let i = lo; i <= hi; i++) next.add(ids[i]);
        setSelectedIds(next);
      } else {
        setSelectedIds(new Set([s.id]));
        setAnchorId(s.id);
      }
      return;
    }

    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const next = new Set(selectedIds);
      if (next.size === 0 && activeSessionId && activeSessionId !== 'master:root') {
        next.add(activeSessionId);
      }
      if (next.has(s.id)) next.delete(s.id);
      else next.add(s.id);
      setSelectedIds(next);
      setAnchorId(s.id);
      return;
    }

    // Normal click clears multi-select and opens the conversation
    if (selectedIds.size > 0) setSelectedIds(new Set());
    setAnchorId(s.id);
    onSelectSession(s.id);
  };

  const handleCreateFolder = (e: React.FormEvent) => {
    e.preventDefault();
    const name = newFolderName.trim();
    if (!name) return;
    onOrganize([{ type: 'create_folder', folderName: name }]);
    setNewFolderName('');
    setCreatingFolder(false);
  };

  const commitRename = (sessionId: string) => {
    onOrganize([{ type: 'rename_session', sessionId, title: renameDraft }]);
    setRenamingId(null);
  };

  const openSectionMenu = (
    sectionLabel: string,
    sectionSessions: UnifiedSession[],
    x: number,
    y: number
  ) => {
    const seen = new Set<string>();
    const unique: UnifiedSession[] = [];
    for (const item of sectionSessions) {
      if (item.harness === 'master' || seen.has(item.id)) continue;
      seen.add(item.id);
      unique.push(item);
    }
    if (unique.length === 0) return;
    const maxY = window.innerHeight - 220;
    const maxX = window.innerWidth - 230;
    setCtxMenu({
      x: Math.max(8, Math.min(x, maxX)),
      y: Math.max(8, Math.min(y, maxY)),
      sessions: unique,
      sectionLabel,
    });
  };

  const renderSessionRow = (
    s: UnifiedSession,
    opts: { showLogo?: boolean; showPin?: boolean } = {}
  ) => {
    const { showLogo = true, showPin = false } = opts;
    const isPrimary = activeSessionId === s.id;
    const isSplit = splitSessionId === s.id;
    const isMultiSelected = selectedIds.has(s.id);

    if (renamingId === s.id) {
      return (
        <div key={s.id} className="px-2 py-1">
          <Input
            autoFocus
            inputSize="sm"
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onBlur={() => commitRename(s.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename(s.id);
              if (e.key === 'Escape') setRenamingId(null);
            }}
          />
        </div>
      );
    }

    const openRowMenu = (x: number, y: number) => {
      let targets: UnifiedSession[];
      if (selectedIds.size > 1 && selectedIds.has(s.id)) {
        targets = visibleOrderedSessions.filter((xItem) => selectedIds.has(xItem.id));
      } else {
        if (selectedIds.size > 0) setSelectedIds(new Set());
        targets = [s];
      }
      const maxY = window.innerHeight - 280;
      const maxX = window.innerWidth - 230;
      setCtxMenu({
        x: Math.max(8, Math.min(x, maxX)),
        y: Math.max(8, Math.min(y, maxY)),
        sessions: targets,
      });
    };

    const showInlinePin = showPin && showLogo;
    const leadingIcon = showLogo ? (
      <HarnessLogo harness={s.harness} size={15} />
    ) : showPin ? (
      <Pin className="w-3.5 h-3.5 text-amber-400/80" />
    ) : undefined;
    const titleBadge = showInlinePin ? (
      <span title="Pinned in harness" className="text-amber-400/80">
        <Pin className="w-3 h-3" />
      </span>
    ) : undefined;

    const recencyOpacity = computeThreadRecencyOpacity(s.updatedAt);
    const isBeingDragged = Boolean(activeDrag?.sessions.some((d) => d.id === s.id));

    return (
      <NavRow
        key={s.id}
        data-session-id={s.id}
        aria-current={isPrimary ? 'page' : undefined}
        icon={leadingIcon}
        unread={Boolean(s.unread)}
        title={s.title}
        titleBadge={titleBadge}
        titleOpacity={recencyOpacity}
        active={isPrimary}
        secondaryActive={isSplit}
        selected={isMultiSelected}
        working={s.status === 'running'}
        workingTone={resolveHarnessOrbTone(s.harnessGroup, usage)}
        className={isBeingDragged ? 'opacity-45' : undefined}
        onPointerDown={(e) => {
          if (e.button !== 0 || s.harnessGroup === 'master') return;
          if ((e.target as HTMLElement | null)?.closest('button, input, textarea')) return;
          const draggedSessions =
            selectedIds.size > 1 && selectedIds.has(s.id)
              ? visibleOrderedSessions.filter(
                  (x) => selectedIds.has(x.id) && x.harnessGroup === s.harnessGroup
                )
              : [s];
          pendingDragRef.current = {
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            sessions: draggedSessions.length > 0 ? draggedSessions : [s],
            harnessGroup: s.harnessGroup,
          };
        }}
        meta={
          s.hostAddress ? (
            <span
              title={`Running on ${s.hostLabel || s.hostAddress} (${s.hostAddress})`}
              className={remoteHostColorClass(s.hostAddress || s.hostLabel || 'remote')}
            >
              <Laptop className="w-3.5 h-3.5" />
            </span>
          ) : s.harness === 'claude-tmux' ? (
            <span
              title={`Live tmux: ${s.tmuxTarget || s.tmuxSessionName || 'local'}`}
              className="text-ink-muted"
            >
              <Laptop className="w-3.5 h-3.5" />
            </span>
          ) : undefined
        }
        hoverActions={
          <IconButton
            size="xs"
            label="Conversation actions"
            className="focus-visible:shadow-none"
            onClick={(e) => {
              e.stopPropagation();
              const rect = e.currentTarget.getBoundingClientRect();
              openRowMenu(rect.right - 220, rect.bottom + 4);
            }}
          >
            <MoreHorizontal className="w-3.5 h-3.5" />
          </IconButton>
        }
        onClick={(e) => handleRowClick(e, s)}
        onMouseEnter={() => {
          if (s.id !== activeSessionId) scheduleHoverPrefetch(s.id);
        }}
        onMouseLeave={cancelHoverPrefetch}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          openRowMenu(e.clientX, e.clientY);
        }}
      />
    );
  };

  return (
    <aside
      ref={asideRef}
      style={{ width }}
      className="shrink-0 h-full flex flex-col border-r border-line-hairline bg-surface-rail select-none"
    >
      {/* Top Bar (draggable window region) */}
      <div className="sh-drag-region h-12 px-3.5 flex items-center justify-between">
        <div className="flex items-center gap-2.5 px-1">
          <Layers className="w-4 h-4 text-ink-secondary" />
          <span className="text-heading font-semibold tracking-tight text-ink-primary">
            Super Harness
          </span>
        </div>
        <div className="flex items-center gap-0.5 relative">
          <IconButton
            label="Search (Ctrl+K)"
            active={showSearch || Boolean(query)}
            onClick={() => {
              setShowSearch((v) => !v);
              setTimeout(() => searchInputRef.current?.focus(), 30);
            }}
          >
            <Search className="w-4 h-4" strokeWidth={1.75} />
          </IconButton>
          <span ref={filterTriggerRef} className="flex items-center">
            <IconButton
              label="Group & Filter"
              active={showFilterMenu || filter !== 'all'}
              onClick={() => setShowFilterMenu((v) => !v)}
            >
              <SlidersHorizontal className="w-4 h-4" strokeWidth={1.75} />
            </IconButton>
          </span>

          {showFilterMenu && (
            <PopoverSurface
              width="sm"
              onClose={() => setShowFilterMenu(false)}
              ignoreRef={filterTriggerRef}
              className="sh-no-drag absolute right-0 top-9 z-40 w-52"
            >
              <MenuSectionLabel>Group by</MenuSectionLabel>
              {(
                [
                  ['native', 'Harness & Native Sections'],
                  ['harness', 'Harness (Flat)'],
                  ['project', 'Unified Projects'],
                  ['folders', 'Custom Folders'],
                  ['recent', 'Recent'],
                ] as Array<[SidebarGroupBy, string]>
              ).map(([m, lbl]) => (
                <MenuItem
                  key={m}
                  active={groupBy === m}
                  onClick={() => {
                    onChangeGroupBy(m);
                    setShowFilterMenu(false);
                  }}
                >
                  {lbl}
                </MenuItem>
              ))}

              <MenuDivider />
              <MenuSectionLabel>Sort by</MenuSectionLabel>
              {SIDEBAR_SORT_OPTIONS.map(([m, lbl]) => (
                <MenuItem
                  key={m}
                  active={sortBy === m}
                  onClick={() => {
                    setSortBy(m);
                    setShowFilterMenu(false);
                  }}
                >
                  {lbl}
                </MenuItem>
              ))}

              <MenuDivider />
              <MenuSectionLabel>Filter</MenuSectionLabel>
              {(
                [
                  ['all', 'All harnesses'],
                  ['live', 'Live / active'],
                  ['antigravity', 'Antigravity'],
                  ['codex', 'Codex'],
                  ['tmux', 'Claude · tmux'],
                  ['claude', 'All Claude'],
                  ['muse', 'Muse'],
                ] as Array<[FilterTab, string]>
              ).map(([k, lbl]) => (
                <MenuItem
                  key={k}
                  active={filter === k}
                  onClick={() => {
                    setFilter(k);
                    setShowFilterMenu(false);
                  }}
                >
                  {lbl}
                </MenuItem>
              ))}

              <MenuDivider />
              <MenuItem
                icon={<FolderPlus className="w-3.5 h-3.5" />}
                onClick={() => {
                  setCreatingFolder(true);
                  setShowFilterMenu(false);
                }}
              >
                New custom folder
              </MenuItem>
            </PopoverSurface>
          )}
        </div>
      </div>

      {/* Primary Actions + Global Top-Pinned Chats (all harnesses, flat below Master Orchestrator) */}
      <div className="px-2.5 pb-2.5 space-y-0.5">
        <button
          type="button"
          onClick={() => onNewSession(filter)}
          className="w-full h-8 flex items-center gap-2 px-2.5 rounded-lg text-[13px] text-ink-secondary hover:text-ink-primary hover:bg-white/[0.045] transition-colors cursor-pointer focus:outline-none focus-visible:shadow-none"
        >
          <SquarePen className="w-3.5 h-3.5 text-ink-muted shrink-0" />
          <span className="leading-[1.35]">New Conversation</span>
        </button>

        {masterSession && (
          <NavRow
            data-session-id={masterSession.id}
            aria-current={activeSessionId === masterSession.id ? 'page' : undefined}
            icon={<HarnessLogo harness="master" size={16} />}
            title="Master Orchestrator"
            active={activeSessionId === masterSession.id}
            onClick={() => onSelectSession(masterSession.id)}
            hoverActions={
              <IconButton
                size="xs"
                label="Open in split"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenInSplit(masterSession.id);
                }}
              >
                <Columns2 className="w-3.5 h-3.5" />
              </IconButton>
            }
          />
        )}

        {globalPinnedSessions.length > 0 && (
          <div className="space-y-0.5 max-h-[32vh] overflow-y-auto">
            {globalPinnedSessions.map((s) =>
              renderSessionRow(s, { showLogo: true, showPin: false })
            )}
          </div>
        )}
      </div>

      {/* Top Harness Switcher Bar (All | Antigravity | Codex | Claude | Muse) with circular radial gauges */}
      {(() => {
        const tabLogoSize = 14;
        const anyWorking =
          workingByHarness.antigravity ||
          workingByHarness.codex ||
          workingByHarness.claude ||
          workingByHarness.muse;
        return (
          <div className="px-2.5 pb-3">
            <SegmentedControl<FilterTab>
              variant="gauge"
              value={filter === 'live' || filter === 'tmux' ? 'all' : filter}
              onChange={(tab) => {
                setFilter(tab);
                dismissUsageHover();
              }}
              onItemMouseEnter={(id, el) => {
                if (!usage) return;
                const target: HarnessGroup | 'all' =
                  id === 'antigravity' || id === 'codex' || id === 'claude' || id === 'muse'
                    ? id
                    : 'all';
                openUsageHover(target, el);
              }}
              onItemMouseLeave={scheduleCloseUsageHover}
              items={orderGaugeItems([
                {
                  id: 'all',
                  label: 'All',
                  working: anyWorking,
                  progress: {
                    value: usage
                      ? Math.max(
                          usage.claude?.barPercent ?? 0,
                          usage.codex?.barPercent ?? 0,
                          usage.antigravity?.barPercent ?? 0,
                          usage.muse?.barPercent ?? 0
                        )
                      : null,
                    tone: 'neutral',
                    estimated: true,
                  },
                },
                {
                  id: 'antigravity',
                  label: 'AGY',
                  icon: <HarnessLogo harness="antigravity" size={tabLogoSize} />,
                  working: workingByHarness.antigravity,
                  progress: {
                    value: usage?.antigravity?.barPercent ?? null,
                    tone: 'antigravity',
                    estimated: usage?.antigravity?.barIsEstimated,
                  },
                },
                {
                  id: 'codex',
                  label: 'Codex',
                  icon: <HarnessLogo harness="codex" size={tabLogoSize} />,
                  working: workingByHarness.codex,
                  progress: {
                    value: usage?.codex?.barPercent ?? null,
                    tone: 'codex',
                    estimated: usage?.codex?.barIsEstimated,
                  },
                },
                {
                  id: 'claude',
                  label: 'Claude',
                  icon: <HarnessLogo harness="claude" size={tabLogoSize} />,
                  working: workingByHarness.claude,
                  progress: {
                    value: usage?.claude?.barPercent ?? null,
                    tone: 'claude',
                    estimated: usage?.claude?.barIsEstimated,
                  },
                },
                {
                  id: 'muse',
                  label: 'Muse',
                  // The Muse mark is drawn centered on its 24x24 box and the 16px icon sits
                  // at an integer offset in the 32px gauge, so it needs no pixel nudge.
                  icon: <HarnessLogo harness="muse" size={16} />,
                  working: workingByHarness.muse,
                  progress: {
                    value: usage?.muse?.barPercent ?? null,
                    tone: 'muse',
                    estimated: usage?.muse?.barIsEstimated,
                  },
                },
              ], harnessOrder)}
              canReorder={(id) => id !== 'all'}
              onReorder={(dragged, target) => {
                if (dragged === 'all' || target === 'all') return;
                onChangeHarnessOrder?.(moveHarness(harnessOrder ?? [], dragged as HarnessGroup, target as HarnessGroup));
              }}
            />
          </div>
        );
      })()}

      {hoveredUsage && usage && (
        <HarnessUsageHoverCard
          target={hoveredUsage.target}
          usage={usage}
          anchorRect={hoveredUsage.rect}
          onMouseEnter={cancelCloseUsageHover}
          onMouseLeave={scheduleCloseUsageHover}
        />
      )}

      {/* Inline Search */}
      {(showSearch || query) && (
        <div className="px-2.5 pb-2">
          <div className="h-9 flex items-center gap-2 px-3 rounded-lg bg-surface-subtle border border-line-subtle focus-within:border-line-strong transition-colors">
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  if (query) {
                    setQuery('');
                  } else {
                    setShowSearch(false);
                  }
                }
              }}
              placeholder="Filter conversations…"
              className="flex-1 min-w-0 bg-transparent p-0 text-[14px] leading-normal text-ink-primary placeholder:text-ink-faint focus:outline-none focus-visible:shadow-none"
            />
            <button
              type="button"
              onClick={() => {
                if (query) {
                  setQuery('');
                  searchInputRef.current?.focus();
                } else {
                  setShowSearch(false);
                }
              }}
              title={query ? 'Clear filter' : 'Close filter'}
              aria-label={query ? 'Clear filter' : 'Close filter'}
              className={`w-5 h-5 rounded-md flex items-center justify-center shrink-0 transition-colors cursor-pointer ${
                query
                  ? 'text-ink-secondary hover:text-ink-primary hover:bg-white/[0.1]'
                  : 'text-ink-faint hover:text-ink-secondary hover:bg-white/[0.06]'
              }`}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* New Folder Input */}
      {creatingFolder && (
        <form onSubmit={handleCreateFolder} className="px-2.5 pb-2 flex gap-1.5">
          <Input
            autoFocus
            inputSize="sm"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setCreatingFolder(false);
            }}
            placeholder="Folder name…"
          />
          <Button type="submit" size="sm" variant="primary">
            Add
          </Button>
        </form>
      )}

      {(filter === 'live' || filter === 'tmux') && (
        <div className="px-3 pb-1.5 flex items-center justify-between text-micro text-ink-muted">
          <span>Filter: {filter}</span>
          <button
            type="button"
            onClick={() => setFilter('all')}
            className="text-ink-faint hover:text-ink-primary cursor-pointer"
          >
            Clear
          </button>
        </div>
      )}

      {/* Multi-selection action strip */}
      {selectedIds.size > 1 && (
        <div className="mx-2.5 mb-2 px-2.5 py-1.5 rounded-lg bg-indigo-500/15 border border-indigo-400/30 flex items-center justify-between gap-2 text-caption">
          <span className="text-indigo-100 font-medium">{selectedIds.size} selected</span>
          <div className="flex items-center gap-1.5">
            <Button
              size="xs"
              variant="secondary"
              iconLeft={<Archive className="w-3 h-3" />}
              onClick={() => {
                const targets = visibleOrderedSessions.filter((x) => selectedIds.has(x.id));
                setSelectedIds(new Set());
                onArchiveMany(targets, false);
              }}
            >
              Archive
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setSelectedIds(new Set())}>
              Clear
            </Button>
          </div>
        </div>
      )}

      {/* Structured Conversation Tree with Sticky Two-Tier Headers */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto px-2.5 pb-4 border-t border-line-hairline"
      >
        {/* Inline unsent draft conversations (? when harness undecided, or harness logo when chosen) */}
        {draftConversations.length > 0 && (
          <div className="pt-2 pb-1 space-y-0.5 border-b border-line-hairline mb-2">
            {draftConversations.map((d) => {
              const title = d.prompt.trim().slice(0, 60) || 'New Conversation';
              return (
                <NavRow
                  key={d.id}
                  icon={
                    d.harness ? (
                      <HarnessLogo harness={d.harness} size={15} />
                    ) : (
                      <HelpCircle className="w-4 h-4 text-ink-muted" />
                    )
                  }
                  title={title}
                  active={activeSessionId === d.id}
                  meta={<span className="text-micro text-ink-faint">draft</span>}
                  hoverActions={
                    <IconButton
                      size="xs"
                      label="Discard draft"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDiscardDraft(d.id);
                      }}
                    >
                      <X className="w-3 h-3" />
                    </IconButton>
                  }
                  onClick={() => onSelectSession(d.id)}
                />
              );
            })}
          </div>
        )}

        {topGroups.length === 0 ? (
          <div className="px-3 py-10 text-center text-body text-ink-muted">
            No conversations found
          </div>
        ) : (
          <div className="space-y-1">
            {topGroups.map((grp, grpIdx) => {
              // Headless flat pinned strip (e.g. individual harness pins in single-harness or folder view)
              if (grp.headless) {
                const showRowLogos = !isSingleHarnessFilter(filter);
                return (
                  <div
                    key={grp.id}
                    className={`space-y-0.5 ${grpIdx === 0 ? 'pt-2' : ''} ${
                      grpIdx < topGroups.length - 1 ? 'pb-2 border-b border-line-hairline/60' : ''
                    }`}
                  >
                    {(grp.items ?? []).map((s) =>
                      renderSessionRow(s, { showLogo: showRowLogos, showPin: true })
                    )}
                  </div>
                );
              }

              const isTopClosed = Boolean(collapsed[grp.id]);
              const groupHasWorking =
                (grp.pinnedItems ?? []).some((i) => i.status === 'running') ||
                (grp.sections
                  ? grp.sections.some((sec) => sec.items.some((i) => i.status === 'running'))
                  : (grp.items ?? []).some((i) => i.status === 'running')) ||
                (grp.harnessLogo ? workingByHarness[grp.harnessLogo] : false);

              const isHarnessDivider = Boolean(grp.harnessLogo);
              const topIcon = grp.harnessLogo ? (
                <HarnessLogo harness={grp.harnessLogo} size={14} />
              ) : grp.isUngrouped ? (
                <Inbox className="w-4 h-4 text-ink-secondary" />
              ) : (
                <FolderGit2 className="w-4 h-4 text-ink-secondary" />
              );

              const allGroupSessions: UnifiedSession[] = [
                ...(grp.pinnedItems ?? []),
                ...(grp.sections ? grp.sections.flatMap((sec) => sec.items) : grp.items ?? []),
              ];

              const isTopDroppable = !grp.sections && (Boolean(grp.harnessGroup) || grp.folderId !== undefined);
              const isTopDragOver = Boolean(
                isTopDroppable &&
                  activeDrag?.overValid &&
                  activeDrag.overTargetId === grp.id
              );
              const isOtherHarnessWhileDragging = Boolean(
                activeDrag &&
                  ((grp.harnessLogo && grp.harnessLogo !== activeDrag.harnessGroup) ||
                    (grp.harnessGroup && grp.harnessGroup !== activeDrag.harnessGroup))
              );

              return (
                <div
                  key={grp.id}
                  data-drop-section-id={isTopDroppable ? grp.id : undefined}
                  className={`relative rounded-lg transition-opacity ${
                    isOtherHarnessWhileDragging ? 'opacity-40' : ''
                  } ${
                    isTopDragOver
                      ? 'bg-indigo-500/10 ring-1 ring-inset ring-indigo-400/45'
                      : ''
                  }`}
                >
                  <SectionHeader
                    level={1}
                    variant={isHarnessDivider ? 'separator' : 'tree'}
                    accent={grp.harnessLogo || grp.harnessGroup}
                    collapsed={isTopClosed}
                    dropTarget={isTopDragOver}
                    onToggle={() => setCollapsed((p) => ({ ...p, [grp.id]: !p[grp.id] }))}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      openSectionMenu(grp.label, allGroupSessions, e.clientX, e.clientY);
                    }}
                    onAdd={
                      grp.harnessLogo
                        ? () => onNewSession(grp.harnessLogo!)
                        : () =>
                            onNewSession(filter, {
                              cwd: resolveGroupCwd(grp.items ?? [], Boolean(grp.isUngrouped)),
                            })
                    }
                    addLabel={
                      grp.harnessLogo
                        ? `New ${grp.label} conversation`
                        : `New conversation in ${grp.label}`
                    }
                    icon={topIcon}
                    label={grp.label}
                    working={groupHasWorking}
                  />

                  {!isTopClosed && (
                    <div className="mt-1 space-y-1.5">
                      {/* Individual harness pins right below the harness separator (no extra Pinned section) */}
                      {grp.pinnedItems && grp.pinnedItems.length > 0 && (
                        <div className="space-y-0.5">
                          {grp.pinnedItems.map((s) =>
                            renderSessionRow(s, { showLogo: false, showPin: true })
                          )}
                        </div>
                      )}

                      {grp.sections ? (
                        grp.sections.map((sec) => {
                          const isSecClosed = Boolean(collapsed[sec.id]);
                          const secHasWorking = sec.items.some((i) => i.status === 'running');
                          const isSecUngrouped = sec.label === 'Ungrouped';
                          const secIcon = isSecUngrouped ? (
                            <Inbox className="w-3.5 h-3.5 text-ink-muted" />
                          ) : (
                            <Folder className="w-3.5 h-3.5 text-ink-secondary" />
                          );
                          const isSecDragOver = Boolean(
                            activeDrag?.overValid && activeDrag.overTargetId === sec.id
                          );

                          return (
                            <div
                              key={sec.id}
                              data-drop-section-id={sec.id}
                              className={`relative rounded-lg transition-colors ${
                                isSecDragOver
                                  ? 'bg-indigo-500/10 ring-1 ring-inset ring-indigo-400/45'
                                  : ''
                              }`}
                            >
                              <SectionHeader
                                level={2}
                                accent={grp.harnessLogo || grp.harnessGroup}
                                collapsed={isSecClosed}
                                dropTarget={isSecDragOver}
                                onToggle={() =>
                                  setCollapsed((p) => ({ ...p, [sec.id]: !p[sec.id] }))
                                }
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  openSectionMenu(sec.label, sec.items, e.clientX, e.clientY);
                                }}
                                onAdd={() =>
                                  onNewSession(grp.harnessLogo || filter, {
                                    cwd: resolveGroupCwd(sec.items, isSecUngrouped),
                                  })
                                }
                                addLabel={`New ${grp.label} conversation in ${sec.label}`}
                                icon={secIcon}
                                label={sec.label}
                                working={secHasWorking}
                              />
                              {!isSecClosed && (
                                <div className="mt-0.5 ml-2.5 pl-2 border-l border-white/[0.06] space-y-0.5">
                                  {sec.items.map((s) =>
                                    renderSessionRow(s, { showLogo: false, showPin: Boolean(s.pinned) })
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })
                      ) : (
                        <div className="space-y-0.5">
                          {(grp.items ?? []).map((s) =>
                            renderSessionRow(s, {
                              showLogo: !grp.harnessLogo && !isSingleHarnessFilter(filter),
                              showPin: Boolean(s.pinned),
                            })
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Settings & Restart Footer */}
      <div className="p-2.5 border-t border-line-hairline flex items-center gap-1">
        <button
          type="button"
          onClick={onOpenSettings}
          className="flex-1 min-w-0 flex items-center gap-2 px-2.5 h-8 rounded-lg text-[13px] text-ink-secondary hover:text-ink-primary hover:bg-white/[0.05] transition-colors cursor-pointer"
        >
          <Settings className="w-4 h-4 text-ink-muted shrink-0" />
          <span className="truncate">Settings</span>
        </button>
        <IconButton
          label="Restart Super Harness"
          onClick={() => {
            void window.superHarness.restartApp();
          }}
        >
          <RotateCw className="w-4 h-4" strokeWidth={1.75} />
        </IconButton>
      </div>

      {/* Floating Pointer-Drag Preview Pill */}
      {activeDrag && (
        <div
          style={{
            left: Math.min(activeDrag.x + 14, window.innerWidth - 240),
            top: Math.min(activeDrag.y + 12, window.innerHeight - 48),
          }}
          className="fixed z-[9999] pointer-events-none max-w-[230px] flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-surface-raised/95 border border-line-strong shadow-xl backdrop-blur-md text-caption text-ink-primary"
        >
          <HarnessLogo harness={activeDrag.harnessGroup} size={13} />
          <span className="truncate font-medium">
            {activeDrag.sessions.length > 1
              ? `${activeDrag.sessions.length} conversations`
              : activeDrag.sessions[0]?.title}
          </span>
          {activeDrag.overTargetId && activeDrag.overValid && activeDrag.overLabel && (
            <span className="shrink-0 text-micro px-1.5 py-0.5 rounded bg-indigo-500/25 text-indigo-200 border border-indigo-400/30">
              → {activeDrag.overLabel}
            </span>
          )}
        </div>
      )}

      {/* Right-Click / Triple-Dot Context Menu */}
      {ctxMenu && (
        <SidebarContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          targets={ctxMenu.sessions}
          sectionLabel={ctxMenu.sectionLabel}
          onClose={() => setCtxMenu(null)}
          onClearSelection={() => setSelectedIds(new Set())}
          onOpenInSplit={onOpenInSplit}
          onStartRename={(s) => {
            setRenameDraft(s.title);
            setRenamingId(s.id);
          }}
          onOrganize={onOrganize}
          onArchiveMany={onArchiveMany}
        />
      )}
    </aside>
  );
});
