import { readLastUserText } from '../utils/lastUserText';
import type {
  HarnessDetection,
  HarnessGroup,
  SessionTranscriptResult,
  TmuxCaptureResult,
  UnifiedSession,
} from '../../shared/types';
import { TranscriptCache } from '../services/transcriptCache';
import { canonicalClaudeModelId } from '../services/catalogService';
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

  private summaryLookup: (sessionId: string) => string | undefined = () => undefined;

  constructor(private readonly store: ConfigStore, drivers: HarnessDriver[] = createDefaultDrivers()) {
    this.drivers = drivers;
    this.driverMap = new Map(drivers.map((d) => [d.id, d]));
  }

  private readingLookup: () => Set<string> = () => new Set();

  /** Sessions lxe is looking at right now (open in a focused desktop pane or on the phone). */
  setReadingLookup(fn: () => Set<string>): void {
    this.readingLookup = fn;
  }

  /** Source of one-line thread summaries overlaid on each discovered session. */
  setSummaryLookup(fn: (sessionId: string) => string | undefined): void {
    this.summaryLookup = fn;
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

    // Detectors are mostly synchronous file/SQLite work. Starting each on its own
    // event-loop turn (their async parts still overlap) lets the Electron main thread,
    // which is also the browser UI thread, handle input and frames in between instead
    // of blocking for the whole sweep at once.
    const pending: Array<ReturnType<HarnessDriver['detect']>> = [];
    for (const driver of this.drivers) {
      if (!enabledHarnesses[driver.id]) {
        pending.push(
          Promise.resolve({
            detection: createDisabledDetection(driver.id, driver.displayName),
            sessions: [] as UnifiedSession[],
          })
        );
        continue;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      pending.push(driver.detect(processes, maxSessionsPerHarness, showArchived));
    }
    const results = await Promise.all(pending);

    const harnesses = results.map((r) => r.detection);
    const mergedRaw = results.flatMap((r) => r.sessions);

    const masterSession: UnifiedSession = {
      id: 'master:root',
      nativeId: 'root',
      harness: 'master',
      harnessGroup: 'master',
      title: 'Master Orchestrator',
      preview: `Engine: ${state.settings.master.harness} • Full Superharness MCP control`,
      cwd: state.settings.master.cwd,
      projectName: 'Superharness',
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

    // The orchestrator's own native sessions live behind the pinned master thread.
    const masterNativeIds = this.store.getMasterNativeIds();
    const decorated = mergedRaw
      .filter((raw) => !masterNativeIds.has(raw.nativeId))
      .map((raw) => {
        const lastUserText = raw.lastUserText ?? readLastUserText(raw.transcriptPath, raw.harnessGroup);
        const summary = this.summaryLookup(raw.id);
        const withText = lastUserText || summary ? { ...raw, lastUserText, summary } : raw;
        // Claude sessions log bare model names; report the picker row's ID so clients match it.
        const canonModel =
          withText.harnessGroup === 'claude' ? canonicalClaudeModelId(withText.model) : withText.model;
        const s = canonModel !== withText.model ? { ...withText, model: canonModel } : withText;
        const ov = state.overrides[s.id];
        if (!ov) return s;
        return {
          ...s,
          customTitle: ov.customTitle ?? s.customTitle,
          title: ov.customTitle || s.title,
          model:
            s.harnessGroup === 'claude' && ov.model ? canonicalClaudeModelId(ov.model) : ov.model || s.model,
          reasoningEffort: ov.reasoningEffort || s.reasoningEffort,
          permissionMode: ov.permissionMode || s.permissionMode,
          folderId: ov.folderId !== undefined ? ov.folderId : s.folderId,
          nativeSection:
            ov.nativeSection !== undefined ? ov.nativeSection || 'Ungrouped' : s.nativeSection,
          nativeSectionOrder:
            ov.nativeSection !== undefined
              ? ov.nativeSection && ov.nativeSection !== 'Ungrouped'
                ? (ov.nativeSectionOrder ?? s.nativeSectionOrder ?? 500)
                : 9999
              : s.nativeSectionOrder,
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

    // Unread: activity newer than what lxe last saw. Sessions open right now are read.
    const reading = this.readingLookup();
    this.store.markRead(
      [masterSession, ...decorated]
        .filter((s) => reading.has(s.id))
        .map((s) => ({ sessionId: s.id, updatedAt: s.updatedAt }))
    );
    for (const s of [masterSession, ...decorated] as UnifiedSession[]) {
      s.unread = s.status !== 'running' && !reading.has(s.id) && s.updatedAt > this.store.getReadMark(s.id) + 1000;
    }

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
