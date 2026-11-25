import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type {
  ImageAttachment,
  LiveActivityState,
  OrganizeAction,
  QueuedMessageItem,
  SessionFolder,
  SessionTranscriptResult,
  UnifiedBlock,
  UnifiedMessage,
  UnifiedSession,
} from '../../shared/types';
import { Button } from '../ui';
import {
  DEFAULT_TRANSCRIPT_LIMIT,
  isTranscriptEquivalent,
  rendererTranscriptCache,
} from '../utils/transcriptCache';
import {
  AssistantMessageView,
  CoalescedBlockView,
  CollapsedTraceGroup,
  isTraceBlock,
  UserMessageView,
} from './CoalescedBlockView';
import { LiveStepsBar } from './LiveStepsBar';
import { QueuedMessagesTray } from './QueuedMessagesTray';
import { SessionComposer } from './SessionComposer';
import { SessionHeader } from './SessionHeader';

export interface ComposerDraft {
  text: string;
  attachments: ImageAttachment[];
}

interface Props {
  session: UnifiedSession | undefined;
  subagents: UnifiedSession[];
  folders: SessionFolder[];
  draft: ComposerDraft;
  onDraftChange: (
    sessionId: string,
    updater: ComposerDraft | ((prev: ComposerDraft) => ComposerDraft)
  ) => void;
  queuedMessages: QueuedMessageItem[];
  onQueueChange: (
    sessionId: string,
    updater: QueuedMessageItem[] | ((prev: QueuedMessageItem[]) => QueuedMessageItem[])
  ) => void;
  isSplitPane?: boolean;
  hasSplitOpen: boolean;
  masterMessages: UnifiedMessage[];
  onSelectSession: (id: string) => void;
  onOrganize: (actions: OrganizeAction[]) => void;
  onArchiveSession: (session: UnifiedSession, killTmux?: boolean) => void;
  onOpenPath: (
    filePath: string,
    opts?: {
      startLine?: number;
      endLine?: number;
      mode?: 'auto' | 'internal' | 'editor' | 'file-manager' | 'terminal';
      tmuxSession?: string;
    }
  ) => void;
  onToggleSplit: () => void;
  onCloseSplit?: () => void;
  onClearMaster: () => void;
}

/**
 * Primary or split conversation pane. Coordinates stale-while-revalidate
 * transcript caching, real-time inotify updates, live streaming, universal
 * message queueing, and image paste/drop while delegating chrome to
 * SessionHeader, LiveStepsBar, QueuedMessagesTray, and SessionComposer.
 */
