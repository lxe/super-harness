import type {
  HarnessGroup,
  SessionFolder,
  SidebarGroupBy,
  UnifiedSession,
} from '../../shared/types';

export type SidebarFilterTab =
  | 'all'
  | 'live'
  | 'codex'
  | 'claude'
  | 'tmux'
  | 'antigravity'
  | 'muse';

export interface SubSection {
  id: string;
  label: string;
  order: number;
  harnessGroup: HarnessGroup;
  items: UnifiedSession[];
}

export interface TopGroup {
  id: string;
  label: string;
  harnessLogo?: HarnessGroup;
  /** Owning editor/harness when this top-level group is a native harness section (single-harness view). */
  harnessGroup?: HarnessGroup;
  /** Section sort order (used when moving chats into a single-harness native section). */
  sectionOrder?: number;
  /** Custom folder ID when groupBy === 'folders' (`null` for Unfiled). */
  folderId?: string | null;
  /** True when items should render flat at the top with no collapsible header (e.g., native harness pins in single-harness view). */
  headless?: boolean;
  isUngrouped?: boolean;
  /** Natively pinned chats rendered flat directly below a harness separator (no extra Pinned section). */
  pinnedItems?: UnifiedSession[];
  sections?: SubSection[];
  items?: UnifiedSession[];
}

export interface DragSectionTarget {
  kind: 'native-section' | 'folder';
  sectionLabel: string;
  harnessGroup?: HarnessGroup;
  sectionOrder?: number;
  folderId?: string | null;
}

export function canDropSessionIntoSection(
  dragged: {
    harnessGroup: UnifiedSession['harnessGroup'];
    nativeSection?: string;
    pinned?: boolean;
    folderId?: string | null;
  },
  target: DragSectionTarget
): boolean {
  if (dragged.harnessGroup === 'master') return false;
  if (target.kind === 'native-section') {
    if (!target.harnessGroup || target.harnessGroup !== dragged.harnessGroup) {
      return false;
    }
    const currentSection =
      !dragged.nativeSection || dragged.nativeSection === 'Ungrouped'
        ? 'Ungrouped'
        : dragged.nativeSection;
    if (!dragged.pinned && currentSection === target.sectionLabel) {
      return false;
    }
    return true;
  }
  const currentFolder = dragged.folderId ?? null;
  const targetFolder = target.folderId ?? null;
  return currentFolder !== targetFolder;
}

export interface HarnessSectionOption {
  label: string;
  order: number;
  isUngrouped: boolean;
}

/**
 * Returns all distinct native sections available for a specific harness group,
 * ordered by section order, with `Ungrouped` always available at the end.
 */
export function getAvailableSectionsForHarness(
  sessions: UnifiedSession[],
  harnessGroup: HarnessGroup
): HarnessSectionOption[] {
  const secMap = new Map<string, { order: number; latestUpdatedAt: number }>();

  for (const s of sessions) {
    if (s.harnessGroup !== harnessGroup) continue;
    if (!s.nativeSection || s.nativeSection === 'Ungrouped') continue;
    const order = s.nativeSectionOrder ?? 500;
    const prev = secMap.get(s.nativeSection);
    if (!prev) {
      secMap.set(s.nativeSection, { order, latestUpdatedAt: s.updatedAt });
    } else {
      prev.order = Math.min(prev.order, order);
      prev.latestUpdatedAt = Math.max(prev.latestUpdatedAt, s.updatedAt);
    }
  }

  const named: HarnessSectionOption[] = Array.from(secMap.entries())
    .sort((a, b) => {
      if (a[1].order !== b[1].order) return a[1].order - b[1].order;
      return b[1].latestUpdatedAt - a[1].latestUpdatedAt;
    })
    .map(([label, info]) => ({
      label,
      order: info.order,
      isUngrouped: false,
    }));

  named.push({ label: 'Ungrouped', order: 9999, isUngrouped: true });
  return named;
}

export function isSingleHarnessFilter(filter: SidebarFilterTab): filter is HarnessGroup {
  return (
    filter === 'antigravity' ||
    filter === 'codex' ||
    filter === 'claude' ||
    filter === 'muse'
  );
}

const HARNESS_DEFS: Array<{ id: HarnessGroup; label: string }> = [
  { id: 'antigravity', label: 'Antigravity' },
  { id: 'codex', label: 'Codex' },
  { id: 'claude', label: 'Claude' },
  { id: 'muse', label: 'Muse' },
];

/**
 * Computes a gentle logarithmic opacity fade for sidebar conversation rows
 * based on how long ago they were active (1.0 for fresh chats, flooring at
 * 0.58 for week+ old threads so they stay cleanly legible).
 */
