import React, { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { Mic, Square } from 'lucide-react';
import type { DictationSettings } from '../../shared/types';
import { Button, IconButton, PopoverSurface, WorkingOrb } from '../ui';
import { DEFAULT_DICTATION_SHORTCUT, matchesShortcut } from '../utils/shortcut';

/**
 * Desktop dictation: a mic button in each composer. Tap to record (live level bars and a stop
 * mark), tap again to stop and transcribe; the text lands at the cursor. Esc cancels. Audio goes
 * to the main process over IPC, which proxies it to settings.dictation like /api/dictate does.
 */

interface DictationContextValue {
  settings?: DictationSettings;
  openSetup: () => void;
}

const DictationContext = createContext<DictationContextValue>({ openSetup: () => {} });

interface RegisteredComposer {
  id: string;
  textarea: () => HTMLTextAreaElement | null;
  isActive: () => boolean;
  toggle: () => void;
}

/** Mounted composers, so the shortcut can find the one to record into. */
const composers = new Map<string, RegisteredComposer>();
let lastFocusedComposerId: string | null = null;

function pickShortcutTarget(): RegisteredComposer | null {
  const all = [...composers.values()];
  const active = all.find((c) => c.isActive());
  if (active) return active;
  const focused = all.find((c) => {
    const el = c.textarea();
    return el && (document.activeElement === el || el.contains(document.activeElement));
  });
  if (focused) return focused;
  const last = lastFocusedComposerId ? composers.get(lastFocusedComposerId) : undefined;
  if (last && last.textarea()?.isConnected) return last;
  return all.length === 1 ? all[0] : null;
}

export const DictationProvider: React.FC<{
  settings?: DictationSettings;
  openSetup: () => void;
  children: React.ReactNode;
}> = ({ settings, openSetup, children }) => {
  const shortcut = settings?.shortcut || DEFAULT_DICTATION_SHORTCUT;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || !matchesShortcut(e, shortcut)) return;
      // A shortcut field being recorded in Settings gets the keys instead.
      if ((e.target as HTMLElement | null)?.closest?.('[data-shortcut-recorder]')) return;
      const target = pickShortcutTarget();
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      target.textarea()?.focus();
      target.toggle();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [shortcut]);

  return (
    <DictationContext.Provider value={{ settings, openSetup }}>{children}</DictationContext.Provider>
  );
};

type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'recording' }
  | { kind: 'transcribing' }
  | { kind: 'notice'; message: string; setup?: boolean };

const BAR_COUNT = 5;
const MIN_RECORDING_MS = 250;

function pickMimeType(): string {
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

/** Inserts `text` at the textarea's selection, adding a space where words would touch. */
export function insertAtSelection(
  value: string,
  start: number,
  end: number,
  text: string
): { next: string; caret: number } {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const trail = after && !/^[\s.,;:!?)]/.test(after) ? ' ' : '';
  const insert = `${lead}${text}${trail}`;
  return { next: before + insert + after, caret: before.length + lead.length + text.length };
}

interface DictationButtonProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (next: string) => void;
}

