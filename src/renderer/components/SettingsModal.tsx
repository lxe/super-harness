import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AppWindow,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Cpu,
  FolderOpen,
  GripVertical,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Sliders,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import type {
  DetectedSystemApps,
  ExternalAppsSettings,
  HarnessDetection,
  HarnessGroup,
  OrganizeAction,
  SidebarGroupBy,
  SuperHarnessSettings,
  SuperHarnessState,
} from '../../shared/types';
import {
  Button,
  Checkbox,
  ChoicePills,
  IconButton,
  Input,
  Select,
  SettingsGroup,
  SettingsRow,
  Switch,
  UnitNumberInput,
} from '../ui';
import { HarnessLogo } from './HarnessLogo';

export type SettingsTab = 'workspace' | 'apps' | 'harnesses' | 'master';

interface Props {
  harnesses: HarnessDetection[];
  state: SuperHarnessState;
  controlPort: number;
  initialTab?: SettingsTab;
  onClose: () => void;
  onRefresh: () => void;
  onUpdateSettings: (patch: Partial<SuperHarnessSettings>) => void;
  onOrganize: (actions: OrganizeAction[]) => void;
}

interface NavItem {
  id: SettingsTab;
  label: string;
  section: 'General' | 'Agents';
  keywords: string;
  Icon: React.FC<{ className?: string }>;
}

const NAV_ITEMS: NavItem[] = [
  {
    id: 'workspace',
    label: 'Workspace',
    section: 'General',
    keywords: 'sidebar group conversations archived hidden folders directory poll refresh',
    Icon: Sliders,
  },
  {
    id: 'apps',
    label: 'Apps and preview',
    section: 'General',
    keywords: 'editor terminal file manager links click previewer',
    Icon: AppWindow,
  },
  {
    id: 'harnesses',
    label: 'Harnesses',
    section: 'Agents',
    keywords: 'codex claude antigravity remote control daemon binary version',
    Icon: Cpu,
  },
  {
    id: 'master',
    label: 'Master agent',
    section: 'Agents',
    keywords: 'orchestrator model mcp api control plane working directory',
    Icon: Sparkles,
  },
];

const POLL_OPTIONS = [
  { value: 1000, label: '1s' },
  { value: 5000, label: '5s' },
  { value: 30000, label: '30s' },
  { value: 0, label: 'Off' },
];

function normalizePollChoice(ms: number): number {
  if (ms === 0) return 0;
  if (ms <= 2000) return 1000;
  if (ms <= 12000) return 5000;
  return 30000;
}

function formatScannedAgo(ts: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  return `${Math.floor(sec / 60)}m ago`;
}

const HARNESS_DISPLAY_NAMES: Record<HarnessGroup, string> = {
  codex: 'OpenAI Codex',
  claude: 'Claude',
  antigravity: 'Google Antigravity',
};

function formatHarnessVersion(raw?: string | null): string | null {
  if (!raw) return null;
  const verMatch = raw.match(/\d+\.\d+(?:\.\d+)?/);
  if (verMatch) return verMatch[0];
  const first = raw.split(' ')[0]?.trim();
  return first && !/^(codex|claude|agy)/i.test(first) ? first : null;
}

function shortenHome(p: string): string {
  return p.replace(/^\/home\/[^/]+/, '~').replace(/^\/Users\/[^/]+/, '~');
}

