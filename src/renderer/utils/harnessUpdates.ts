import { useCallback, useEffect, useState } from 'react';
import type { HarnessDetection, HarnessGroup, HarnessUpdateJob } from '../../shared/types';

/** Whether a harness needs attention for its version, in a few words (for the gauge dot), else undefined. */
export function harnessUpdateNotice(h: HarnessDetection | undefined): string | undefined {
  const u = h?.update;
  if (!u) return undefined;
  if (u.updateAvailable) return `Update available: ${u.current} → ${u.latest}`;
  if (u.staleDaemon) return `${u.staleDaemon.name} runs an older version`;
  return undefined;
}

export function isUpdateRunning(job: HarnessUpdateJob | undefined): boolean {
  return Boolean(job && (job.phase === 'waiting' || job.phase === 'updating' || job.phase === 'restarting'));
}

/** Live harness update jobs (latest per harness) and the actions to start or cancel one. */
export function useHarnessUpdateJobs(): {
  jobs: Partial<Record<HarnessGroup, HarnessUpdateJob>>;
  start: (harness: HarnessGroup) => Promise<string | null>;
  cancel: (harness: HarnessGroup) => Promise<void>;
  dismiss: (harness: HarnessGroup) => void;
} {
  const [jobs, setJobs] = useState<Partial<Record<HarnessGroup, HarnessUpdateJob>>>({});

  useEffect(() => {
    let alive = true;
    void window.superHarness.getHarnessUpdateJobs().then((list) => {
      if (!alive) return;
      setJobs((prev) => {
        const next = { ...prev };
        for (const j of list) if (!next[j.harness]) next[j.harness] = j;
        return next;
      });
    });
    const off = window.superHarness.onHarnessUpdate((job) => {
      setJobs((prev) => ({ ...prev, [job.harness]: job }));
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const start = useCallback(async (harness: HarnessGroup) => {
    const res = await window.superHarness.startHarnessUpdate(harness);
    if (!res.ok) return res.error;
    setJobs((prev) => ({ ...prev, [harness]: res.job }));
    return null;
  }, []);

  const cancel = useCallback(async (harness: HarnessGroup) => {
    await window.superHarness.cancelHarnessUpdate(harness);
  }, []);

  const dismiss = useCallback((harness: HarnessGroup) => {
    setJobs((prev) => {
      const next = { ...prev };
      delete next[harness];
      return next;
    });
  }, []);

  return { jobs, start, cancel, dismiss };
}
