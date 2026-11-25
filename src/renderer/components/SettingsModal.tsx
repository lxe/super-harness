import React, { useEffect, useState } from 'react';
import {
  AppWindow,
  Check,
  Copy,
  Cpu,
  FolderOpen,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Sliders,
  Sparkles,
  Square,
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
  Badge,
  Button,
  IconButton,
  Input,
  Select,
  SettingsGroup,
  SettingsRow,
  StatTile,
  Switch,
} from '../ui';
import { HarnessLogo } from './HarnessLogo';

type SettingsTab = 'harnesses' | 'apps' | 'master' | 'workspace';

interface Props {
  harnesses: HarnessDetection[];
  state: SuperHarnessState;
  controlPort: number;
  onClose: () => void;
  onRefresh: () => void;
  onUpdateSettings: (patch: Partial<SuperHarnessSettings>) => void;
  onOrganize: (actions: OrganizeAction[]) => void;
}

const NAV_ITEMS: Array<{
  id: SettingsTab;
  label: string;
  subtitle: string;
  Icon: React.FC<{ className?: string }>;
}> = [
  { id: 'harnesses', label: 'Harnesses', subtitle: 'Detection, PIDs & daemons', Icon: Cpu },
  { id: 'apps', label: 'Apps & Preview', subtitle: 'Editor, folder & terminal', Icon: AppWindow },
  { id: 'master', label: 'Master & MCP', subtitle: 'Orchestrator engine & API', Icon: Sparkles },
  { id: 'workspace', label: 'Workspace', subtitle: 'Discovery, layout & folders', Icon: Sliders },
];