export const SettingsModal: React.FC<Props> = ({
  harnesses,
  state,
  controlPort,
  initialTab = 'workspace',
  onClose,
  onRefresh,
  onUpdateSettings,
  onOrganize,
}) => {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [navSearch, setNavSearch] = useState('');
  const [systemApps, setSystemApps] = useState<DetectedSystemApps | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [busyHarness, setBusyHarness] = useState<string | null>(null);
  const [copiedBin, setCopiedBin] = useState<string | null>(null);
  const [expandedHarness, setExpandedHarness] = useState<Record<string, boolean>>({});
  const [scannedAt, setScannedAt] = useState<number>(() => Date.now());

  // Folder inline creation, rename & drag reorder
  const [addingFolder, setAddingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameFolderDraft, setRenameFolderDraft] = useState('');
  const [dragFolderId, setDragFolderId] = useState<string | null>(null);
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);

  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined' && window.superHarness?.getSystemApps) {
      void window.superHarness.getSystemApps().then(setSystemApps);
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (renamingFolderId) {
          setRenamingFolderId(null);
        } else if (addingFolder) {
          setAddingFolder(false);
        } else {
          onClose();
        }
      } else if (
        e.key === '/' &&
        document.activeElement?.tagName !== 'INPUT' &&
        document.activeElement?.tagName !== 'TEXTAREA'
      ) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, renamingFolderId, addingFolder]);

  const { settings, folders, overrides } = state;
  const updateApps = (patch: Partial<ExternalAppsSettings>) => {
    onUpdateSettings({ apps: { ...settings.apps, ...patch } });
  };

  // Count conversations assigned to each custom folder
  const folderCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const ov of Object.values(overrides || {})) {
      if (ov.folderId) {
        map.set(ov.folderId, (map.get(ov.folderId) ?? 0) + 1);
      }
    }
    return map;
  }, [overrides]);

  const filteredNavItems = useMemo(() => {
    const q = navSearch.trim().toLowerCase();
    if (!q) return NAV_ITEMS;
    return NAV_ITEMS.filter(
      (n) => n.label.toLowerCase().includes(q) || n.keywords.toLowerCase().includes(q)
    );
  }, [navSearch]);

  const handleControl = async (
    harness: HarnessGroup,
    action: 'start_remote' | 'stop_remote'
  ) => {
    setBusyHarness(`${harness}:${action}`);
    setActionMsg(null);
    try {
      const res = await window.superHarness.controlHarness(harness, action);
      setActionMsg(
        res.ok
          ? res.output || `${harness} ${action} succeeded`
          : `Error: ${res.error || 'failed'}`
      );
      onRefresh();
    } finally {
      setBusyHarness(null);
    }
  };

  const handleCopyPath = (id: string, text: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedBin(id);
    setTimeout(() => setCopiedBin((cur) => (cur === id ? null : cur)), 1400);
  };

  const handlePickMasterCwd = async () => {
    const dir = await window.superHarness.pickDirectory();
    if (dir) onUpdateSettings({ master: { ...settings.master, cwd: dir } });
  };

  const handlePickDefaultCwd = async () => {
    const dir = await window.superHarness.pickDirectory();
    if (dir) onUpdateSettings({ defaultNewSessionCwd: dir });
  };

  const handleCreateFolder = () => {
    const trimmed = newFolderName.trim();
    if (!trimmed) return;
    onOrganize([{ type: 'create_folder', folderName: trimmed }]);
    setNewFolderName('');
    setAddingFolder(false);
  };

  const handleCommitRenameFolder = (folderId: string) => {
    const trimmed = renameFolderDraft.trim();
    if (trimmed) {
      onOrganize([{ type: 'rename_folder', folderId, folderName: trimmed }]);
    }
    setRenamingFolderId(null);
  };

  const handleDropFolder = (targetId: string) => {
    if (!dragFolderId || dragFolderId === targetId) {
      setDragFolderId(null);
      setDragOverFolderId(null);
      return;
    }
    const orderedIds = folders.map((f) => f.id);
    const fromIdx = orderedIds.indexOf(dragFolderId);
    const toIdx = orderedIds.indexOf(targetId);
    if (fromIdx !== -1 && toIdx !== -1) {
      orderedIds.splice(fromIdx, 1);
      orderedIds.splice(toIdx, 0, dragFolderId);
      onOrganize([{ type: 'reorder_folders', folderIds: orderedIds }]);
    }
    setDragFolderId(null);
    setDragOverFolderId(null);
  };

  const installedCount = harnesses.filter((h) => h.installed).length;
  const activeMeta = NAV_ITEMS.find((n) => n.id === tab)!;

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/65 backdrop-blur-sm flex items-center justify-center p-5"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Super Harness Settings"
        onClick={(e) => e.stopPropagation()}
        className="w-[880px] max-w-[92vw] h-[640px] max-h-[86vh] rounded-2xl border border-line-subtle bg-surface-canvas shadow-[0_24px_64px_-12px_rgba(0,0,0,0.8)] flex overflow-hidden select-none"
      >
        {/* Left Navigation Rail */}
        <aside className="w-60 shrink-0 bg-surface-rail border-r border-line-hairline flex flex-col">
          <div className="px-4 pt-6 pb-4">
            <div className="h-9 px-3 rounded-lg bg-surface-subtle border border-line-hairline focus-within:border-line-subtle flex items-center gap-2">
              <Search className="w-3.5 h-3.5 text-ink-faint shrink-0" />
              <input
                ref={searchInputRef}
                value={navSearch}
                onChange={(e) => setNavSearch(e.target.value)}
                placeholder="Search settings"
                className="flex-1 min-w-0 bg-transparent text-caption text-ink-primary placeholder:text-ink-faint focus:outline-none focus-visible:shadow-none"
              />
              {navSearch ? (
                <button
                  type="button"
                  onClick={() => setNavSearch('')}
                  className="text-ink-faint hover:text-ink-primary cursor-pointer focus:outline-none focus-visible:shadow-none"
                  aria-label="Clear search"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              ) : (
                <kbd className="text-[11px] font-mono text-ink-faint">/</kbd>
              )}
            </div>
          </div>

          <nav className="flex-1 px-3 pb-4 space-y-5 overflow-y-auto">
            {(['General', 'Agents'] as const).map((section) => {
              const items = filteredNavItems.filter((n) => n.section === section);
              if (items.length === 0) return null;
              return (
                <div key={section} className="space-y-1">
                  <div className="px-2.5 pb-1 text-micro font-medium text-ink-faint">
                    {section}
                  </div>
                  {items.map(({ id, label, Icon }) => {
                    const active = tab === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setTab(id)}
                        className={`w-full h-9 flex items-center gap-2.5 px-2.5 rounded-lg text-label transition-colors cursor-pointer focus:outline-none focus-visible:shadow-none ${
                          active
                            ? 'bg-white/[0.1] text-ink-primary font-medium'
                            : 'text-ink-muted hover:text-ink-primary hover:bg-white/[0.05]'
                        }`}
                      >
                        <Icon
                          className={`w-4 h-4 shrink-0 ${
                            active ? 'text-ink-primary' : 'text-ink-faint'
                          }`}
                        />
                        <span className="truncate flex-1 text-left">{label}</span>
                        {id === 'harnesses' && (
                          <span className="text-micro tabular-nums text-ink-faint">
                            {installedCount}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </nav>

          <div className="px-4 py-4 border-t border-line-hairline text-micro text-ink-faint space-y-1.5">
            <div className="flex items-center justify-between">
              <span>API</span>
              <span className="font-mono text-ink-muted">:{controlPort}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Settings</span>
              <span className="font-mono text-ink-muted">Ctrl ,</span>
            </div>
          </div>
        </aside>

        {/* Right Content Pane */}
        <div className="flex-1 min-w-0 flex flex-col">
          {/* Pane Header — equalized 24px top / 32px horizontal breathing room */}
          <div className="px-8 pt-6 pb-5 flex items-start justify-between gap-4 shrink-0">
            <div className="min-w-0 pt-0.5">
              <h3 className="text-[19px] font-semibold text-ink-primary tracking-tight leading-tight">
                {activeMeta.label}
              </h3>
              {tab === 'harnesses' && (
                <p className="text-caption text-ink-faint mt-1">
                  {installedCount} detected · scanned {formatScannedAgo(scannedAt)}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2.5 shrink-0">
              {tab === 'harnesses' && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setScannedAt(Date.now());
                    onRefresh();
                  }}
                  iconLeft={<RefreshCw className="w-3.5 h-3.5" />}
                >
                  Rescan
                </Button>
              )}
              <IconButton
                size="md"
                label="Close settings (Esc)"
                onClick={onClose}
                className="-mr-1.5"
              >
                <X className="w-4 h-4" />
              </IconButton>
            </div>
          </div>

          {/* Scrollable Body */}
          <div className="flex-1 overflow-y-auto px-8 pb-8 pt-0 space-y-8">
            {actionMsg && (
              <div className="rounded-xl border border-line-subtle bg-surface-subtle px-3.5 py-2.5 text-caption text-ink-secondary font-mono flex items-center justify-between gap-2">
                <span className="truncate">{actionMsg}</span>
                <IconButton size="xs" label="Dismiss" onClick={() => setActionMsg(null)}>
                  <X className="w-3 h-3" />
                </IconButton>
              </div>
            )}

            {/* WORKSPACE */}
            {tab === 'workspace' && (
              <div className="space-y-7">
                <SettingsGroup title="Sidebar">
                  <SettingsRow
                    label="Group conversations by"
                    description="How the left rail is organized"
                    control={
                      <Select
                        inputSize="sm"
                        className="w-48"
                        value={settings.sidebarGroupBy}
                        onChange={(e) =>
                          onUpdateSettings({ sidebarGroupBy: e.target.value as SidebarGroupBy })
                        }
                      >
                        <option value="native">Harness</option>
                        <option value="harness">Harness (flat)</option>
                        <option value="project">Project</option>
                        <option value="folders">Custom folders</option>
                        <option value="recent">Recent</option>
                      </Select>
                    }
                  />

                  <SettingsRow
                    label="Also show"
                    description="Hidden here means hidden in Super Harness"
                    control={
                      <div className="flex items-center gap-5">
                        <Checkbox
                          checked={settings.showArchived}
                          label="Archived"
                          onChange={(v) => onUpdateSettings({ showArchived: v })}
                        />
                        <Checkbox
                          checked={settings.showHidden}
                          label="Hidden"
                          onChange={(v) => onUpdateSettings({ showHidden: v })}
                        />
                      </div>
                    }
                  />

                  <SettingsRow
                    label="Sessions per harness"
                    description="Older ones load on scroll"
                    control={
                      <UnitNumberInput
                        ariaLabel="Sessions per harness"
                        value={settings.maxSessionsPerHarness}
                        unit="max"
                        min={10}
                        max={300}
                        step={10}
                        onChange={(v) =>
                          onUpdateSettings({
                            maxSessionsPerHarness: Math.min(300, Math.max(10, v || 80)),
                          })
                        }
                      />
                    }
                  />
                </SettingsGroup>

                <SettingsGroup title="New conversations">
                  <SettingsRow
                    label="Start in"
                    description={
                      <span className="font-mono text-ink-muted">
                        {shortenHome(settings.defaultNewSessionCwd || '~')}
                      </span>
                    }
                    control={
                      <Button
                        size="sm"
                        variant="secondary"
                        iconLeft={<FolderOpen className="w-3.5 h-3.5" />}
                        onClick={() => void handlePickDefaultCwd()}
                      >
                        Change
                      </Button>
                    }
                  />
                </SettingsGroup>

                <SettingsGroup
                  title="Folders"
                  action={
                    <button
                      type="button"
                      onClick={() => setAddingFolder(true)}
                      className="inline-flex items-center gap-1 text-caption text-ink-muted hover:text-ink-primary transition-colors cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>New folder</span>
                    </button>
                  }
                >
                  {addingFolder && (
                    <div className="py-2.5 flex items-center gap-2">
                      <Input
                        autoFocus
                        inputSize="sm"
                        value={newFolderName}
                        onChange={(e) => setNewFolderName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleCreateFolder();
                          if (e.key === 'Escape') {
                            setAddingFolder(false);
                            setNewFolderName('');
                          }
                        }}
                        placeholder="Folder name…"
                      />
                      <Button size="sm" variant="primary" onClick={handleCreateFolder}>
                        Add
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setAddingFolder(false);
                          setNewFolderName('');
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  )}

                  {folders.length === 0 && !addingFolder ? (
                    <div className="py-3 text-caption text-ink-faint">
                      No custom folders yet.
                    </div>
                  ) : (
                    folders.map((f) => {
                      const count = folderCounts.get(f.id) ?? 0;
                      const isRenaming = renamingFolderId === f.id;
                      const isDragTarget = dragOverFolderId === f.id && dragFolderId !== f.id;
                      return (
                        <div
                          key={f.id}
                          draggable={!isRenaming}
                          onDragStart={() => setDragFolderId(f.id)}
                          onDragOver={(e) => {
                            e.preventDefault();
                            setDragOverFolderId(f.id);
                          }}
                          onDragLeave={() =>
                            setDragOverFolderId((cur) => (cur === f.id ? null : cur))
                          }
                          onDrop={(e) => {
                            e.preventDefault();
                            handleDropFolder(f.id);
                          }}
                          onDragEnd={() => {
                            setDragFolderId(null);
                            setDragOverFolderId(null);
                          }}
                          className={`group -mx-2 px-2 py-2.5 rounded-lg flex items-center justify-between gap-3 transition-colors ${
                            isDragTarget
                              ? 'bg-white/[0.08] ring-1 ring-line-strong'
                              : 'hover:bg-white/[0.04]'
                          }`}
                        >
                          <div className="flex items-center gap-2.5 min-w-0 flex-1">
                            <GripVertical
                              className="w-3.5 h-3.5 text-ink-faint/60 group-hover:text-ink-muted cursor-grab shrink-0"
                              aria-hidden="true"
                            />
                            <span
                              className="w-2.5 h-2.5 rounded-full shrink-0"
                              style={{ background: f.color }}
                            />
                            {isRenaming ? (
                              <Input
                                autoFocus
                                inputSize="sm"
                                className="max-w-xs"
                                value={renameFolderDraft}
                                onChange={(e) => setRenameFolderDraft(e.target.value)}
                                onBlur={() => handleCommitRenameFolder(f.id)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') handleCommitRenameFolder(f.id);
                                  if (e.key === 'Escape') setRenamingFolderId(null);
                                }}
                              />
                            ) : (
                              <span className="text-body font-medium text-ink-primary truncate">
                                {f.name}
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-1 shrink-0">
                            <span className="text-caption tabular-nums text-ink-faint group-hover:hidden">
                              {count}
                            </span>
                            <div className="hidden group-hover:flex items-center gap-0.5">
                              <IconButton
                                size="xs"
                                label={`Rename ${f.name}`}
                                onClick={() => {
                                  setRenamingFolderId(f.id);
                                  setRenameFolderDraft(f.name);
                                }}
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </IconButton>
                              <IconButton
                                size="xs"
                                tone="danger"
                                label={`Delete ${f.name}`}
                                onClick={() =>
                                  onOrganize([{ type: 'delete_folder', folderId: f.id }])
                                }
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </IconButton>
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </SettingsGroup>

                <SettingsGroup title="Advanced" collapsible defaultOpen={false}>
                  <SettingsRow
                    label="Fallback refresh"
                    description="File watching is instant; this is the backup poll"
                    control={
                      <ChoicePills
                        value={normalizePollChoice(settings.pollIntervalMs)}
                        options={POLL_OPTIONS}
                        onChange={(ms) => onUpdateSettings({ pollIntervalMs: ms })}
                      />
                    }
                  />
                </SettingsGroup>
              </div>
            )}

            {/* HARNESSES — Flat hairline-divided rows, uniform 2-line geometry, expandable inline details */}
            {tab === 'harnesses' && (
              <div className="divide-y divide-line-hairline border-t border-line-hairline">
                {harnesses.map((h) => {
                  const enabled = settings.enabledHarnesses[h.id];
                  const isExpanded = Boolean(expandedHarness[h.id]);
                  const shortVer = formatHarnessVersion(h.version);
                  const displayName = HARNESS_DISPLAY_NAMES[h.id] || h.name;
                  const runtimeBits = [
                    shortVer,
                    h.desktopAppRunning
                      ? h.id === 'claude'
                        ? 'desktop + tmux'
                        : 'desktop'
                      : h.installed
                        ? 'cli'
                        : null,
                  ]
                    .filter(Boolean)
                    .join(' · ');

                  const summaryLine = !h.installed
                    ? 'Not found on PATH'
                    : `${h.activeSessionCount} active · ${h.totalSessionCount} threads`;

                  return (
                    <div
                      key={h.id}
                      className={`transition-opacity ${enabled ? '' : 'opacity-60'}`}
                    >
                      <div className="py-4 flex items-center justify-between gap-4">
                        {/* Clickable identity & summary toggles inline details */}
                        <button
                          type="button"
                          onClick={() =>
                            h.installed &&
                            setExpandedHarness((prev) => ({ ...prev, [h.id]: !prev[h.id] }))
                          }
                          className={`flex items-center gap-4 min-w-0 flex-1 text-left focus:outline-none focus-visible:shadow-none ${
                            h.installed ? 'cursor-pointer group' : 'cursor-default'
                          }`}
                        >
                          <div className="w-9 h-9 rounded-lg bg-surface-subtle border border-line-hairline flex items-center justify-center shrink-0">
                            <HarnessLogo harness={h.id} size={18} />
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-baseline gap-2 min-w-0">
                              <span className="text-body font-semibold text-ink-primary group-hover:text-white transition-colors truncate">
                                {displayName}
                              </span>
                              {runtimeBits && (
                                <span className="text-micro text-ink-faint shrink-0">
                                  {runtimeBits}
                                </span>
                              )}
                              {h.installed &&
                                (isExpanded ? (
                                  <ChevronDown className="w-3.5 h-3.5 text-ink-faint self-center shrink-0" />
                                ) : (
                                  <ChevronRight className="w-3.5 h-3.5 text-ink-faint opacity-0 group-hover:opacity-100 transition-opacity self-center shrink-0" />
                                ))}
                            </div>
                            <div className="text-caption text-ink-muted mt-0.5 truncate">
                              {summaryLine}
                            </div>
                          </div>
                        </button>

                        {/* Compact inline right controls: remote state + single action + switch */}
                        <div className="flex items-center gap-3.5 shrink-0">
                          {h.installed && (
                            <>
                              <span className="inline-flex items-center gap-1.5 text-caption text-ink-muted whitespace-nowrap">
                                <span
                                  className={`w-1.5 h-1.5 rounded-full ${
                                    h.remoteControlEnabled ? 'bg-emerald-400' : 'bg-zinc-600'
                                  }`}
                                />
                                <span>
                                  {h.remoteControlEnabled ? 'Remote on' : 'Remote off'}
                                </span>
                              </span>

                              {h.id === 'claude' ? (
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  loading={busyHarness === 'claude:start_remote'}
                                  disabled={busyHarness !== null}
                                  onClick={() => void handleControl(h.id, 'start_remote')}
                                >
                                  New session
                                </Button>
                              ) : h.remoteControlEnabled ? (
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  loading={busyHarness === `${h.id}:stop_remote`}
                                  disabled={busyHarness !== null}
                                  onClick={() => void handleControl(h.id, 'stop_remote')}
                                >
                                  Stop
                                </Button>
                              ) : (
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  loading={busyHarness === `${h.id}:start_remote`}
                                  disabled={busyHarness !== null}
                                  onClick={() => void handleControl(h.id, 'start_remote')}
                                >
                                  Start
                                </Button>
                              )}
                            </>
                          )}

                          <Switch
                            checked={enabled}
                            disabled={!h.installed}
                            label={`Enable ${displayName}`}
                            onChange={(next) =>
                              onUpdateSettings({
                                enabledHarnesses: {
                                  ...settings.enabledHarnesses,
                                  [h.id]: next,
                                },
                              })
                            }
                          />
                        </div>
                      </div>

                      {/* Progressive disclosure: clean key-value details aligned under title */}
                      {h.installed && isExpanded && (
                        <div className="pl-[52px] pb-4 pt-0.5 space-y-2 text-caption">
                          {h.notes && (
                            <div className="grid grid-cols-[96px_1fr] gap-3 items-baseline">
                              <span className="text-ink-faint">Sessions</span>
                              <span className="text-ink-secondary">{h.notes}</span>
                            </div>
                          )}
                          <div className="grid grid-cols-[96px_1fr] gap-3 items-baseline">
                            <span className="text-ink-faint">Processes</span>
                            <span className="tabular-nums text-ink-secondary">
                              {h.runningProcesses}
                            </span>
                          </div>
                          <div className="grid grid-cols-[96px_1fr] gap-3 items-center">
                            <span className="text-ink-faint">Binary</span>
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span
                                title={h.binaryPath || 'none'}
                                className="font-mono text-micro text-ink-secondary truncate"
                              >
                                {h.binaryPath ? shortenHome(h.binaryPath) : 'none'}
                              </span>
                              {h.binaryPath && (
                                <IconButton
                                  size="xs"
                                  label="Copy binary path"
                                  onClick={() => handleCopyPath(h.id, h.binaryPath!)}
                                >
                                  {copiedBin === h.id ? (
                                    <Check className="w-3 h-3 text-status-success" />
                                  ) : (
                                    <Copy className="w-3 h-3" />
                                  )}
                                </IconButton>
                              )}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* APPS AND PREVIEW */}
            {tab === 'apps' && (
              <div className="space-y-7">
                <SettingsGroup title="Link behavior">
                  <SettingsRow
                    label="Open file links in"
                    description="When clicking a file path inside a conversation"
                    control={
                      <Select
                        inputSize="sm"
                        className="w-52"
                        value={settings.apps.fileClickAction}
                        onChange={(e) =>
                          updateApps({
                            fileClickAction:
                              e.target.value as ExternalAppsSettings['fileClickAction'],
                          })
                        }
                      >
                        <option value="internal">Built-in previewer</option>
                        <option value="editor">Editor</option>
                        <option value="system">System default</option>
                      </Select>
                    }
                  />
                  <SettingsRow
                    label="Open folder links in"
                    description="When opening a workspace or directory link"
                    control={
                      <Select
                        inputSize="sm"
                        className="w-52"
                        value={settings.apps.folderClickAction}
                        onChange={(e) =>
                          updateApps({
                            folderClickAction:
                              e.target.value as ExternalAppsSettings['folderClickAction'],
                          })
                        }
                      >
                        <option value="file-manager">File manager</option>
                        <option value="internal">Built-in previewer</option>
                        <option value="editor">Editor</option>
                        <option value="terminal">Terminal</option>
                      </Select>
                    }
                  />
                </SettingsGroup>

                <SettingsGroup
                  title="External apps"
                  description="Leave blank to use the first detected app on your system."
                >
                  <SettingsRow
                    label="Editor"
                    description={
                      <>
                        Uses <code className="font-mono text-ink-secondary">{'{path}'}</code> and{' '}
                        <code className="font-mono text-ink-secondary">{'{line}'}</code>
                      </>
                    }
                    control={
                      <div className="w-64 space-y-1.5">
                        <Input
                          inputSize="sm"
                          mono
                          value={settings.apps.editorCommand}
                          onChange={(e) => updateApps({ editorCommand: e.target.value })}
                          placeholder={
                            systemApps?.editors[0]?.command || 'cursor --goto {path}:{line}'
                          }
                        />
                        {systemApps && systemApps.editors.length > 0 && (
                          <div className="flex flex-wrap gap-1 justify-end">
                            {systemApps.editors.map((ed) => (
                              <button
                                key={ed.id}
                                type="button"
                                onClick={() => updateApps({ editorCommand: ed.command })}
                                className={`px-2 py-0.5 rounded-md text-micro transition-colors cursor-pointer ${
                                  settings.apps.editorCommand === ed.command
                                    ? 'bg-white/[0.12] text-ink-primary'
                                    : 'text-ink-faint hover:text-ink-secondary hover:bg-white/[0.05]'
                                }`}
                              >
                                {ed.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    }
                  />

                  <SettingsRow
                    label="File manager"
                    description={
                      <>
                        Uses <code className="font-mono text-ink-secondary">{'{path}'}</code>
                      </>
                    }
                    control={
                      <div className="w-64 space-y-1.5">
                        <Input
                          inputSize="sm"
                          mono
                          value={settings.apps.fileManagerCommand}
                          onChange={(e) => updateApps({ fileManagerCommand: e.target.value })}
                          placeholder={systemApps?.fileManagers[0]?.command || 'dolphin {path}'}
                        />
                        {systemApps && systemApps.fileManagers.length > 0 && (
                          <div className="flex flex-wrap gap-1 justify-end">
                            {systemApps.fileManagers.map((fm) => (
                              <button
                                key={fm.id}
                                type="button"
                                onClick={() => updateApps({ fileManagerCommand: fm.command })}
                                className={`px-2 py-0.5 rounded-md text-micro transition-colors cursor-pointer ${
                                  settings.apps.fileManagerCommand === fm.command
                                    ? 'bg-white/[0.12] text-ink-primary'
                                    : 'text-ink-faint hover:text-ink-secondary hover:bg-white/[0.05]'
                                }`}
                              >
                                {fm.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    }
                  />

                  <SettingsRow
                    label="Terminal"
                    description={
                      <>
                        Uses <code className="font-mono text-ink-secondary">{'{cwd}'}</code>
                      </>
                    }
                    control={
                      <div className="w-64 space-y-1.5">
                        <Input
                          inputSize="sm"
                          mono
                          value={settings.apps.terminalCommand}
                          onChange={(e) => updateApps({ terminalCommand: e.target.value })}
                          placeholder={
                            systemApps?.terminals[0]?.command || 'kitty --directory {cwd}'
                          }
                        />
                        {systemApps && systemApps.terminals.length > 0 && (
                          <div className="flex flex-wrap gap-1 justify-end">
                            {systemApps.terminals.map((tm) => (
                              <button
                                key={tm.id}
                                type="button"
                                onClick={() => updateApps({ terminalCommand: tm.command })}
                                className={`px-2 py-0.5 rounded-md text-micro transition-colors cursor-pointer ${
                                  settings.apps.terminalCommand === tm.command
                                    ? 'bg-white/[0.12] text-ink-primary'
                                    : 'text-ink-faint hover:text-ink-secondary hover:bg-white/[0.05]'
                                }`}
                              >
                                {tm.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    }
                  />
                </SettingsGroup>
              </div>
            )}

            {/* MASTER AGENT */}
            {tab === 'master' && (
              <div className="space-y-7">
                <SettingsGroup title="Orchestrator">
                  <SettingsRow
                    label="Run with"
                    description="Which harness executes Master Orchestrator turns"
                    control={
                      <ChoicePills<HarnessGroup>
                        value={settings.master.harness}
                        onChange={(eng) =>
                          onUpdateSettings({ master: { ...settings.master, harness: eng } })
                        }
                        options={[
                          {
                            value: 'claude',
                            label: 'Claude',
                            icon: <HarnessLogo harness="claude" size={13} />,
                          },
                          {
                            value: 'codex',
                            label: 'Codex',
                            icon: <HarnessLogo harness="codex" size={13} />,
                          },
                          {
                            value: 'antigravity',
                            label: 'AGY',
                            icon: <HarnessLogo harness="antigravity" size={13} />,
                          },
                        ]}
                      />
                    }
                  />

                  <SettingsRow
                    label="Model"
                    description="Leave blank to use the harness default"
                    control={
                      <Input
                        inputSize="sm"
                        className="w-56"
                        value={settings.master.model}
                        onChange={(e) =>
                          onUpdateSettings({
                            master: { ...settings.master, model: e.target.value },
                          })
                        }
                        placeholder="Harness default"
                      />
                    }
                  />

                  <SettingsRow
                    label="Working directory"
                    description={
                      <span className="font-mono text-ink-muted">
                        {shortenHome(settings.master.cwd || '~')}
                      </span>
                    }
                    control={
                      <Button
                        size="sm"
                        variant="secondary"
                        iconLeft={<FolderOpen className="w-3.5 h-3.5" />}
                        onClick={() => void handlePickMasterCwd()}
                      >
                        Change
                      </Button>
                    }
                  />
                </SettingsGroup>

                <SettingsGroup title="Control API and MCP">
                  <SettingsRow
                    label="Loopback endpoint"
                    description="Per-session bearer auth for local tool calls"
                    control={
                      <span className="font-mono text-caption text-ink-secondary">
                        127.0.0.1:{controlPort}
                      </span>
                    }
                  />
                  <SettingsRow
                    label="MCP server"
                    description="Wired into Master Orchestrator for cross-harness dispatch"
                    control={
                      <span className="inline-flex items-center gap-1.5 text-caption text-ink-secondary">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                        <span className="font-mono">super-harness-mcp</span>
                      </span>
                    }
                  />
                </SettingsGroup>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
