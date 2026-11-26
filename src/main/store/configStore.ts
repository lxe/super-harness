import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  MasterThreadState,
  OrganizeAction,
  SuperHarnessSettings,
  SuperHarnessState,
  UnifiedMessage,
} from '../../shared/types';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'super-harness');
const STATE_FILE = path.join(CONFIG_DIR, 'state.json');

export function createDefaultState(): SuperHarnessState {
  return {
    readMarks: {},
    readBaseline: Date.now(),
    settings: {
      pollIntervalMs: 5000,
      maxSessionsPerHarness: 80,
      sidebarGroupBy: 'native',
      showArchived: false,
      showHidden: false,
      enabledHarnesses: {
        codex: true,
        claude: true,
        antigravity: true,
        muse: true,
      },
      master: {
        harness: 'claude',
        model: '',
        cwd: os.homedir(),
        autoApplyActions: true,
      },
      defaultNewSessionCwd: os.homedir(),
      apps: {
        fileClickAction: 'internal',
        folderClickAction: 'file-manager',
        editorCommand: '',
        fileManagerCommand: '',
        terminalCommand: '',
      },
      mobileApi: {
        enabled: true,
        bindHost: '0.0.0.0',
        port: 47890,
        token: crypto.randomBytes(24).toString('hex'),
      },
    },
    folders: [
      { id: 'folder-active', name: 'Active Workstreams', color: '#22c55e', order: 0 },
      { id: 'folder-remote', name: 'Remote & Background', color: '#a855f7', order: 1 },
    ],
    overrides: {},
    linkedCliSessions: {},
    masterMessages: [
      {
        id: 'master-welcome',
        role: 'assistant',
        timestamp: Date.now(),
        blocks: [
          {
            type: 'text',
            text: [
              '### Master Orchestrator Ready',
              '',
              'I have live MCP control over **Super Harness** across all your detected harnesses (**Codex**, **Claude Desktop**, **Claude tmux / Remote Control**, **Antigravity**, and **Muse**).',
              '',
              'Ask me in natural language — or use instant slash commands:',
              '- `/status` — inspect detected harnesses, live PIDs, and remote-control daemons',
              '- `/sessions [query]` — search sessions across every harness',
              '- `/folder <name>` — create a sidebar folder',
              '- `/auto-organize` — group live tmux & project workstreams into folders',
              '- `/send <sessionId> <message>` — dispatch a prompt to any session',
              '- `/engine <claude|codex|antigravity|muse>` — switch which harness powers this Master Session',
            ].join('\n'),
          },
        ],
      },
    ],
  };
}

export class ConfigStore {
  private readSaveTimer: NodeJS.Timeout | null = null;
  private state: SuperHarnessState;
  private listeners = new Set<(state: SuperHarnessState) => void>();

  constructor() {
    const hadStateFile = fs.existsSync(STATE_FILE);
    this.state = this.load();
    if (hadStateFile) {
      try {
        const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Partial<SuperHarnessState>;
        if (!raw.settings?.mobileApi?.token) {
          this.save();
        }
      } catch {
        // ignore parse errors
      }
    }
  }