export const SessionPane: React.FC<Props> = ({
  session,
  subagents,
  folders,
  draft,
  onDraftChange,
  queuedMessages,
  onQueueChange,
  isSplitPane,
  hasSplitOpen,
  masterMessages,
  onSelectSession,
  onOrganize,
  onArchiveSession,
  onOpenPath,
  onToggleSplit,
  onCloseSplit,
  onClearMaster,
}) => {
  const [messages, setMessages] = useState<UnifiedMessage[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [liveActivity, setLiveActivity] = useState<LiveActivityState | undefined>(undefined);
  const [limit, setLimit] = useState(DEFAULT_TRANSCRIPT_LIMIT);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<'chat' | 'tmux'>('chat');
  const [tmuxOutput, setTmuxOutput] = useState('');

  const [sending, setSending] = useState(false);
  const [dispatchNote, setDispatchNote] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState('');
  const [streamingBlocks, setStreamingBlocks] = useState<UnifiedBlock[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const stickyBottomRef = useRef(true);
  const lastResultRef = useRef<SessionTranscriptResult | null>(null);
  const currentSessionRef = useRef(session?.id ?? '');
  currentSessionRef.current = session?.id ?? '';

  const isMaster = session?.harness === 'master';
  const sessionId = session?.id ?? '';
  const paneId = isSplitPane ? 'split' : 'primary';

  const input = draft.text;
  const attachments = draft.attachments;

  const setInput = useCallback(
    (updater: string | ((prev: string) => string)) => {
      const targetId = currentSessionRef.current;
      if (!targetId) return;
      onDraftChange(targetId, (prev) => ({
        ...prev,
        text: typeof updater === 'function' ? updater(prev.text) : updater,
      }));
    },
    [onDraftChange]
  );

  const setAttachments = useCallback(
    (updater: ImageAttachment[] | ((prev: ImageAttachment[]) => ImageAttachment[])) => {
      const targetId = currentSessionRef.current;
      if (!targetId) return;
      onDraftChange(targetId, (prev) => ({
        ...prev,
        attachments: typeof updater === 'function' ? updater(prev.attachments) : updater,
      }));
    },
    [onDraftChange]
  );

  // Hydrate instantly from renderer LRU cache on session switch (stale-while-revalidate)
  // so revisiting or clicking a prefetched chat has zero loading flash.
  useEffect(() => {
    setViewMode('chat');
    setDispatchNote(null);
    setStreamError(null);
    setStreamingText('');
    setStreamingBlocks([]);
    setIsStreaming(false);
    stickyBottomRef.current = true;

    if (!sessionId) {
      lastResultRef.current = null;
      setMessages([]);
      setTotalCount(0);
      setLiveActivity(undefined);
      setLimit(DEFAULT_TRANSCRIPT_LIMIT);
      setLoading(false);
      return;
    }

    if (isMaster) {
      lastResultRef.current = null;
      setMessages(masterMessages);
      setTotalCount(masterMessages.length);
      setLiveActivity(undefined);
      setLimit(DEFAULT_TRANSCRIPT_LIMIT);
      setLoading(false);
      return;
    }

    const cached = rendererTranscriptCache.get(sessionId);
    if (cached) {
      lastResultRef.current = cached.result;
      setMessages(cached.result.messages);
      setTotalCount(cached.result.totalCount);
      setLiveActivity(cached.result.liveActivity);
      setLimit(Math.max(DEFAULT_TRANSCRIPT_LIMIT, cached.fetchedLimit));
      setLoading(false);
    } else {
      lastResultRef.current = null;
      setMessages([]);
      setTotalCount(0);
      setLiveActivity(undefined);
      setLimit(DEFAULT_TRANSCRIPT_LIMIT);
    }
  }, [sessionId, isMaster]);

  const loadTranscript = useCallback(
    async (silent = false, targetLimit?: number) => {
      const reqId = sessionId;
      const reqLimit = targetLimit ?? limit;
      if (!reqId) return;
      if (isMaster) {
        setMessages(masterMessages);
        setTotalCount(masterMessages.length);
        return;
      }
      const hasCached = rendererTranscriptCache.has(reqId);
      if (!silent && !hasCached) setLoading(true);
      try {
        const res = await window.superHarness.getTranscript(reqId, reqLimit);
        rendererTranscriptCache.set(reqId, res, reqLimit);
        // Guard against out-of-order async responses after switching sessions
        if (currentSessionRef.current !== reqId) return;
        if (!isTranscriptEquivalent(lastResultRef.current, res)) {
          lastResultRef.current = res;
          setMessages(res.messages);
          setTotalCount(res.totalCount);
          setLiveActivity(res.liveActivity);
        }
      } finally {
        if (currentSessionRef.current === reqId) setLoading(false);
      }
    },
    [sessionId, isMaster, masterMessages, limit]
  );

  useEffect(() => {
    const cached = sessionId && !isMaster ? rendererTranscriptCache.get(sessionId) : null;
    const silent = Boolean(cached && cached.fetchedLimit >= limit);
    void loadTranscript(silent, limit);
  }, [sessionId, limit, isMaster, loadTranscript]);

  useEffect(() => {
    if (isMaster) {
      setMessages(masterMessages);
      setTotalCount(masterMessages.length);
    }
  }, [isMaster, masterMessages]);

  // Real-time Linux inotify live push subscription
  useEffect(() => {
    if (!sessionId || isMaster) {
      void window.superHarness.watchSession(paneId, null);
      return;
    }
    void window.superHarness.watchSession(paneId, sessionId, limit);
    const off = window.superHarness.onTranscriptUpdated((res) => {
      rendererTranscriptCache.set(res.sessionId, res, Math.max(limit, res.messages.length));
      if (res.sessionId !== sessionId) return;
      if (!isTranscriptEquivalent(lastResultRef.current, res)) {
        lastResultRef.current = res;
        setMessages(res.messages);
        setTotalCount(res.totalCount);
        setLiveActivity(res.liveActivity);
      }
    });
    return () => {
      off();
      void window.superHarness.watchSession(paneId, null);
    };
  }, [paneId, sessionId, limit, isMaster]);

  // Live tmux capture when Terminal view is selected
  useEffect(() => {
    if (!session || isMaster) return;
    if (viewMode === 'tmux' && session.tmuxTarget) {
      const fetchTmux = async () => {
        const res = await window.superHarness.captureTmux(session.tmuxTarget!);
        setTmuxOutput(res.error ? `[tmux error] ${res.error}` : res.content);
      };
      void fetchTmux();
      const t = setInterval(fetchTmux, 1000);
      return () => clearInterval(t);
    }
  }, [session?.id, session?.tmuxTarget, viewMode, isMaster]);

  // Direct IPC stream listener (never drops error/delta/done events)
  useEffect(() => {
    if (!sessionId) return;
    return window.superHarness.onStreamEvent((ev) => {
      if (ev.sessionId !== sessionId) return;
      if (ev.kind === 'start') {
        setIsStreaming(true);
        setStreamError(null);
        setStreamingText('');
        setStreamingBlocks([]);
      } else if (ev.kind === 'delta' && ev.text) {
        setIsStreaming(true);
        setStreamingText((prev) => prev + ev.text);
      } else if (ev.kind === 'block' && ev.block) {
        setIsStreaming(true);
        setStreamingBlocks((prev) => [...prev, ev.block!]);
      } else if (ev.kind === 'error' && ev.error) {
        setStreamError(ev.error);
      } else if (ev.kind === 'done') {
        setIsStreaming(false);
        setStreamingText('');
        setStreamingBlocks([]);
        void loadTranscript(true);
        setTimeout(() => void loadTranscript(true), 1200);
      }
    });
  }, [sessionId, loadTranscript]);

  // Smooth sticky bottom scroll
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickyBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streamingText, tmuxOutput, viewMode, liveActivity?.isWorking]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickyBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
  };

  // Image paste / drop helper (captures targetSessionId + uses functional draft updates)
  const ingestImageFiles = useCallback(
    async (files: FileList | File[]) => {
      const targetSessionId = currentSessionRef.current;
      if (!targetSessionId) return;
      const list = Array.from(files).filter((f) => f.type.startsWith('image/'));
      for (const file of list) {
        const dataUrl = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ''));
          reader.onerror = () => resolve('');
          reader.readAsDataURL(file);
        });
        if (!dataUrl) continue;
        const saved = await window.superHarness.saveAttachment(dataUrl, file.name || undefined);
        onDraftChange(targetSessionId, (prev) => ({
          ...prev,
          attachments: [...prev.attachments, saved],
        }));
      }
    },
    [onDraftChange]
  );

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const targetSessionId = currentSessionRef.current;
      if (!targetSessionId) return;

      const imageFiles: File[] = [];
      const seen = new Set<string>();
      const pushIfImage = (f: File | null) => {
        if (!f || !f.type.startsWith('image/')) return;
        const key = `${f.name}:${f.size}:${f.type}`;
        if (seen.has(key)) return;
        seen.add(key);
        imageFiles.push(f);
      };

      const items = e.clipboardData?.items;
      if (items) {
        for (const item of Array.from(items)) {
          if (item.type.startsWith('image/')) {
            pushIfImage(item.getAsFile());
          }
        }
      }
      if (imageFiles.length === 0 && e.clipboardData?.files?.length) {
        for (const f of Array.from(e.clipboardData.files)) {
          pushIfImage(f);
        }
      }

      if (imageFiles.length > 0) {
        e.preventDefault();
        await ingestImageFiles(imageFiles);
        return;
      }

      // Fallback for Wayland/Electron clipboards where clipboardData omits image items
      const plainText = e.clipboardData?.getData('text/plain') || '';
      if (!plainText) {
        const nativeImg = await window.superHarness.readClipboardImage();
        if (nativeImg) {
          onDraftChange(targetSessionId, (prev) => ({
            ...prev,
            attachments: [...prev.attachments, nativeImg],
          }));
        }
      }
    },
    [ingestImageFiles, onDraftChange]
  );

  const handlePickImages = useCallback(async () => {
    const picked = await window.superHarness.pickImageFiles();
    if (picked.length > 0) {
      setAttachments((prev) => [...prev, ...picked]);
    }
  }, [setAttachments]);

  const handleRemoveAttachment = useCallback(
    (id: string) => {
      setAttachments((prev) => prev.filter((x) => x.id !== id));
    },
    [setAttachments]
  );

  const isAgentBusy =
    !isMaster &&
    (isStreaming || Boolean(liveActivity?.isWorking) || session?.status === 'running');

  const dispatchMessageNow = useCallback(
    async (prompt: string, msgAttachments: ImageAttachment[]) => {
      if (!session) return;
      if (!prompt && msgAttachments.length === 0) return;

      setSending(true);
      setDispatchNote(null);
      setStreamError(null);
      stickyBottomRef.current = true;

      if (!isMaster) {
        const optimisticBlocks: UnifiedBlock[] = [
          ...msgAttachments.map((a) => ({
            type: 'image' as const,
            path: a.path,
            name: a.name,
            dataUrl: a.previewDataUrl,
          })),
          ...(prompt ? [{ type: 'text' as const, text: prompt }] : []),
        ];
        setMessages((prev) => [
          ...prev,
          {
            id: `opt-${Date.now()}`,
            role: 'user',
            timestamp: Date.now(),
            blocks: optimisticBlocks,
          },
        ]);
      }

      try {
        const res = await window.superHarness.sendMessage(
          session.id,
          prompt,
          msgAttachments.length > 0 ? msgAttachments : undefined
        );
        if (!res.ok) {
          setStreamError(res.error || 'Dispatch failed');
        } else {
          setDispatchNote(res.dispatchedVia || null);
          if (session.dispatchMode === 'tmux-send') {
            setTimeout(() => void loadTranscript(true), 1200);
          }
        }
      } finally {
        setSending(false);
      }
    },
    [session, isMaster, loadTranscript]
  );

  const handleSend = useCallback(
    async (customText?: string) => {
      if (!session) return;
      const prompt = (customText ?? input).trim();
      const currentAttachments = customText ? [] : attachments;
      if (!prompt && currentAttachments.length === 0) return;

      if (!customText) {
        onDraftChange(session.id, { text: '', attachments: [] });
      }

      // If the agent is currently working, queue the message cleanly instead of clobbering the turn
      if (isAgentBusy && !customText) {
        const queuedItem: QueuedMessageItem = {
          id: `sh-q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          text: prompt,
          attachments: currentAttachments.length > 0 ? currentAttachments : undefined,
          createdAt: Date.now(),
          source: 'super-harness',
        };
        onQueueChange(session.id, (prev) => [...prev, queuedItem]);
        return;
      }

      await dispatchMessageNow(prompt, currentAttachments);
    },
    [session, input, attachments, isAgentBusy, onDraftChange, onQueueChange, dispatchMessageNow]
  );

  // Auto-dequeue the next Super Harness queued message once the agent finishes working
  useEffect(() => {
    if (!session || isAgentBusy || sending || queuedMessages.length === 0) return;
    const nextItem = queuedMessages[0];
    const targetSid = session.id;
    const timer = window.setTimeout(() => {
      if (currentSessionRef.current !== targetSid) return;
      onQueueChange(targetSid, (prev) => prev.filter((x) => x.id !== nextItem.id));
      void dispatchMessageNow(nextItem.text, nextItem.attachments ?? []);
    }, 450);
    return () => window.clearTimeout(timer);
  }, [session?.id, isAgentBusy, sending, queuedMessages, onQueueChange, dispatchMessageNow]);

  const handleQueueSendNow = useCallback(
    (id: string) => {
      if (!session) return;
      const item = queuedMessages.find((q) => q.id === id);
      if (!item) return;
      onQueueChange(session.id, (prev) => prev.filter((q) => q.id !== id));
      void dispatchMessageNow(item.text, item.attachments ?? []);
    },
    [session, queuedMessages, onQueueChange, dispatchMessageNow]
  );

  const handleQueueEdit = useCallback(
    (id: string) => {
      if (!session) return;
      const item = queuedMessages.find((q) => q.id === id);
      if (!item) return;
      onQueueChange(session.id, (prev) => prev.filter((q) => q.id !== id));
      onDraftChange(session.id, (prev) => ({
        text: prev.text ? `${item.text}\n${prev.text}` : item.text,
        attachments: [...(item.attachments ?? []), ...prev.attachments],
      }));
      setTimeout(() => textareaRef.current?.focus(), 20);
    },
    [session, queuedMessages, onQueueChange, onDraftChange]
  );

  const handleQueueRemove = useCallback(
    (id: string) => {
      if (!session) return;
      onQueueChange(session.id, (prev) => prev.filter((q) => q.id !== id));
    },
    [session, onQueueChange]
  );

  const combinedQueue = useMemo<QueuedMessageItem[]>(() => {
    const nativeItems = liveActivity?.queuedMessages ?? [];
    return [...nativeItems, ...queuedMessages];
  }, [liveActivity?.queuedMessages, queuedMessages]);

  const handleAbort = useCallback(async () => {
    if (!session) return;
    await window.superHarness.abortRun(session.id);
    setIsStreaming(false);
  }, [session]);

  const handleMessageOpenPath = useCallback(
    (fp: string, opts?: { startLine?: number; endLine?: number }) => {
      onOpenPath(fp, opts);
    },
    [onOpenPath]
  );

  const handleQuickReply = useCallback(
    (txt: string) => {
      setInput((prev) => (prev ? `${prev}\n${txt}` : txt));
    },
    [setInput]
  );

  const handleToggleViewMode = useCallback(() => {
    setViewMode((v) => (v === 'chat' ? 'tmux' : 'chat'));
  }, []);

  const handleReloadTranscript = useCallback(() => {
    void loadTranscript(false);
  }, [loadTranscript]);

  const handleDropFiles = useCallback(
    (files: FileList) => {
      void ingestImageFiles(files);
    },
    [ingestImageFiles]
  );

  if (!session) {
    return (
      <div className="flex-1 flex items-center justify-center text-ink-faint text-body bg-surface-canvas">
        Select a conversation
      </div>
    );
  }

  return (
    <section
      className={`flex-1 min-w-0 h-full flex flex-col bg-surface-canvas ${
        isSplitPane ? 'border-l border-line-hairline' : ''
      }`}
    >
      <SessionHeader
        session={session}
        isMaster={isMaster}
        subagents={subagents}
        folders={folders}
        viewMode={viewMode}
        isSplitPane={isSplitPane}
        hasSplitOpen={hasSplitOpen}
        onToggleViewMode={handleToggleViewMode}
        onSelectSession={onSelectSession}
        onOrganize={onOrganize}
        onReloadTranscript={handleReloadTranscript}
        onArchiveSession={onArchiveSession}
        onClearMaster={onClearMaster}
        onOpenPath={onOpenPath}
        onToggleSplit={onToggleSplit}
        onCloseSplit={onCloseSplit}
      />

      {/* Main Scroll Canvas */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-6 py-6"
      >
        {viewMode === 'tmux' && session.tmuxTarget ? (
          <div className="max-w-4xl mx-auto h-full flex flex-col">
            <pre className="flex-1 bg-surface-code border border-line-hairline rounded-xl p-4 font-mono text-caption text-ink-secondary leading-relaxed whitespace-pre-wrap overflow-y-auto">
              {tmuxOutput || 'Connecting to tmux pane…'}
            </pre>
          </div>
        ) : (
          <div className="max-w-[740px] mx-auto space-y-6 pb-4">
            {totalCount > messages.length && (
              <div className="flex justify-center">
                <Button size="xs" variant="ghost" onClick={() => setLimit((prev) => prev + 60)}>
                  Load earlier ({totalCount - messages.length})
                </Button>
              </div>
            )}

            {loading && messages.length === 0 ? (
              <div className="py-16 flex items-center justify-center gap-2 text-xs text-zinc-500">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Loading…
              </div>
            ) : messages.length === 0 ? (
              <div className="py-20 text-center text-sm text-zinc-500">
                Start a conversation below. Paste or drop images anytime.
              </div>
            ) : (
              messages.map((msg) => {
                if (msg.role === 'user') {
                  return (
                    <UserMessageView
                      key={msg.id}
                      msg={msg}
                      onOpenPath={handleMessageOpenPath}
                    />
                  );
                }

                if (msg.role === 'system') {
                  return (
                    <div key={msg.id} className="flex justify-center">
                      {msg.blocks.map((b, i) => (
                        <CoalescedBlockView key={i} block={b} />
                      ))}
                    </div>
                  );
                }

                return (
                  <AssistantMessageView
                    key={msg.id}
                    msg={msg}
                    onOpenPath={handleMessageOpenPath}
                    onQuickReply={handleQuickReply}
                  />
                );
              })
            )}

            {/* Live streaming assistant reply */}
            {!isMaster && isStreaming && (
              <div className="space-y-2.5">
                {streamingBlocks.length > 0 && (
                  <CollapsedTraceGroup blocks={streamingBlocks.filter(isTraceBlock)} />
                )}
                {streamingText && (
                  <CoalescedBlockView block={{ type: 'text', text: streamingText }} />
                )}
                <div className="flex items-center gap-2 text-xs text-zinc-500 pt-1">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span>Working</span>
                </div>
              </div>
            )}

            {/* Quiet live Working indicator */}
            {!isMaster && !isStreaming && liveActivity?.isWorking && (
              <div className="flex items-center gap-2 text-xs text-zinc-500 pt-1">
                <Loader2 className="w-3 h-3 animate-spin" />
                <span>Working</span>
                {liveActivity.focus && (
                  <span className="text-zinc-600 truncate">· {liveActivity.focus}</span>
                )}
              </div>
            )}

            {streamError && (
              <div className="rounded-xl border border-rose-500/25 bg-rose-500/[0.06] px-4 py-3 text-xs text-rose-300 font-mono whitespace-pre-wrap">
                {streamError}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom Composer Dock */}
      <div className="px-6 pb-4 pt-1 shrink-0">
        <div className="max-w-[740px] mx-auto space-y-2">
          {!isMaster && <LiveStepsBar key={session.id} steps={liveActivity?.steps} />}

          <QueuedMessagesTray
            items={combinedQueue}
            onSendNow={handleQueueSendNow}
            onEdit={handleQueueEdit}
            onRemove={handleQueueRemove}
          />

          <SessionComposer
            session={session}
            isMaster={isMaster}
            input={input}
            attachments={attachments}
            sending={sending}
            isStreaming={isStreaming}
            isAgentBusy={isAgentBusy}
            dispatchNote={dispatchNote}
            textareaRef={textareaRef}
            onInputChange={setInput}
            onRemoveAttachment={handleRemoveAttachment}
            onPaste={(e) => void handlePaste(e)}
            onDropFiles={handleDropFiles}
            onPickImages={() => void handlePickImages()}
            onSend={() => void handleSend()}
            onAbort={() => void handleAbort()}
          />
        </div>
      </div>
    </section>
  );
};
