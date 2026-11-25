import React, { useMemo, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  ListChecks,
  Loader2,
} from 'lucide-react';
import type { LiveStepItem } from '../../shared/types';

export interface LiveStepsBarProps {
  steps?: LiveStepItem[];
}

/**
 * Collapsible live task checklist pinned quietly above the composer whenever
 * an agent publishes active steps (Antigravity `update_steps` / Claude `TodoWrite`).
 */
export const LiveStepsBar: React.FC<LiveStepsBarProps> = React.memo(({ steps }) => {
  const [expanded, setExpanded] = useState(false);

  const completedCount = useMemo(
    () => (steps ? steps.filter((s) => s.status === 'done').length : 0),
    [steps]
  );

  if (!steps || steps.length === 0) return null;

  const current = steps.find((s) => s.status === 'in_progress');
  if (!current && !expanded && completedCount === steps.length) {
    return null;
  }

  return (
    <div className="rounded-xl border border-line-hairline bg-surface-popover overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-3 py-1.5 flex items-center gap-2 text-caption text-ink-muted hover:text-ink-primary transition-colors cursor-pointer"
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 shrink-0" />
        )}
        <ListChecks className="w-3.5 h-3.5 shrink-0 text-ink-faint" />
        <span className="font-mono text-micro text-ink-faint shrink-0">
          {completedCount}/{steps.length}
        </span>
        <span className="truncate flex-1 text-left text-ink-secondary">
          {current ? current.title : 'Completed'}
        </span>
      </button>
      {expanded && (
        <div className="px-3 pb-2.5 pt-1 border-t border-line-hairline space-y-1">
          {steps.map((st, idx) => (
            <div key={idx} className="flex items-center gap-2 text-caption">
              {st.status === 'done' ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-ink-faint shrink-0" />
              ) : st.status === 'in_progress' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-ink-secondary shrink-0" />
              ) : (
                <Circle className="w-3.5 h-3.5 text-zinc-700 shrink-0" />
              )}
              <span
                className={
                  st.status === 'done'
                    ? 'text-ink-faint line-through'
                    : st.status === 'in_progress'
                      ? 'text-ink-primary'
                      : 'text-ink-faint'
                }
              >
                {st.title}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