export function computeThreadRecencyOpacity(updatedAt: number, now = Date.now()): number {
  const ageMin = Math.max(0, (now - updatedAt) / 60_000);
  if (ageMin <= 15) return 1;
  // Smooth log curve from 15m -> 14d (20,160m), mapping [0..1] to [1.0..0.58]
  const minLog = Math.log10(15);
  const maxLog = Math.log10(14 * 24 * 60);
  const t = Math.min(1, Math.max(0, (Math.log10(ageMin) - minLog) / (maxLog - minLog)));
  return Number((1 - t * 0.42).toFixed(3));
}

/**
 * Returns all Super Harness top-pinned chats across every harness (rendered
 * directly below Master Orchestrator and above the harness switcher).
 */
export function getGlobalPinnedSessions(workerSessions: UnifiedSession[]): UnifiedSession[] {
  return workerSessions
    .filter((s) => s.pinnedToTop)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

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
    if (filter === 'muse' && s.harness !== 'muse') return false;
    if (q) {
      const hay =
        `${s.title} ${s.projectName} ${s.nativeSection || ''} ${s.cwd} ${s.harness} ${s.tmuxSessionName || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function splitNativePinnedAndSections(
  hId: HarnessGroup,
  hItems: UnifiedSession[]
): { pinnedItems: UnifiedSession[]; sections: SubSection[] } {
  const pinnedItems: UnifiedSession[] = [];
  const secMap = new Map<string, { order: number; items: UnifiedSession[] }>();

  for (const s of hItems) {
    if (s.pinned) {
      pinnedItems.push(s);
      continue;
    }
    const isUnfiled = !s.nativeSection || s.nativeSection === 'Ungrouped';
    const sec = isUnfiled ? 'Ungrouped' : s.nativeSection!;
    const order = isUnfiled ? 9999 : (s.nativeSectionOrder ?? 500);
    if (!secMap.has(sec)) secMap.set(sec, { order, items: [] });
    const entry = secMap.get(sec)!;
    entry.order = Math.min(entry.order, order);
    entry.items.push(s);
  }

  pinnedItems.sort((a, b) => b.updatedAt - a.updatedAt);

  const sections: SubSection[] = Array.from(secMap.entries())
    .map(([label, info]) => ({
      id: `${hId}:${label}`,
      label,
      order: info.order,
      harnessGroup: hId,
      items: info.items,
    }))
    .sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return (b.items[0]?.updatedAt ?? 0) - (a.items[0]?.updatedAt ?? 0);
    });

  return { pinnedItems, sections };
}

/**
 * Pure grouping & ordering logic for the scrollable conversation list below
 * the harness switcher across all 5 view modes (`native`, `harness`, `project`,
 * `folders`, `recent`).
 *
 * - Global Super Harness top-pinned chats (`pinnedToTop`) are excluded here
 *   because they live permanently above the harness switcher across all tabs.
 * - Individual harness pins (`pinned`) float directly below their harness
 *   header (or at the top of a single-harness tab) with no extra "Pinned" section.
 */
export function groupSessionsForSidebar(
  filtered: UnifiedSession[],
  groupBy: SidebarGroupBy,
  folders: SessionFolder[],
  filter: SidebarFilterTab
): TopGroup[] {
  const rest = filtered.filter((s) => !s.pinnedToTop);

  if (groupBy === 'recent') {
    return rest.length > 0 ? [{ id: 'recent', label: 'Conversations', items: rest }] : [];
  }

  if (groupBy === 'native') {
    // Single-harness tab: native harness pins sit flat at the top (no Pinned header),
    // followed directly by the harness's project / native sections.
    if (
      filter === 'antigravity' ||
      filter === 'codex' ||
      filter === 'claude' ||
      filter === 'muse'
    ) {
      const { pinnedItems, sections } = splitNativePinnedAndSections(filter, rest);
      const out: TopGroup[] = [];
      if (pinnedItems.length > 0) {
        out.push({
          id: `${filter}:native-pinned`,
          label: 'Pinned',
          headless: true,
          items: pinnedItems,
        });
      }
      for (const sec of sections) {
        out.push({
          id: sec.id,
          label: sec.label,
          harnessGroup: filter,
          sectionOrder: sec.order,
          isUngrouped: sec.label === 'Ungrouped',
          items: sec.items,
        });
      }
      return out;
    }

    const out: TopGroup[] = [];
    for (const h of HARNESS_DEFS) {
      const hItems = rest.filter((s) => s.harnessGroup === h.id);
      if (hItems.length === 0) continue;
      const { pinnedItems, sections } = splitNativePinnedAndSections(h.id, hItems);
      out.push({
        id: `harness:${h.id}`,
        label: h.label,
        harnessLogo: h.id,
        pinnedItems: pinnedItems.length > 0 ? pinnedItems : undefined,
        sections,
      });
    }
    return out;
  }

  if (groupBy === 'harness') {
    return HARNESS_DEFS.map((d) => {
      const hItems = rest
        .filter((s) => s.harnessGroup === d.id)
        .sort((a, b) => {
          if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
          return b.updatedAt - a.updatedAt;
        });
      return {
        id: `flat-h:${d.id}`,
        label: d.label,
        harnessLogo: d.id,
        items: hItems,
      };
    }).filter((g) => (g.items?.length ?? 0) > 0);
  }

  if (groupBy === 'folders') {
    const out: TopGroup[] = [];
    const pinned = rest.filter((s) => s.pinned).sort((a, b) => b.updatedAt - a.updatedAt);
    if (pinned.length > 0) {
      out.push({ id: 'harness-pinned-flat', label: 'Pinned', headless: true, items: pinned });
    }
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
      if (items.length > 0) out.push({ id: f.id, label: f.name, folderId: f.id, items });
    }
    if (unfiled.length > 0) {
      out.push({ id: 'unfiled', label: 'Conversations', folderId: null, items: unfiled });
    }
    return out;
  }

  // Unified cross-harness by Project
  const projMap = new Map<string, UnifiedSession[]>();
  for (const s of rest) {
    const key = s.projectName || 'General';
    if (!projMap.has(key)) projMap.set(key, []);
    projMap.get(key)!.push(s);
  }
  return Array.from(projMap.entries())
    .map(([label, items]) => ({ id: `proj:${label}`, label, items }))
    .sort((a, b) => (b.items[0]?.updatedAt ?? 0) - (a.items[0]?.updatedAt ?? 0));
}

/**
 * Flattens currently expanded sidebar groups into exact rendered top-to-bottom
 * order (used for Shift+Click range multi-selection).
 */
export function flattenVisibleSessions(
  topGroups: TopGroup[],
  collapsed: Record<string, boolean>,
  globalPinned: UnifiedSession[] = []
): UnifiedSession[] {
  const list: UnifiedSession[] = [...globalPinned];
  for (const grp of topGroups) {
    if (!grp.headless && collapsed[grp.id]) continue;
    if (grp.pinnedItems && grp.pinnedItems.length > 0) {
      list.push(...grp.pinnedItems);
    }
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

/** How threads are ordered inside each sidebar group. 'native' keeps each harness's own order. */
export type SidebarSortBy = 'native' | 'active' | 'created';

export const SIDEBAR_SORT_OPTIONS: Array<[SidebarSortBy, string]> = [
  ['native', 'Native order'],
  ['active', 'Last active'],
  ['created', 'Newest first'],
];

/**
 * Reorder grouped sidebar threads by last activity or creation time. Sections and groups
 * move too, ordered by their newest thread; headless pinned rows stay on top.
 */
export function sortSidebarGroups(groups: TopGroup[], sortBy: SidebarSortBy): TopGroup[] {
  if (sortBy === 'native') return groups;
  const key = (s: UnifiedSession) => (sortBy === 'active' ? s.updatedAt : s.createdAt) || 0;
  const sortItems = (items: UnifiedSession[]) => [...items].sort((a, b) => key(b) - key(a));
  const newest = (items: UnifiedSession[]) => items.reduce((m, s) => Math.max(m, key(s)), 0);

  const sorted = groups.map((g) => {
    const sections = g.sections
      ?.map((sec) => ({ ...sec, items: sortItems(sec.items) }))
      .sort((a, b) => newest(b.items) - newest(a.items));
    return {
      ...g,
      items: g.items ? sortItems(g.items) : undefined,
      pinnedItems: g.pinnedItems ? sortItems(g.pinnedItems) : undefined,
      sections,
    };
  });
  const groupNewest = (g: TopGroup) =>
    Math.max(
      newest(g.items ?? []),
      newest(g.pinnedItems ?? []),
      ...(g.sections ?? []).map((sec) => newest(sec.items))
    );
  const headless = sorted.filter((g) => g.headless);
  const rest = sorted.filter((g) => !g.headless).sort((a, b) => groupNewest(b) - groupNewest(a));
  return [...headless, ...rest];
}

/**
 * Short badge for the machine a session runs on: the last octet of an IPv4 address
 * (`192.168.0.3` -> `.3`), otherwise the first label of the host name.
 */
export function hostBadgeLabel(address: string | undefined): string | undefined {
  if (!address) return undefined;
  const host = address.replace(/^.*@/, '');
  const v4 = host.match(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.(\d{1,3})$/);
  if (v4) return `.${v4[1]}`;
  return host.split('.')[0].slice(0, 8);
}
