import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canDropSessionIntoSection,
  groupSessionsForSidebar,
} from '../src/renderer/utils/sidebarGrouping';
import type { UnifiedSession } from '../src/shared/types';

function makeSession(overrides: Partial<UnifiedSession>): UnifiedSession {
  return {
    id: 'codex:1',
    nativeId: '1',
    harness: 'codex',
    harnessGroup: 'codex',
    title: 'Sample chat',
    preview: 'Sample',
    cwd: '/tmp/proj',
    projectName: 'proj',
    nativeSection: 'Alpha',
    nativeSectionOrder: 10,
    status: 'idle',
    isLive: false,
    isRemote: false,
    createdAt: 1000,
    updatedAt: 2000,
    pinned: false,
    folderId: null,
    tags: [],
    hidden: false,
    dispatchMode: 'codex-exec',
    ...overrides,
  };
}

describe('Sidebar section drag-and-drop restrictions', () => {
  it('allows dragging a chat between sections within the same editor/harness only', () => {
    const codexChat = makeSession({
      id: 'codex:a',
      harness: 'codex',
      harnessGroup: 'codex',
      nativeSection: 'Orble',
    });

    // Allowed: different section in the same harness (Codex)
    expect(
      canDropSessionIntoSection(codexChat, {
        kind: 'native-section',
        harnessGroup: 'codex',
        sectionLabel: 'DSX',
        sectionOrder: 20,
      })
    ).toBe(true);

    // Blocked: same section in the same harness (no-op)
    expect(
      canDropSessionIntoSection(codexChat, {
        kind: 'native-section',
        harnessGroup: 'codex',
        sectionLabel: 'Orble',
        sectionOrder: 10,
      })
    ).toBe(false);

    // Blocked: different editor/harness (Claude or Antigravity)
    expect(
      canDropSessionIntoSection(codexChat, {
        kind: 'native-section',
        harnessGroup: 'claude',
        sectionLabel: 'Orble',
        sectionOrder: 10,
      })
    ).toBe(false);
    expect(
      canDropSessionIntoSection(codexChat, {
        kind: 'native-section',
        harnessGroup: 'antigravity',
        sectionLabel: 'DSX',
        sectionOrder: 10,
      })
    ).toBe(false);
  });

  it('allows dragging a natively pinned chat into a section of its own harness', () => {
    const pinnedClaude = makeSession({
      id: 'claude:p1',
      harness: 'claude-desktop',
      harnessGroup: 'claude',
      nativeSection: 'Orble',
      pinned: true,
    });

    expect(
      canDropSessionIntoSection(pinnedClaude, {
        kind: 'native-section',
        harnessGroup: 'claude',
        sectionLabel: 'Orble',
      })
    ).toBe(true);

    expect(
      canDropSessionIntoSection(pinnedClaude, {
        kind: 'native-section',
        harnessGroup: 'codex',
        sectionLabel: 'Orble',
      })
    ).toBe(false);
  });

  it('tags every native sidebar section with its owning harnessGroup in both All and single-harness views', () => {
    const sessions = [
      makeSession({ id: 'codex:1', harness: 'codex', harnessGroup: 'codex', nativeSection: 'DSX' }),
      makeSession({
        id: 'claude:1',
        harness: 'claude-desktop',
        harnessGroup: 'claude',
        nativeSection: 'Orble',
      }),
      makeSession({
        id: 'antigravity:1',
        harness: 'antigravity',
        harnessGroup: 'antigravity',
        nativeSection: 'agent-sandbox',
      }),
    ];

    const allGroups = groupSessionsForSidebar(sessions, 'native', [], 'all');
    for (const grp of allGroups) {
      expect(grp.harnessLogo).toBeTruthy();
      for (const sec of grp.sections ?? []) {
        expect(sec.harnessGroup).toBe(grp.harnessLogo);
      }
    }

    const codexOnly = groupSessionsForSidebar(
      sessions.filter((s) => s.harnessGroup === 'codex'),
      'native',
      [],
      'codex'
    );
    expect(codexOnly[0]?.harnessGroup).toBe('codex');
    expect(codexOnly[0]?.label).toBe('DSX');
  });

  it('keeps section headers free of chat counts, hover-reveals the plus button, and avoids Wayland-hanging HTML5 DnD', () => {
    const sidebarSrc = fs.readFileSync(
      path.resolve(__dirname, '../src/renderer/components/Sidebar.tsx'),
      'utf8'
    );
    const listRowSrc = fs.readFileSync(
      path.resolve(__dirname, '../src/renderer/ui/ListRow.tsx'),
      'utf8'
    );

    expect(sidebarSrc).not.toMatch(/count=\{totalInGroup\}/);
    expect(sidebarSrc).not.toMatch(/count=\{sec\.items\.length\}/);
    expect(listRowSrc).toContain('opacity-0 pointer-events-none group-hover:opacity-100');

    // Never use native HTML5 draggable/onDragStart in Sidebar (hangs Chromium/Electron Ozone Wayland)
    expect(sidebarSrc).not.toMatch(/\bdraggable\s*=/);
    expect(sidebarSrc).not.toMatch(/\bonDragStart\s*=/);
    expect(sidebarSrc).toContain('onPointerDown');
    expect(sidebarSrc).toContain('data-drop-section-id');
    expect(sidebarSrc).toContain('if (e.buttons === 0)');
  });
});

describe('Project view coalescing across harnesses', () => {
  it('merges same-named sections from different harnesses and a matching cwd project into one group', () => {
    const agy = makeSession({
      id: 'antigravity:a',
      harness: 'antigravity',
      harnessGroup: 'antigravity',
      cwd: '/home/lxe',
      projectName: 'Antigravity',
      nativeSection: 'bluebubbles-native',
      updatedAt: 3000,
    });
    const codex = makeSession({
      id: 'codex:b',
      cwd: '/home/lxe',
      projectName: 'Home (~)',
      nativeSection: 'bluebubbles-native',
      updatedAt: 2500,
    });
    // A future session started in ~/bluebubbles-native with no section of its own.
    const claude = makeSession({
      id: 'claude:c',
      harness: 'claude',
      harnessGroup: 'claude',
      cwd: '/home/lxe/bluebubbles-native',
      projectName: 'BlueBubbles_Native',
      nativeSection: 'Ungrouped',
      updatedAt: 2000,
    });
    const other = makeSession({ id: 'codex:d', projectName: 'elsewhere', nativeSection: undefined });

    const groups = groupSessionsForSidebar([agy, codex, claude, other], 'project', [], 'all');
    const bb = groups.filter((g) => g.label.toLowerCase().includes('bluebubbles'));
    expect(bb).toHaveLength(1);
    expect(bb[0].label).toBe('bluebubbles-native');
    expect(bb[0].items?.map((s) => s.id)).toEqual(['antigravity:a', 'codex:b', 'claude:c']);
    expect(groups.find((g) => g.label === 'elsewhere')?.items?.map((s) => s.id)).toEqual(['codex:d']);
  });
});
