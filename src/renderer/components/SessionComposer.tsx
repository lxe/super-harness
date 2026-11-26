import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  ImagePlus,
  Loader2,
  Search,
  Square,
  X,
} from 'lucide-react';
import type {
  HarnessCatalog,
  ImageAttachment,
  UnifiedSession,
} from '../../shared/types';
import { Badge, IconButton, PopoverSurface } from '../ui';
import { getHarnessVisual, mediaUrlForPath } from '../utils/format';
import {
  formatEffortLabel,
  getEffortHint,
  resolveEffortSelectionChange,
  resolveModelSelectionChange,
  resolveSessionModelControls,
} from '../utils/modelOptions';
import { HarnessLogo } from './HarnessLogo';
import type { PreviewImageItem } from './ImageLightbox';

export interface SessionComposerProps {
  session: UnifiedSession;
  isMaster: boolean;
  catalog?: HarnessCatalog | null;
  onChangeModel?: (patch: { model?: string; reasoningEffort?: string }) => void;
  input: string;
  attachments: ImageAttachment[];
  sending: boolean;
  isStreaming: boolean;
  isAgentBusy: boolean;
  dispatchNote: string | null;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onInputChange: (next: string) => void;
  onRemoveAttachment: (id: string) => void;
  onPreviewImage?: (images: PreviewImageItem[], index: number) => void;
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  onDropFiles: (files: FileList) => void;
  onPickImages: () => void;
  onSend: () => void;
  onAbort: () => void;
}

/**
 * Borderless obsidian chat composer with auto-grow textarea, drag/paste image
 * attachments, interactive per-harness model & thinking selectors, stop control,
 * and queue-aware send button.
 */