export const DictationButton: React.FC<DictationButtonProps> = ({ textareaRef, value, onChange }) => {
  const { settings, openSetup } = useContext(DictationContext);
  const configured = Boolean(settings?.baseUrl?.trim());
  const shortcut = settings?.shortcut || DEFAULT_DICTATION_SHORTCUT;
  const id = useId();

  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [levels, setLevels] = useState<number[]>(() => Array(BAR_COUNT).fill(0));
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const recRef = useRef<{
    stream: MediaStream;
    recorder: MediaRecorder;
    ctx: AudioContext;
    raf: number;
    chunks: Blob[];
    startedAt: number;
    cancelled: boolean;
  } | null>(null);
  const noticeTimer = useRef<number | null>(null);

  const showNotice = useCallback((message: string, setup = false) => {
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    setPhase({ kind: 'notice', message, setup });
    if (!setup) {
      noticeTimer.current = window.setTimeout(() => {
        setPhase((p) => (p.kind === 'notice' ? { kind: 'idle' } : p));
      }, 4000);
    }
  }, []);

  const teardown = useCallback(() => {
    const rec = recRef.current;
    recRef.current = null;
    if (!rec) return;
    cancelAnimationFrame(rec.raf);
    rec.stream.getTracks().forEach((t) => t.stop());
    void rec.ctx.close().catch(() => {});
    setLevels(Array(BAR_COUNT).fill(0));
  }, []);

  const insertText = useCallback(
    (text: string) => {
      const el = textareaRef.current;
      const cur = valueRef.current;
      const start = el ? el.selectionStart : cur.length;
      const end = el ? el.selectionEnd : cur.length;
      const { next, caret } = insertAtSelection(cur, start, end, text);
      onChangeRef.current(next);
      requestAnimationFrame(() => {
        const t = textareaRef.current;
        if (!t) return;
        t.focus();
        t.setSelectionRange(caret, caret);
      });
    },
    [textareaRef]
  );

  const start = useCallback(async () => {
    if (!configured) {
      showNotice('Dictation isn’t set up yet.', true);
      return;
    }
    setPhase({ kind: 'starting' });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
    } catch (err) {
      showNotice(err instanceof Error && err.name === 'NotAllowedError' ? 'Microphone access was denied.' : 'No microphone available.');
      return;
    }
    if (phaseRef.current.kind !== 'starting') {
      // Cancelled (Esc) while the microphone was opening.
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.6;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    const rec = { stream, recorder, ctx, raf: 0, chunks: [] as Blob[], startedAt: Date.now(), cancelled: false };
    recRef.current = rec;

    let lastPaint = 0;
    const tick = (now: number) => {
      rec.raf = requestAnimationFrame(tick);
      if (now - lastPaint < 50) return;
      lastPaint = now;
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.min(1, Math.sqrt(sum / buf.length) * 4);
      setLevels((prev) => [...prev.slice(1), rms]);
    };
    rec.raf = requestAnimationFrame(tick);

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) rec.chunks.push(e.data);
    };
    recorder.onstop = async () => {
      const durationMs = Date.now() - rec.startedAt;
      teardown();
      if (rec.cancelled) {
        setPhase({ kind: 'idle' });
        return;
      }
      if (durationMs < MIN_RECORDING_MS || rec.chunks.length === 0) {
        setPhase({ kind: 'idle' });
        return;
      }
      setPhase({ kind: 'transcribing' });
      try {
        const blob = new Blob(rec.chunks, { type: recorder.mimeType || 'audio/webm' });
        const audio = new Uint8Array(await blob.arrayBuffer());
        const res = await window.superHarness.transcribeAudio(audio, blob.type);
        if (!res.ok) {
          showNotice(res.error || 'Transcription failed.');
          return;
        }
        if (res.text?.trim()) insertText(res.text.trim());
        setPhase({ kind: 'idle' });
      } catch (err) {
        showNotice(err instanceof Error ? err.message : 'Transcription failed.');
      }
    };
    recorder.start(250);
    setPhase({ kind: 'recording' });
  }, [configured, insertText, showNotice, teardown]);

  const stop = useCallback((cancel: boolean) => {
    const p = phaseRef.current;
    if (p.kind === 'starting' && cancel) {
      setPhase({ kind: 'idle' });
      return;
    }
    const rec = recRef.current;
    if (!rec) return;
    rec.cancelled = cancel;
    if (rec.recorder.state !== 'inactive') rec.recorder.stop();
  }, []);

  const toggle = useCallback(() => {
    const p = phaseRef.current.kind;
    if (p === 'recording') stop(false);
    else if (p === 'starting') stop(true);
    else if (p === 'idle' || p === 'notice') void start();
  }, [start, stop]);

  // Register with the shortcut dispatcher and remember which composer was focused last.
  useEffect(() => {
    composers.set(id, {
      id,
      textarea: () => textareaRef.current,
      isActive: () => phaseRef.current.kind === 'recording' || phaseRef.current.kind === 'starting',
      toggle,
    });
    const el = textareaRef.current;
    const onFocus = () => {
      lastFocusedComposerId = id;
    };
    el?.addEventListener('focus', onFocus);
    return () => {
      composers.delete(id);
      if (lastFocusedComposerId === id) lastFocusedComposerId = null;
      el?.removeEventListener('focus', onFocus);
    };
  }, [id, textareaRef, toggle]);

  // Esc cancels a recording (before any other Escape handler sees it).
  const recordingish = phase.kind === 'recording' || phase.kind === 'starting';
  useEffect(() => {
    if (!recordingish) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      stop(true);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recordingish, stop]);

  useEffect(
    () => () => {
      if (recRef.current) recRef.current.cancelled = true;
      recRef.current?.recorder.state !== 'inactive' && recRef.current?.recorder.stop();
      teardown();
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    },
    [teardown]
  );

  const notice = phase.kind === 'notice' ? phase : null;

  return (
    <div className="relative shrink-0">
      {phase.kind === 'recording' ? (
        <button
          ref={triggerRef}
          type="button"
          onClick={() => stop(false)}
          title={`Stop and transcribe (${shortcut}) · Esc to cancel`}
          aria-label="Stop recording and transcribe"
          className="h-7 px-2 rounded-md inline-flex items-center gap-1.5 text-ink-primary bg-white/[0.1] hover:bg-white/[0.14] transition-colors cursor-pointer"
        >
          <span className="flex items-center gap-[2px] h-3.5" aria-hidden="true">
            {levels.map((lv, i) => (
              <span
                key={i}
                className="w-[2px] rounded-full bg-current transition-[height] duration-75"
                style={{ height: `${Math.max(3, Math.round(3 + lv * 11))}px` }}
              />
            ))}
          </span>
          <Square className="w-2.5 h-2.5 fill-current" />
        </button>
      ) : phase.kind === 'transcribing' || phase.kind === 'starting' ? (
        <IconButton
          ref={triggerRef}
          label={phase.kind === 'starting' ? 'Opening microphone' : 'Transcribing'}
          onClick={() => phase.kind === 'starting' && stop(true)}
        >
          <WorkingOrb tone="master" size="sm" />
        </IconButton>
      ) : (
        <IconButton
          ref={triggerRef}
          label={configured ? `Dictate (${shortcut})` : 'Dictation isn’t set up'}
          onClick={toggle}
          className={configured ? undefined : 'opacity-45 hover:opacity-100'}
        >
          <Mic className="w-3.5 h-3.5" strokeWidth={1.75} />
        </IconButton>
      )}

      {notice && (
        <PopoverSurface
          width="auto"
          onClose={() => setPhase({ kind: 'idle' })}
          ignoreRef={triggerRef}
          className="absolute right-0 bottom-full mb-2 z-50 w-64 p-3 space-y-2.5"
        >
          <p className="text-caption text-ink-secondary leading-snug">
            {notice.message}
            {notice.setup && ' Choose a transcription server in Settings.'}
          </p>
          {notice.setup && (
            <Button
              size="xs"
              variant="secondary"
              onClick={() => {
                setPhase({ kind: 'idle' });
                openSetup();
              }}
            >
              Set up
            </Button>
          )}
        </PopoverSurface>
      )}
    </div>
  );
};
