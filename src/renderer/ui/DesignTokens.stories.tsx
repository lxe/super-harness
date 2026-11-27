import type { Meta, StoryObj } from '@storybook/react';
import React from 'react';
import { HarnessLogo } from '../components/HarnessLogo';

const SURFACES = [
  { name: 'surface-code', hex: '#101114', role: 'Recessed terminal / code wells', cls: 'bg-surface-code' },
  { name: 'surface-rail', hex: '#111215', role: 'Navigation sidebar rail', cls: 'bg-surface-rail' },
  { name: 'surface-canvas', hex: '#16171b', role: 'Primary reading & chat canvas', cls: 'bg-surface-canvas' },
  { name: 'surface-subtle', hex: '#181a1f', role: 'Cards, inputs, segmented track', cls: 'bg-surface-subtle' },
  { name: 'surface-popover', hex: '#1a1c22', role: 'Menus, modals, hover cards', cls: 'bg-surface-popover' },
  { name: 'surface-raised', hex: '#1f2128', role: 'Secondary buttons, hovered tiles', cls: 'bg-surface-raised' },
  { name: 'surface-bubble', hex: '#23252c', role: 'User chat bubbles', cls: 'bg-surface-bubble' },
];

const INKS = [
  { name: 'ink-primary', hex: '#f1f3f7', role: 'Headings, active rows, user text', cls: 'text-ink-primary' },
  { name: 'ink-secondary', hex: '#c8ccd6', role: 'Body copy, standard controls', cls: 'text-ink-secondary' },
  { name: 'ink-muted', hex: '#8b909e', role: 'Metadata, secondary icons, hints', cls: 'text-ink-muted' },
  { name: 'ink-faint', hex: '#5f6472', role: 'Placeholders, counts, timestamps', cls: 'text-ink-faint' },
];

const BRANDS = [
  { id: 'antigravity' as const, name: 'Antigravity', hex: '#60a5fa', cls: 'bg-brand-antigravity' },
  { id: 'codex' as const, name: 'Codex', hex: '#10a37f', cls: 'bg-brand-codex' },
  { id: 'claude' as const, name: 'Claude', hex: '#d97757', cls: 'bg-brand-claude' },
  { id: 'master' as const, name: 'Master Orchestrator', hex: '#818cf8', cls: 'bg-brand-master' },
];

const TokensOverview: React.FC = () => (
  <div className="w-[760px] max-w-full space-y-8 p-6 bg-surface-canvas text-ink-primary rounded-2xl border border-line-hairline">
    <div>
      <h1 className="text-base font-semibold tracking-tight">Superharness Design System</h1>
      <p className="text-caption text-ink-muted mt-1">
        Calm obsidian charcoal elevation scale, 4-step ink contrast hierarchy, 4px spacing grid, and harness brand tokens.
      </p>
    </div>

    <section className="space-y-2.5">
      <h2 className="text-caption font-semibold uppercase tracking-wider text-ink-muted">
        Surface Elevation Scale
      </h2>
      <div className="grid grid-cols-2 gap-2.5">
        {SURFACES.map((s) => (
          <div
            key={s.name}
            className="flex items-center gap-3 p-2.5 rounded-xl border border-line-hairline bg-surface-rail/60"
          >
            <div className={`w-10 h-10 rounded-lg border border-line-subtle shrink-0 ${s.cls}`} />
            <div className="min-w-0">
              <div className="text-caption font-mono font-medium text-ink-primary">{s.name}</div>
              <div className="text-micro text-ink-muted truncate">{s.role}</div>
              <div className="text-[10px] font-mono text-ink-faint">{s.hex}</div>
            </div>
          </div>
        ))}
      </div>
    </section>

    <section className="space-y-2.5">
      <h2 className="text-caption font-semibold uppercase tracking-wider text-ink-muted">
        Ink & Typography Scale
      </h2>
      <div className="rounded-xl border border-line-hairline bg-surface-subtle p-4 space-y-3">
        <div className="flex items-baseline justify-between border-b border-line-hairline pb-2">
          <span className="text-heading font-semibold text-ink-primary">Heading · 14px / 600</span>
          <span className="text-micro font-mono text-ink-faint">text-heading</span>
        </div>
        <div className="flex items-baseline justify-between border-b border-line-hairline pb-2">
          <span className="text-body text-ink-primary">Body · 13.5px / 400 — Sidebar rows & conversation canvas</span>
          <span className="text-micro font-mono text-ink-faint">text-body</span>
        </div>
        <div className="flex items-baseline justify-between border-b border-line-hairline pb-2">
          <span className="text-label font-medium text-ink-secondary">Label · 13px / 500 — Section headers & controls</span>
          <span className="text-micro font-mono text-ink-faint">text-label</span>
        </div>
        <div className="flex items-baseline justify-between border-b border-line-hairline pb-2">
          <span className="text-caption text-ink-secondary">Caption · 12px / 400 — Menus, buttons, cards</span>
          <span className="text-micro font-mono text-ink-faint">text-caption</span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-micro font-medium text-ink-muted">Micro · 11px / 500 — Badges, timestamps, counters</span>
          <span className="text-micro font-mono text-ink-faint">text-micro</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2.5 pt-1">
        {INKS.map((i) => (
          <div
            key={i.name}
            className="flex items-center justify-between px-3 py-2 rounded-lg border border-line-hairline bg-surface-subtle"
          >
            <div>
              <div className={`text-label font-medium ${i.cls}`}>{i.name}</div>
              <div className="text-micro text-ink-faint">{i.role}</div>
            </div>
            <span className="text-[10px] font-mono text-ink-faint">{i.hex}</span>
          </div>
        ))}
      </div>
    </section>

    <section className="space-y-2.5">
      <h2 className="text-caption font-semibold uppercase tracking-wider text-ink-muted">
        Harness Brand Accents
      </h2>
      <div className="grid grid-cols-4 gap-2.5">
        {BRANDS.map((b) => (
          <div
            key={b.id}
            className="rounded-xl border border-line-hairline bg-surface-subtle p-3 space-y-2"
          >
            <div className="flex items-center gap-2">
              <HarnessLogo harness={b.id} size={16} />
              <span className="text-caption font-medium text-ink-primary truncate">{b.name}</span>
            </div>
            <div className={`h-1.5 w-full rounded-full ${b.cls}`} />
            <div className="text-[10px] font-mono text-ink-faint">{b.hex}</div>
          </div>
        ))}
      </div>
    </section>
  </div>
);

const meta: Meta = {
  title: 'Foundations/Design Tokens',
  parameters: { layout: 'padded' },
};
export default meta;

export const Overview: StoryObj = {
  render: () => <TokensOverview />,
};
