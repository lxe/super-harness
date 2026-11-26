import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  Cpu,
  FolderOpen,
  FolderPlus,
  HelpCircle,
  Loader2,
  Radio,
  Search,
  Sparkles,
  Terminal,
  X,
} from 'lucide-react';
import type {
  HarnessCatalog,
  HarnessGroup,
  HarnessModelOption,
  StartSessionRequest,
} from '../../shared/types';
import { Badge, Button, IconButton, MenuDivider, PopoverSurface } from '../ui';
import { HarnessLogo } from './HarnessLogo';

export interface DraftConversation {
  id: string;
  harness: StartSessionRequest['harness'] | null;
  cwd: string;
  model: string;
  reasoningEffort?: string;
  remoteControl: boolean;
  prompt: string;
  createdAt: number;
}

const EFFORT_META: Record<string, { label: string; hint: string }> = {
  low: { label: 'Low', hint: 'Fastest responses, light reasoning' },
  medium: { label: 'Medium', hint: 'Balanced speed & reasoning depth' },
  high: { label: 'High', hint: 'Thorough multi-step reasoning' },
  xhigh: { label: 'Extra High', hint: 'Extended deep reasoning' },
  max: { label: 'Max', hint: 'Maximum thinking budget' },
  ultra: { label: 'Ultra', hint: 'Deepest possible reasoning' },
};

const AGY_SUFFIX_RE = /^(.*)-(low|medium|high|xhigh|max)$/i;

function formatEffortLabel(level: string): string {
  return EFFORT_META[level.toLowerCase()]?.label ?? level;
}

interface Props {
  draft: DraftConversation;
  catalog?: HarnessCatalog | null;
  onRefreshCatalog?: () => void;
  onUpdateDraft: (patch: Partial<DraftConversation>) => void;
  onDiscard: () => void;
  onLaunched: (sessionId?: string) => void;
}

function groupForDraftHarness(h: StartSessionRequest['harness'] | null): HarnessGroup | null {
  if (!h) return null;
  if (h === 'antigravity') return 'antigravity';
  if (h === 'codex') return 'codex';
  return 'claude';
}

function shortenPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  if (parts.length <= 2) return p;
  return `…/${parts.slice(-2).join('/')}`;
}

