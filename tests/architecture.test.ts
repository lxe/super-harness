import { describe, expect, it, vi } from 'vitest';
import type { SessionFolder, UnifiedSession } from '../src/shared/types';
import {
  createDisabledDetection,
  createUniqueIdGenerator,
  formatPromptWithImagePaths,
  type HarnessDriver,
} from '../src/main/adapters/types';
import { HarnessRegistry } from '../src/main/adapters/registry';
import type { ConfigStore } from '../src/main/store/configStore';
import {
  filterSidebarSessions,
  flattenVisibleSessions,
  getGlobalPinnedSessions,
  groupSessionsForSidebar,
} from '../src/renderer/utils/sidebarGrouping';

function makeSession(overrides: Partial<UnifiedSession>): UnifiedSession {
  return {
    id: 'codex:1',
    nativeId: '1',
    harness: 'codex',
    harnessGroup: 'codex',
    title: 'Sample session',
    preview: 'Sample',
    cwd: '/tmp/app',
    projectName: 'app',
    status: 'idle',
    isLive: false,
    isRemote: false,
    createdAt: 1000,
    updatedAt: 2000,
    pinned: false,
    folderId: null,
    tags: [],
    hidden: false,
    dispatchMode: 'codex-resume',
    ...overrides,
  };
}

describe('HarnessDriver shared utilities & registry delegation', () => {
  it('createUniqueIdGenerator deduplicates repeated IDs deterministically', () => {
    const uid = createUniqueIdGenerator();
    expect(uid('step-1')).toBe('step-1');
    expect(uid('step-1')).toBe('step-1-2');
    expect(uid('step-1')).toBe('step-1-3');
    expect(uid('step-2')).toBe('step-2');
  });

  it('formatPromptWithImagePaths handles empty prompt, text-only, and attached images', () => {
    expect(formatPromptWithImagePaths('hello')).toBe('hello');
    expect(
      formatPromptWithImagePaths('look here', [
        { id: '1', name: 'a.png', path: '/tmp/a.png', mimeType: 'image/png', previewDataUrl: '' },
      ])
    ).toBe('[Attached image: /tmp/a.png]\n\nlook here');
    expect(
      formatPromptWithImagePaths('', [
        { id: '1', name: 'a.png', path: '/tmp/a.png', mimeType: 'image/png', previewDataUrl: '' },
      ])
    ).toContain('Please inspect the attached image(s).');
  });

  it('HarnessRegistry delegates discovery & cached transcript reads generically to injected HarnessDrivers', async () => {
    const sample = makeSession({ id: 'codex:mock-1', nativeId: 'mock-1', title: 'Mock thread' });
    const loadTranscript = vi.fn(async () => ({
      sessionId: sample.id,
      messages: [
        { id: 'm1', role: 'user' as const, timestamp: 1, blocks: [{ type: 'text' as const, text: 'hi' }] },
      ],
      totalCount: 1,
      hasMore: false,
      sourceMtimeMs: 999,
    }));

    const mockDriver: HarnessDriver = {
      id: 'codex',
      displayName: 'Mock Codex',
      detect: vi.fn(async () => ({
        detection: { ...createDisabledDetection('codex', 'Mock Codex'), installed: true },
        sessions: [sample],
      })),
      getTranscriptFingerprint: vi.fn(async () => 'fp-v1'),
      loadTranscript,
      getGlobalWatchDirs: () => [],
      getSessionWatchFiles: () => [],
      sendMessage: async () => ({ ok: true }),
      startSession: async () => ({ ok: true }),
      controlDaemon: async () => ({ ok: true }),
      archiveSession: async () => null,
    };

    const fakeStore = {
      getMasterNativeIds: () => new Set<string>(),
      getState: () => ({
        version: 1,
        folders: [],
        overrides: {},
        masterMessages: [],
        settings: {
          maxSessionsPerHarness: 50,
          showArchived: false,
          showHidden: false,
          enabledHarnesses: { codex: true, claude: false, antigravity: false },
          master: { harness: 'claude', cwd: '/tmp', model: '' },
          sidebarGroupBy: 'native',
          pollIntervalMs: 5000,
          defaultNewSessionCwd: '/tmp',
          apps: {},
        },
      }),
    } as unknown as ConfigStore;

    const registry = new HarnessRegistry(fakeStore, [mockDriver]);
    const { harnesses, sessions } = await registry.discover();

    expect(harnesses).toHaveLength(1);
    expect(sessions.map((s) => s.id)).toEqual(['master:root', 'codex:mock-1']);

    // Two transcript reads with same fingerprint -> driver invoked only ONCE
    const t1 = await registry.getTranscript('codex:mock-1', 40);
    const t2 = await registry.getTranscript('codex:mock-1', 40);
    expect(t1).toBe(t2);
    expect(loadTranscript).toHaveBeenCalledTimes(1);

    // After invalidation -> reloads cleanly
    registry.invalidateTranscriptCache('codex:mock-1');
    await registry.getTranscript('codex:mock-1', 40);
    expect(loadTranscript).toHaveBeenCalledTimes(2);
  });
});

