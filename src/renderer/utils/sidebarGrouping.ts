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
  | 'muse'
  | 'pi';

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
    filter === 'muse' ||
    filter === 'pi'
  );
}

const HARNESS_DEFS: Array<{ id: HarnessGroup; label: string }> = [
  { id: 'antigravity', label: 'Antigravity' },
  { id: 'codex', label: 'Codex' },
  { id: 'claude', label: 'Claude' },
  { id: 'muse', label: 'Muse' },
  { id: 'pi', label: 'Pi' },
];

/** Default harness order; lxe can rearrange it (settings.harnessOrder). */
export const DEFAULT_HARNESS_ORDER: HarnessGroup[] = HARNESS_DEFS.map((d) => d.id);

/** A saved order made complete: known harnesses once each, missing ones appended in default order. */
export function normalizeHarnessOrder(order?: readonly string[] | null): HarnessGroup[] {
  const known = new Set<string>(DEFAULT_HARNESS_ORDER);
  const seen = new Set<string>();
  const out: HarnessGroup[] = [];
  for (const h of order ?? []) {
    if (known.has(h) && !seen.has(h)) {
      seen.add(h);
      out.push(h as HarnessGroup);
    }
  }
  for (const h of DEFAULT_HARNESS_ORDER) if (!seen.has(h)) out.push(h);
  return out;
}

/** Order after dragging `dragged` onto `target`'s position. */
export function moveHarness(order: readonly HarnessGroup[], dragged: HarnessGroup, target: HarnessGroup): HarnessGroup[] {
  const full = normalizeHarnessOrder(order);
  const from = full.indexOf(dragged);
  const to = full.indexOf(target);
  if (from < 0 || to < 0 || from === to) return full;
  const next = full.filter((h) => h !== dragged);
  next.splice(to, 0, dragged);
  return next;
}

function orderedHarnessDefs(order?: readonly string[] | null): Array<{ id: HarnessGroup; label: string }> {
  const byId = new Map(HARNESS_DEFS.map((d) => [d.id, d]));
  return normalizeHarnessOrder(order).map((id) => byId.get(id)!);
}

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
    if (filter === 'pi' && s.harnessGroup !== 'pi') return false;
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
  filter: SidebarFilterTab,
  harnessOrder?: readonly string[] | null
): TopGroup[] {
  const harnessDefs = orderedHarnessDefs(harnessOrder);
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
      filter === 'muse' ||
      filter === 'pi'
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
    for (const h of harnessDefs) {
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
    return harnessDefs.map((d) => {
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
  const sortItems = (items: UnifiedSession[]) =>
    [...items].sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
      return key(b) - key(a);
    });
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
  const rest = sorted.filter((g) => !g.headless);
  // Top-level harness sections always match the user's saved harness gauge order.
  const isHarnessTopLevel = rest.length > 0 && rest.every((g) => Boolean(g.harnessLogo));
  const orderedRest = isHarnessTopLevel
    ? rest
    : [...rest].sort((a, b) => groupNewest(b) - groupNewest(a));
  return [...headless, ...orderedRest];
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
