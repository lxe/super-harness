import type { Meta, StoryObj } from '@storybook/react';
import React, { useState } from 'react';
import type { HarnessDetection, SuperHarnessState } from '../../shared/types';
import { SettingsModal } from './SettingsModal';

const MOCK_HARNESSES: HarnessDetection[] = [
  {
    id: 'codex',
    name: 'OpenAI Codex',
    installed: true,
    binaryPath: '/usr/local/bin/codex',
    version: 'cli 0.x',
    runningProcesses: 2,
    desktopAppRunning: true,
    daemonRunning: true,
    remoteControlEnabled: true,
    activeSessionCount: 1,
    totalSessionCount: 85,
    capabilities: { canStartNew: true, canResume: true, canTmuxMirror: false, canControlDaemon: true },
    notes: '1 active · 85 threads synced via daemon',
  },
  {
    id: 'claude',
    name: 'Claude',
    installed: true,
    binaryPath: '~/.local/bin/claude',
    version: '2.1.332',
    runningProcesses: 64,
    desktopAppRunning: true,
    daemonRunning: true,
    remoteControlEnabled: true,
    activeSessionCount: 22,
    totalSessionCount: 80,
    capabilities: { canStartNew: true, canResume: true, canTmuxMirror: true, canControlDaemon: true },
    notes: '18 tmux · 33 desktop · 21 remote-controlled',
  },
  {
    id: 'antigravity',
    name: 'Google Antigravity',
    installed: true,
    binaryPath: '/usr/bin/agy',
    version: '1.5.17',
    runningProcesses: 3,
    desktopAppRunning: true,
    daemonRunning: false,
    remoteControlEnabled: false,
    activeSessionCount: 2,
    totalSessionCount: 10,
    capabilities: { canStartNew: true, canResume: true, canTmuxMirror: false, canControlDaemon: true },
    notes: 'Direct ACP connection',
  },
];

const INITIAL_STATE: SuperHarnessState = {
  settings: {
    pollIntervalMs: 5000,
    maxSessionsPerHarness: 80,
    sidebarGroupBy: 'native',
    showArchived: false,
    showHidden: false,
    enabledHarnesses: { codex: true, claude: true, antigravity: true, muse: true, pi: true },
    master: { harness: 'claude', model: '', cwd: '~/projects/super-harness', autoApplyActions: true },
    defaultNewSessionCwd: '~',
    apps: {
      fileClickAction: 'internal',
      folderClickAction: 'file-manager',
      editorCommand: '',
      fileManagerCommand: '',
      terminalCommand: '',
    },
  },
  folders: [
    { id: 'f1', name: 'Active workstreams', color: '#22c55e', order: 0 },
    { id: 'f2', name: 'Backend API', color: '#3b82f6', order: 1 },
    { id: 'f3', name: 'Parked', color: '#71717a', order: 2 },
  ],
  overrides: {
    'codex:1': { folderId: 'f1' },
    'codex:2': { folderId: 'f1' },
    'claude:1': { folderId: 'f2' },
    'antigravity:1': { folderId: 'f3' },
  },
  masterMessages: [],
};

const meta: Meta = {
  title: 'Domain/SettingsModal',
  parameters: { layout: 'fullscreen' },
};
export default meta;

function InteractiveSettings({ initialTab }: { initialTab: 'workspace' | 'harnesses' }) {
  const [st, setSt] = useState<SuperHarnessState>(INITIAL_STATE);
  return (
    <div className="h-[700px] relative">
      <SettingsModal
        harnesses={MOCK_HARNESSES}
        state={st}
        controlPort={33797}
        initialTab={initialTab}
        onClose={() => {}}
        onRefresh={() => {}}
        onUpdateSettings={(patch) =>
          setSt((prev) => ({ ...prev, settings: { ...prev.settings, ...patch } }))
        }
        onOrganize={(actions) => {
          setSt((prev) => {
            let nextFolders = [...prev.folders];
            for (const act of actions) {
              if (act.type === 'create_folder' && act.folderName) {
                nextFolders.push({
                  id: `f-${Date.now()}`,
                  name: act.folderName,
                  color: '#38bdf8',
                  order: nextFolders.length,
                });
              } else if (act.type === 'delete_folder' && act.folderId) {
                nextFolders = nextFolders.filter((f) => f.id !== act.folderId);
              } else if (act.type === 'rename_folder' && act.folderId && act.folderName) {
                nextFolders = nextFolders.map((f) =>
                  f.id === act.folderId ? { ...f, name: act.folderName! } : f
                );
              } else if (act.type === 'reorder_folders' && act.folderIds) {
                const byId = new Map(nextFolders.map((f) => [f.id, f]));
                nextFolders = act.folderIds
                  .map((id) => byId.get(id))
                  .filter((x): x is NonNullable<typeof x> => Boolean(x));
              }
            }
            return { ...prev, folders: nextFolders };
          });
        }}
      />
    </div>
  );
}

export const WorkspaceTab: StoryObj = {
  render: () => <InteractiveSettings initialTab="workspace" />,
};

export const HarnessesTab: StoryObj = {
  render: () => <InteractiveSettings initialTab="harnesses" />,
};
