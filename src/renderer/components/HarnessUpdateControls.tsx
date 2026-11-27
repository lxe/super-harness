import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { HarnessDetection, HarnessUpdateJob } from '../../shared/types';
import { Button, IconButton } from '../ui';
import { isUpdateRunning } from '../utils/harnessUpdates';

function agoLabel(at: number | null | undefined): string {
  if (!at) return 'never';
  const mins = Math.floor((Date.now() - at) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** Right side of a Settings → Harnesses row: "1.4.0 → 1.6.1" and Update, when there is one. */
export const HarnessUpdateAction: React.FC<{
  harness: HarnessDetection;
  job?: HarnessUpdateJob;
  onStart: () => void;
}> = ({ harness, job, onStart }) => {
  const u = harness.update;
  const running = isUpdateRunning(job);
  if (!u || (!u.updateAvailable && !u.staleDaemon && !running)) return null;
  return (
    <>
      {u.updateAvailable && (
        <span className="text-caption text-ink-muted tabular-nums whitespace-nowrap">
          {u.current} → {u.latest}
        </span>
      )}
      <Button size="sm" variant="secondary" loading={running} disabled={running} onClick={onStart}>
        {job?.phase === 'waiting' ? 'Waiting' : running ? 'Updating' : u.updateAvailable ? 'Update' : 'Restart daemon'}
      </Button>
    </>
  );
};

/** Progress, log and outcome of the latest update, under the row. */
export const HarnessUpdateStatus: React.FC<{
  job: HarnessUpdateJob;
  onCancel: () => void;
  onDismiss: () => void;
}> = ({ job, onCancel, onDismiss }) => {
  const running = isUpdateRunning(job);
  const [showLog, setShowLog] = useState(running);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (running) setShowLog(true);
  }, [running]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [job.log.length, showLog]);

  const headline =
    job.phase === 'waiting'
      ? job.message
      : job.phase === 'updating'
        ? `Running ${job.step ?? 'the updater'}…`
        : job.phase === 'restarting'
          ? 'Restarting and checking the new version…'
          : job.message;
  const tone =
    job.phase === 'failed' ? 'text-status-danger' : job.phase === 'done' ? 'text-status-success' : 'text-ink-secondary';

  return (
    <div className="pl-[52px] pb-4 -mt-1 space-y-2">
      <div className="flex items-start gap-3">
        <p className={`text-caption flex-1 min-w-0 ${tone}`}>{headline}</p>
        <div className="flex items-center gap-1.5 shrink-0">
          {job.phase === 'waiting' && (
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
          {job.log.length > 0 && !running && (
            <Button size="sm" variant="ghost" onClick={() => setShowLog((v) => !v)}>
              {showLog ? 'Hide log' : 'Show log'}
            </Button>
          )}
          {!running && (
            <IconButton size="xs" label="Dismiss" onClick={onDismiss}>
              <X className="w-3 h-3" />
            </IconButton>
          )}
        </div>
      </div>
      {showLog && job.log.length > 0 && (
        <pre
          ref={logRef}
          className="max-h-40 overflow-auto rounded-lg bg-surface-subtle border border-line-hairline px-3 py-2 font-mono text-micro text-ink-secondary whitespace-pre-wrap break-words"
        >
          {job.log.join('\n')}
        </pre>
      )}
    </div>
  );
};

/** Version rows inside a harness's expanded details. */
export const HarnessUpdateDetails: React.FC<{
  harness: HarnessDetection;
  job?: HarnessUpdateJob;
  onStart: () => void;
}> = ({ harness, job, onStart }) => {
  const u = harness.update;
  if (!u) return null;
  const running = isUpdateRunning(job);
  const latestText = u.latest
    ? u.updateAvailable
      ? `${u.latest} available`
      : `${u.latest}, up to date`
    : 'unknown';
  return (
    <>
      <div className="grid grid-cols-[96px_1fr] gap-3 items-baseline">
        <span className="text-ink-faint">Version</span>
        <span className="text-ink-secondary">
          <span className="tabular-nums">{u.current ?? 'unknown'}</span>
          <span className="text-ink-faint"> · latest </span>
          <span className="tabular-nums">{latestText}</span>
          <span className="text-ink-faint">
            {' '}
            · checked {agoLabel(u.checkedAt)}
            {u.latestSource ? ` (${u.latestSource})` : ''}
          </span>
        </span>
      </div>
      {u.checkError && (
        <div className="grid grid-cols-[96px_1fr] gap-3 items-baseline">
          <span className="text-ink-faint">Last check</span>
          <span className="text-status-warning">{u.checkError}</span>
        </div>
      )}
      {u.staleDaemon && (
        <div className="grid grid-cols-[96px_1fr] gap-3 items-baseline">
          <span className="text-ink-faint">Daemon</span>
          <span className="text-status-warning">{u.staleDaemon.detail}</span>
        </div>
      )}
      {u.staleProcesses ? (
        <div className="grid grid-cols-[96px_1fr] gap-3 items-baseline">
          <span className="text-ink-faint">Old build</span>
          <span className="text-ink-secondary">
            {u.staleProcesses} running {u.staleProcesses === 1 ? 'process keeps' : 'processes keep'} an older
            version until {u.staleProcesses === 1 ? 'it’s' : 'they’re'} restarted (sessions in tmux or a terminal).
          </span>
        </div>
      ) : null}
      <div className="grid grid-cols-[96px_1fr] gap-3 items-center">
        <span className="text-ink-faint">Updater</span>
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-micro text-ink-secondary truncate" title={u.command}>
            {u.method === 'manual' ? u.manualHint : u.command}
          </span>
          {u.method === 'command' && (
            <Button size="sm" variant="ghost" loading={running} disabled={running} onClick={onStart}>
              Run
            </Button>
          )}
        </div>
      </div>
      {u.selfUpdating && (
        <div className="grid grid-cols-[96px_1fr] gap-3 items-baseline">
          <span className="text-ink-faint" />
          <span className="text-ink-faint">{u.selfUpdating}</span>
        </div>
      )}
    </>
  );
};