describe('sidebarGrouping pure logic', () => {
  const sessions: UnifiedSession[] = [
    makeSession({
      id: 'antigravity:a1',
      harness: 'antigravity',
      harnessGroup: 'antigravity',
      title: 'Pinned chat',
      pinnedToTop: true,
      updatedAt: 5000,
    }),
    makeSession({
      id: 'codex:c0',
      harness: 'codex',
      harnessGroup: 'codex',
      title: 'Codex Native Pin',
      projectName: 'api',
      nativeSection: 'api',
      pinned: true,
      updatedAt: 4500,
    }),
    makeSession({
      id: 'codex:c1',
      harness: 'codex',
      harnessGroup: 'codex',
      title: 'Backend API',
      projectName: 'api',
      nativeSection: 'api',
      nativeSectionOrder: 10,
      updatedAt: 4000,
    }),
    makeSession({
      id: 'claude-tmux:t1',
      harness: 'claude-tmux',
      harnessGroup: 'claude',
      title: 'UI Polish',
      projectName: 'web',
      nativeSection: 'Ungrouped',
      folderId: 'f1',
      isLive: true,
      updatedAt: 3000,
    }),
  ];

  const folders: SessionFolder[] = [{ id: 'f1', name: 'Sprint', createdAt: 1 }];

  it('filters by harness tab, live flag, and search query', () => {
    expect(filterSidebarSessions(sessions, 'all', '')).toHaveLength(4);
    expect(filterSidebarSessions(sessions, 'live', '').map((s) => s.id)).toEqual(['claude-tmux:t1']);
    expect(filterSidebarSessions(sessions, 'codex', '').map((s) => s.id)).toEqual([
      'codex:c0',
      'codex:c1',
    ]);
    expect(filterSidebarSessions(sessions, 'all', 'backend').map((s) => s.id)).toEqual(['codex:c1']);
  });

  it('extracts global pinned chats across all harnesses and keeps native pins flat below each harness header', () => {
    const globalPins = getGlobalPinnedSessions(sessions);
    expect(globalPins.map((s) => s.id)).toEqual(['antigravity:a1']);

    // Tree excludes global top-pinned chats (rendered above the harness switcher)
    const groupsAll = groupSessionsForSidebar(sessions, 'native', folders, 'all');
    expect(groupsAll.map((g) => g.id)).toEqual(['harness:codex', 'harness:claude']);
    // Codex native pin lives in pinnedItems directly below the Codex separator (no extra Pinned section)
    expect(groupsAll[0].pinnedItems?.map((s) => s.id)).toEqual(['codex:c0']);
    expect(groupsAll[0].sections?.map((s) => s.label)).toEqual(['api']);

    // Single-harness tab promotes native pins to a headless flat strip at the top
    const codexOnly = groupSessionsForSidebar(
      filterSidebarSessions(sessions, 'codex', ''),
      'native',
      folders,
      'codex'
    );
    expect(codexOnly[0].headless).toBe(true);
    expect(codexOnly[0].items?.map((s) => s.id)).toEqual(['codex:c0']);
    expect(codexOnly[1].label).toBe('api');
    expect(codexOnly[1].items?.map((s) => s.id)).toEqual(['codex:c1']);
  });

  it('supports folders, project, harness, and recent groupings + collapsed flattening', () => {
    const globalPins = getGlobalPinnedSessions(sessions);
    const byFolders = groupSessionsForSidebar(sessions, 'folders', folders, 'all');
    expect(byFolders.map((g) => g.label)).toEqual(['Pinned', 'Sprint', 'Conversations']);
    expect(byFolders[0].headless).toBe(true);

    const byProject = groupSessionsForSidebar(sessions, 'project', folders, 'all');
    expect(byProject.map((g) => g.label)).toEqual(['api', 'web']);

    // Flattening prepends global pins and skips collapsed groups
    const visibleAll = flattenVisibleSessions(byFolders, {}, globalPins);
    expect(visibleAll.map((s) => s.id)).toEqual([
      'antigravity:a1',
      'codex:c0',
      'claude-tmux:t1',
      'codex:c1',
    ]);

    const visibleCollapsed = flattenVisibleSessions(byFolders, { f1: true }, globalPins);
    expect(visibleCollapsed.map((s) => s.id)).toEqual(['antigravity:a1', 'codex:c0', 'codex:c1']);
  });
});