export const DraftSessionPane: React.FC<Props> = ({
  draft,
  catalog,
  onRefreshCatalog,
  onUpdateDraft,
  onDiscard,
  onLaunched,
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [highlightPicker, setHighlightPicker] = useState(false);

  // Remember preferred Claude launch mode (defaults to idiomatic tmux + remote-control)
  const [claudeMode, setClaudeMode] = useState<'claude-tmux' | 'claude-cli'>(
    draft.harness === 'claude-cli' ? 'claude-cli' : 'claude-tmux'
  );
  const [claudeMenuOpen, setClaudeMenuOpen] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [thinkingMenuOpen, setThinkingMenuOpen] = useState(false);

  const [projectSearch, setProjectSearch] = useState('');
  const [modelSearch, setModelSearch] = useState('');
  const [creatingProject, setCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectError, setNewProjectError] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const claudeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const projectTriggerRef = useRef<HTMLButtonElement | null>(null);
  const modelTriggerRef = useRef<HTMLButtonElement | null>(null);
  const thinkingTriggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (draft.harness === 'claude-tmux' || draft.harness === 'claude-cli') {
      setClaudeMode(draft.harness);
    }
  }, [draft.harness]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 56), 240)}px`;
  }, [draft.prompt, draft.id]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, [draft.id]);

  const selectedGroup = groupForDraftHarness(draft.harness);

  const availableModels = useMemo<HarnessModelOption[]>(() => {
    if (!selectedGroup || !catalog) return [];
    return catalog.models[selectedGroup] ?? [];
  }, [selectedGroup, catalog]);

  const filteredModels = useMemo(() => {
    const q = modelSearch.trim().toLowerCase();
    if (!q) return availableModels;
    return availableModels.filter(
      (m) =>
        m.label.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        (m.group || '').toLowerCase().includes(q)
    );
  }, [availableModels, modelSearch]);

  const defaultModelOption = useMemo(
    () => availableModels.find((m) => m.isDefault),
    [availableModels]
  );

  const selectedModelOption = useMemo(
    () => availableModels.find((m) => m.id === draft.model),
    [availableModels, draft.model]
  );

  // Resolve available thinking / reasoning modes for the active harness + model
  const activeModelForThinking = selectedModelOption || defaultModelOption || availableModels[0];
  const availableThinkingLevels = useMemo<string[]>(() => {
    if (!selectedGroup) return [];
    if (activeModelForThinking?.reasoningLevels && activeModelForThinking.reasoningLevels.length > 0) {
      return activeModelForThinking.reasoningLevels;
    }
    if (selectedGroup === 'codex') return ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
    if (selectedGroup === 'claude') return ['low', 'medium', 'high', 'xhigh', 'max'];
    return ['low', 'medium', 'high', 'xhigh'];
  }, [selectedGroup, activeModelForThinking]);

  const defaultThinkingLevel = useMemo(() => {
    if (!selectedGroup) return undefined;
    if (selectedGroup === 'antigravity') {
      return activeModelForThinking?.defaultReasoningLevel || catalog?.defaultReasoningEffort?.antigravity;
    }
    return (
      catalog?.defaultReasoningEffort?.[selectedGroup] ||
      activeModelForThinking?.defaultReasoningLevel
    );
  }, [selectedGroup, activeModelForThinking, catalog?.defaultReasoningEffort]);

  const handleSelectModel = (modelId: string) => {
    const picked = availableModels.find((m) => m.id === modelId);
    if (selectedGroup === 'antigravity') {
      const suffixMatch = modelId.match(AGY_SUFFIX_RE);
      onUpdateDraft({
        model: modelId,
        reasoningEffort: suffixMatch ? suffixMatch[2].toLowerCase() : '',
      });
    } else {
      const nextEffort =
        draft.reasoningEffort &&
        picked?.reasoningLevels &&
        !picked.reasoningLevels.includes(draft.reasoningEffort)
          ? ''
          : draft.reasoningEffort;
      onUpdateDraft({ model: modelId, reasoningEffort: nextEffort });
    }
    setModelMenuOpen(false);
  };

  const handleSelectThinking = (level: string) => {
    if (selectedGroup === 'antigravity' && level) {
      // Antigravity encodes thinking effort directly into the model slug (e.g. gemini-4-neon-xhigh)
      const baseModel = selectedModelOption || defaultModelOption || availableModels[0];
      const m = baseModel?.id.match(AGY_SUFFIX_RE);
      if (m) {
        const candidateId = `${m[1]}-${level}`;
        if (availableModels.some((x) => x.id === candidateId)) {
          onUpdateDraft({ model: candidateId, reasoningEffort: level });
          setThinkingMenuOpen(false);
          return;
        }
      }
    }
    onUpdateDraft({ reasoningEffort: level });
    setThinkingMenuOpen(false);
  };

  const projects = useMemo(() => {
    const all = catalog?.projects ?? [];
    const q = projectSearch.trim().toLowerCase();
    const filtered = q
      ? all.filter(
          (p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q)
        )
      : all;
    if (!selectedGroup) return filtered;
    // Gently float projects already used by the selected harness to the top
    return [...filtered].sort((a, b) => {
      const aMatch = a.harnesses.includes(selectedGroup) ? 0 : 1;
      const bMatch = b.harnesses.includes(selectedGroup) ? 0 : 1;
      return aMatch - bMatch;
    });
  }, [catalog?.projects, projectSearch, selectedGroup]);

  const selectedProjectLabel = useMemo(() => {
    const match = (catalog?.projects ?? []).find((p) => p.path === draft.cwd);
    if (match) return match.name;
    const parts = draft.cwd.split('/').filter(Boolean);
    return parts[parts.length - 1] || draft.cwd || '~';
  }, [catalog?.projects, draft.cwd]);

  const handleSelectHarness = (nextHarness: StartSessionRequest['harness']) => {
    const nextGroup = groupForDraftHarness(nextHarness);
    const switchingGroup = nextGroup !== selectedGroup;
    onUpdateDraft({
      harness: nextHarness,
      // Reset model & thinking selection when switching between different harnesses
      ...(switchingGroup ? { model: '', reasoningEffort: '' } : {}),
    });
    setError(null);
  };

  const handleBrowseFolder = async () => {
    const dir = await window.superHarness.pickDirectory();
    if (dir) {
      onUpdateDraft({ cwd: dir });
      setProjectMenuOpen(false);
    }
  };

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProjectName.trim()) return;
    setNewProjectError(null);
    const res = await window.superHarness.createProjectDirectory(draft.cwd, newProjectName.trim());
    if (!res.ok || !res.path) {
      setNewProjectError(res.error || 'Could not create directory');
      return;
    }
    onUpdateDraft({ cwd: res.path });
    setNewProjectName('');
    setCreatingProject(false);
    setProjectMenuOpen(false);
    onRefreshCatalog?.();
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
        reasoningEffort: draft.reasoningEffort?.trim() || undefined,
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

  const headerTitle =
    selectedGroup === 'antigravity'
      ? 'Antigravity'
      : selectedGroup === 'codex'
        ? 'Codex'
        : selectedGroup === 'claude'
          ? draft.harness === 'claude-cli'
            ? 'Claude CLI'
            : 'Claude'
          : null;

  return (
    <section className="flex-1 min-w-0 h-full flex flex-col bg-surface-canvas">
      {/* Header */}
      <header className="sh-drag-region h-11 px-4 border-b border-line-hairline flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {selectedGroup ? (
            <HarnessLogo harness={selectedGroup} size={16} />
          ) : (
            <HelpCircle className="w-4 h-4 text-ink-muted shrink-0" />
          )}
          <h1 className="text-label font-medium text-ink-primary truncate">
            {headerTitle ? `New ${headerTitle} Conversation` : 'New Conversation'}
          </h1>
        </div>
        <IconButton label="Discard draft" onClick={onDiscard}>
          <X className="w-4 h-4" />
        </IconButton>
      </header>

      {/* Center Canvas */}
      <div className="flex-1 overflow-y-auto px-6 py-8 flex flex-col items-center justify-center">
        <div className="w-full max-w-[720px] space-y-6">
          <div className="text-center space-y-2">
            <div className="inline-flex items-center justify-center w-11 h-11 rounded-2xl bg-surface-subtle border border-line-subtle mb-1">
              {selectedGroup ? (
                <HarnessLogo harness={selectedGroup} size={22} />
              ) : (
                <Sparkles className="w-5 h-5 text-ink-muted" />
              )}
            </div>
            <h2 className="text-[18px] font-semibold text-ink-primary tracking-tight">
              {headerTitle
                ? `Start a new ${headerTitle} thread`
                : 'Choose a harness for this conversation'}
            </h2>
            <p className="text-body text-ink-muted">
              {headerTitle
                ? 'Choose a project & model below, then send your first message.'
                : 'Pick Antigravity, Codex, or Claude below. You can switch anytime before sending.'}
            </p>
          </div>

          {/* 3-Card Harness Selector (Claude has split dropdown for tmux vs Headless CLI) */}
          <div
            className={`grid grid-cols-1 sm:grid-cols-3 gap-2.5 p-1 rounded-2xl transition-all ${
              highlightPicker ? 'ring-2 ring-amber-400/60 bg-amber-400/[0.04]' : ''
            }`}
          >
            {/* Antigravity */}
            <button
              type="button"
              onClick={() => handleSelectHarness('antigravity')}
              className={`text-left p-3.5 rounded-xl border transition-colors cursor-pointer ${
                selectedGroup === 'antigravity'
                  ? 'bg-white/[0.09] border-line-strong text-ink-primary'
                  : 'bg-surface-subtle border-line-hairline text-ink-muted hover:text-ink-primary hover:border-line-subtle'
              }`}
            >
              <div className="flex items-center gap-2 text-label font-semibold">
                <HarnessLogo harness="antigravity" size={16} />
                <span className="truncate">Antigravity</span>
              </div>
              <div className="text-caption text-ink-faint mt-1 leading-snug">
                Direct ACP conversation
              </div>
            </button>

            {/* Codex */}
            <button
              type="button"
              onClick={() => handleSelectHarness('codex')}
              className={`text-left p-3.5 rounded-xl border transition-colors cursor-pointer ${
                selectedGroup === 'codex'
                  ? 'bg-white/[0.09] border-line-strong text-ink-primary'
                  : 'bg-surface-subtle border-line-hairline text-ink-muted hover:text-ink-primary hover:border-line-subtle'
              }`}
            >
              <div className="flex items-center gap-2 text-label font-semibold">
                <HarnessLogo harness="codex" size={16} />
                <span className="truncate">Codex</span>
              </div>
              <div className="text-caption text-ink-faint mt-1 leading-snug">
                OpenAI Codex thread
              </div>
            </button>

            {/* Claude (defaults to tmux + Remote Control, with dropdown for Headless CLI) */}
            <div className="relative">
              <div
                onClick={() => handleSelectHarness(claudeMode)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleSelectHarness(claudeMode);
                  }
                }}
                className={`h-full text-left p-3.5 rounded-xl border transition-colors cursor-pointer ${
                  selectedGroup === 'claude'
                    ? 'bg-white/[0.09] border-line-strong text-ink-primary'
                    : 'bg-surface-subtle border-line-hairline text-ink-muted hover:text-ink-primary hover:border-line-subtle'
                }`}
              >
                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex items-center gap-2 text-label font-semibold min-w-0">
                    <HarnessLogo harness="claude" size={16} />
                    <span className="truncate">Claude</span>
                  </div>
                  <button
                    ref={claudeTriggerRef}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setClaudeMenuOpen((v) => !v);
                      setProjectMenuOpen(false);
                      setModelMenuOpen(false);
                      setThinkingMenuOpen(false);
                    }}
                    title="Choose Claude runtime mode"
                    aria-label="Choose Claude runtime mode"
                    className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-micro font-medium text-ink-muted hover:text-ink-primary hover:bg-white/[0.1] transition-colors shrink-0 cursor-pointer"
                  >
                    <span>{claudeMode === 'claude-tmux' ? 'tmux' : 'CLI'}</span>
                    <ChevronDown className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="text-caption text-ink-faint mt-1 leading-snug">
                  {claudeMode === 'claude-tmux'
                    ? 'Persistent tmux + remote control'
                    : 'Resumable headless CLI'}
                </div>
              </div>

              {claudeMenuOpen && (
                <PopoverSurface
                  width="auto"
                  onClose={() => setClaudeMenuOpen(false)}
                  ignoreRef={claudeTriggerRef}
                  className="absolute right-0 top-[calc(100%+6px)] z-40 w-64 p-1.5 space-y-1"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setClaudeMode('claude-tmux');
                      handleSelectHarness('claude-tmux');
                      setClaudeMenuOpen(false);
                    }}
                    className={`w-full text-left px-2.5 py-2 rounded-lg transition-colors cursor-pointer ${
                      claudeMode === 'claude-tmux'
                        ? 'bg-white/[0.09] text-ink-primary'
                        : 'text-ink-secondary hover:bg-white/[0.05]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 text-label font-medium">
                        <Terminal className="w-3.5 h-3.5 text-brand-claude" />
                        tmux + Remote Control
                      </span>
                      {claudeMode === 'claude-tmux' && <Check className="w-3.5 h-3.5 text-ink-primary" />}
                    </div>
                    <p className="text-micro text-ink-muted mt-0.5 leading-snug">
                      Recommended · persistent shell, live terminal mirror &amp; mobile control
                    </p>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setClaudeMode('claude-cli');
                      handleSelectHarness('claude-cli');
                      setClaudeMenuOpen(false);
                    }}
                    className={`w-full text-left px-2.5 py-2 rounded-lg transition-colors cursor-pointer ${
                      claudeMode === 'claude-cli'
                        ? 'bg-white/[0.09] text-ink-primary'
                        : 'text-ink-secondary hover:bg-white/[0.05]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 text-label font-medium">
                        <Cpu className="w-3.5 h-3.5 text-ink-muted" />
                        Headless CLI
                      </span>
                      {claudeMode === 'claude-cli' && <Check className="w-3.5 h-3.5 text-ink-primary" />}
                    </div>
                    <p className="text-micro text-ink-muted mt-0.5 leading-snug">
                      Lightweight one-shot / resumable `claude -p` turn without tmux
                    </p>
                  </button>
                </PopoverSurface>
              )}
            </div>
          </div>

          {error && (
            <div className="rounded-xl border border-rose-500/25 bg-rose-500/[0.08] px-3.5 py-2.5 text-caption text-rose-200">
              {error}
            </div>
          )}

          {/* Inline Composer */}
          <div className="rounded-2xl border border-line-subtle focus-within:border-line-strong bg-surface-subtle transition-colors">
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
                headerTitle
                  ? `Message ${headerTitle}…`
                  : 'Select a harness above, then type your message…'
              }
              className="w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-body text-ink-primary placeholder:text-ink-faint focus:outline-none focus-visible:shadow-none max-h-60 overflow-y-auto leading-relaxed"
            />

            <div className="px-3 pb-3 pt-1 flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2 flex-wrap min-w-0">
                {/* Project Selector Popover */}
                <div className="relative">
                  <button
                    ref={projectTriggerRef}
                    type="button"
                    onClick={() => {
                      setProjectMenuOpen((v) => !v);
                      setModelMenuOpen(false);
                      setThinkingMenuOpen(false);
                      setClaudeMenuOpen(false);
                      setCreatingProject(false);
                      setNewProjectError(null);
                    }}
                    title={draft.cwd}
                    className="h-8 inline-flex items-center gap-1.5 px-2.5 rounded-lg bg-white/[0.05] border border-line-hairline hover:border-line-subtle hover:bg-white/[0.08] text-caption text-ink-secondary hover:text-ink-primary transition-colors cursor-pointer max-w-[220px]"
                  >
                    <FolderOpen className="w-3.5 h-3.5 text-ink-muted shrink-0" />
                    <span className="truncate font-medium">{selectedProjectLabel}</span>
                    <ChevronDown className="w-3.5 h-3.5 text-ink-faint shrink-0" />
                  </button>

                  {projectMenuOpen && (
                    <PopoverSurface
                      width="auto"
                      onClose={() => setProjectMenuOpen(false)}
                      ignoreRef={projectTriggerRef}
                      className="absolute left-0 bottom-[calc(100%+8px)] z-40 w-80 p-2 space-y-2"
                    >
                      <div className="flex items-center gap-2 px-2.5 h-8 rounded-lg bg-surface-code border border-line-hairline focus-within:border-line-subtle">
                        <Search className="w-3.5 h-3.5 text-ink-faint shrink-0" />
                        <input
                          autoFocus
                          value={projectSearch}
                          onChange={(e) => setProjectSearch(e.target.value)}
                          placeholder="Search harness projects…"
                          className="flex-1 min-w-0 bg-transparent text-caption text-ink-primary placeholder:text-ink-faint focus:outline-none focus-visible:shadow-none"
                        />
                      </div>

                      <div className="max-h-56 overflow-y-auto space-y-0.5 pr-0.5">
                        {projects.length === 0 ? (
                          <div className="px-2.5 py-3 text-caption text-ink-faint text-center">
                            No matching projects
                          </div>
                        ) : (
                          projects.map((proj) => {
                            const active = draft.cwd === proj.path;
                            return (
                              <button
                                key={proj.path}
                                type="button"
                                onClick={() => {
                                  onUpdateDraft({ cwd: proj.path });
                                  setProjectMenuOpen(false);
                                }}
                                className={`w-full text-left px-2.5 py-2 rounded-lg flex items-center justify-between gap-2 transition-colors cursor-pointer ${
                                  active
                                    ? 'bg-white/[0.1] text-ink-primary'
                                    : 'text-ink-secondary hover:bg-white/[0.05]'
                                }`}
                              >
                                <div className="min-w-0 flex-1">
                                  <div className="text-caption font-medium truncate">
                                    {proj.name}
                                  </div>
                                  <div className="text-micro font-mono text-ink-faint truncate">
                                    {shortenPath(proj.path)}
                                  </div>
                                </div>
                                <div className="flex items-center gap-1 shrink-0">
                                  {proj.harnesses.map((h) => (
                                    <HarnessLogo key={h} harness={h} size={12} />
                                  ))}
                                  {active && <Check className="w-3.5 h-3.5 text-ink-primary ml-0.5" />}
                                </div>
                              </button>
                            );
                          })
                        )}
                      </div>

                      <MenuDivider />

                      {creatingProject ? (
                        <form onSubmit={(e) => void handleCreateProject(e)} className="space-y-2 p-1">
                          <div className="text-micro text-ink-muted">
                            Create inside <span className="font-mono text-ink-secondary">{shortenPath(draft.cwd)}</span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <input
                              autoFocus
                              value={newProjectName}
                              onChange={(e) => setNewProjectName(e.target.value)}
                              placeholder="new-project-name"
                              className="flex-1 min-w-0 h-8 px-2.5 rounded-lg bg-surface-code border border-line-subtle text-caption text-ink-primary placeholder:text-ink-faint focus:outline-none focus:border-line-strong"
                            />
                            <Button size="xs" variant="primary" type="submit">
                              Create
                            </Button>
                          </div>
                          {newProjectError && (
                            <div className="text-micro text-rose-300">{newProjectError}</div>
                          )}
                        </form>
                      ) : (
                        <div className="flex items-center gap-1.5">
                          <Button
                            size="xs"
                            variant="subtle"
                            className="flex-1"
                            iconLeft={<FolderPlus className="w-3.5 h-3.5" />}
                            onClick={() => setCreatingProject(true)}
                          >
                            New project
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            className="flex-1"
                            iconLeft={<FolderOpen className="w-3.5 h-3.5" />}
                            onClick={() => void handleBrowseFolder()}
                          >
                            Browse…
                          </Button>
                        </div>
                      )}
                    </PopoverSurface>
                  )}
                </div>

                {/* Model Selector Popover (mirrors the selected harness's live models) */}
                <div className="relative">
                  <button
                    ref={modelTriggerRef}
                    type="button"
                    onClick={() => {
                      setModelMenuOpen((v) => !v);
                      setProjectMenuOpen(false);
                      setThinkingMenuOpen(false);
                      setClaudeMenuOpen(false);
                    }}
                    disabled={!selectedGroup}
                    title={draft.model || defaultModelOption?.label || 'Select model'}
                    className="h-8 inline-flex items-center gap-1.5 px-2.5 rounded-lg bg-white/[0.05] border border-line-hairline hover:border-line-subtle hover:bg-white/[0.08] text-caption text-ink-secondary hover:text-ink-primary disabled:opacity-45 disabled:cursor-not-allowed transition-colors cursor-pointer max-w-[230px]"
                  >
                    <Cpu className="w-3.5 h-3.5 text-ink-muted shrink-0" />
                    <span className="truncate font-medium">
                      {selectedModelOption?.label ||
                        draft.model ||
                        (defaultModelOption ? `${defaultModelOption.label}` : 'Default model')}
                    </span>
                    <ChevronDown className="w-3.5 h-3.5 text-ink-faint shrink-0" />
                  </button>

                  {modelMenuOpen && selectedGroup && (
                    <PopoverSurface
                      width="auto"
                      onClose={() => setModelMenuOpen(false)}
                      ignoreRef={modelTriggerRef}
                      className="absolute left-0 bottom-[calc(100%+8px)] z-40 w-80 p-2 space-y-2"
                    >
                      <div className="flex items-center gap-2 px-2.5 h-8 rounded-lg bg-surface-code border border-line-hairline focus-within:border-line-subtle">
                        <Search className="w-3.5 h-3.5 text-ink-faint shrink-0" />
                        <input
                          autoFocus
                          value={modelSearch}
                          onChange={(e) => setModelSearch(e.target.value)}
                          placeholder={`Filter ${headerTitle || ''} models…`}
                          className="flex-1 min-w-0 bg-transparent text-caption text-ink-primary placeholder:text-ink-faint focus:outline-none focus-visible:shadow-none"
                        />
                      </div>

                      <div className="max-h-64 overflow-y-auto space-y-0.5 pr-0.5">
                        {!modelSearch.trim() && (
                          <button
                            type="button"
                            onClick={() => {
                              handleSelectModel('');
                            }}
                            className={`w-full text-left px-2.5 py-2 rounded-lg flex items-center justify-between gap-2 transition-colors cursor-pointer ${
                              !draft.model
                                ? 'bg-white/[0.1] text-ink-primary'
                                : 'text-ink-secondary hover:bg-white/[0.05]'
                            }`}
                          >
                            <div className="min-w-0">
                              <div className="text-caption font-medium">Harness default</div>
                              {defaultModelOption && (
                                <div className="text-micro text-ink-faint truncate">
                                  Currently {defaultModelOption.label}
                                </div>
                              )}
                            </div>
                            {!draft.model && <Check className="w-3.5 h-3.5 text-ink-primary shrink-0" />}
                          </button>
                        )}

                        {filteredModels.map((m) => {
                          const active = draft.model === m.id;
                          return (
                            <button
                              key={m.id}
                              type="button"
                              onClick={() => {
                                handleSelectModel(m.id);
                              }}
                              className={`w-full text-left px-2.5 py-2 rounded-lg flex items-center justify-between gap-2 transition-colors cursor-pointer ${
                                active
                                  ? 'bg-white/[0.1] text-ink-primary'
                                  : 'text-ink-secondary hover:bg-white/[0.05]'
                              }`}
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-caption font-medium truncate">{m.label}</span>
                                  {m.isDefault && <Badge tone="neutral">default</Badge>}
                                </div>
                                <div className="text-micro font-mono text-ink-faint truncate">
                                  {m.id}
                                </div>
                              </div>
                              {active && <Check className="w-3.5 h-3.5 text-ink-primary shrink-0" />}
                            </button>
                          );
                        })}

                        {modelSearch.trim() &&
                          !filteredModels.some((m) => m.id === modelSearch.trim()) && (
                            <button
                              type="button"
                              onClick={() => {
                                onUpdateDraft({ model: modelSearch.trim() });
                                setModelMenuOpen(false);
                              }}
                              className="w-full text-left px-2.5 py-2 rounded-lg text-caption text-ink-secondary hover:bg-white/[0.06] cursor-pointer"
                            >
                              Use custom model:{' '}
                              <span className="font-mono text-ink-primary">
                                {modelSearch.trim()}
                              </span>
                            </button>
                          )}
                      </div>
                    </PopoverSurface>
                  )}
                </div>

                {/* Thinking / Reasoning Effort Selector Popover */}
                <div className="relative">
                  <button
                    ref={thinkingTriggerRef}
                    type="button"
                    onClick={() => {
                      setThinkingMenuOpen((v) => !v);
                      setModelMenuOpen(false);
                      setProjectMenuOpen(false);
                      setClaudeMenuOpen(false);
                    }}
                    disabled={!selectedGroup || availableThinkingLevels.length === 0}
                    title="Model thinking mode"
                    className="h-8 inline-flex items-center gap-1.5 px-2.5 rounded-lg bg-white/[0.05] border border-line-hairline hover:border-line-subtle hover:bg-white/[0.08] text-caption text-ink-secondary hover:text-ink-primary disabled:opacity-45 disabled:cursor-not-allowed transition-colors cursor-pointer"
                  >
                    <Brain className="w-3.5 h-3.5 text-ink-muted shrink-0" />
                    <span className="font-medium">
                      {draft.reasoningEffort
                        ? formatEffortLabel(draft.reasoningEffort)
                        : defaultThinkingLevel
                          ? formatEffortLabel(defaultThinkingLevel)
                          : 'Thinking'}
                    </span>
                    <ChevronDown className="w-3.5 h-3.5 text-ink-faint shrink-0" />
                  </button>

                  {thinkingMenuOpen && selectedGroup && (
                    <PopoverSurface
                      width="auto"
                      onClose={() => setThinkingMenuOpen(false)}
                      ignoreRef={thinkingTriggerRef}
                      className="absolute left-0 bottom-[calc(100%+8px)] z-40 w-64 p-1.5 space-y-0.5"
                    >
                      <button
                        type="button"
                        onClick={() => handleSelectThinking('')}
                        className={`w-full text-left px-2.5 py-2 rounded-lg flex items-center justify-between gap-2 transition-colors cursor-pointer ${
                          !draft.reasoningEffort
                            ? 'bg-white/[0.1] text-ink-primary'
                            : 'text-ink-secondary hover:bg-white/[0.05]'
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="text-caption font-medium">Harness default</div>
                          {defaultThinkingLevel && (
                            <div className="text-micro text-ink-faint">
                              Currently {formatEffortLabel(defaultThinkingLevel)}
                            </div>
                          )}
                        </div>
                        {!draft.reasoningEffort && (
                          <Check className="w-3.5 h-3.5 text-ink-primary shrink-0" />
                        )}
                      </button>

                      <MenuDivider />

                      {availableThinkingLevels.map((lvl) => {
                        const active = draft.reasoningEffort === lvl;
                        const meta = EFFORT_META[lvl] ?? { label: lvl, hint: '' };
                        return (
                          <button
                            key={lvl}
                            type="button"
                            onClick={() => handleSelectThinking(lvl)}
                            className={`w-full text-left px-2.5 py-2 rounded-lg flex items-center justify-between gap-2 transition-colors cursor-pointer ${
                              active
                                ? 'bg-white/[0.1] text-ink-primary'
                                : 'text-ink-secondary hover:bg-white/[0.05]'
                            }`}
                          >
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="text-caption font-medium">{meta.label}</span>
                                {defaultThinkingLevel === lvl && (
                                  <Badge tone="neutral">default</Badge>
                                )}
                              </div>
                              {meta.hint && (
                                <div className="text-micro text-ink-faint leading-snug">
                                  {meta.hint}
                                </div>
                              )}
                            </div>
                            {active && <Check className="w-3.5 h-3.5 text-ink-primary shrink-0" />}
                          </button>
                        );
                      })}
                    </PopoverSurface>
                  )}
                </div>

                {draft.harness === 'claude-tmux' && (
                  <button
                    type="button"
                    onClick={() => onUpdateDraft({ remoteControl: !draft.remoteControl })}
                    className={`h-8 inline-flex items-center gap-1.5 px-2.5 rounded-lg border text-caption transition-colors cursor-pointer ${
                      draft.remoteControl
                        ? 'bg-indigo-500/15 border-indigo-400/30 text-indigo-200'
                        : 'bg-white/[0.04] border-line-hairline text-ink-faint hover:text-ink-secondary'
                    }`}
                  >
                    <Radio className="w-3.5 h-3.5" />
                    <span>Remote</span>
                  </button>
                )}
              </div>

              <button
                type="button"
                disabled={busy}
                onClick={() => void handleLaunch()}
                title="Start conversation (Enter)"
                className="w-8 h-8 rounded-full bg-ink-primary text-surface-rail flex items-center justify-center hover:bg-white disabled:opacity-35 disabled:cursor-not-allowed transition-all cursor-pointer"
              >
                {busy ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
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