export const SessionComposer: React.FC<SessionComposerProps> = React.memo(
  ({
    session,
    isMaster,
    catalog,
    onChangeModel,
    input,
    attachments,
    sending,
    isStreaming,
    isAgentBusy,
    dispatchNote,
    textareaRef,
    onInputChange,
    onRemoveAttachment,
    onPreviewImage,
    onPaste,
    onDropFiles,
    onPickImages,
    onSend,
    onAbort,
  }) => {
    const [dragOver, setDragOver] = useState(false);
    const [modelMenuOpen, setModelMenuOpen] = useState(false);
    const [thinkingMenuOpen, setThinkingMenuOpen] = useState(false);
    const [modelSearch, setModelSearch] = useState('');

    const modelTriggerRef = useRef<HTMLButtonElement | null>(null);
    const thinkingTriggerRef = useRef<HTMLButtonElement | null>(null);

    // Close open menus on session switch
    useEffect(() => {
      setModelMenuOpen(false);
      setThinkingMenuOpen(false);
      setModelSearch('');
    }, [session.id]);

    // Auto-grow composer textarea smoothly up to 240px
    useEffect(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = `${Math.min(Math.max(el.scrollHeight, 44), 240)}px`;
    }, [input, session.id, textareaRef]);

    const vis = getHarnessVisual(session.harness);
    const canSwitchModel = !isMaster && session.harnessGroup !== 'master' && Boolean(onChangeModel);

    const modelControls = useMemo(() => {
      if (session.harnessGroup === 'master') return null;
      return resolveSessionModelControls(
        session.harnessGroup,
        session.model,
        session.reasoningEffort,
        catalog,
        vis.label
      );
    }, [session.harnessGroup, session.model, session.reasoningEffort, catalog, vis.label]);

    const filteredModels = useMemo(() => {
      const list = modelControls?.models ?? [];
      const q = modelSearch.trim().toLowerCase();
      if (!q) return list;
      return list.filter(
        (m) =>
          m.label.toLowerCase().includes(q) ||
          m.id.toLowerCase().includes(q) ||
          (m.group || '').toLowerCase().includes(q)
      );
    }, [modelControls?.models, modelSearch]);

    const groupedModels = useMemo(() => {
      const hasGroups = filteredModels.some((m) => Boolean(m.group));
      if (!hasGroups) {
        return [{ group: '', items: filteredModels }];
      }
      const map = new Map<string, typeof filteredModels>();
      for (const m of filteredModels) {
        const g = m.group || 'Other';
        if (!map.has(g)) map.set(g, []);
        map.get(g)!.push(m);
      }
      return Array.from(map.entries()).map(([group, items]) => ({ group, items }));
    }, [filteredModels]);

    const handleSelectModel = (modelId: string) => {
      if (!onChangeModel || session.harnessGroup === 'master' || !modelControls) return;
      const patch = resolveModelSelectionChange(
        session.harnessGroup,
        modelId,
        session.reasoningEffort,
        modelControls.models
      );
      onChangeModel(patch);
      setModelMenuOpen(false);
      setModelSearch('');
    };

    const handleSelectThinking = (level: string) => {
      if (!onChangeModel || session.harnessGroup === 'master' || !modelControls) return;
      const patch = resolveEffortSelectionChange(
        session.harnessGroup,
        level,
        session.model,
        modelControls.models
      );
      onChangeModel(patch);
      setThinkingMenuOpen(false);
    };

    const activeModelId = modelControls?.activeModelOption?.id || session.model;

    return (
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer?.files?.length) {
            onDropFiles(e.dataTransfer.files);
          }
        }}
        className={`relative rounded-2xl border bg-surface-subtle transition-colors ${
          dragOver
            ? 'border-line-strong bg-surface-raised'
            : 'border-line-subtle focus-within:border-line-strong'
        }`}
      >
        {attachments.length > 0 && (
          <div className="px-3.5 pt-3 pb-1 flex items-center gap-2 flex-wrap">
            {attachments.map((att, idx) => (
              <div
                key={att.id}
                className="relative group w-14 h-14 rounded-xl overflow-hidden border border-line-subtle hover:border-line-strong bg-black/40 transition-colors"
              >
                <button
                  type="button"
                  onClick={() =>
                    onPreviewImage?.(
                      attachments.map((a) => ({
                        src: a.previewDataUrl || mediaUrlForPath(a.path),
                        name: a.name,
                        path: a.path,
                      })),
                      idx
                    )
                  }
                  title={`Preview ${att.name}`}
                  className="w-full h-full block cursor-pointer"
                >
                  <img
                    src={att.previewDataUrl}
                    alt={att.name}
                    className="w-full h-full object-cover hover:brightness-110 transition-all"
                  />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveAttachment(att.id);
                  }}
                  title="Remove image"
                  aria-label="Remove image"
                  className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/80 text-ink-primary flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={textareaRef}
          rows={2}
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          placeholder={
            isMaster
              ? 'Ask Master Orchestrator anything, or type /status, /auto-organize…'
              : 'Ask anything, paste screenshots (Ctrl+V)…'
          }
          className="w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-body text-ink-primary placeholder:text-ink-faint focus:outline-none focus-visible:shadow-none max-h-60 overflow-y-auto leading-relaxed"
        />

        <div className="px-3 pb-2.5 pt-0.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1 min-w-0">
            <IconButton label="Attach image (or Ctrl+V to paste)" onClick={onPickImages}>
              <ImagePlus className="w-4 h-4" />
            </IconButton>

            {canSwitchModel && modelControls ? (
              <>
                {/* Model Selector */}
                <div className="relative min-w-0">
                  <button
                    ref={modelTriggerRef}
                    type="button"
                    onClick={() => {
                      setModelMenuOpen((v) => !v);
                      setThinkingMenuOpen(false);
                    }}
                    title="Switch model"
                    aria-label="Switch model"
                    aria-expanded={modelMenuOpen}
                    className={`h-7 px-2 rounded-lg flex items-center gap-1.5 text-caption transition-colors cursor-pointer max-w-[230px] focus:outline-none focus-visible:shadow-none ${
                      modelMenuOpen
                        ? 'bg-white/[0.09] text-ink-primary'
                        : 'text-ink-muted hover:text-ink-primary hover:bg-white/[0.06]'
                    }`}
                  >
                    <HarnessLogo harness={session.harness} size={14} />
                    <span className="truncate">{modelControls.displayModelLabel}</span>
                    <ChevronDown className="w-3 h-3 text-ink-faint shrink-0" />
                  </button>

                  {modelMenuOpen && (
                    <PopoverSurface
                      width="md"
                      onClose={() => {
                        setModelMenuOpen(false);
                        setModelSearch('');
                      }}
                      ignoreRef={modelTriggerRef}
                      className="absolute left-0 bottom-full mb-2 z-50 w-72 p-1.5"
                    >
                      {modelControls.models.length > 6 && (
                        <div className="px-1.5 pb-1.5">
                          <div className="h-8 flex items-center gap-2 px-2.5 rounded-lg bg-surface-subtle border border-line-subtle focus-within:border-line-strong">
                            <Search className="w-3.5 h-3.5 text-ink-faint shrink-0" />
                            <input
                              autoFocus
                              type="text"
                              value={modelSearch}
                              onChange={(e) => setModelSearch(e.target.value)}
                              placeholder="Filter models…"
                              className="flex-1 min-w-0 bg-transparent text-caption text-ink-primary placeholder:text-ink-faint focus:outline-none focus-visible:shadow-none"
                            />
                            {modelSearch && (
                              <button
                                type="button"
                                onClick={() => setModelSearch('')}
                                className="text-ink-faint hover:text-ink-primary cursor-pointer"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                        </div>
                      )}

                      <div className="max-h-72 overflow-y-auto space-y-1">
                        {filteredModels.length === 0 ? (
                          <div className="px-2.5 py-4 text-center text-caption text-ink-muted">
                            No models available
                          </div>
                        ) : (
                          groupedModels.map(({ group, items }) => (
                            <div key={group || 'all'} className="space-y-0.5">
                              {group && (
                                <div className="px-2.5 pt-1.5 pb-0.5 text-micro font-semibold uppercase tracking-[0.06em] text-ink-faint">
                                  {group}
                                </div>
                              )}
                              {items.map((m) => {
                                const isSelected = m.id === activeModelId;
                                return (
                                  <button
                                    key={m.id}
                                    type="button"
                                    onClick={() => handleSelectModel(m.id)}
                                    className={`w-full px-2.5 py-1.5 rounded-lg text-left flex items-center justify-between gap-2 transition-colors cursor-pointer ${
                                      isSelected
                                        ? 'bg-white/[0.09] text-ink-primary'
                                        : 'text-ink-secondary hover:bg-white/[0.05] hover:text-ink-primary'
                                    }`}
                                  >
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center gap-1.5 min-w-0">
                                        <span className="text-caption font-medium truncate">
                                          {m.label}
                                        </span>
                                        {m.isDefault && <Badge tone="neutral">default</Badge>}
                                      </div>
                                      {m.label !== m.id && (
                                        <div className="text-micro font-mono text-ink-faint truncate">
                                          {m.id}
                                        </div>
                                      )}
                                    </div>
                                    {isSelected && (
                                      <Check className="w-3.5 h-3.5 text-ink-primary shrink-0" />
                                    )}
                                  </button>
                                );
                              })}
                            </div>
                          ))
                        )}
                      </div>
                    </PopoverSurface>
                  )}
                </div>

                {/* Thinking / Reasoning Effort Selector */}
                {modelControls.thinkingLevels.length > 0 && (
                  <div className="relative shrink-0">
                    <button
                      ref={thinkingTriggerRef}
                      type="button"
                      onClick={() => {
                        setThinkingMenuOpen((v) => !v);
                        setModelMenuOpen(false);
                      }}
                      title="Switch thinking / reasoning level"
                      aria-label="Switch thinking level"
                      aria-expanded={thinkingMenuOpen}
                      className={`h-7 px-2 rounded-lg flex items-center gap-1.5 text-caption transition-colors cursor-pointer focus:outline-none focus-visible:shadow-none ${
                        thinkingMenuOpen
                          ? 'bg-white/[0.09] text-ink-primary'
                          : 'text-ink-muted hover:text-ink-primary hover:bg-white/[0.06]'
                      }`}
                    >
                      <Brain className="w-3.5 h-3.5 text-ink-faint shrink-0" />
                      <span>
                        {modelControls.activeEffort
                          ? formatEffortLabel(modelControls.activeEffort)
                          : 'Thinking'}
                      </span>
                      <ChevronDown className="w-3 h-3 text-ink-faint shrink-0" />
                    </button>

                    {thinkingMenuOpen && (
                      <PopoverSurface
                        width="sm"
                        onClose={() => setThinkingMenuOpen(false)}
                        ignoreRef={thinkingTriggerRef}
                        className="absolute left-0 bottom-full mb-2 z-50 w-56 p-1.5 space-y-0.5"
                      >
                        <div className="px-2.5 pt-1 pb-1 text-micro font-semibold uppercase tracking-[0.06em] text-ink-faint">
                          Thinking effort
                        </div>
                        {modelControls.thinkingLevels.map((lvl) => {
                          const isSelected = modelControls.activeEffort === lvl;
                          const isDefault = modelControls.defaultEffort === lvl;
                          const hint = getEffortHint(lvl);
                          return (
                            <button
                              key={lvl}
                              type="button"
                              onClick={() => handleSelectThinking(lvl)}
                              className={`w-full px-2.5 py-1.5 rounded-lg text-left flex items-center justify-between gap-2 transition-colors cursor-pointer ${
                                isSelected
                                  ? 'bg-white/[0.09] text-ink-primary'
                                  : 'text-ink-secondary hover:bg-white/[0.05] hover:text-ink-primary'
                              }`}
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-caption font-medium">
                                    {formatEffortLabel(lvl)}
                                  </span>
                                  {isDefault && <Badge tone="neutral">default</Badge>}
                                </div>
                                {hint && (
                                  <div className="text-micro text-ink-faint truncate">{hint}</div>
                                )}
                              </div>
                              {isSelected && (
                                <Check className="w-3.5 h-3.5 text-ink-primary shrink-0" />
                              )}
                            </button>
                          );
                        })}
                      </PopoverSurface>
                    )}
                  </div>
                )}

                {dispatchNote ? (
                  <span className="text-micro text-ink-faint truncate pl-1">
                    · {dispatchNote}
                  </span>
                ) : session.liveOwner === 'desktop' ? (
                  <span
                    title={
                      session.harnessGroup === 'claude'
                        ? 'This tab is currently open in Claude Desktop. Sending from Super Harness works via Claude stream-json; reopen the tab in Claude Desktop to refresh its view.'
                        : 'Antigravity Desktop is currently running a turn on this conversation.'
                    }
                    className="text-micro text-amber-300/75 truncate pl-1"
                  >
                    · Open in Desktop
                  </span>
                ) : session.liveOwner === 'tmux' ? (
                  <span className="text-micro text-emerald-300/75 truncate pl-1">
                    · Live tmux
                  </span>
                ) : null}
              </>
            ) : (
              <div className="flex items-center gap-2 min-w-0 pl-1">
                <HarnessLogo harness={session.harness} size={14} />
                <span className="text-caption text-ink-muted truncate">
                  {session.model || vis.label}
                  {dispatchNote ? ` · ${dispatchNote}` : ''}
                </span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {(isStreaming || isAgentBusy) &&
            (isMaster || (!input.trim() && attachments.length === 0)) ? (
              <button
                type="button"
                onClick={onAbort}
                title="Stop"
                aria-label="Stop"
                className="w-7 h-7 rounded-full bg-ink-primary text-surface-rail flex items-center justify-center hover:bg-white transition-all cursor-pointer"
              >
                <Square className="w-3 h-3 fill-current" />
              </button>
            ) : (
              <button
                type="button"
                disabled={sending || (!input.trim() && attachments.length === 0)}
                onClick={onSend}
                title={
                  isAgentBusy ? 'Queue message (sends after agent finishes)' : 'Send (Enter)'
                }
                aria-label={isAgentBusy ? 'Queue message' : 'Send'}
                className="w-7 h-7 rounded-full bg-ink-primary text-surface-rail flex items-center justify-center hover:bg-white disabled:opacity-25 disabled:cursor-not-allowed transition-all cursor-pointer"
              >
                {sending ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <ArrowUp className="w-4 h-4" />
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
);