  private load(): SuperHarnessState {
    const def = createDefaultState();
    try {
      if (!fs.existsSync(STATE_FILE)) return def;
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Partial<SuperHarnessState>;
      // Migrate legacy variant-prefixed Claude IDs (claude-desktop:/claude-cli:/claude-tmux:)
      // to canonical `claude:<uuid>` so user pins, renames, folders & hidden flags stay intact.
      const migratedOverrides: SuperHarnessState['overrides'] = {};
      for (const [k, v] of Object.entries(raw.overrides ?? {})) {
        const canonical = k.replace(/^claude-(?:desktop|cli|tmux):/, 'claude:');
        migratedOverrides[canonical] = { ...(migratedOverrides[canonical] ?? {}), ...v };
      }
      return {
        settings: {
          ...def.settings,
          ...(raw.settings ?? {}),
          enabledHarnesses: {
            ...def.settings.enabledHarnesses,
            ...(raw.settings?.enabledHarnesses ?? {}),
          },
          master: {
            ...def.settings.master,
            ...(raw.settings?.master ?? {}),
          },
          apps: {
            ...def.settings.apps,
            ...(raw.settings?.apps ?? {}),
          },
          mobileApi: {
            ...def.settings.mobileApi!,
            ...(raw.settings?.mobileApi ?? {}),
            token: raw.settings?.mobileApi?.token || def.settings.mobileApi!.token,
          },
        },
        folders: Array.isArray(raw.folders) ? raw.folders : def.folders,
        overrides: migratedOverrides,
        linkedCliSessions: raw.linkedCliSessions ?? {},
        readMarks: raw.readMarks ?? {},
        // Existing installs start with everything read, so the dot only marks new activity.
        readBaseline: typeof raw.readBaseline === 'number' ? raw.readBaseline : Date.now(),
        masterThread: raw.masterThread && Array.isArray(raw.masterThread.segments) ? raw.masterThread : { segments: [] },
        masterMessages:
          Array.isArray(raw.masterMessages) && raw.masterMessages.length > 0
            ? raw.masterMessages
            : def.masterMessages,
      };
    } catch {
      return def;
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2), 'utf8');
    } catch (err) {
      console.error('[ConfigStore] Failed to save state:', err);
    }
  }

  private emit(): void {
    const snapshot = this.getState();
    for (const cb of this.listeners) {
      cb(snapshot);
    }
  }

  subscribe(cb: (state: SuperHarnessState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  getState(): SuperHarnessState {
    return structuredClone(this.state);
  }

  updateSettings(patch: Partial<SuperHarnessSettings>): SuperHarnessState {
    if (patch.harnessOrder !== undefined) {
      const known = new Set(['antigravity', 'codex', 'claude', 'muse']);
      const order = Array.isArray(patch.harnessOrder)
        ? patch.harnessOrder.filter((h, i, a) => known.has(h) && a.indexOf(h) === i)
        : [];
      patch = { ...patch, harnessOrder: order as SuperHarnessSettings['harnessOrder'] };
    }
    this.state.settings = {
      ...this.state.settings,
      ...patch,
      enabledHarnesses: {
        ...this.state.settings.enabledHarnesses,
        ...(patch.enabledHarnesses ?? {}),
      },
      master: {
        ...this.state.settings.master,
        ...(patch.master ?? {}),
      },
      apps: {
        ...this.state.settings.apps,
        ...(patch.apps ?? {}),
      },
      mobileApi: {
        enabled: this.state.settings.mobileApi?.enabled ?? true,
        bindHost: this.state.settings.mobileApi?.bindHost ?? '0.0.0.0',
        port: this.state.settings.mobileApi?.port ?? 47890,
        token: this.state.settings.mobileApi?.token || crypto.randomBytes(24).toString('hex'),
        ...(patch.mobileApi ?? {}),
      },
    };
    this.save();
    this.emit();
    return this.getState();
  }

  applyOrganize(actions: OrganizeAction[]): SuperHarnessState {
    for (const act of actions) {
      switch (act.type) {
        case 'create_folder': {
          if (!act.folderName?.trim()) break;
          const existing = this.state.folders.find(
            (f) => f.name.toLowerCase() === act.folderName!.trim().toLowerCase()
          );
          if (!existing) {
            this.state.folders.push({
              id: act.folderId || `folder-${crypto.randomBytes(4).toString('hex')}`,
              name: act.folderName.trim(),
              color: act.folderColor || '#38bdf8',
              order: this.state.folders.length,
            });
          }
          break;
        }
        case 'delete_folder': {
          if (!act.folderId) break;
          this.state.folders = this.state.folders.filter((f) => f.id !== act.folderId);
          for (const ov of Object.values(this.state.overrides)) {
            if (ov.folderId === act.folderId) ov.folderId = null;
          }
          break;
        }
        case 'rename_folder': {
          if (!act.folderId || !act.folderName?.trim()) break;
          const f = this.state.folders.find((x) => x.id === act.folderId);
          if (f) f.name = act.folderName.trim();
          break;
        }
        case 'reorder_folders': {
          if (!Array.isArray(act.folderIds) || act.folderIds.length === 0) break;
          const byId = new Map(this.state.folders.map((f) => [f.id, f]));
          const reordered: typeof this.state.folders = [];
          for (const fid of act.folderIds) {
            const found = byId.get(fid);
            if (found) {
              reordered.push(found);
              byId.delete(fid);
            }
          }
          for (const rest of byId.values()) reordered.push(rest);
          reordered.forEach((f, idx) => {
            f.order = idx;
          });
          this.state.folders = reordered;
          break;
        }
        case 'assign_folder': {
          if (!act.sessionId) break;
          let targetFolderId = act.folderId ?? null;
          if (!targetFolderId && act.folderName) {
            let f = this.state.folders.find(
              (x) => x.name.toLowerCase() === act.folderName!.toLowerCase()
            );
            if (!f) {
              f = {
                id: `folder-${crypto.randomBytes(4).toString('hex')}`,
                name: act.folderName.trim(),
                color: act.folderColor || '#38bdf8',
                order: this.state.folders.length,
              };
              this.state.folders.push(f);
            }
            targetFolderId = f.id;
          }
          this.state.overrides[act.sessionId] = {
            ...(this.state.overrides[act.sessionId] ?? {}),
            folderId: targetFolderId,
          };
          break;
        }
        case 'move_section': {
          if (!act.sessionId) break;
          const normalizedSection =
            act.sectionName && act.sectionName.trim() && act.sectionName.trim() !== 'Ungrouped'
              ? act.sectionName.trim()
              : 'Ungrouped';
          this.state.overrides[act.sessionId] = {
            ...(this.state.overrides[act.sessionId] ?? {}),
            nativeSection: normalizedSection,
            nativeSectionOrder:
              normalizedSection === 'Ungrouped' ? 9999 : (act.sectionOrder ?? 500),
            pinned: false,
            pinnedToTop: false,
          };
          break;
        }
        case 'set_model': {
          if (!act.sessionId) break;
          const prev = this.state.overrides[act.sessionId] ?? {};
          this.state.overrides[act.sessionId] = {
            ...prev,
            ...(act.model !== undefined ? { model: act.model.trim() || undefined } : {}),
            ...(act.reasoningEffort !== undefined
              ? { reasoningEffort: act.reasoningEffort.trim().toLowerCase() || undefined }
              : {}),
            ...(act.permissionMode !== undefined
              ? { permissionMode: act.permissionMode.trim() || undefined }
              : {}),
          };
          break;
        }
        case 'pin': {
          if (!act.sessionId) break;
          this.state.overrides[act.sessionId] = {
            ...(this.state.overrides[act.sessionId] ?? {}),
            pinned: true,
          };
          break;
        }
        case 'unpin': {
          if (!act.sessionId) break;
          this.state.overrides[act.sessionId] = {
            ...(this.state.overrides[act.sessionId] ?? {}),
            pinned: false,
          };
          break;
        }
        case 'pin_top': {
          if (!act.sessionId) break;
          this.state.overrides[act.sessionId] = {
            ...(this.state.overrides[act.sessionId] ?? {}),
            pinnedToTop: true,
          };
          break;
        }
        case 'unpin_top': {
          if (!act.sessionId) break;
          this.state.overrides[act.sessionId] = {
            ...(this.state.overrides[act.sessionId] ?? {}),
            pinnedToTop: false,
          };
          break;
        }
        case 'rename_session': {
          if (!act.sessionId) break;
          this.state.overrides[act.sessionId] = {
            ...(this.state.overrides[act.sessionId] ?? {}),
            customTitle: act.title?.trim() || undefined,
          };
          break;
        }
        case 'tag_session': {
          if (!act.sessionId) break;
          this.state.overrides[act.sessionId] = {
            ...(this.state.overrides[act.sessionId] ?? {}),
            tags: act.tags ?? [],
          };
          break;
        }
        case 'hide_session': {
          if (!act.sessionId) break;
          this.state.overrides[act.sessionId] = {
            ...(this.state.overrides[act.sessionId] ?? {}),
            hidden: true,
          };
          break;
        }
        case 'unhide_session': {
          if (!act.sessionId) break;
          this.state.overrides[act.sessionId] = {
            ...(this.state.overrides[act.sessionId] ?? {}),
            hidden: false,
          };
          break;
        }
      }
    }
    this.save();
    this.emit();
    return this.getState();
  }

  appendMasterMessage(msg: UnifiedMessage): SuperHarnessState {
    this.state.masterMessages.push(msg);
    if (this.state.masterMessages.length > 200) {
      this.state.masterMessages = this.state.masterMessages.slice(-200);
    }
    this.save();
    this.emit();
    return this.getState();
  }

  updateMasterMessage(id: string, updater: (msg: UnifiedMessage) => UnifiedMessage): void {
    const idx = this.state.masterMessages.findIndex((m) => m.id === id);
    if (idx === -1) return;
    this.state.masterMessages[idx] = updater(this.state.masterMessages[idx]);
    this.save();
    this.emit();
  }

  /** Last-read `updatedAt` per session, with the baseline for sessions never opened. */
  getReadMark(sessionId: string): number {
    const mark = this.state.readMarks?.[sessionId];
    if (mark === -1) return -1; // marked unread by hand
    return Math.max(mark ?? 0, this.state.readBaseline ?? 0);
  }

  /**
   * Record that lxe has seen these sessions up to the given updatedAt. Saves at most every
   * few seconds (it is called on every discovery pass for open sessions).
   */
  markRead(marks: Array<{ sessionId: string; updatedAt: number }>): boolean {
    if (!this.state.readMarks) this.state.readMarks = {};
    let changed = false;
    for (const { sessionId, updatedAt } of marks) {
      const prev = this.state.readMarks[sessionId] ?? 0;
      if (prev === -1 || prev < updatedAt) {
        this.state.readMarks[sessionId] = updatedAt;
        changed = true;
      }
    }
    if (changed && !this.readSaveTimer) {
      this.readSaveTimer = setTimeout(() => {
        this.readSaveTimer = null;
        this.save();
      }, 3000);
      this.readSaveTimer.unref?.();
    }
    return changed;
  }

  /** Mark a session unread again (it shows the dot until opened). */
  markUnread(sessionId: string): void {
    if (!this.state.readMarks) this.state.readMarks = {};
    this.state.readMarks[sessionId] = -1;
    this.save();
    this.emit();
  }

  getMasterThread(): MasterThreadState {
    if (!this.state.masterThread) this.state.masterThread = { segments: [] };
    return this.state.masterThread;
  }

  updateMasterThread(updater: (t: MasterThreadState) => MasterThreadState): MasterThreadState {
    this.state.masterThread = updater(this.getMasterThread());
    this.save();
    this.emit();
    return this.state.masterThread;
  }

  /** Native session ids that belong to the orchestrator (all segments plus legacy one-turn sessions). */
  getMasterNativeIds(): Set<string> {
    const t = this.getMasterThread();
    return new Set([
      ...t.segments.map((s) => s.nativeId).filter((x): x is string => Boolean(x)),
      ...(t.legacyNativeIds ?? []),
    ]);
  }

  clearMasterMessages(): SuperHarnessState {
    // A cleared orchestrator thread starts a fresh native session; legacy hiding stays.
    const prev = this.getMasterThread();
    this.state.masterThread = {
      segments: [],
      legacyNativeIds: [
        ...(prev.legacyNativeIds ?? []),
        ...prev.segments.map((s) => s.nativeId).filter((x): x is string => Boolean(x)),
      ],
      legacyScanDone: prev.legacyScanDone,
    };
    this.state.masterMessages = createDefaultState().masterMessages;
    this.save();
    this.emit();
    return this.getState();
  }

  getLinkedCliSession(sessionId: string): string | undefined {
    return this.state.linkedCliSessions?.[sessionId];
  }

  setLinkedCliSession(sessionId: string, cliConversationId: string): void {
    if (!this.state.linkedCliSessions) this.state.linkedCliSessions = {};
    this.state.linkedCliSessions[sessionId] = cliConversationId;
    this.save();
  }
}