export const SettingsModal: React.FC<Props> = ({
  harnesses,
  state,
  controlPort,
  onClose,
  onRefresh,
  onUpdateSettings,
  onOrganize,
}) => {
  const [tab, setTab] = useState<SettingsTab>('harnesses');
  const [systemApps, setSystemApps] = useState<DetectedSystemApps | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [busyHarness, setBusyHarness] = useState<string | null>(null);
  const [copiedBin, setCopiedBin] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState('');

  useEffect(() => {
    void window.superHarness.getSystemApps().then(setSystemApps);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const { settings, folders } = state;
  const updateApps = (patch: Partial<ExternalAppsSettings>) => {
    onUpdateSettings({ apps: { ...settings.apps, ...patch } });
  };

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
    if (dir) {
      onUpdateSettings({ master: { ...settings.master, cwd: dir } });
    }
  };

  const handlePickDefaultCwd = async () => {
    const dir = await window.superHarness.pickDirectory();
    if (dir) {
      onUpdateSettings({ defaultNewSessionCwd: dir });
    }
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
        <aside className="w-56 shrink-0 bg-surface-rail border-r border-line-hairline flex flex-col">
          <div className="px-4 pt-4 pb-3 border-b border-line-hairline">
            <h2 className="text-heading font-semibold text-ink-primary tracking-tight">Settings</h2>
            <p className="text-micro text-ink-faint mt-0.5">Super Harness preferences</p>
          </div>

          <nav className="flex-1 p-2.5 space-y-1">
            {NAV_ITEMS.map(({ id, label, Icon }) => {
              const active = tab === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTab(id)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-label transition-colors cursor-pointer ${
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
                    <span className="text-micro font-mono text-ink-faint">
                      {installedCount}/{harnesses.length}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          <div className="p-3 border-t border-line-hairline text-micro font-mono text-ink-faint space-y-0.5">
            <div className="flex items-center justify-between">
              <span>Control API</span>
              <span className="text-ink-muted">:{controlPort}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Shortcut</span>
              <span className="text-ink-muted">Ctrl + ,</span>
            </div>
          </div>
        </aside>

        {/* Right Content Pane */}
        <div className="flex-1 min-w-0 flex flex-col">
          {/* Pane Header */}
          <div className="h-14 px-6 border-b border-line-hairline flex items-center justify-between gap-4 shrink-0">
            <div className="min-w-0">
              <h3 className="text-heading font-semibold text-ink-primary">{activeMeta.label}</h3>
              <p className="text-micro text-ink-muted">{activeMeta.subtitle}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {tab === 'harnesses' && (
                <Button
                  size="xs"
                  variant="subtle"
                  onClick={onRefresh}
                  iconLeft={<RefreshCw className="w-3 h-3" />}
                >
                  Rescan
                </Button>
              )}
              <IconButton label="Close settings (Esc)" onClick={onClose}>
                <X className="w-4 h-4" />
              </IconButton>
            </div>
          </div>

          {/* Scrollable Body */}
          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
            {actionMsg && (
              <div className="rounded-xl border border-indigo-500/25 bg-indigo-500/[0.08] px-3.5 py-2.5 text-caption text-indigo-200 font-mono flex items-center justify-between gap-2">
                <span className="truncate">{actionMsg}</span>
                <IconButton size="xs" label="Dismiss" onClick={() => setActionMsg(null)}>
                  <X className="w-3 h-3" />
                </IconButton>
              </div>
            )}

            {/* HARNESSES */}
            {tab === 'harnesses' && (
              <div className="space-y-3.5">
                {harnesses.map((h) => {
                  const enabled = settings.enabledHarnesses[h.id];
                  return (
                    <div
                      key={h.id}
                      className={`rounded-xl border transition-colors overflow-hidden ${
                        enabled
                          ? 'border-line-hairline bg-surface-subtle'
                          : 'border-line-hairline/60 bg-surface-subtle/40 opacity-70'
                      }`}
                    >
                      {/* Top Header Row */}
                      <div className="px-4 py-3.5 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-8 h-8 rounded-lg bg-surface-raised border border-line-hairline flex items-center justify-center shrink-0">
                            <HarnessLogo harness={h.id} size={17} />
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-heading font-semibold text-ink-primary">
                                {h.name}
                              </span>
                              {h.desktopAppRunning && <Badge tone="success">Desktop</Badge>}
                              {h.remoteControlEnabled && (
                                <Badge tone="accent" icon={<Radio className="w-2.5 h-2.5" />}>
                                  Remote
                                </Badge>
                              )}
                              {!h.installed && <Badge tone="neutral">Not installed</Badge>}
                            </div>
                            <p className="text-micro text-ink-muted truncate mt-0.5">
                              {h.notes || (h.installed ? 'Detected locally' : 'Binary not found')}
                            </p>
                          </div>
                        </div>

                        <Switch
                          checked={enabled}
                          label={`Enable ${h.name}`}
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

                      {/* Structured Metrics + Binary Path */}
                      {h.installed && (
                        <div className="px-4 pb-3.5 space-y-2.5">
                          <div className="grid grid-cols-4 gap-2">
                            <StatTile label="Version" value={h.version?.split(' ')[0] || '—'} />
                            <StatTile label="Processes" value={h.runningProcesses} />
                            <StatTile
                              label="Active"
                              value={h.activeSessionCount}
                              emphasize={h.activeSessionCount > 0}
                            />
                            <StatTile label="Total Threads" value={h.totalSessionCount} />
                          </div>

                          <div className="flex items-center justify-between gap-2 pt-1">
                            <div className="flex items-center gap-1.5 min-w-0 bg-surface-code border border-line-hairline rounded-lg px-2.5 py-1 flex-1">
                              <span className="text-micro uppercase tracking-wider text-ink-faint shrink-0">
                                bin
                              </span>
                              <span
                                title={h.binaryPath || 'none'}
                                className="text-micro font-mono text-ink-muted truncate flex-1"
                              >
                                {h.binaryPath || 'none'}
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

                            <div className="flex items-center gap-1.5 shrink-0">
                              {h.id === 'claude' ? (
                                <Button
                                  size="xs"
                                  variant="secondary"
                                  loading={busyHarness === 'claude:start_remote'}
                                  disabled={busyHarness !== null}
                                  iconLeft={<Play className="w-3 h-3" />}
                                  onClick={() => void handleControl(h.id, 'start_remote')}
                                >
                                  New tmux + Remote
                                </Button>
                              ) : h.remoteControlEnabled ? (
                                <Button
                                  size="xs"
                                  variant="subtle"
                                  loading={busyHarness === `${h.id}:stop_remote`}
                                  disabled={busyHarness !== null}
                                  iconLeft={<Square className="w-3 h-3" />}
                                  onClick={() => void handleControl(h.id, 'stop_remote')}
                                >
                                  Stop Remote
                                </Button>
                              ) : (
                                <Button
                                  size="xs"
                                  variant="secondary"
                                  loading={busyHarness === `${h.id}:start_remote`}
                                  disabled={busyHarness !== null}
                                  iconLeft={<Play className="w-3 h-3" />}
                                  onClick={() => void handleControl(h.id, 'start_remote')}
                                >
                                  Start Remote
                                </Button>
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

            {/* APPS & PREVIEW */}
            {tab === 'apps' && (
              <div className="space-y-5">
                <SettingsGroup
                  title="Link Click Behavior"
                  description="Choose where clicked file and folder links open."
                >
                  <SettingsRow
                    label="File links"
                    description="Action when clicking a file path inside any transcript"
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
                        <option value="internal">Internal File Previewer</option>
                        <option value="editor">Default Editor</option>
                        <option value="system">System Default (xdg-open)</option>
                      </Select>
                    }
                  />
                  <SettingsRow
                    label="Folder links"
                    description="Action when opening a workspace or directory link"
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
                        <option value="file-manager">Default File Viewer</option>
                        <option value="internal">Internal Folder Previewer</option>
                        <option value="editor">Default Editor</option>
                        <option value="terminal">Default Terminal</option>
                      </Select>
                    }
                  />
                </SettingsGroup>

                <SettingsGroup
                  title="External Applications"
                  description="Leave blank to automatically use the first detected app on your system."
                >
                  <SettingsRow
                    stacked
                    label="Default Editor"
                    description={
                      <>
                        Placeholders: <code className="font-mono text-ink-secondary">{'{path}'}</code>,{' '}
                        <code className="font-mono text-ink-secondary">{'{line}'}</code>
                      </>
                    }
                    control={
                      <div className="space-y-2">
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
                          <div className="flex flex-wrap gap-1.5">
                            {systemApps.editors.map((ed) => (
                              <Button
                                key={ed.id}
                                size="xs"
                                variant={
                                  settings.apps.editorCommand === ed.command
                                    ? 'secondary'
                                    : 'subtle'
                                }
                                onClick={() => updateApps({ editorCommand: ed.command })}
                              >
                                {ed.label}
                              </Button>
                            ))}
                          </div>
                        )}
                      </div>
                    }
                  />

                  <SettingsRow
                    stacked
                    label="Default File Viewer"
                    description={
                      <>
                        Placeholder: <code className="font-mono text-ink-secondary">{'{path}'}</code>
                      </>
                    }
                    control={
                      <div className="space-y-2">
                        <Input
                          inputSize="sm"
                          mono
                          value={settings.apps.fileManagerCommand}
                          onChange={(e) => updateApps({ fileManagerCommand: e.target.value })}
                          placeholder={systemApps?.fileManagers[0]?.command || 'dolphin {path}'}
                        />
                        {systemApps && systemApps.fileManagers.length > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {systemApps.fileManagers.map((fm) => (
                              <Button
                                key={fm.id}
                                size="xs"
                                variant={
                                  settings.apps.fileManagerCommand === fm.command
                                    ? 'secondary'
                                    : 'subtle'
                                }
                                onClick={() => updateApps({ fileManagerCommand: fm.command })}
                              >
                                {fm.label}
                              </Button>
                            ))}
                          </div>
                        )}
                      </div>
                    }
                  />

                  <SettingsRow
                    stacked
                    label="Default Terminal"
                    description={
                      <>
                        Placeholder: <code className="font-mono text-ink-secondary">{'{cwd}'}</code>
                      </>
                    }
                    control={
                      <div className="space-y-2">
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
                          <div className="flex flex-wrap gap-1.5">
                            {systemApps.terminals.map((tm) => (
                              <Button
                                key={tm.id}
                                size="xs"
                                variant={
                                  settings.apps.terminalCommand === tm.command
                                    ? 'secondary'
                                    : 'subtle'
                                }
                                onClick={() => updateApps({ terminalCommand: tm.command })}
                              >
                                {tm.label}
                              </Button>
                            ))}
                          </div>
                        )}
                      </div>
                    }
                  />
                </SettingsGroup>
              </div>
            )}

            {/* MASTER & MCP */}
            {tab === 'master' && (
              <div className="space-y-5">
                <div className="rounded-xl border border-indigo-500/25 bg-indigo-500/[0.06] px-4 py-3.5 flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-label font-semibold text-indigo-100">
                        Control Plane & MCP Server
                      </span>
                      <Badge tone="success">Active</Badge>
                    </div>
                    <p className="text-micro text-indigo-200/75 leading-relaxed">
                      Loopback API on{' '}
                      <code className="font-mono text-indigo-100">127.0.0.1:{controlPort}</code>{' '}
                      with per-session bearer auth. Automatically wired to{' '}
                      <code className="font-mono text-indigo-100">super-harness-mcp</code> so Master
                      Orchestrator can inspect, organize, launch, and dispatch across every harness.
                    </p>
                  </div>
                </div>

                <SettingsGroup title="Master Orchestrator Engine">
                  <SettingsRow
                    stacked
                    label="Backing Harness"
                    description="Which installed harness executes Master Orchestrator turns"
                    control={
                      <div className="grid grid-cols-3 gap-2">
                        {(['claude', 'codex', 'antigravity'] as HarnessGroup[]).map((eng) => {
                          const active = settings.master.harness === eng;
                          return (
                            <button
                              key={eng}
                              type="button"
                              onClick={() =>
                                onUpdateSettings({
                                  master: { ...settings.master, harness: eng },
                                })
                              }
                              className={`flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border text-caption font-medium capitalize transition-colors cursor-pointer ${
                                active
                                  ? 'bg-white/[0.1] border-line-strong text-ink-primary'
                                  : 'bg-surface-canvas border-line-hairline text-ink-muted hover:text-ink-secondary hover:border-line-subtle'
                              }`}
                            >
                              <HarnessLogo harness={eng} size={14} />
                              <span>{eng === 'antigravity' ? 'Antigravity' : eng}</span>
                            </button>
                          );
                        })}
                      </div>
                    }
                  />

                  <SettingsRow
                    label="Model Override"
                    description="Leave blank to use the selected harness default"
                    control={
                      <Input
                        inputSize="sm"
                        className="w-60"
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
                    stacked
                    label="Master Working Directory"
                    control={
                      <div className="flex gap-2">
                        <Input
                          inputSize="sm"
                          mono
                          value={settings.master.cwd}
                          onChange={(e) =>
                            onUpdateSettings({
                              master: { ...settings.master, cwd: e.target.value },
                            })
                          }
                        />
                        <IconButton
                          size="sm"
                          label="Browse folder"
                          onClick={() => void handlePickMasterCwd()}
                          className="border border-line-subtle bg-surface-canvas w-8 h-8"
                        >
                          <FolderOpen className="w-3.5 h-3.5" />
                        </IconButton>
                      </div>
                    }
                  />
                </SettingsGroup>
              </div>
            )}

            {/* WORKSPACE */}
            {tab === 'workspace' && (
              <div className="space-y-5">
                <SettingsGroup title="Discovery & Sidebar">
                  <SettingsRow
                    label="Default Sidebar Grouping"
                    description="How conversations are organized in the left rail"
                    control={
                      <Select
                        inputSize="sm"
                        className="w-52"
                        value={settings.sidebarGroupBy}
                        onChange={(e) =>
                          onUpdateSettings({ sidebarGroupBy: e.target.value as SidebarGroupBy })
                        }
                      >
                        <option value="native">Harness & Native Sections</option>
                        <option value="harness">Harness (Flat)</option>
                        <option value="project">Unified Projects</option>
                        <option value="folders">Custom Folders</option>
                        <option value="recent">Recent Flat List</option>
                      </Select>
                    }
                  />

                  <SettingsRow
                    label="Auto-Refresh Interval"
                    description="Fallback discovery poll in milliseconds (inotify pushes instantly)"
                    control={
                      <Input
                        inputSize="sm"
                        type="number"
                        min={2000}
                        max={60000}
                        step={1000}
                        className="w-28 font-mono text-right"
                        value={settings.pollIntervalMs}
                        onChange={(e) =>
                          onUpdateSettings({ pollIntervalMs: Number(e.target.value) || 5000 })
                        }
                      />
                    }
                  />

                  <SettingsRow
                    label="Max Sessions per Harness"
                    description="Upper limit loaded into the sidebar per harness"
                    control={
                      <Input
                        inputSize="sm"
                        type="number"
                        min={10}
                        max={300}
                        step={10}
                        className="w-28 font-mono text-right"
                        value={settings.maxSessionsPerHarness}
                        onChange={(e) =>
                          onUpdateSettings({
                            maxSessionsPerHarness: Number(e.target.value) || 80,
                          })
                        }
                      />
                    }
                  />

                  <SettingsRow
                    label="Show Archived Sessions"
                    description="Include archived Codex and Claude Desktop threads"
                    control={
                      <Switch
                        checked={settings.showArchived}
                        label="Show Archived Sessions"
                        onChange={(v) => onUpdateSettings({ showArchived: v })}
                      />
                    }
                  />

                  <SettingsRow
                    label="Show Hidden Sessions"
                    description="Include threads manually hidden in Super Harness"
                    control={
                      <Switch
                        checked={settings.showHidden}
                        label="Show Hidden Sessions"
                        onChange={(v) => onUpdateSettings({ showHidden: v })}
                      />
                    }
                  />

                  <SettingsRow
                    stacked
                    label="Default Directory for New Conversations"
                    control={
                      <div className="flex gap-2">
                        <Input
                          inputSize="sm"
                          mono
                          value={settings.defaultNewSessionCwd}
                          onChange={(e) =>
                            onUpdateSettings({ defaultNewSessionCwd: e.target.value })
                          }
                        />
                        <IconButton
                          size="sm"
                          label="Browse folder"
                          onClick={() => void handlePickDefaultCwd()}
                          className="border border-line-subtle bg-surface-canvas w-8 h-8"
                        >
                          <FolderOpen className="w-3.5 h-3.5" />
                        </IconButton>
                      </div>
                    }
                  />
                </SettingsGroup>

                <SettingsGroup
                  title="Custom Sidebar Folders"
                  description="Organize conversations across harnesses into shared folders."
                >
                  {folders.length === 0 ? (
                    <div className="px-4 py-3 text-micro text-ink-faint">
                      No custom folders yet.
                    </div>
                  ) : (
                    folders.map((f) => (
                      <div
                        key={f.id}
                        className="px-4 py-2.5 flex items-center justify-between gap-3 text-caption"
                      >
                        <div className="flex items-center gap-2.5">
                          <span
                            className="w-2.5 h-2.5 rounded-full shrink-0"
                            style={{ background: f.color }}
                          />
                          <span className="text-ink-primary font-medium">{f.name}</span>
                        </div>
                        <IconButton
                          size="xs"
                          tone="danger"
                          label={`Delete ${f.name}`}
                          onClick={() => onOrganize([{ type: 'delete_folder', folderId: f.id }])}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </IconButton>
                      </div>
                    ))
                  )}
                  <div className="px-4 py-3 flex gap-2 bg-surface-rail/40">
                    <Input
                      inputSize="sm"
                      value={newFolderName}
                      onChange={(e) => setNewFolderName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && newFolderName.trim()) {
                          onOrganize([{ type: 'create_folder', folderName: newFolderName.trim() }]);
                          setNewFolderName('');
                        }
                      }}
                      placeholder="New folder name…"
                    />
                    <Button
                      size="sm"
                      variant="primary"
                      iconLeft={<Plus className="w-3.5 h-3.5" />}
                      onClick={() => {
                        if (!newFolderName.trim()) return;
                        onOrganize([{ type: 'create_folder', folderName: newFolderName.trim() }]);
                        setNewFolderName('');
                      }}
                    >
                      Add
                    </Button>
                  </div>
                </SettingsGroup>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
