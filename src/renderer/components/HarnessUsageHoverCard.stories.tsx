import type { Meta, StoryObj } from '@storybook/react';
import React from 'react';
import type { UsageSnapshot } from '../../shared/types';
import { HarnessUsageHoverCard } from './HarnessUsageHoverCard';

const MOCK_USAGE: UsageSnapshot = {
  antigravity: {
    harness: 'antigravity',
    updatedAt: Date.now(),
    planLabel: 'Antigravity',
    barPercent: 68,
    barIsEstimated: true,
    windows: [],
    spend5hUsd: 42.1,
    spend24hUsd: 68.4,
    spend7dUsd: 86.2,
    spend14dUsd: 94.5,
    tokens7d: 66_500_000,
    dailySpend7d: [
      { date: '2026-11-19', dayLabel: 'Thu', spendUsd: 0, tokens: 0 },
      { date: '2026-11-20', dayLabel: 'Fri', spendUsd: 4.2, tokens: 3_100_000 },
      { date: '2026-11-21', dayLabel: 'Sat', spendUsd: 0, tokens: 0 },
      { date: '2026-11-22', dayLabel: 'Sun', spendUsd: 8.1, tokens: 6_200_000 },
      { date: '2026-11-23', dayLabel: 'Mon', spendUsd: 2.5, tokens: 1_900_000 },
      { date: '2026-11-24', dayLabel: 'Tue', spendUsd: 11.4, tokens: 8_400_000 },
      { date: '2026-11-25', dayLabel: 'Wed', spendUsd: 60.0, tokens: 46_900_000 },
    ],
    spendIsEstimated: true,
    note: 'Quota % is not stored locally by Antigravity — showing est. transcript spend',
  },
  codex: {
    harness: 'codex',
    updatedAt: Date.now(),
    planLabel: 'Codex Pro',
    barPercent: 35,
    barIsEstimated: false,
    windows: [
      {
        id: 'weekly',
        label: 'Weekly (7d)',
        usedPercent: 35,
        resetsAt: Date.now() + 31 * 3600 * 1000,
        windowMinutes: 10080,
      },
    ],
    creditsBalance: 62497.74,
    spend5hUsd: 0.4,
    spend24hUsd: 105.2,
    spend7dUsd: 1431.8,
    spend14dUsd: 2079.2,
    tokens7d: 4_440_246_000,
    dailySpend7d: [
      { date: '2026-11-19', dayLabel: 'Thu', spendUsd: 613.8, tokens: 1_902_000_000 },
      { date: '2026-11-20', dayLabel: 'Fri', spendUsd: 258.5, tokens: 819_000_000 },
      { date: '2026-11-21', dayLabel: 'Sat', spendUsd: 153.9, tokens: 502_000_000 },
      { date: '2026-11-22', dayLabel: 'Sun', spendUsd: 78.5, tokens: 230_000_000 },
      { date: '2026-11-23', dayLabel: 'Mon', spendUsd: 0, tokens: 0 },
      { date: '2026-11-24', dayLabel: 'Tue', spendUsd: 104.7, tokens: 333_000_000 },
      { date: '2026-11-25', dayLabel: 'Wed', spendUsd: 1.4, tokens: 1_900_000 },
    ],
    spendIsEstimated: true,
  },
  claude: {
    harness: 'claude',
    updatedAt: Date.now(),
    planLabel: 'Claude Plan',
    barPercent: 32,
    barIsEstimated: false,
    windows: [
      { id: 'five_hour', label: '5-hour', usedPercent: 14, windowMinutes: 300 },
      { id: 'weekly', label: 'Weekly (7d)', usedPercent: 32, delta24h: 5, windowMinutes: 10080 },
      { id: 'extra', label: 'Extra usage', usedPercent: 36.4 },
    ],
    spend5hUsd: 48.7,
    spend24hUsd: 218.0,
    spend7dUsd: 2704.5,
    spend14dUsd: 12806.8,
    tokens7d: 4_239_856_000,
    dailySpend7d: [
      { date: '2026-11-19', dayLabel: 'Thu', spendUsd: 31.5, tokens: 33_400_000 },
      { date: '2026-11-20', dayLabel: 'Fri', spendUsd: 268.0, tokens: 416_000_000 },
      { date: '2026-11-21', dayLabel: 'Sat', spendUsd: 184.2, tokens: 193_000_000 },
      { date: '2026-11-22', dayLabel: 'Sun', spendUsd: 240.8, tokens: 374_000_000 },
      { date: '2026-11-23', dayLabel: 'Mon', spendUsd: 1084.7, tokens: 1_884_000_000 },
      { date: '2026-11-24', dayLabel: 'Tue', spendUsd: 230.6, tokens: 371_000_000 },
      { date: '2026-11-25', dayLabel: 'Wed', spendUsd: 50.2, tokens: 83_300_000 },
    ],
    spendIsEstimated: true,
  },
};

const meta: Meta = {
  title: 'Domain/HarnessUsageHoverCard',
  parameters: { layout: 'padded' },
};
export default meta;

export const AllHarnesses: StoryObj = {
  render: () => (
    <div className="relative h-[460px] w-[320px]">
      <HarnessUsageHoverCard
        target="all"
        usage={MOCK_USAGE}
        anchorRect={{ left: 20, bottom: 12, width: 70 }}
        onMouseEnter={() => {}}
        onMouseLeave={() => {}}
      />
    </div>
  ),
};

export const Claude: StoryObj = {
  render: () => (
    <div className="relative h-[460px] w-[320px]">
      <HarnessUsageHoverCard
        target="claude"
        usage={MOCK_USAGE}
        anchorRect={{ left: 20, bottom: 12, width: 70 }}
        onMouseEnter={() => {}}
        onMouseLeave={() => {}}
      />
    </div>
  ),
};

export const Codex: StoryObj = {
  render: () => (
    <div className="relative h-[460px] w-[320px]">
      <HarnessUsageHoverCard
        target="codex"
        usage={MOCK_USAGE}
        anchorRect={{ left: 20, bottom: 12, width: 70 }}
        onMouseEnter={() => {}}
        onMouseLeave={() => {}}
      />
    </div>
  ),
};

export const Antigravity: StoryObj = {
  render: () => (
    <div className="relative h-[460px] w-[320px]">
      <HarnessUsageHoverCard
        target="antigravity"
        usage={MOCK_USAGE}
        anchorRect={{ left: 20, bottom: 12, width: 70 }}
        onMouseEnter={() => {}}
        onMouseLeave={() => {}}
      />
    </div>
  ),
};
