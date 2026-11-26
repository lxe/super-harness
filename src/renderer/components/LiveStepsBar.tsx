import React, { useMemo, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  ListChecks,
} from 'lucide-react';
import type { LiveStepItem } from '../../shared/types';
import { WorkingOrb } from '../ui';

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
        className="w-full px-3.5 py-2.5 flex items-center gap-2.5 text-caption leading-none text-ink-muted hover:text-ink-primary hover:bg-white/[0.03] transition-colors cursor-pointer focus:outline-none focus-visible:shadow-none"
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 shrink-0" />
        )}
        <ListChecks className="w-3.5 h-3.5 shrink-0 text-ink-faint" />
        <span className="tabular-nums font-medium text-caption leading-none text-ink-faint shrink-0">
          {completedCount}/{steps.length}
        </span>
        <span className="truncate flex-1 text-left leading-snug text-ink-secondary">
          {current ? current.title : 'Completed'}
        </span>
      </button>
      {expanded && (
        <div className="px-3.5 py-3 border-t border-white/[0.06] space-y-2.5">
          {steps.map((st, idx) => (
            <div key={idx} className="flex items-center gap-2.5 text-caption leading-snug">
              {st.status === 'done' ? (
                <CheckCircle2 className="w-4 h-4 text-ink-faint shrink-0" />
              ) : st.status === 'in_progress' ? (
                <WorkingOrb tone="antigravity" size="sm" className="shrink-0" />
              ) : (
                <Circle className="w-4 h-4 text-zinc-700 shrink-0" />
              )}
              <span
                className={
                  st.status === 'done'
                    ? 'text-ink-faint line-through'
                    : st.status === 'in_progress'
                      ? 'text-ink-primary font-medium'
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
