import type {
  HarnessDetection,
  HarnessGroup,
  SessionTranscriptResult,
  TmuxCaptureResult,
  UnifiedSession,
} from '../../shared/types';
import { TranscriptCache } from '../services/transcriptCache';
import type { ConfigStore } from '../store/configStore';
import { listProcesses } from '../utils/system';
import { captureTmuxPane } from './claudeAdapter';
import { createDefaultDrivers, createDisabledDetection, type HarnessDriver } from './index';

/**
 * Central harness-agnostic registry coordinating session discovery, metadata
 * overrides, and cached transcript loading across all registered HarnessDrivers.
 */
export class HarnessRegistry {
  private readonly drivers: HarnessDriver[];
  private readonly driverMap: Map<HarnessGroup, HarnessDriver>;
  private lastHarnesses: HarnessDetection[] = [];
  private lastSessions: UnifiedSession[] = [];
  private sessionMap = new Map<string, UnifiedSession>();
  private readonly transcriptCache = new TranscriptCache({
    maxEntries: 64,
    maxEstimatedBytes: 40 * 1024 * 1024,
  });

  constructor(private readonly store: ConfigStore, drivers: HarnessDriver[] = createDefaultDrivers()) {
    this.drivers = drivers;
    this.driverMap = new Map(drivers.map((d) => [d.id, d]));
  }

  getDrivers(): readonly HarnessDriver[] {
    return this.drivers;
  }

  getDriver(group: HarnessGroup): HarnessDriver | undefined {
    return this.driverMap.get(group);
  }

  async discover(): Promise<{
    harnesses: HarnessDetection[];
    sessions: UnifiedSession[];
  }> {
    const state = this.store.getState();
    const { maxSessionsPerHarness, showArchived, enabledHarnesses, showHidden } = state.settings;
    const processes = await listProcesses();

    const results = await Promise.all(
      this.drivers.map((driver) =>
        enabledHarnesses[driver.id]
          ? driver.detect(processes, maxSessionsPerHarness, showArchived)
          : Promise.resolve({
              detection: createDisabledDetection(driver.id, driver.displayName),
              sessions: [] as UnifiedSession[],
            })
      )
    );

    const harnesses = results.map((r) => r.detection);
    const mergedRaw = results.flatMap((r) => r.sessions);

    const masterSession: UnifiedSession = {
      id: 'master:root',
      nativeId: 'root',
      harness: 'master',
      harnessGroup: 'master',
      title: 'Master Orchestrator',
      preview: `Engine: ${state.settings.master.harness} • Full Super Harness MCP control`,
      cwd: state.settings.master.cwd,
      projectName: 'Super Harness',
      model: state.settings.master.model || `${state.settings.master.harness} (default)`,
      status: 'running',
      isLive: true,
      isRemote: false,
      createdAt: 0,
      updatedAt:
        state.masterMessages[state.masterMessages.length - 1]?.timestamp ?? Date.now(),
      pinned: true,
      folderId: null,
      tags: ['master', 'mcp'],
      hidden: false,
      dispatchMode: 'master',
    };

    const decorated = mergedRaw
      .map((s) => {
        const ov = state.overrides[s.id];
        if (!ov) return s;
        return {
          ...s,
          customTitle: ov.customTitle ?? s.customTitle,
          title: ov.customTitle || s.title,
          folderId: ov.folderId !== undefined ? ov.folderId : s.folderId,
          pinned: ov.pinned !== undefined ? ov.pinned : s.pinned,
          pinnedToTop: Boolean(ov.pinnedToTop),
          tags: ov.tags !== undefined ? ov.tags : s.tags,
          hidden: ov.hidden !== undefined ? ov.hidden : s.hidden,
        };
      })
      .filter((s) => showHidden || !s.hidden)
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
        return b.updatedAt - a.updatedAt;
      });

    const sessions = [masterSession, ...decorated];
    this.lastHarnesses = harnesses;
    this.lastSessions = sessions;
    this.sessionMap.clear();
    for (const s of sessions) {
      this.sessionMap.set(s.id, s);
    }

    return { harnesses, sessions };
  }

  getCached(): { harnesses: HarnessDetection[]; sessions: UnifiedSession[] } {
    return { harnesses: this.lastHarnesses, sessions: this.lastSessions };
  }

  getSession(sessionId: string): UnifiedSession | undefined {
    return this.sessionMap.get(sessionId);
  }

  async getTranscript(
    sessionId: string,
    limit = 120
  ): Promise<SessionTranscriptResult> {
    if (sessionId === 'master:root') {
      const msgs = this.store.getState().masterMessages;
      const sliced = msgs.length > limit ? msgs.slice(msgs.length - limit) : msgs;
      return {
        sessionId,
        messages: sliced,
        totalCount: msgs.length,
        hasMore: msgs.length > limit,
        sourceMtimeMs: Date.now(),
      };
    }

    let session = this.sessionMap.get(sessionId);
    if (!session) {
      await this.discover();
      session = this.sessionMap.get(sessionId);
    }
    if (!session || session.harnessGroup === 'master') {
      return {
        sessionId,
        messages: [],
        totalCount: 0,
        hasMore: false,
        sourceMtimeMs: Date.now(),
      };
    }

    const driver = this.driverMap.get(session.harnessGroup);
    if (!driver) {
      return {
        sessionId,
        messages: [],
        totalCount: 0,
        hasMore: false,
        sourceMtimeMs: Date.now(),
      };
    }

    const target = session;
    const fp = await driver.getTranscriptFingerprint(target);
    return this.transcriptCache.getOrLoad(sessionId, fp, limit, () =>
      driver.loadTranscript(target, limit)
    );
  }

  invalidateTranscriptCache(sessionId?: string): void {
    if (sessionId) this.transcriptCache.invalidate(sessionId);
    else this.transcriptCache.clear();
  }

  getTranscriptCacheStats() {
    return this.transcriptCache.stats();
  }

  async captureTmux(target: string): Promise<TmuxCaptureResult> {
    return captureTmuxPane(target);
  }
}
