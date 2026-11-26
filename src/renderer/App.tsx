import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  HarnessCatalog,
  HarnessDetection,
  OrganizeAction,
  QueuedMessageItem,
  SidebarGroupBy,
  StartSessionRequest,
  SuperHarnessSettings,
  SuperHarnessState,
  UnifiedSession,
  UsageSnapshot,
} from '../shared/types';
import { DraftSessionPane, type DraftConversation } from './components/DraftSessionPane';
import { FilePreviewDrawer, type PreviewTarget } from './components/FilePreviewDrawer';
import { SessionPane, type ComposerDraft } from './components/SessionPane';
import { SettingsModal } from './components/SettingsModal';
import { Sidebar, type SidebarFilterTab } from './components/Sidebar';
import {
  DEFAULT_TRANSCRIPT_LIMIT,
  prefetchSessionTranscript,
  rendererTranscriptCache,
} from './utils/transcriptCache';

const EMPTY_DRAFT: ComposerDraft = { text: '', attachments: [] };
const EMPTY_QUEUE: QueuedMessageItem[] = [];

export const App: React.FC = () => {
  const [harnesses, setHarnesses] = useState<HarnessDetection[]>([]);
  const [sessions, setSessions] = useState<UnifiedSession[]>([]);
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [catalog, setCatalog] = useState<HarnessCatalog | null>(null);
  const [state, setState] = useState<SuperHarnessState | null>(null);
  const [controlPort, setControlPort] = useState(0);

  const [activeSessionId, setActiveSessionId] = useState<string>('master:root');
  const [splitSessionId, setSplitSessionId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, ComposerDraft>>({});
  const [queuedBySession, setQueuedBySession] = useState<Record<string, QueuedMessageItem[]>>({});
  const [draftConversations, setDraftConversations] = useState<DraftConversation[]>([]);
  const [pendingSessions, setPendingSessions] = useState<Record<string, UnifiedSession>>({});
  const [toast, setToast] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [streamingIds, setStreamingIds] = useState<Set<string>>(() => new Set());
  const [liveWorkingMap, setLiveWorkingMap] = useState<Record<string, boolean>>({});

  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem('sh:sidebarWidth'));
      if (Number.isFinite(saved) && saved >= 240 && saved <= 560) return saved;
    } catch {
      // ignore
    }
    return 312;
  });
  const [resizingSidebar, setResizingSidebar] = useState(false);

  useEffect(() => {
    if (!resizingSidebar) return;
    const onMove = (e: MouseEvent) => {
      const clamped = Math.max(240, Math.min(560, e.clientX));
      setSidebarWidth(clamped);
    };
    const onUp = () => {
      setResizingSidebar(false);
      try {
        localStorage.setItem('sh:sidebarWidth', String(sidebarWidth));
      } catch {
        // ignore
      }
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [resizingSidebar, sidebarWidth]);

  const [showSettings, setShowSettings] = useState(false);
  const [previewTarget, setPreviewTarget] = useState<PreviewTarget | null>(null);

  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let mounted = true;
    void window.superHarness.getBootstrap().then((boot) => {
      if (!mounted) return;
      setHarnesses(boot.harnesses);
      setSessions(boot.sessions);
      setState(boot.state);
      setControlPort(boot.controlPort);
      // Auto-select first live non-master session in split if user has active harnesses, keep Master primary
      const firstLive = boot.sessions.find((s) => s.harness !== 'master' && !s.isSubagent && s.isLive);
      if (firstLive) {
        setActiveSessionId(firstLive.id);
      }

      // Gently warm top pinned/live conversations in the background after initial paint
      const warmCandidates = boot.sessions
        .filter((s) => s.harness !== 'master' && !s.isSubagent && s.id !== firstLive?.id)
        .sort((a, b) => {
          if (Boolean(a.pinnedToTop) !== Boolean(b.pinnedToTop)) return a.pinnedToTop ? -1 : 1;
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
          return b.updatedAt - a.updatedAt;
        })
        .slice(0, 4);

      warmCandidates.forEach((s, idx) => {
        window.setTimeout(() => {
          if (mounted) prefetchSessionTranscript(s.id);
        }, 350 + idx * 140);
      });
    });

    void window.superHarness.getUsage().then((snap) => {
      if (mounted) setUsage(snap);
    });
    void window.superHarness.getHarnessCatalog().then((cat) => {
      if (mounted) setCatalog(cat);
    });

    const offSessions = window.superHarness.onSessionsUpdated((payload) => {
      setHarnesses(payload.harnesses);
      setSessions(payload.sessions);
      setLiveWorkingMap({});
    });
    const offState = window.superHarness.onStateChanged((next) => {
      setState(next);
    });
    const offUsage = window.superHarness.onUsageUpdated((snap) => {
      setUsage(snap);
    });
    const offStream = window.superHarness.onStreamEvent((ev) => {
      if (ev.kind === 'start' || ev.kind === 'delta' || ev.kind === 'block') {
        setStreamingIds((prev) => {
          if (prev.has(ev.sessionId)) return prev;
          const next = new Set(prev);
          next.add(ev.sessionId);
          return next;
        });
      } else if (ev.kind === 'done' || ev.kind === 'error') {
        setStreamingIds((prev) => {
          if (!prev.has(ev.sessionId)) return prev;
          const next = new Set(prev);
          next.delete(ev.sessionId);
          return next;
        });
      }
    });
    const offTranscript = window.superHarness.onTranscriptUpdated((res) => {
      if (typeof res.liveActivity?.isWorking === 'boolean') {
        setLiveWorkingMap((prev) => {
          if (prev[res.sessionId] === res.liveActivity!.isWorking) return prev;
          return { ...prev, [res.sessionId]: res.liveActivity!.isWorking };
        });
      }
    });

    return () => {
      mounted = false;
      offSessions();
      offState();
      offUsage();
      offStream();
      offTranscript();
    };
  }, []);

  const handleCreateDraftConversation = useCallback(
    (activeFilter?: SidebarFilterTab, opts?: { cwd?: string }) => {
      const f =
        activeFilter ??
        ((localStorage.getItem('sh:sidebarFilter') as SidebarFilterTab | null) || 'all');
      const preselectedHarness: StartSessionRequest['harness'] | null =
        f === 'antigravity'
          ? 'antigravity'
          : f === 'codex'
            ? 'codex'
            : f === 'claude' || f === 'tmux'
              ? 'claude-tmux'
              : null;

      const defaultCwd = opts?.cwd?.trim() || state?.settings.defaultNewSessionCwd || '~';
      const newDraft: DraftConversation = {
        id: `draft:${Date.now()}`,
        harness: preselectedHarness,
        cwd: defaultCwd,
        model: '',
        reasoningEffort: '',
        remoteControl: true,
        prompt: '',
        createdAt: Date.now(),
      };
      setDraftConversations((prev) => [newDraft, ...prev]);
      setActiveSessionId(newDraft.id);
    },
    [state?.settings.defaultNewSessionCwd]
  );

  const handleUpdateDraftConversation = useCallback(
    (draftId: string, patch: Partial<DraftConversation>) => {
      setDraftConversations((prev) =>
        prev.map((d) => (d.id === draftId ? { ...d, ...patch } : d))
      );
    },
    []
  );

  const handleDiscardDraftConversation = useCallback(
    (draftId: string) => {
      setDraftConversations((prev) => prev.filter((d) => d.id !== draftId));
      if (activeSessionId === draftId) {
        const next = sessions.find((s) => s.harness !== 'master' && !s.isSubagent);
        setActiveSessionId(next?.id || 'master:root');
      }
    },
    [activeSessionId, sessions]
  );

  const handleQueueChange = useCallback(
    (
      sessionId: string,
      updater: QueuedMessageItem[] | ((prev: QueuedMessageItem[]) => QueuedMessageItem[])
    ) => {
      setQueuedBySession((prev) => {
        const current = prev[sessionId] ?? EMPTY_QUEUE;
        const next = typeof updater === 'function' ? updater(current) : updater;
        return { ...prev, [sessionId]: next };
      });
    },
    []
  );

  // Global keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (mod && e.key === ',') {
        e.preventDefault();
        setShowSettings((v) => !v);
      } else if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        handleCreateDraftConversation();
      } else if (mod && e.key === '\\') {
        e.preventDefault();
        setSplitSessionId((prev) => (prev ? null : 'master:root'));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleCreateDraftConversation]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await window.superHarness.refreshDiscovery();
      setHarnesses(res.harnesses);
      setSessions(res.sessions);
    } finally {
      setRefreshing(false);
    }
  }, []);

  const handleOrganize = useCallback(async (actions: OrganizeAction[]) => {
    const next = await window.superHarness.organize(actions);
    setState(next);
  }, []);

  const handleUpdateSettings = useCallback(async (patch: Partial<SuperHarnessSettings>) => {
    const next = await window.superHarness.updateSettings(patch);
    setState(next);
  }, []);

  const handleChangeGroupBy = useCallback(
    (g: SidebarGroupBy) => {
      void handleUpdateSettings({ sidebarGroupBy: g });
    },
    [handleUpdateSettings]
  );

  const handleClearMaster = useCallback(async () => {
    const next = await window.superHarness.clearMasterHistory();
    setState(next);
  }, []);

  const handleDraftChange = useCallback(
    (
      sessionId: string,
      updater: ComposerDraft | ((prev: ComposerDraft) => ComposerDraft)
    ) => {
      setDrafts((prev) => {
        const current = prev[sessionId] ?? EMPTY_DRAFT;
        const next = typeof updater === 'function' ? updater(current) : updater;
        return { ...prev, [sessionId]: next };
      });
    },
    []
  );

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => {
      setToast((cur) => (cur === msg ? null : cur));
    }, 2800);
  }, []);

  const handleArchiveSession = useCallback(
    async (session: UnifiedSession, killTmux = false) => {
      const res = await window.superHarness.archiveSession(session.id, { killTmux });
      if (res.ok) {
        showToast(`Archived "${session.title}" (${res.method || 'done'})`);
        if (activeSessionId === session.id) {
          const next = sessions.find(
            (s) => s.id !== session.id && !s.isSubagent && s.harness !== 'master'
          );
          setActiveSessionId(next?.id || 'master:root');
        }
        if (splitSessionId === session.id) {
          setSplitSessionId(null);
        }
      } else {
        showToast(`Archive failed: ${res.error || 'unknown error'}`);
      }
    },
    [activeSessionId, splitSessionId, sessions, showToast]
  );

  const handleArchiveMany = useCallback(
    async (targets: UnifiedSession[], killTmux = false) => {
      if (targets.length === 0) return;
      if (targets.length === 1) {
        await handleArchiveSession(targets[0], killTmux);
        return;
      }
      const targetIds = new Set(targets.map((t) => t.id));
      if (targetIds.has(activeSessionId)) {
        const next = sessions.find(
          (s) => !targetIds.has(s.id) && !s.isSubagent && s.harness !== 'master'
        );
        setActiveSessionId(next?.id || 'master:root');
      }
      if (splitSessionId && targetIds.has(splitSessionId)) {
        setSplitSessionId(null);
      }

      showToast(`Archiving ${targets.length} sessions…`);
      // Serialize Codex CLI archive calls to avoid SQLite write lock contention;
      // run non-Codex archives in small batches.
      const results: Array<{ ok: boolean }> = [];
      const codexTargets = targets.filter((t) => t.harness === 'codex');
      const otherTargets = targets.filter((t) => t.harness !== 'codex');

      for (const t of codexTargets) {
        results.push(await window.superHarness.archiveSession(t.id, { killTmux }));
      }
      for (let i = 0; i < otherTargets.length; i += 4) {
        const batch = otherTargets.slice(i, i + 4);
        const batchRes = await Promise.all(
          batch.map((t) => window.superHarness.archiveSession(t.id, { killTmux }))
        );
        results.push(...batchRes);
      }

      const okCount = results.filter((r) => r.ok).length;
      const failCount = results.length - okCount;
      showToast(
        failCount > 0
          ? `Archived ${okCount}/${results.length} sessions (${failCount} failed)`
          : `Archived ${okCount} sessions`
      );
      void handleRefresh();
    },
    [activeSessionId, splitSessionId, sessions, handleArchiveSession, showToast, handleRefresh]
  );

  const handleOpenPath = useCallback(
    async (
      filePath: string,
      opts?: {
        startLine?: number;
        endLine?: number;
        mode?: 'auto' | 'internal' | 'editor' | 'file-manager' | 'terminal';
        tmuxSession?: string;
      }
    ) => {
      const mode = opts?.mode ?? 'auto';
      const res = await window.superHarness.openPath(filePath, mode, {
        line: opts?.startLine,
        tmuxSession: opts?.tmuxSession,
      });
      if (!res.ok) {
        showToast(res.error || `Could not open ${filePath}`);
        return;
      }
      if (res.action === 'internal') {
        setPreviewTarget({
          path: filePath,
          startLine: opts?.startLine,
          endLine: opts?.endLine,
        });
      }
    },
    [showToast]
  );

  // Prune optimistic pending sessions as soon as real discovery picks them up
  useEffect(() => {
    setPendingSessions((prev) => {
      const keys = Object.keys(prev);
      if (keys.length === 0) return prev;
      let changed = false;
      const next: Record<string, UnifiedSession> = {};
      const now = Date.now();
      for (const id of keys) {
        const p = prev[id];
        const discovered = sessions.some(
          (s) => s.id === p.id || (p.nativeId && s.nativeId === p.nativeId)
        );
        if (discovered || now - p.createdAt > 90_000) {
          changed = true;
        } else {
          next[id] = p;
        }
      }
      return changed ? next : prev;
    });
  }, [sessions]);

  const effectiveSessions = useMemo(() => {
    const merged: UnifiedSession[] = [];
    for (const p of Object.values(pendingSessions)) {
      if (!sessions.some((s) => s.id === p.id || (p.nativeId && s.nativeId === p.nativeId))) {
        merged.push(p);
      }
    }
    for (const s of sessions) {
      if (streamingIds.has(s.id)) {
        merged.push(
          s.status === 'running' ? s : { ...s, status: 'running' as const, isLive: true }
        );
        continue;
      }
      const liveOverride = liveWorkingMap[s.id];
      if (liveOverride === true && s.status !== 'running') {
        merged.push({ ...s, status: 'running' as const, isLive: true });
        continue;
      }
      if (liveOverride === false && s.status === 'running') {
        merged.push({ ...s, status: 'idle' as const });
        continue;
      }
      merged.push(s);
    }
    return merged;
  }, [sessions, pendingSessions, streamingIds, liveWorkingMap]);

  const findSessionResilient = useCallback(
    (list: UnifiedSession[], id: string | null): UnifiedSession | undefined => {
      if (!id) return undefined;
      const exact = list.find((s) => s.id === id);
      if (exact) return exact;
      // Fallback by nativeId so a session never drops out of view if its harness variant changes
      const colonIdx = id.indexOf(':');
      if (colonIdx > 0) {
        const nativeId = id.slice(colonIdx + 1);
        if (nativeId) return list.find((s) => s.nativeId === nativeId);
      }
      return undefined;
    },
    []
  );

  const activeSession = useMemo(
    () => findSessionResilient(effectiveSessions, activeSessionId),
    [effectiveSessions, activeSessionId, findSessionResilient]
  );

  const splitSession = useMemo(
    () => findSessionResilient(effectiveSessions, splitSessionId),
    [effectiveSessions, splitSessionId, findSessionResilient]
  );

  const activeSubagents = useMemo(
    () =>
      activeSession
        ? effectiveSessions.filter((s) => s.isSubagent && s.parentSessionId === activeSession.id)
        : [],
    [effectiveSessions, activeSession]
  );

  const splitSubagents = useMemo(
    () =>
      splitSession
        ? effectiveSessions.filter((s) => s.isSubagent && s.parentSessionId === splitSession.id)
        : [],
    [effectiveSessions, splitSession]
  );

  const activeDraft = useMemo(
    () => draftConversations.find((d) => d.id === activeSessionId),
    [draftConversations, activeSessionId]
  );

  const handleSelectSession = useCallback((id: string) => {
    setActiveSessionId(id);
  }, []);

  const handleOpenInSplit = useCallback((id: string) => {
    setSplitSessionId(id);
  }, []);

  const handleOpenSettings = useCallback(() => {
    setShowSettings(true);
  }, []);

  const handleCloseSplit = useCallback(() => {
    setSplitSessionId(null);
  }, []);

  const handleRefreshCatalog = useCallback(() => {
    void window.superHarness.getHarnessCatalog(true).then((cat) => {
      setCatalog(cat);
    });
  }, []);

  const handleToggleSplitPrimary = useCallback(() => {
    setSplitSessionId((prev) => {
      if (prev) return null;
      return activeSessionId === 'master:root'
        ? sessions.find((s) => s.harness !== 'master' && !s.isSubagent)?.id ?? null
        : 'master:root';
    });
  }, [activeSessionId, sessions]);

  const folders = state?.folders ?? [];
  const masterMessages = state?.masterMessages ?? [];

  return (
    <div className="h-screen w-screen flex overflow-hidden bg-surface-canvas text-ink-primary">
      <Sidebar
        width={sidebarWidth}
        harnesses={harnesses}
        sessions={effectiveSessions}
        draftConversations={draftConversations}
        usage={usage}
        folders={folders}
        groupBy={state?.settings.sidebarGroupBy ?? 'native'}
        activeSessionId={activeSessionId}
        splitSessionId={splitSessionId}
        searchInputRef={searchInputRef}
        refreshing={refreshing}
        onSelectSession={handleSelectSession}
        onOpenInSplit={handleOpenInSplit}
        onNewSession={handleCreateDraftConversation}
        onDiscardDraft={handleDiscardDraftConversation}
        onOpenSettings={handleOpenSettings}
        onRefresh={handleRefresh}
        onChangeGroupBy={handleChangeGroupBy}
        onOrganize={handleOrganize}
        onArchiveSession={handleArchiveSession}
        onArchiveMany={handleArchiveMany}
      />

      {/* Draggable sidebar resize handle */}
      <div
        onMouseDown={() => setResizingSidebar(true)}
        onDoubleClick={() => {
          setSidebarWidth(312);
          try {
            localStorage.setItem('sh:sidebarWidth', '312');
          } catch {
            // ignore
          }
        }}
        title="Drag to resize sidebar (double-click to reset)"
        className={`w-1.5 -ml-0.5 shrink-0 cursor-col-resize transition-colors z-20 ${
          resizingSidebar ? 'bg-zinc-400/50' : 'bg-transparent hover:bg-white/[0.14]'
        }`}
      />

      <main className="flex-1 min-w-0 h-full flex relative">
        {activeDraft ? (
          <DraftSessionPane
            draft={activeDraft}
            catalog={catalog}
            onRefreshCatalog={handleRefreshCatalog}
            onUpdateDraft={(patch) => handleUpdateDraftConversation(activeDraft.id, patch)}
            onDiscard={() => handleDiscardDraftConversation(activeDraft.id)}
            onLaunched={(newSid) => {
              const launchedDraft = activeDraft;
              setDraftConversations((prev) => prev.filter((d) => d.id !== launchedDraft.id));
              if (newSid && launchedDraft.harness) {
                const now = Date.now();
                const nativeId = newSid.includes(':') ? newSid.slice(newSid.indexOf(':') + 1) : newSid;
                const harnessGroup =
                  launchedDraft.harness === 'codex'
                    ? 'codex'
                    : launchedDraft.harness === 'antigravity'
                      ? 'antigravity'
                      : 'claude';
                const cwdParts = launchedDraft.cwd.split('/').filter(Boolean);
                const projectName = cwdParts[cwdParts.length - 1] || launchedDraft.cwd || 'Project';
                const titleText =
                  launchedDraft.prompt.trim().slice(0, 80) || `New ${projectName} session`;

                const optimisticSession: UnifiedSession = {
                  id: newSid,
                  nativeId,
                  harness: launchedDraft.harness,
                  harnessGroup,
                  title: titleText,
                  preview: launchedDraft.prompt.trim().slice(0, 140) || 'Starting session…',
                  cwd: launchedDraft.cwd,
                  projectName,
                  model: launchedDraft.model || undefined,
                  status: 'running',
                  isLive: true,
                  isRemote: launchedDraft.harness === 'claude-tmux' && launchedDraft.remoteControl,
                  createdAt: now,
                  updatedAt: now,
                  pinned: false,
                  folderId: null,
                  tags: ['launching'],
                  hidden: false,
                  dispatchMode:
                    launchedDraft.harness === 'codex'
                      ? 'codex-resume'
                      : launchedDraft.harness === 'antigravity'
                        ? 'agy-resume'
                        : launchedDraft.harness === 'claude-tmux'
                          ? 'tmux-send'
                          : 'claude-resume',
                };

                setPendingSessions((prev) => ({ ...prev, [newSid]: optimisticSession }));

                if (launchedDraft.prompt.trim()) {
                  rendererTranscriptCache.set(
                    newSid,
                    {
                      sessionId: newSid,
                      messages: [
                        {
                          id: `optimistic-launch-${now}`,
                          role: 'user',
                          timestamp: now,
                          blocks: [{ type: 'text', text: launchedDraft.prompt.trim() }],
                        },
                      ],
                      totalCount: 1,
                      hasMore: false,
                      sourceMtimeMs: now,
                      liveActivity: { isWorking: true, lastEventAt: now },
                    },
                    DEFAULT_TRANSCRIPT_LIMIT
                  );
                }

                setActiveSessionId(newSid);
              }
              void handleRefresh();
              window.setTimeout(() => void handleRefresh(), 1500);
            }}
          />
        ) : (
          <SessionPane
            session={activeSession}
            subagents={activeSubagents}
            folders={folders}
            draft={drafts[activeSessionId] ?? EMPTY_DRAFT}
            onDraftChange={handleDraftChange}
            queuedMessages={queuedBySession[activeSessionId] ?? EMPTY_QUEUE}
            onQueueChange={handleQueueChange}
            hasSplitOpen={Boolean(splitSessionId)}
            masterMessages={masterMessages}
            onSelectSession={handleSelectSession}
            onOrganize={handleOrganize}
            onArchiveSession={handleArchiveSession}
            onOpenPath={handleOpenPath}
            onToggleSplit={handleToggleSplitPrimary}
            onClearMaster={handleClearMaster}
          />
        )}

        {splitSessionId && (
          <SessionPane
            session={splitSession}
            subagents={splitSubagents}
            folders={folders}
            draft={drafts[splitSessionId] ?? EMPTY_DRAFT}
            onDraftChange={handleDraftChange}
            queuedMessages={queuedBySession[splitSessionId] ?? EMPTY_QUEUE}
            onQueueChange={handleQueueChange}
            isSplitPane
            hasSplitOpen
            masterMessages={masterMessages}
            onSelectSession={handleOpenInSplit}
            onOrganize={handleOrganize}
            onArchiveSession={handleArchiveSession}
            onOpenPath={handleOpenPath}
            onToggleSplit={handleCloseSplit}
            onCloseSplit={handleCloseSplit}
            onClearMaster={handleClearMaster}
          />
        )}

        {previewTarget && (
          <FilePreviewDrawer
            target={previewTarget}
            onClose={() => setPreviewTarget(null)}
            onNavigate={(next) => setPreviewTarget(next)}
            onLaunchExternal={(p, mode, line) =>
              void handleOpenPath(p, { mode, startLine: line })
            }
          />
        )}

        {toast && (
          <div className="fixed bottom-5 right-5 z-50 px-3.5 py-2 rounded-xl border border-line-subtle bg-surface-popover text-caption text-ink-primary shadow-2xl">
            {toast}
          </div>
        )}
      </main>

      {showSettings && state && (
        <SettingsModal
          harnesses={harnesses}
          state={state}
          controlPort={controlPort}
          onClose={() => setShowSettings(false)}
          onRefresh={() => void handleRefresh()}
          onUpdateSettings={(p) => void handleUpdateSettings(p)}
          onOrganize={(a) => void handleOrganize(a)}
        />
      )}
    </div>
  );
};
