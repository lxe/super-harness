import fs from 'node:fs';
import path from 'node:path';
import type { SessionTranscriptResult } from '../../shared/types';
import type { HarnessRegistry } from '../adapters/registry';

interface PaneWatch {
  paneId: string;
  sessionId: string;
  limit: number;
  watchers: fs.FSWatcher[];
  debounceTimer: NodeJS.Timeout | null;
  lastFingerprint: string;
  watchedFiles: string[];
}

/**
 * Event-driven real-time FS watcher (Linux inotify via fs.watch) that reacts
 * within ~65ms whenever any registered HarnessDriver's transcripts, rollouts,
 * or SQLite WAL files change — pushing updates live over IPC and SSE.
 *
 * All harness-specific paths live inside each HarnessDriver's
 * `getGlobalWatchDirs()` and `getSessionWatchFiles()` methods.
 */
export class LiveSyncService {
  private globalWatchers: fs.FSWatcher[] = [];
  private globalDebounce: NodeJS.Timeout | null = null;
  private paneWatches = new Map<string, PaneWatch>();
  private safetyTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly registry: HarnessRegistry,
    private readonly onSessionsDirty: () => void,
    private readonly onTranscriptPushed: (result: SessionTranscriptResult) => void
  ) {}

  start(): void {
    this.setupGlobalWatchers();
    // Lightweight stat fallback every 1.2s for active panes (covers mmap/WAL writes)
    this.safetyTimer = setInterval(() => {
      for (const pw of this.paneWatches.values()) {
        const fp = this.computeFilesFingerprint(pw.watchedFiles);
        if (fp !== pw.lastFingerprint) {
          pw.lastFingerprint = fp;
          this.schedulePanePush(pw, 20);
        }
      }
    }, 1200);
  }

  stop(): void {
    if (this.safetyTimer) {
      clearInterval(this.safetyTimer);
      this.safetyTimer = null;
    }
    if (this.globalDebounce) {
      clearTimeout(this.globalDebounce);
      this.globalDebounce = null;
    }
    for (const w of this.globalWatchers) {
      try {
        w.close();
      } catch {
        // ignore
      }
    }
    this.globalWatchers = [];
    for (const paneId of Array.from(this.paneWatches.keys())) {
      this.unwatchPane(paneId);
    }
  }

  private setupGlobalWatchers(): void {
    const targets = this.registry.getDrivers().flatMap((d) => d.getGlobalWatchDirs());

    for (const t of targets) {
      if (!fs.existsSync(t.dir)) continue;
      try {
        const w = fs.watch(t.dir, { persistent: false }, (_event, filename) => {
          if (t.filter && filename && !t.filter(String(filename))) return;
          this.scheduleGlobalRefresh();
        });
        w.on('error', () => {
          // ignore watcher errors on transient directories
        });
        this.globalWatchers.push(w);
      } catch {
        // ignore watch failures
      }
    }
  }

  private scheduleGlobalRefresh(): void {
    if (this.globalDebounce) clearTimeout(this.globalDebounce);
    this.globalDebounce = setTimeout(() => {
      this.globalDebounce = null;
      this.onSessionsDirty();
    }, 250);
  }

  async watchPane(paneId: string, sessionId: string | null, limit = 60): Promise<void> {
    this.unwatchPane(paneId);
    if (!sessionId || sessionId === 'master:root') return;

    let session = this.registry.getSession(sessionId);
    if (!session) {
      await this.registry.discover();
      session = this.registry.getSession(sessionId);
    }
    if (!session || session.harnessGroup === 'master') return;

    const driver = this.registry.getDriver(session.harnessGroup);
    if (!driver) return;

    const watchedFiles: string[] = [];
    const dirsToWatch = new Map<string, Set<string>>();

    for (const filePath of driver.getSessionWatchFiles(session)) {
      if (!filePath) continue;
      watchedFiles.push(filePath);
      let isDir = false;
      try {
        isDir = fs.existsSync(filePath) && fs.statSync(filePath).isDirectory();
      } catch {
        isDir = false;
      }
      if (isDir) {
        // Watch the directory itself for any added/modified/removed files (e.g. queued messages)
        if (!dirsToWatch.has(filePath)) dirsToWatch.set(filePath, new Set());
        dirsToWatch.get(filePath)!.add('*');
      } else {
        const dir = path.dirname(filePath);
        const base = path.basename(filePath);
        if (!dirsToWatch.has(dir)) dirsToWatch.set(dir, new Set());
        dirsToWatch.get(dir)!.add(base);
      }
    }

    const pw: PaneWatch = {
      paneId,
      sessionId,
      limit,
      watchers: [],
      debounceTimer: null,
      watchedFiles,
      lastFingerprint: this.computeFilesFingerprint(watchedFiles),
    };

    // Watch parent directories so atomic renames/appends & WAL writes always fire reliably
    for (const [dir, allowedBases] of dirsToWatch.entries()) {
      if (!fs.existsSync(dir)) continue;
      const watchAll = allowedBases.has('*');
      try {
        const w = fs.watch(dir, { persistent: false }, (_event, filename) => {
          const name = filename ? String(filename) : '';
          if (!watchAll && name && !allowedBases.has(name) && !name.endsWith('-wal')) return;
          pw.lastFingerprint = this.computeFilesFingerprint(pw.watchedFiles);
          this.schedulePanePush(pw, 65);
        });
        w.on('error', () => {
          // ignore
        });
        pw.watchers.push(w);
      } catch {
        // ignore
      }
    }

    // Also attach direct file watchers where possible for instant inotify IN_MODIFY
    for (const fp of watchedFiles) {
      if (!fs.existsSync(fp)) continue;
      try {
        if (fs.statSync(fp).isDirectory()) continue;
        const w = fs.watch(fp, { persistent: false }, () => {
          pw.lastFingerprint = this.computeFilesFingerprint(pw.watchedFiles);
          this.schedulePanePush(pw, 65);
        });
        w.on('error', () => {
          // ignore
        });
        pw.watchers.push(w);
      } catch {
        // ignore
      }
    }

    this.paneWatches.set(paneId, pw);
  }

  /** Native push activity for a session (e.g. Codex daemon notifications). */
  notifyExternalActivity(sessionId: string): void {
    this.scheduleGlobalRefresh();
    for (const pw of this.paneWatches.values()) {
      if (pw.sessionId === sessionId) this.schedulePanePush(pw, 150);
    }
  }

  unwatchPane(paneId: string): void {
    const existing = this.paneWatches.get(paneId);
    if (!existing) return;
    if (existing.debounceTimer) clearTimeout(existing.debounceTimer);
    for (const w of existing.watchers) {
      try {
        w.close();
      } catch {
        // ignore
      }
    }
    this.paneWatches.delete(paneId);
  }

  private schedulePanePush(pw: PaneWatch, delayMs: number): void {
    if (pw.debounceTimer) clearTimeout(pw.debounceTimer);
    pw.debounceTimer = setTimeout(async () => {
      pw.debounceTimer = null;
      // Ensure this pane is still watching the same session
      if (this.paneWatches.get(pw.paneId) !== pw) return;
      try {
        const res = await this.registry.getTranscript(pw.sessionId, pw.limit);
        this.onTranscriptPushed(res);
      } catch {
        // ignore transient read errors mid-write
      }
    }, delayMs);
  }

  private computeFilesFingerprint(files: string[]): string {
    return files
      .map((f) => {
        try {
          const st = fs.statSync(f);
          if (st.isDirectory()) {
            const count = fs.readdirSync(f).length;
            return `dir:${count}:${Math.floor(st.mtimeMs)}`;
          }
          return `${st.size}:${Math.floor(st.mtimeMs)}`;
        } catch {
          return '0:0';
        }
      })
      .join('|');
  }
}
