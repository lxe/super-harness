import { useCallback, useSyncExternalStore } from 'react';
import type { ImageAttachment } from '../../shared/types';

export interface ComposerDraft {
  text: string;
  attachments: ImageAttachment[];
}

export type DraftUpdater = ComposerDraft | ((prev: ComposerDraft) => ComposerDraft);

/**
 * Composer drafts (text + pasted attachments) for every session, kept outside
 * React state.
 *
 * Each change is written to localStorage synchronously, so a crash or restart
 * never loses what was typed. Each composer subscribes to its own session's
 * draft only, so a keystroke re-renders that session's pane and nothing else:
 * no App, sidebar or other pane renders.
 */

const STORAGE_KEY = 'sh:composerDrafts:v1';
export const EMPTY_DRAFT: ComposerDraft = Object.freeze({ text: '', attachments: [] }) as ComposerDraft;

function load(): Map<string, ComposerDraft> {
  const out = new Map<string, ComposerDraft>();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return out;
    const parsed = JSON.parse(raw) as Record<string, ComposerDraft>;
    if (!parsed || typeof parsed !== 'object') return out;
    for (const [sid, d] of Object.entries(parsed)) {
      if (!d || typeof d !== 'object') continue;
      const text = typeof d.text === 'string' ? d.text : '';
      const attachments = Array.isArray(d.attachments) ? d.attachments : [];
      if (text || attachments.length > 0) out.set(sid, { text, attachments });
    }
  } catch {
    // unreadable storage: start empty
  }
  return out;
}

const drafts = load();
const listeners = new Map<string, Set<() => void>>();

function persist(): void {
  try {
    const compact: Record<string, ComposerDraft> = {};
    for (const [sid, d] of drafts) {
      // Inline previews are bulky; attachments reload from their path.
      const attachments = d.attachments.map(({ previewDataUrl: _drop, ...rest }) => rest);
      if (d.text || attachments.length > 0) compact[sid] = { text: d.text, attachments };
    }
    if (Object.keys(compact).length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(compact));
  } catch {
    // ignore storage quota errors
  }
}

export function getComposerDraft(sessionId: string): ComposerDraft {
  return drafts.get(sessionId) ?? EMPTY_DRAFT;
}

export function setComposerDraft(sessionId: string, updater: DraftUpdater): void {
  if (!sessionId) return;
  const prev = getComposerDraft(sessionId);
  const next = typeof updater === 'function' ? updater(prev) : updater;
  if (next === prev) return;
  if (!next.text && next.attachments.length === 0) drafts.delete(sessionId);
  else drafts.set(sessionId, next);
  persist();
  const subs = listeners.get(sessionId);
  if (subs) for (const fn of subs) fn();
}

function subscribe(sessionId: string, fn: () => void): () => void {
  let subs = listeners.get(sessionId);
  if (!subs) {
    subs = new Set();
    listeners.set(sessionId, subs);
  }
  subs.add(fn);
  return () => {
    subs!.delete(fn);
    if (subs!.size === 0) listeners.delete(sessionId);
  };
}

/** The draft for one session; re-renders only when that session's draft changes. */
export function useComposerDraft(sessionId: string): ComposerDraft {
  const sub = useCallback((fn: () => void) => subscribe(sessionId, fn), [sessionId]);
  return useSyncExternalStore(sub, () => getComposerDraft(sessionId));
}
