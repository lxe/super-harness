import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  FolderOpen,
  HelpCircle,
  Loader2,
  Radio,
  Sparkles,
  X,
} from 'lucide-react';
import type { StartSessionRequest } from '../../shared/types';
import { Button, IconButton } from '../ui';
import { HarnessLogo } from './HarnessLogo';

export interface DraftConversation {
  id: string;
  harness: StartSessionRequest['harness'] | null;
  cwd: string;
  model: string;
  remoteControl: boolean;
  prompt: string;
  createdAt: number;
}

interface Props {
  draft: DraftConversation;
  onUpdateDraft: (patch: Partial<DraftConversation>) => void;
  onDiscard: () => void;
  onLaunched: (sessionId?: string) => void;
}

const HARNESS_CHOICES: Array<{
  id: StartSessionRequest['harness'];
  label: string;
  desc: string;
  logo: 'antigravity' | 'codex' | 'claude-tmux' | 'claude-cli';
}> = [
  {
    id: 'antigravity',
    label: 'Antigravity',
    desc: 'Direct ACP conversation',
    logo: 'antigravity',
  },
  {
    id: 'codex',
    label: 'Codex',
    desc: 'OpenAI Codex workspace thread',
    logo: 'codex',
  },
  {
    id: 'claude-tmux',
    label: 'Claude · tmux',
    desc: 'Persistent tmux + remote control',
    logo: 'claude-tmux',
  },
  {
    id: 'claude-cli',
    label: 'Claude CLI',
    desc: 'Resumable headless session',
    logo: 'claude-cli',
  },
];

