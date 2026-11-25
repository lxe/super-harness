import type { Meta, StoryObj } from '@storybook/react';
import React from 'react';
import { ProgressBar, StatTile } from './ProgressBar';

const meta: Meta = {
  title: 'Primitives/ProgressBar & StatTile',
};
export default meta;

export const BarsAndTiles: StoryObj = {
  render: () => (
    <div className="w-[340px] space-y-4 p-4 bg-surface-popover rounded-2xl border border-line-subtle">
      <div className="space-y-2">
        <div className="text-micro text-ink-muted">Claude (32%)</div>
        <ProgressBar value={32} tone="claude" />
        <div className="text-micro text-ink-muted">Codex (35%)</div>
        <ProgressBar value={35} tone="codex" />
        <div className="text-micro text-ink-muted">Antigravity (68% est.)</div>
        <ProgressBar value={68} tone="antigravity" estimated />
        <div className="text-micro text-ink-muted">Warning threshold (80%)</div>
        <ProgressBar value={80} tone="claude" />
        <div className="text-micro text-ink-muted">Critical threshold (94%)</div>
        <ProgressBar value={94} tone="codex" />
      </div>

      <div className="grid grid-cols-3 gap-1.5 pt-2 border-t border-line-hairline">
        <StatTile label="5h" value="~$48.8" />
        <StatTile label="24h" value="~$218" />
        <StatTile label="7d" value="~$2.7k" emphasize />
      </div>
    </div>
  ),
};
