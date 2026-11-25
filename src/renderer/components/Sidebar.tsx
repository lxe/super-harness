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
} from '../ui';
import { formatRelativeTime } from '../utils/format';
import {
  filterSidebarSessions,
  flattenVisibleSessions,
  getGlobalPinnedSessions,
  groupSessionsForSidebar,
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
  onNewSession: (activeFilter: SidebarFilterTab) => void;
  onDiscardDraft: (draftId: string) => void;
  onOpenSettings: () => void;
  onRefresh: () => void;
  onChangeGroupBy: (g: SidebarGroupBy) => void;
  onOrganize: (actions: OrganizeAction[]) => void;
  onArchiveSession: (session: UnifiedSession, killTmux?: boolean) => void;
  onArchiveMany: (sessions: UnifiedSession[], killTmux?: boolean) => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  sessions: UnifiedSession[];
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
  onOrganize,
  onArchiveSession,
  onArchiveMany,
}) => {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterTab>(() => {
    try {
      const saved = localStorage.getItem('sh:sidebarFilter') as FilterTab | null;
      if (saved && ['all', 'live', 'codex', 'claude', 'tmux', 'antigravity'].includes(saved)) {
        return saved;
      }
    } catch {
      // ignore
    }
    return 'all';
  });
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
  const [hoveredUsage, setHoveredUsage] = useState<{
    target: HarnessGroup | 'all';
    rect: { left: number; bottom: number; width: number };
  } | null>(null);
  const hoverCloseTimerRef = useRef<number | null>(null);
  const prefetchTimerRef = useRef<number | null>(null);

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
    () => groupSessionsForSidebar(filtered, groupBy, folders, filter),
    [filtered, groupBy, folders, filter]
  );

  // Flat list of currently visible session IDs in exact rendered top-to-bottom order (for Shift+Click range select)
  const visibleOrderedSessions = useMemo(
    () => flattenVisibleSessions(topGroups, collapsed, globalPinnedSessions),
    [topGroups, collapsed, globalPinnedSessions]
  );

  const handleRowClick = (e: React.MouseEvent, s: UnifiedSession) => {
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

    const leadingIcon = showLogo ? (
      <HarnessLogo harness={s.harness} size={15} />
    ) : showPin ? (
      <Pin className="w-3.5 h-3.5 text-amber-400/80" />
    ) : undefined;

    return (
      <NavRow
        key={s.id}
        icon={leadingIcon}
        title={s.title}
        active={isPrimary}
        secondaryActive={isSplit}
        selected={isMultiSelected}
        working={s.status === 'running'}
        meta={
          <>
            {showPin && showLogo && (
              <Pin className="w-3 h-3 text-amber-400/80 shrink-0" aria-label="Pinned" />
            )}
            {s.harness === 'claude-tmux' && (
              <span
                title={`Live tmux: ${s.tmuxTarget || s.tmuxSessionName || 'remote'}`}
                className="text-ink-muted"
              >
                <Laptop className="w-3.5 h-3.5" />
              </span>
            )}
            {s.status !== 'running' && (
              <span className="text-caption text-ink-faint">
                {formatRelativeTime(s.updatedAt)}
              </span>
            )}
          </>
        }
        hoverActions={
          <IconButton
            size="xs"
            label="Conversation actions"
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
            <Search className="w-3.5 h-3.5" />
          </IconButton>
          <IconButton
            label="Group & Filter"
            active={showFilterMenu || filter !== 'all'}
            onClick={() => setShowFilterMenu((v) => !v)}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
          </IconButton>

          {showFilterMenu && (
            <PopoverSurface width="sm" className="sh-no-drag absolute right-0 top-9 z-40 w-52">
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
              <MenuSectionLabel>Filter</MenuSectionLabel>
              {(
                [
                  ['all', 'All harnesses'],
                  ['live', 'Live / active'],
                  ['antigravity', 'Antigravity'],
                  ['codex', 'Codex'],
                  ['tmux', 'Claude · tmux'],
                  ['claude', 'All Claude'],
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
          className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-body text-ink-secondary hover:text-ink-primary hover:bg-white/[0.06] transition-colors cursor-pointer"
        >
          <SquarePen className="w-4 h-4 text-ink-muted shrink-0" />
          <span>New Conversation</span>
        </button>

        {masterSession && (
          <NavRow
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
          <div className="pt-0.5 space-y-0.5 max-h-[32vh] overflow-y-auto">
            {globalPinnedSessions.map((s) =>
              renderSessionRow(s, { showLogo: true, showPin: true })
            )}
          </div>
        )}
      </div>

      {/* Top Harness Switcher Bar (All | Antigravity | Codex | Claude) with bottom usage bars */}
      <div className="px-2.5 pb-3">
        <SegmentedControl<FilterTab>
          value={filter === 'live' || filter === 'tmux' ? 'all' : filter}
          onChange={(tab) => {
            setFilter(tab);
            dismissUsageHover();
          }}
          onItemMouseEnter={(id, el) => {
            if (!usage) return;
            const target: HarnessGroup | 'all' =
              id === 'antigravity' || id === 'codex' || id === 'claude' ? id : 'all';
            openUsageHover(target, el);
          }}
          onItemMouseLeave={scheduleCloseUsageHover}
          items={[
            {
              id: 'all',
              label: 'All',
              progress: {
                value: usage
                  ? Math.max(
                      usage.claude.barPercent ?? 0,
                      usage.codex.barPercent ?? 0,
                      usage.antigravity.barPercent ?? 0
                    )
                  : null,
                tone: 'neutral',
                estimated: true,
              },
            },
            {
              id: 'antigravity',
              label: 'AGY',
              icon: <HarnessLogo harness="antigravity" size={13} />,
              working: workingByHarness.antigravity,
              progress: {
                value: usage?.antigravity.barPercent ?? null,
                tone: 'antigravity',
                estimated: usage?.antigravity.barIsEstimated,
              },
            },
            {
              id: 'codex',
              label: 'Codex',
              icon: <HarnessLogo harness="codex" size={13} />,
              working: workingByHarness.codex,
              progress: {
                value: usage?.codex.barPercent ?? null,
                tone: 'codex',
                estimated: usage?.codex.barIsEstimated,
              },
            },
            {
              id: 'claude',
              label: 'Claude',
              icon: <HarnessLogo harness="claude" size={13} />,
              working: workingByHarness.claude,
              progress: {
                value: usage?.claude.barPercent ?? null,
                tone: 'claude',
                estimated: usage?.claude.barIsEstimated,
              },
            },
          ]}
        />
      </div>

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
      <div className="flex-1 overflow-y-auto px-2.5 pb-4 border-t border-line-hairline">
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
          <div className="space-y-3">
            {topGroups.map((grp, grpIdx) => {
              // Headless flat pinned strip (e.g. individual harness pins in single-harness or folder view)
              if (grp.headless) {
                const showRowLogos =
                  filter !== 'antigravity' && filter !== 'codex' && filter !== 'claude';
                return (
                  <div
                    key={grp.id}
                    className={`pt-1.5 space-y-0.5 ${
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
              const pinnedCount = grp.pinnedItems?.length ?? 0;
              const totalInGroup =
                pinnedCount +
                (grp.sections
                  ? grp.sections.reduce((acc, s) => acc + s.items.length, 0)
                  : grp.items?.length ?? 0);
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

              return (
                <div key={grp.id} className="relative">
                  <SectionHeader
                    level={1}
                    variant={isHarnessDivider ? 'separator' : 'tree'}
                    collapsed={isTopClosed}
                    onToggle={() => setCollapsed((p) => ({ ...p, [grp.id]: !p[grp.id] }))}
                    icon={topIcon}
                    label={grp.label}
                    count={totalInGroup}
                    working={groupHasWorking}
                    className={
                      isHarnessDivider && grpIdx === 0 && draftConversations.length === 0
                        ? 'border-t-0'
                        : undefined
                    }
                  />

                  {!isTopClosed && (
                    <div className="mt-1 space-y-2">
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
                          const secIcon =
                            sec.label === 'Ungrouped' ? (
                              <Inbox className="w-3.5 h-3.5 text-ink-muted" />
                            ) : (
                              <Folder className="w-3.5 h-3.5 text-ink-secondary" />
                            );
                          return (
                            <div key={sec.id} className="relative">
                              <SectionHeader
                                level={2}
                                collapsed={isSecClosed}
                                onToggle={() =>
                                  setCollapsed((p) => ({ ...p, [sec.id]: !p[sec.id] }))
                                }
                                icon={secIcon}
                                label={sec.label}
                                count={sec.items.length}
                                working={secHasWorking}
                              />
                              {!isSecClosed && (
                                <div className="mt-0.5 space-y-0.5">
                                  {sec.items.map((s) =>
                                    renderSessionRow(s, { showLogo: false })
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
                              showLogo:
                                !grp.harnessLogo &&
                                filter !== 'antigravity' &&
                                filter !== 'codex' &&
                                filter !== 'claude',
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

      {/* Settings Footer */}
      <div className="p-2.5 border-t border-line-hairline">
        <button
          type="button"
          onClick={onOpenSettings}
          className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-body text-ink-secondary hover:text-ink-primary hover:bg-white/[0.06] transition-colors cursor-pointer"
        >
          <Settings className="w-4 h-4 text-ink-muted" />
          <span>Settings</span>
        </button>
      </div>

      {/* Right-Click / Triple-Dot Context Menu */}
      {ctxMenu && (
        <SidebarContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          targets={ctxMenu.sessions}
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
