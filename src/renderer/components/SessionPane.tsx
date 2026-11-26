import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, FileText, Terminal } from 'lucide-react';
import type {
  HarnessCatalog,
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
import { Badge, Button, Modal, WorkingIndicator, WorkingOrb } from '../ui';
import { isBusyDispatchError } from '../utils/queueStorage';
import {
  captureStreamTurnBaseline,
  DEFAULT_TRANSCRIPT_LIMIT,
  isTranscriptEquivalent,
  rendererTranscriptCache,
  resolveVisibleStreamingOverlay,
  type StreamTurnBaseline,
} from '../utils/transcriptCache';
import {
  AssistantMessageView,
  CoalescedBlockView,
  CollapsedTraceGroup,
  isTraceBlock,
  UserMessageView,
} from './CoalescedBlockView';
import { ImageLightbox, type PreviewImageItem } from './ImageLightbox';
import { LiveStepsBar } from './LiveStepsBar';
import { QueuedMessagesTray } from './QueuedMessagesTray';
import { SessionComposer } from './SessionComposer';
import { SessionHeader } from './SessionHeader';
import { reconcileById } from '../utils/reconcile';

interface FailedUserEntry {
  msg: UnifiedMessage;
  prompt: string;
  attachments: ImageAttachment[];
}

const FAILED_MESSAGES_STORAGE_KEY = 'sh:failedUserMessages';

function loadFailedMessagesCache(): Map<string, FailedUserEntry[]> {
  const map = new Map<string, FailedUserEntry[]>();
  try {
    const raw = localStorage.getItem(FAILED_MESSAGES_STORAGE_KEY);
    if (!raw) return map;
    const parsed = JSON.parse(raw) as Record<string, FailedUserEntry[]>;
    if (parsed && typeof parsed === 'object') {
      for (const [sid, list] of Object.entries(parsed)) {
        if (Array.isArray(list) && list.length > 0) map.set(sid, list);
      }
    }
  } catch {
    // ignore storage read errors
  }
  return map;
}

function saveFailedMessagesCache(map: Map<string, FailedUserEntry[]>): void {
  try {
    const obj: Record<string, FailedUserEntry[]> = {};
    for (const [sid, list] of map.entries()) {
      if (list.length === 0) continue;
      // Strip bulky base64 previewDataUrl/dataUrl so localStorage stays lean; files reload via sh-media://path
      obj[sid] = list.map((e) => ({
        prompt: e.prompt,
        attachments: e.attachments.map(({ previewDataUrl: _drop, ...rest }) => rest),
        msg: {
          ...e.msg,
          blocks: e.msg.blocks.map((b) =>
            b.type === 'image' && b.path ? { type: 'image', path: b.path, name: b.name } : b
          ),
        },
      }));
    }
    if (Object.keys(obj).length === 0) {
      localStorage.removeItem(FAILED_MESSAGES_STORAGE_KEY);
    } else {
      localStorage.setItem(FAILED_MESSAGES_STORAGE_KEY, JSON.stringify(obj));
    }
  } catch {
    // ignore storage quota errors
  }
}

/**
 * Persists failed user messages per session across transcript reloads, session
 * switches, and app restarts so unsent prompts stay visible with a `!` indicator
 * until retried or dismissed.
 */
const failedUserMessagesBySession = loadFailedMessagesCache();

export interface ComposerDraft {
  text: string;
  attachments: ImageAttachment[];
}

interface Props {
  session: UnifiedSession | undefined;
  subagents: UnifiedSession[];
  folders: SessionFolder[];
  catalog?: HarnessCatalog | null;
  isStreamingGlobal?: boolean;
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
  onOpenSessionLink?: (href: string) => void;
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
  catalog,
  isStreamingGlobal = false,
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
  onOpenSessionLink,
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
  const [tasksExpanded, setTasksExpanded] = useState(false);
  const [lightbox, setLightbox] = useState<{
    images: PreviewImageItem[];
    index: number;
  } | null>(null);
  const [confirmRestartInTmux, setConfirmRestartInTmux] = useState(false);
  const [restartInTmuxBusy, setRestartInTmuxBusy] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const stickyBottomRef = useRef(true);
  const lastResultRef = useRef<SessionTranscriptResult | null>(null);
  const messagesRef = useRef<UnifiedMessage[]>([]);
  messagesRef.current = messages;
  const streamBaselineRef = useRef<StreamTurnBaseline | null>(null);
  const pendingOptimisticRef = useRef<{
    sessionId: string;
    msg: UnifiedMessage;
    promptText: string;
    attachments: ImageAttachment[];
    sentAt: number;
  } | null>(null);
  const currentSessionRef = useRef(session?.id ?? '');
  currentSessionRef.current = session?.id ?? '';

  const mergeWithOptimistic = useCallback(
    (
      reqId: string,
      incoming: UnifiedMessage[],
      incomingActivity?: LiveActivityState
    ): UnifiedMessage[] => {
      let result = incoming;
      const failedList = failedUserMessagesBySession.get(reqId);
      if (failedList && failedList.length > 0) {
        const existingIds = new Set(result.map((m) => m.id));
        const toAppend = failedList
          .map((e) => e.msg)
          .filter((m) => !existingIds.has(m.id));
        if (toAppend.length > 0) {
          result = [...result, ...toAppend];
        }
      }

      const pending = pendingOptimisticRef.current;
      if (!pending || pending.sessionId !== reqId) return result;
      // Expire after 25s if the harness never wrote it
      if (Date.now() - pending.sentAt > 25_000) {
        pendingOptimisticRef.current = null;
        return result;
      }
      // If the harness routed the message into its native queue (e.g. Codex active-writer fallback),
      // drop the optimistic transcript bubble so it isn't shown twice.
      const matchedInNativeQueue = (incomingActivity?.queuedMessages ?? []).some(
        (q) =>
          (pending.promptText && q.text.trim() === pending.promptText) ||
          q.createdAt >= pending.sentAt - 2000
      );
      if (matchedInNativeQueue) {
        pendingOptimisticRef.current = null;
        return result;
      }
      // Once the real transcript contains this user message (or any newer user message), drop the optimistic copy
      const matched = incoming.some((m) => {
        if (m.role !== 'user') return false;
        if (m.timestamp >= pending.sentAt - 2000) return true;
        if (!pending.promptText) return false;
        return m.blocks.some(
          (b) => b.type === 'text' && b.text.trim() === pending.promptText
        );
      });
      if (matched) {
        pendingOptimisticRef.current = null;
        return result;
      }
      return [...result, pending.msg];
    },
    []
  );

  const markPendingFailed = useCallback((targetSid: string, errorText: string): boolean => {
    const pending = pendingOptimisticRef.current;
    if (!pending || pending.sessionId !== targetSid) return false;
    const failedMsg: UnifiedMessage = { ...pending.msg, error: errorText };
    const existing = failedUserMessagesBySession.get(targetSid) ?? [];
    failedUserMessagesBySession.set(targetSid, [
      ...existing.filter((e) => e.msg.id !== failedMsg.id),
      { msg: failedMsg, prompt: pending.promptText, attachments: pending.attachments },
    ]);
    saveFailedMessagesCache(failedUserMessagesBySession);
    pendingOptimisticRef.current = null;
    if (currentSessionRef.current === targetSid) {
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === failedMsg.id);
        if (idx !== -1) {
          const next = [...prev];
          next[idx] = failedMsg;
          return next;
        }
        return [...prev, failedMsg];
      });
    }
    return true;
  }, []);

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
    streamBaselineRef.current = null;
    setTasksExpanded(false);
    setLightbox(null);
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
      setMessages(mergeWithOptimistic(sessionId, cached.result.messages, cached.result.liveActivity));
      setTotalCount(cached.result.totalCount);
      setLiveActivity(cached.result.liveActivity);
      setLimit(Math.max(DEFAULT_TRANSCRIPT_LIMIT, cached.fetchedLimit));
      setLoading(false);
    } else {
      lastResultRef.current = null;
      setMessages(mergeWithOptimistic(sessionId, []));
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
        // Preserve a freshly seeded optimistic launch prompt until the harness flushes its first turn
        const prevOpt = lastResultRef.current;
        const preserveLaunchSeed =
          res.messages.length === 0 &&
          prevOpt?.sessionId === reqId &&
          prevOpt.messages.some((m) => m.id.startsWith('optimistic-launch-')) &&
          Date.now() - prevOpt.sourceMtimeMs < 25_000;
        if (preserveLaunchSeed) return;

        rendererTranscriptCache.set(reqId, res, reqLimit);
        // Guard against out-of-order async responses after switching sessions
        if (currentSessionRef.current !== reqId) return;
        if (!isTranscriptEquivalent(lastResultRef.current, res)) {
          lastResultRef.current = res;
          const merged = mergeWithOptimistic(reqId, res.messages, res.liveActivity);
          setMessages((prev) => reconcileById(prev, merged));
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
        // Keep unchanged messages' identity so memoized message views skip re-rendering.
        const merged = mergeWithOptimistic(sessionId, res.messages, res.liveActivity);
        setMessages((prev) => reconcileById(prev, merged));
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
        streamBaselineRef.current = captureStreamTurnBaseline(messagesRef.current);
        setIsStreaming(true);
        setStreamError(null);
        setStreamingText('');
        setStreamingBlocks([]);
      } else if (ev.kind === 'delta' && ev.text) {
        if (!streamBaselineRef.current) {
          streamBaselineRef.current = captureStreamTurnBaseline(messagesRef.current);
        }
        setIsStreaming(true);
        setStreamingText((prev) => prev + ev.text);
      } else if (ev.kind === 'block' && ev.block) {
        if (!streamBaselineRef.current) {
          streamBaselineRef.current = captureStreamTurnBaseline(messagesRef.current);
        }
        setIsStreaming(true);
        setStreamingBlocks((prev) => [...prev, ev.block!]);
      } else if (ev.kind === 'error' && ev.error) {
        // Attach the error directly to the user message so it stays in the transcript with a `!` indicator
        const attached = markPendingFailed(sessionId, ev.error);
        if (!attached) {
          setStreamError(ev.error);
        }
      } else if (ev.kind === 'done') {
        streamBaselineRef.current = null;
        setIsStreaming(false);
        setStreamingText('');
        setStreamingBlocks([]);
        void loadTranscript(true);
        setTimeout(() => void loadTranscript(true), 1200);
      }
    });
  }, [sessionId, loadTranscript]);

  // Smooth sticky bottom scroll (re-runs whenever messages, streaming, or Working indicator height changes)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickyBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
    const raf = window.requestAnimationFrame(() => {
      if (scrollRef.current && stickyBottomRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    });
    return () => window.cancelAnimationFrame(raf);
  }, [
    messages,
    streamingText,
    streamingBlocks.length,
    isStreaming,
    isStreamingGlobal,
    tmuxOutput,
    viewMode,
    liveActivity?.isWorking,
    liveActivity?.focus,
  ]);

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

  const effectiveStreaming = isStreaming || isStreamingGlobal;
  const isAgentBusy =
    !isMaster &&
    (effectiveStreaming || Boolean(liveActivity?.isWorking) || session?.status === 'running');

  const dispatchMessageNow = useCallback(
    async (
      prompt: string,
      msgAttachments: ImageAttachment[],
      opts?: { force?: boolean }
    ) => {
      if (!session) return;
      if (!prompt && msgAttachments.length === 0) return;

      setSending(true);
      setDispatchNote(null);
      setStreamError(null);
      stickyBottomRef.current = true;

      let optimisticId: string | null = null;
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
        const sentAt = Date.now();
        const optMsg: UnifiedMessage = {
          id: `opt-${sentAt}`,
          role: 'user',
          timestamp: sentAt,
          blocks: optimisticBlocks,
        };
        optimisticId = optMsg.id;
        pendingOptimisticRef.current = {
          sessionId: session.id,
          msg: optMsg,
          promptText: prompt.trim(),
          attachments: msgAttachments,
          sentAt,
        };
        setMessages((prev) => [...prev, optMsg]);
      }

      try {
        const res = await window.superHarness.sendMessage(
          session.id,
          prompt,
          msgAttachments.length > 0 ? msgAttachments : undefined,
          opts
        );
        if (!res.ok) {
          const errText = res.error || 'Dispatch failed';
          // Never fail a user's prompt with a red "Not delivered" banner when the harness
          // is mid-turn (unless the user explicitly forced Send Now and it genuinely errored)
          if (!opts?.force && isBusyDispatchError(errText)) {
            if (pendingOptimisticRef.current?.msg.id === optimisticId) {
              pendingOptimisticRef.current = null;
            }
            if (optimisticId) {
              setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
            }
            if (session.harnessGroup === 'codex') {
              try {
                const qRes = await window.superHarness.queueMessage(
                  session.id,
                  prompt,
                  msgAttachments.length > 0 ? msgAttachments : undefined
                );
                if (qRes.ok) {
                  setDispatchNote(qRes.dispatchedVia || 'Codex queue');
                  void loadTranscript(true);
                  return;
                }
              } catch {
                // Fall back to Super Harness persistent queue below
              }
            }
            const queuedItem: QueuedMessageItem = {
              id: `sh-q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              text: prompt,
              attachments: msgAttachments.length > 0 ? msgAttachments : undefined,
              createdAt: Date.now(),
              source: 'super-harness',
            };
            onQueueChange(session.id, (prev) => [...prev, queuedItem]);
            setDispatchNote('Queued until current turn finishes');
            return;
          }
          const attached = markPendingFailed(session.id, errText);
          if (!attached) setStreamError(errText);
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
    [session, isMaster, loadTranscript, onQueueChange]
  );

  const handleDismissFailed = useCallback(
    (msgId: string) => {
      if (!sessionId) return;
      const list = failedUserMessagesBySession.get(sessionId);
      if (list) {
        const next = list.filter((e) => e.msg.id !== msgId);
        if (next.length > 0) failedUserMessagesBySession.set(sessionId, next);
        else failedUserMessagesBySession.delete(sessionId);
        saveFailedMessagesCache(failedUserMessagesBySession);
      }
      setMessages((prev) => prev.filter((m) => m.id !== msgId));
    },
    [sessionId]
  );

  const handleRetryFailed = useCallback(
    (msg: UnifiedMessage) => {
      if (!sessionId) return;
      const list = failedUserMessagesBySession.get(sessionId) ?? [];
      const entry = list.find((e) => e.msg.id === msg.id);
      const fallbackText = msg.blocks
        .filter((b): b is Extract<UnifiedBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      handleDismissFailed(msg.id);
      void dispatchMessageNow(entry?.prompt ?? fallbackText, entry?.attachments ?? []);
    },
    [sessionId, handleDismissFailed, dispatchMessageNow]
  );

  const handleQueue = useCallback(async () => {
    if (!session || isMaster) return;
    const prompt = input.trim();
    const currentAttachments = attachments;
    if (!prompt && currentAttachments.length === 0) return;

    onDraftChange(session.id, { text: '', attachments: [] });

    if (session.harnessGroup === 'codex') {
      try {
        const qRes = await window.superHarness.queueMessage(
          session.id,
          prompt,
          currentAttachments.length > 0 ? currentAttachments : undefined
        );
        if (qRes.ok) {
          setDispatchNote(qRes.dispatchedVia || 'Codex queue');
          void loadTranscript(true);
          setTimeout(() => void loadTranscript(true), 600);
          return;
        }
      } catch {
        // Fall back to Super Harness's persistent queue below
      }
    }

    const queuedItem: QueuedMessageItem = {
      id: `sh-q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      text: prompt,
      attachments: currentAttachments.length > 0 ? currentAttachments : undefined,
      createdAt: Date.now(),
      source: 'super-harness',
    };
    onQueueChange(session.id, (prev) => [...prev, queuedItem]);
    setDispatchNote('Queued until current turn finishes');
  }, [session, isMaster, input, attachments, onDraftChange, onQueueChange, loadTranscript]);

  const handleSend = useCallback(
    async (customText?: string) => {
      if (!session) return;
      const prompt = (customText ?? input).trim();
      const currentAttachments = customText ? [] : attachments;
      if (!prompt && currentAttachments.length === 0) return;

      if (!customText) {
        onDraftChange(session.id, { text: '', attachments: [] });
      }

      // Default Enter always sends/steers immediately (even while working);
      // Ctrl+Enter / Option+Enter explicitly queues for after the current turn.
      await dispatchMessageNow(
        prompt,
        currentAttachments,
        isAgentBusy ? { force: true } : undefined
      );
    },
    [session, input, attachments, isAgentBusy, onDraftChange, dispatchMessageNow]
  );

  // Auto-dequeue is coordinated globally in App.tsx so queued messages drain across
  // all sessions (active, split, and background tabs) and persist across restarts.

  const handleQueueSendNow = useCallback(
    (id: string) => {
      if (!session) return;
      const item = queuedMessages.find((q) => q.id === id);
      if (!item) return;
      onQueueChange(session.id, (prev) => prev.filter((q) => q.id !== id));
      void dispatchMessageNow(item.text, item.attachments ?? [], { force: true });
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

  const visibleStreaming = useMemo(
    () =>
      isStreaming
        ? resolveVisibleStreamingOverlay(
            messages,
            streamBaselineRef.current,
            streamingBlocks,
            streamingText
          )
        : { showBlocks: [], showText: '' },
    [isStreaming, messages, streamingBlocks, streamingText]
  );

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

  const handlePreviewImage = useCallback((images: PreviewImageItem[], index: number) => {
    if (images.length === 0) return;
    setLightbox({ images, index });
  }, []);

  const runPromoteToTmux = useCallback(async () => {
    if (!session) return;
    setRestartInTmuxBusy(true);
    try {
      const res = await window.superHarness.promoteToTmux(session.id);
      if (res.ok) {
        setDispatchNote(
          session.harnessGroup === 'muse'
            ? `Restarted in tmux (${res.tmuxSession || 'live'}) — Super Harness can now type into that terminal`
            : `Moved to tmux (${res.tmuxSession || 'live'})`
        );
        setStreamError(null);
      } else {
        setStreamError(res.error || 'Failed to move session to tmux');
      }
    } catch (err) {
      setStreamError(err instanceof Error ? err.message : 'Failed to move session to tmux');
    } finally {
      setRestartInTmuxBusy(false);
      setConfirmRestartInTmux(false);
    }
  }, [session]);

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
        onPromoteToTmux={
          session.harnessGroup === 'claude' && session.dispatchMode !== 'tmux-send'
            ? () => void runPromoteToTmux()
            : session.harnessGroup === 'muse' && session.isTerminalHeld
              ? () => setConfirmRestartInTmux(true)
              : undefined
        }
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
          <div className="max-w-[740px] mx-auto space-y-6 pb-12">
            {totalCount > messages.length && (
              <div className="flex justify-center">
                <Button size="xs" variant="ghost" onClick={() => setLimit((prev) => prev + 60)}>
                  Load earlier ({totalCount - messages.length})
                </Button>
              </div>
            )}

            {loading && messages.length === 0 ? (
              <div className="py-16 flex items-center justify-center gap-2 text-caption text-ink-muted">
                <WorkingOrb tone={session.harnessGroup} size="md" />
                Loading…
              </div>
            ) : messages.length === 0 ? (
              <div className="py-20 text-center text-body text-ink-muted">
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
                      onOpenSessionLink={onOpenSessionLink}
                      onPreviewImage={handlePreviewImage}
                      onRetryFailed={handleRetryFailed}
                      onDismissFailed={handleDismissFailed}
                    />
                  );
                }

                if (msg.role === 'system') {
                  return (
                    <div key={msg.id} className="flex justify-center">
                      {msg.blocks.map((b, i) => (
                        <CoalescedBlockView
                          key={i}
                          block={b}
                          onOpenPath={handleMessageOpenPath}
                          onOpenSessionLink={onOpenSessionLink}
                          onPreviewImage={handlePreviewImage}
                        />
                      ))}
                    </div>
                  );
                }

                return (
                  <AssistantMessageView
                    key={msg.id}
                    msg={msg}
                    onOpenPath={handleMessageOpenPath}
                    onOpenSessionLink={onOpenSessionLink}
                    onQuickReply={handleQuickReply}
                    onPreviewImage={handlePreviewImage}
                  />
                );
              })
            )}

            {/* Live streaming assistant reply (deduped against live-synced persisted turns) */}
            {!isMaster && isStreaming && (
              <div className="space-y-2.5">
                {visibleStreaming.showBlocks.length > 0 && (
                  <CollapsedTraceGroup blocks={visibleStreaming.showBlocks.filter(isTraceBlock)} />
                )}
                {visibleStreaming.showText && (
                  <CoalescedBlockView block={{ type: 'text', text: visibleStreaming.showText }} />
                )}
              </div>
            )}

            {/* Working indicator + running background tasks (stacked cleanly) */}
            {!isMaster && (() => {
              const showWorking = isStreaming || effectiveStreaming || Boolean(liveActivity?.isWorking);
              const tasks = liveActivity?.runningTasks ?? [];
              const hasTasks = tasks.length > 0;
              if (!showWorking && !hasTasks) return null;

              const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user' && m.timestamp);
              const turnStartedAt =
                lastUserMsg?.timestamp && Date.now() - lastUserMsg.timestamp < 2 * 60 * 60 * 1000
                  ? lastUserMsg.timestamp
                  : undefined;

              return (
                <div className="pt-0.5 space-y-1.5">
                  {showWorking && (
                    <WorkingIndicator
                      tone={session.harnessGroup}
                      focus={liveActivity?.focus}
                      startedAt={turnStartedAt}
                    />
                  )}
                  {hasTasks && (
                    <div>
                      <button
                        type="button"
                        onClick={() => setTasksExpanded((v) => !v)}
                        className="inline-flex items-center gap-1.5 text-caption text-ink-muted hover:text-ink-primary transition-colors cursor-pointer py-0.5 px-1 -mx-1 rounded-md outline-none focus:outline-none focus-visible:shadow-none focus-visible:bg-white/[0.05]"
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-status-success animate-pulse shrink-0" />
                        <span>
                          {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'} running
                        </span>
                        {tasksExpanded ? (
                          <ChevronDown className="w-3.5 h-3.5 text-ink-faint" />
                        ) : (
                          <ChevronRight className="w-3.5 h-3.5 text-ink-faint" />
                        )}
                      </button>
                      {tasksExpanded && (
                        <div className="mt-1.5 rounded-xl border border-line-hairline bg-surface-subtle/80 divide-y divide-line-hairline overflow-hidden">
                          {tasks.map((task) => (
                            <div
                              key={task.id}
                              className="px-3 py-2 flex items-start justify-between gap-2.5 text-caption"
                            >
                              <div className="min-w-0 flex-1 space-y-0.5">
                                <div className="flex items-center gap-1.5 min-w-0">
                                  <Terminal className="w-3 h-3 text-ink-faint shrink-0" />
                                  <span className="text-ink-secondary font-medium truncate">
                                    {task.summary}
                                  </span>
                                  {task.isDaemon && <Badge tone="neutral">daemon</Badge>}
                                </div>
                                {task.command && (
                                  <div className="text-micro font-mono text-ink-faint truncate">
                                    {task.command}
                                  </div>
                                )}
                              </div>
                              {task.logPath && (
                                <button
                                  type="button"
                                  onClick={() => handleMessageOpenPath(task.logPath!)}
                                  className="inline-flex items-center gap-1 text-micro text-ink-muted hover:text-ink-primary px-1.5 py-0.5 rounded hover:bg-white/[0.06] shrink-0 cursor-pointer outline-none focus:outline-none"
                                  title="Inspect task log"
                                >
                                  <FileText className="w-3 h-3" />
                                  <span>Log</span>
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })()}

            {streamError && (
              <div className="rounded-xl border border-rose-500/25 bg-rose-500/[0.06] px-4 py-3 text-caption text-rose-300 font-mono whitespace-pre-wrap">
                {streamError}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom Composer Dock */}
      <div className="relative z-10 px-6 pb-5 pt-2 shrink-0 bg-surface-canvas">
        <div className="pointer-events-none absolute -top-5 inset-x-0 h-5 bg-gradient-to-t from-surface-canvas via-surface-canvas/70 to-transparent" />
        <div className="max-w-[740px] mx-auto space-y-2">
          {!isMaster && <LiveStepsBar key={session.id} steps={liveActivity?.steps} />}

          <QueuedMessagesTray
            items={combinedQueue}
            isAgentBusy={isAgentBusy}
            harnessLabel={
              session.harnessGroup === 'antigravity'
                ? 'Antigravity'
                : session.harnessGroup === 'codex'
                  ? 'Codex'
                  : session.harnessGroup === 'claude'
                    ? 'Claude'
                    : session.harnessGroup === 'muse'
                      ? 'Muse'
                      : undefined
            }
            onSendNow={handleQueueSendNow}
            onEdit={handleQueueEdit}
            onRemove={handleQueueRemove}
            onPreviewImage={handlePreviewImage}
          />

          <SessionComposer
            session={session}
            isMaster={isMaster}
            catalog={catalog}
            onChangeModel={(patch) => {
              onOrganize([
                {
                  type: 'set_model',
                  sessionId: session.id,
                  ...(patch.model !== undefined ? { model: patch.model } : {}),
                  ...(patch.reasoningEffort !== undefined
                    ? { reasoningEffort: patch.reasoningEffort }
                    : {}),
                },
              ]);
            }}
            input={input}
            attachments={attachments}
            sending={sending}
            isStreaming={effectiveStreaming}
            isAgentBusy={isAgentBusy}
            dispatchNote={dispatchNote}
            textareaRef={textareaRef}
            onInputChange={setInput}
            onRemoveAttachment={handleRemoveAttachment}
            onPreviewImage={handlePreviewImage}
            onPaste={(e) => void handlePaste(e)}
            onDropFiles={handleDropFiles}
            onPickImages={() => void handlePickImages()}
            onSend={() => void handleSend()}
            onQueue={() => void handleQueue()}
            onAbort={() => void handleAbort()}
          />
        </div>
      </div>

      {lightbox && (
        <ImageLightbox
          images={lightbox.images}
          initialIndex={lightbox.index}
          onClose={() => setLightbox(null)}
        />
      )}

      {confirmRestartInTmux && (
        <Modal
          onClose={() => {
            if (!restartInTmuxBusy) setConfirmRestartInTmux(false);
          }}
          title="Restart this Muse session in tmux?"
          subtitle={session.title}
          width="sm"
          footer={
            <>
              <Button
                variant="ghost"
                onClick={() => setConfirmRestartInTmux(false)}
                disabled={restartInTmuxBusy}
              >
                Cancel
              </Button>
              <Button variant="danger" onClick={() => void runPromoteToTmux()} disabled={restartInTmuxBusy}>
                {restartInTmuxBusy ? 'Restarting…' : 'Close terminal and restart in tmux'}
              </Button>
            </>
          }
        >
          <div className="space-y-3 text-body text-ink-secondary">
            <p>
              This session is open in a Muse terminal that Super Harness cannot type into (it has
              no attach endpoint and is not inside tmux), which is why messages sent from here are
              not delivered.
            </p>
            <p>
              Super Harness will close that exact Muse terminal process and relaunch the same
              session with <code>muse resume</code> inside a new tmux session. The conversation
              is preserved. Closing the old terminal can take up to half a minute. If the session
              is mid-turn, Super Harness will refuse rather than kill active work.
            </p>
            <p>
              Afterwards Super Harness can type into that tmux terminal for you, and you can watch
              or take over any time with <code>tmux attach</code>.
            </p>
          </div>
        </Modal>
      )}
    </section>
  );
};
