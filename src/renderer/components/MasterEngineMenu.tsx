import React, { useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import type { HarnessCatalog, HarnessGroup, MasterEngineConfig } from '../../shared/types';
import { Badge, MenuDivider, MenuItem, MenuSectionLabel, PopoverSurface } from '../ui';
import { HARNESS_TITLES } from '../utils/harnessMeta';
import { resolveSessionModelControls } from '../utils/modelOptions';
import { HarnessLogo } from './HarnessLogo';

/** Harnesses the Master Orchestrator can run on (see MasterEngine.runSegmentTurn). */
export const MASTER_ENGINE_HARNESSES: HarnessGroup[] = ['claude', 'codex', 'antigravity', 'muse'];

/** Chip text for the orchestrator's engine, e.g. "codex · gpt-6.2-sol" or "claude · default". */
export function masterEngineChipLabel(config: Pick<MasterEngineConfig, 'harness' | 'model'>): string {
  return `${config.harness} · ${config.model?.trim() || 'default'}`;
}

export interface MasterEngineMenuProps {
  config: MasterEngineConfig;
  catalog?: HarnessCatalog | null;
  onChange: (patch: { harness?: HarnessGroup; model?: string }) => void;
  /** Start with the menu open (Storybook). */
  initialOpen?: boolean;
}

/**
 * Composer chip for the Master Orchestrator: pick the harness that runs its turns and that
 * harness's model. A harness switch is applied by MasterEngine on the next turn through the
 * MEMORY.md handoff; a model change applies to the next turn on the same thread.
 */
export const MasterEngineMenu: React.FC<MasterEngineMenuProps> = ({ config, catalog, onChange, initialOpen = false }) => {
  const [open, setOpen] = useState(initialOpen);
  const [search, setSearch] = useState('');
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const controls = useMemo(
    () =>
      resolveSessionModelControls(
        config.harness,
        config.model || undefined,
        undefined,
        catalog,
        HARNESS_TITLES[config.harness]
      ),
    [config.harness, config.model, catalog]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return controls.models;
    return controls.models.filter(
      (m) =>
        m.label.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        (m.group || '').toLowerCase().includes(q)
    );
  }, [controls.models, search]);

  const close = () => {
    setOpen(false);
    setSearch('');
  };

  const selectHarness = (harness: HarnessGroup) => {
    if (harness === config.harness) return;
    // A model id belongs to one harness, so a harness switch starts on that harness's default.
    onChange({ harness, model: '' });
    setSearch('');
  };

  const selectModel = (model: string) => {
    onChange({ model });
    close();
  };

  const activeModel = config.model?.trim() || '';

  return (
    <div className="relative flex items-center min-w-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Switch the orchestrator's harness and model"
        aria-label="Switch orchestrator harness and model"
        aria-expanded={open}
        className={`h-7 px-2 rounded-lg inline-flex items-center gap-1.5 text-caption leading-none transition-colors cursor-pointer max-w-[260px] focus:outline-none focus-visible:shadow-none ${
          open
            ? 'bg-white/[0.09] text-ink-primary'
            : 'text-ink-muted hover:text-ink-primary hover:bg-white/[0.06]'
        }`}
      >
        <span className="inline-flex items-center justify-center shrink-0">
          <HarnessLogo harness={config.harness} size={14} />
        </span>
        <span className="truncate leading-none translate-y-[0.5px]">
          {masterEngineChipLabel(config)}
        </span>
        <ChevronDown className="w-3 h-3 text-ink-faint shrink-0 translate-y-[0.5px]" />
      </button>

      {open && (
        <PopoverSurface
          width="md"
          onClose={close}
          ignoreRef={triggerRef}
          // The shared popover shadow reads heavy on this tall menu over the composer; use the
          // tight card elevation token instead.
          className="absolute left-0 bottom-full mb-2 z-50 w-64 sh-shadow-card"
        >
          <MenuSectionLabel>Harness</MenuSectionLabel>
          <div className="space-y-0.5">
            {MASTER_ENGINE_HARNESSES.map((h) => {
              const isSelected = h === config.harness;
              return (
                <MenuItem
                  key={h}
                  active={isSelected}
                  onClick={() => selectHarness(h)}
                  rightSlot={
                    isSelected ? (
                      <Check className="w-3.5 h-3.5 text-ink-primary" strokeWidth={2} />
                    ) : undefined
                  }
                >
                  <span className="inline-flex items-center gap-2 min-w-0">
                    <HarnessLogo harness={h} size={14} />
                    <span className="truncate font-medium">{HARNESS_TITLES[h]}</span>
                  </span>
                </MenuItem>
              );
            })}
          </div>

          <MenuDivider />

          {controls.models.length > 6 && (
            <div className="mx-0.5 mt-0.5 mb-2 flex items-center gap-2 px-3 h-8 rounded-[20px] bg-surface-code shadow-[inset_0_1px_2px_rgba(0,0,0,0.34)] focus-within:bg-surface-rail transition-colors">
              <Search className="w-3.5 h-3.5 text-ink-faint shrink-0" strokeWidth={1.75} />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && filtered.length > 0) {
                    e.preventDefault();
                    selectModel(filtered[0].id);
                  }
                }}
                placeholder="Filter models…"
                className="flex-1 min-w-0 bg-transparent text-caption text-ink-primary placeholder:text-ink-faint focus:outline-none focus-visible:shadow-none"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  aria-label="Clear filter"
                  className="p-0.5 rounded text-ink-faint hover:text-ink-primary hover:bg-white/[0.06] transition-colors cursor-pointer"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          )}

          <div className="max-h-64 overflow-y-auto sh-scroll-hover space-y-0.5">
            {!search.trim() && (
              <MenuItem
                active={!activeModel}
                onClick={() => selectModel('')}
                rightSlot={
                  !activeModel ? (
                    <Check className="w-3.5 h-3.5 text-ink-primary" strokeWidth={2} />
                  ) : undefined
                }
              >
                <span className="truncate font-medium">Harness default</span>
              </MenuItem>
            )}
            {filtered.length === 0 && search.trim() ? (
              <div className="px-2.5 py-4 text-center text-caption text-ink-muted">
                No matching models
              </div>
            ) : (
              filtered.map((m) => {
                const isSelected = m.id === activeModel;
                return (
                  <MenuItem
                    key={m.id}
                    active={isSelected}
                    title={m.id}
                    onClick={() => selectModel(m.id)}
                    rightSlot={
                      <span className="inline-flex items-center gap-1.5">
                        {m.isDefault && <Badge tone="neutral">Default</Badge>}
                        {isSelected && (
                          <Check className="w-3.5 h-3.5 text-ink-primary" strokeWidth={2} />
                        )}
                      </span>
                    }
                  >
                    <span className="truncate font-medium">{m.label}</span>
                  </MenuItem>
                );
              })
            )}
          </div>
        </PopoverSurface>
      )}
    </div>
  );
};
