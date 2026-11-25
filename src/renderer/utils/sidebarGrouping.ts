import type {
  HarnessGroup,
  SessionFolder,
  SidebarGroupBy,
  UnifiedSession,
} from '../../shared/types';

export type SidebarFilterTab = 'all' | 'live' | 'codex' | 'claude' | 'tmux' | 'antigravity';

export interface SubSection {
  id: string;
  label: string;
  order: number;
  items: UnifiedSession[];
}

export interface TopGroup {
  id: string;
  label: string;
  harnessLogo?: HarnessGroup;
  isTopPinned?: boolean;
  isUngrouped?: boolean;
  sections?: SubSection[];
  items?: UnifiedSession[];
}

const HARNESS_DEFS: Array<{ id: HarnessGroup; label: string }> = [
  { id: 'antigravity', label: 'Antigravity' },
  { id: 'codex', label: 'Codex' },
  { id: 'claude', label: 'Claude' },
];

export function filterSidebarSessions(
  workerSessions: UnifiedSession[],
  filter: SidebarFilterTab,
  query: string
): UnifiedSession[] {
  const q = query.trim().toLowerCase();
  return workerSessions.filter((s) => {
    if (filter === 'live' && !s.isLive) return false;
    if (filter === 'codex' && s.harness !== 'codex') return false;
    if (filter === 'claude' && s.harnessGroup !== 'claude') return false;
    if (filter === 'tmux' && s.harness !== 'claude-tmux') return false;
    if (filter === 'antigravity' && s.harness !== 'antigravity') return false;
    if (q) {
      const hay =
        `${s.title} ${s.projectName} ${s.nativeSection || ''} ${s.cwd} ${s.harness} ${s.tmuxSessionName || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function buildNativeSections(hId: string, hItems: UnifiedSession[]): SubSection[] {
  const secMap = new Map<string, { order: number; items: UnifiedSession[] }>();
  for (const s of hItems) {
    const isUnfiled = !s.nativeSection || s.nativeSection === 'Ungrouped';
    const sec = s.pinned ? 'Pinned' : isUnfiled ? 'Ungrouped' : s.nativeSection!;
    const order = s.pinned ? -1 : isUnfiled ? 9999 : (s.nativeSectionOrder ?? 500);
    if (!secMap.has(sec)) secMap.set(sec, { order, items: [] });
    const entry = secMap.get(sec)!;
    entry.order = Math.min(entry.order, order);
    entry.items.push(s);
  }
  return Array.from(secMap.entries())
    .map(([label, info]) => ({
      id: `${hId}:${label}`,
      label,
      order: info.order,
      items: info.items,
    }))
    .sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return (b.items[0]?.updatedAt ?? 0) - (a.items[0]?.updatedAt ?? 0);
    });
}

/**
 * Pure grouping & ordering logic for the sidebar across all 5 view modes
 * (`native`, `harness`, `project`, `folders`, `recent`), always keeping
 * Super Harness top-pinned chats anchored at the very top.
 */
export function groupSessionsForSidebar(
  filtered: UnifiedSession[],
  groupBy: SidebarGroupBy,
  folders: SessionFolder[],
  filter: SidebarFilterTab
): TopGroup[] {
  const topPinnedItems = filtered
    .filter((s) => s.pinnedToTop)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const rest = topPinnedItems.length > 0 ? filtered.filter((s) => !s.pinnedToTop) : filtered;
  const pinnedGroup: TopGroup[] =
    topPinnedItems.length > 0
      ? [{ id: 'sh-pinned-top', label: 'Pinned', isTopPinned: true, items: topPinnedItems }]
      : [];

  if (groupBy === 'recent') {
    return [
      ...pinnedGroup,
      ...(rest.length > 0 ? [{ id: 'recent', label: 'Conversations', items: rest }] : []),
    ];
  }

  if (groupBy === 'native') {
    // When filtered to a single harness tab, promote its native sections directly to top-level
    if (filter === 'antigravity' || filter === 'codex' || filter === 'claude') {
      const secs = buildNativeSections(filter, rest);
      return [
        ...pinnedGroup,
        ...secs.map((sec) => ({
          id: sec.id,
          label: sec.label,
          isUngrouped: sec.label === 'Ungrouped',
          items: sec.items,
        })),
      ];
    }

    const out: TopGroup[] = [...pinnedGroup];
    for (const h of HARNESS_DEFS) {
      const hItems = rest.filter((s) => s.harnessGroup === h.id);
      if (hItems.length === 0) continue;
      out.push({
        id: `harness:${h.id}`,
        label: h.label,
        harnessLogo: h.id,
        sections: buildNativeSections(h.id, hItems),
      });
    }
    return out;
  }

  if (groupBy === 'harness') {
    return [
      ...pinnedGroup,
      ...HARNESS_DEFS.map((d) => ({
        id: `flat-h:${d.id}`,
        label: d.label,
        harnessLogo: d.id,
        items: rest.filter((s) => s.harnessGroup === d.id),
      })).filter((g) => (g.items?.length ?? 0) > 0),
    ];
  }

  if (groupBy === 'folders') {
    const out: TopGroup[] = [...pinnedGroup];
    const pinned = rest.filter((s) => s.pinned);
    if (pinned.length > 0) out.push({ id: 'pinned', label: 'Harness Pinned', items: pinned });
    const folderMap = new Map<string, UnifiedSession[]>();
    for (const f of folders) folderMap.set(f.id, []);
    const unfiled: UnifiedSession[] = [];
    for (const s of rest) {
      if (s.pinned) continue;
      if (s.folderId && folderMap.has(s.folderId)) folderMap.get(s.folderId)!.push(s);
      else unfiled.push(s);
    }
    for (const f of folders) {
      const items = folderMap.get(f.id) ?? [];
      if (items.length > 0) out.push({ id: f.id, label: f.name, items });
    }
    if (unfiled.length > 0) out.push({ id: 'unfiled', label: 'Conversations', items: unfiled });
    return out;
  }

  // Unified cross-harness by Project
  const projMap = new Map<string, UnifiedSession[]>();
  for (const s of rest) {
    const key = s.projectName || 'General';
    if (!projMap.has(key)) projMap.set(key, []);
    projMap.get(key)!.push(s);
  }
  return [
    ...pinnedGroup,
    ...Array.from(projMap.entries())
      .map(([label, items]) => ({ id: `proj:${label}`, label, items }))
      .sort((a, b) => (b.items[0]?.updatedAt ?? 0) - (a.items[0]?.updatedAt ?? 0)),
  ];
}

/**
 * Flattens currently expanded sidebar groups into exact rendered top-to-bottom
 * order (used for Shift+Click range multi-selection).
 */
export function flattenVisibleSessions(
  topGroups: TopGroup[],
  collapsed: Record<string, boolean>
): UnifiedSession[] {
  const list: UnifiedSession[] = [];
  for (const grp of topGroups) {
    if (collapsed[grp.id]) continue;
    if (grp.sections) {
      for (const sec of grp.sections) {
        if (collapsed[sec.id]) continue;
        list.push(...sec.items);
      }
    } else if (grp.items) {
      list.push(...grp.items);
    }
  }
  return list;
}