export const DraftSessionPane: React.FC<Props> = ({
  draft,
  onUpdateDraft,
  onDiscard,
  onLaunched,
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [highlightPicker, setHighlightPicker] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 52), 240)}px`;
  }, [draft.prompt, draft.id]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, [draft.id]);

  const handlePickDir = async () => {
    const dir = await window.superHarness.pickDirectory();
    if (dir) onUpdateDraft({ cwd: dir });
  };

  const handleLaunch = async () => {
    if (!draft.harness) {
      setHighlightPicker(true);
      setError('Pick a harness above to start this conversation.');
      setTimeout(() => setHighlightPicker(false), 1200);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await window.superHarness.startSession({
        harness: draft.harness,
        cwd: draft.cwd,
        model: draft.model.trim() || undefined,
        prompt: draft.prompt.trim() || undefined,
        remoteControl: draft.remoteControl,
      });
      if (!res.ok) {
        setError(res.error || 'Failed to launch conversation');
      } else {
        onLaunched(res.sessionId);
      }
    } finally {
      setBusy(false);
    }
  };

  const selectedMeta = HARNESS_CHOICES.find((h) => h.id === draft.harness);
  const shortCwd = draft.cwd.split('/').filter(Boolean).slice(-2).join('/') || draft.cwd;

  return (
    <section className="flex-1 min-w-0 h-full flex flex-col bg-surface-canvas">
      {/* Header */}
      <header className="sh-drag-region h-11 px-4 border-b border-line-hairline flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {selectedMeta ? (
            <HarnessLogo harness={selectedMeta.logo} size={15} />
          ) : (
            <HelpCircle className="w-4 h-4 text-ink-muted shrink-0" />
          )}
          <h1 className="text-label font-medium text-ink-primary truncate">
            {selectedMeta ? `New ${selectedMeta.label} Conversation` : 'New Conversation'}
          </h1>
        </div>
        <IconButton label="Discard draft" onClick={onDiscard}>
          <X className="w-4 h-4" />
        </IconButton>
      </header>

      {/* Center Canvas */}
      <div className="flex-1 overflow-y-auto px-6 py-8 flex flex-col items-center justify-center">
        <div className="w-full max-w-[680px] space-y-6">
          <div className="text-center space-y-1.5">
            <div className="inline-flex items-center justify-center w-10 h-10 rounded-2xl bg-surface-subtle border border-line-subtle mb-1">
              {selectedMeta ? (
                <HarnessLogo harness={selectedMeta.logo} size={20} />
              ) : (
                <Sparkles className="w-5 h-5 text-ink-muted" />
              )}
            </div>
            <h2 className="text-base font-semibold text-ink-primary tracking-tight">
              {selectedMeta
                ? `Start a new ${selectedMeta.label} thread`
                : 'Choose a harness for this conversation'}
            </h2>
            <p className="text-caption text-ink-muted">
              {selectedMeta
                ? 'Type your first message below — Super Harness will launch and attach automatically.'
                : 'Pick Antigravity, Codex, or Claude below. You can switch anytime before sending.'}
            </p>
          </div>

          {/* Inline Harness Selector */}
          <div
            className={`grid grid-cols-2 sm:grid-cols-4 gap-2 p-1 rounded-2xl transition-all ${
              highlightPicker ? 'ring-2 ring-amber-400/60 bg-amber-400/[0.04]' : ''
            }`}
          >
            {HARNESS_CHOICES.map((h) => {
              const active = draft.harness === h.id;
              return (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => {
                    onUpdateDraft({ harness: h.id });
                    setError(null);
                  }}
                  className={`text-left p-3 rounded-xl border transition-colors cursor-pointer ${
                    active
                      ? 'bg-white/[0.09] border-line-strong text-ink-primary'
                      : 'bg-surface-subtle border-line-hairline text-ink-muted hover:text-ink-primary hover:border-line-subtle'
                  }`}
                >
                  <div className="flex items-center gap-2 text-caption font-semibold">
                    <HarnessLogo harness={h.logo} size={15} />
                    <span className="truncate">{h.label}</span>
                  </div>
                  <div className="text-[10px] text-ink-faint mt-1 leading-snug">{h.desc}</div>
                </button>
              );
            })}
          </div>

          {error && (
            <div className="rounded-xl border border-rose-500/25 bg-rose-500/[0.08] px-3.5 py-2.5 text-caption text-rose-200">
              {error}
            </div>
          )}

          {/* Inline Composer */}
          <div className="rounded-2xl border border-line-subtle focus-within:border-line-strong bg-surface-subtle transition-colors overflow-hidden">
            <textarea
              ref={textareaRef}
              rows={2}
              value={draft.prompt}
              onChange={(e) => onUpdateDraft({ prompt: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void handleLaunch();
                }
              }}
              placeholder={
                selectedMeta
                  ? `Message ${selectedMeta.label}…`
                  : 'Select a harness above, then type your message…'
              }
              className="w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-body text-ink-primary placeholder:text-ink-faint focus:outline-none focus-visible:shadow-none max-h-60 overflow-y-auto leading-relaxed"
            />

            <div className="px-3 pb-2.5 pt-0.5 flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                <Button
                  size="xs"
                  variant="subtle"
                  onClick={() => void handlePickDir()}
                  title={draft.cwd}
                  iconLeft={<FolderOpen className="w-3 h-3 text-ink-muted" />}
                >
                  {shortCwd}
                </Button>

                <input
                  value={draft.model}
                  onChange={(e) => onUpdateDraft({ model: e.target.value })}
                  placeholder="Model (default)"
                  className="h-7 w-32 bg-white/[0.04] border border-line-hairline rounded-md px-2 text-micro text-ink-secondary placeholder:text-ink-faint focus:outline-none focus:border-line-subtle"
                />

                {draft.harness === 'claude-tmux' && (
                  <button
                    type="button"
                    onClick={() => onUpdateDraft({ remoteControl: !draft.remoteControl })}
                    className={`h-7 inline-flex items-center gap-1 px-2 rounded-md border text-micro transition-colors cursor-pointer ${
                      draft.remoteControl
                        ? 'bg-indigo-500/15 border-indigo-400/30 text-indigo-200'
                        : 'bg-white/[0.03] border-line-hairline text-ink-faint hover:text-ink-secondary'
                    }`}
                  >
                    <Radio className="w-3 h-3" />
                    <span>Remote</span>
                  </button>
                )}
              </div>

              <button
                type="button"
                disabled={busy}
                onClick={() => void handleLaunch()}
                title="Start conversation (Enter)"
                className="w-7 h-7 rounded-full bg-ink-primary text-surface-rail flex items-center justify-center hover:bg-white disabled:opacity-35 transition-all cursor-pointer shrink-0"
              >
                {busy ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <ArrowUp className="w-4 h-4" />
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
