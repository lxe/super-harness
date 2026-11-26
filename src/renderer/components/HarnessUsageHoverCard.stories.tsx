import type { Meta, StoryObj } from '@storybook/react';
import React from 'react';
import type { UsageSnapshot } from '../../shared/types';
import { HarnessUsageHoverCard } from './HarnessUsageHoverCard';

const now = Date.now();
const DAY = 24 * 60 * 60 * 1000;

const MOCK_USAGE: UsageSnapshot = {
  claude: {
    harness: 'claude',
    updatedAt: now - 60_000,
    planLabel: 'Max plan',
    barPercent: 32,
    barIsEstimated: false,
    windows: [
      { id: 'five_hour', label: '5-hour session', usedPercent: 0, windowMinutes: 300 },
      {
        id: 'weekly',
        label: 'Weekly limit',
        usedPercent: 32,
        delta24h: 3,
        resetsAt: now + 3.8 * DAY,
        windowMinutes: 10080,
      },
      { id: 'extra', label: 'Extra usage', usedPercent: 36 },
    ],
    spend5hUsd: 36,
    spend24hUsd: 165,
    spend7dUsd: 2400,
    spend14dUsd: 3900,
    tokens7d: 3_900_000_000,
    dailySpend7d: [
      { date: '2026-11-19', dayLabel: 'Thu', spendUsd: 120, tokens: 180_000_000 },
      { date: '2026-11-20', dayLabel: 'Fri', spendUsd: 240, tokens: 340_000_000 },
      { date: '2026-11-21', dayLabel: 'Sat', spendUsd: 110, tokens: 160_000_000 },
      { date: '2026-11-22', dayLabel: 'Sun', spendUsd: 190, tokens: 290_000_000 },
      { date: '2026-11-23', dayLabel: 'Mon', spendUsd: 1100, tokens: 1_500_000_000 },
      { date: '2026-11-24', dayLabel: 'Tue', spendUsd: 180, tokens: 260_000_000 },
      { date: '2026-11-25', dayLabel: 'Wed', spendUsd: 165, tokens: 240_000_000 },
    ],
    spendIsEstimated: true,
  },
  codex: {
    harness: 'codex',
    updatedAt: now - 120_000,
    planLabel: 'Codex Pro',
    barPercent: 35,
    barIsEstimated: false,
    windows: [
      {
        id: 'weekly',
        label: 'Weekly (7d)',
        usedPercent: 35,
        resetsAt: now + 2.2 * DAY,
        windowMinutes: 10080,
      },
    ],
    spend5hUsd: 12,
    spend24hUsd: 64,
    spend7dUsd: 420,
    spend14dUsd: 780,
    tokens7d: 510_000_000,
    dailySpend7d: [
      { date: '2026-11-19', dayLabel: 'Thu', spendUsd: 40, tokens: 50_000_000 },
      { date: '2026-11-20', dayLabel: 'Fri', spendUsd: 90, tokens: 110_000_000 },
      { date: '2026-11-21', dayLabel: 'Sat', spendUsd: 35, tokens: 45_000_000 },
      { date: '2026-11-22', dayLabel: 'Sun', spendUsd: 60, tokens: 75_000_000 },
      { date: '2026-11-23', dayLabel: 'Mon', spendUsd: 80, tokens: 95_000_000 },
      { date: '2026-11-24', dayLabel: 'Tue', spendUsd: 51, tokens: 65_000_000 },
      { date: '2026-11-25', dayLabel: 'Wed', spendUsd: 64, tokens: 70_000_000 },
    ],
    spendIsEstimated: true,
  },
  antigravity: {
    harness: 'antigravity',
    updatedAt: now - 30_000,
    planLabel: 'Antigravity',
    barPercent: 27,
    barIsEstimated: false,
    creditsBalance: 2500,
    windows: [
      {
        id: 'five_hour',
        label: 'Gemini · 5h limit',
        usedPercent: 27,
        resetsAt: now + 2.1 * 3600_000,
        windowMinutes: 300,
      },
      {
        id: 'weekly',
        label: 'Gemini · Weekly',
        usedPercent: 7,
        resetsAt: now + 5.8 * DAY,
        windowMinutes: 10080,
      },
      { id: '3p-5h', label: 'Claude & GPT · 5h limit', usedPercent: 0, windowMinutes: 300 },
    ],
    spend5hUsd: 18,
    spend24hUsd: 84,
    spend7dUsd: 310,
    spend14dUsd: 540,
    tokens7d: 420_000_000,
    dailySpend7d: [
      { date: '2026-11-19', dayLabel: 'Thu', spendUsd: 25, tokens: 30_000_000 },
      { date: '2026-11-20', dayLabel: 'Fri', spendUsd: 55, tokens: 70_000_000 },
      { date: '2026-11-21', dayLabel: 'Sat', spendUsd: 20, tokens: 25_000_000 },
      { date: '2026-11-22', dayLabel: 'Sun', spendUsd: 40, tokens: 55_000_000 },
      { date: '2026-11-23', dayLabel: 'Mon', spendUsd: 46, tokens: 65_000_000 },
      { date: '2026-11-24', dayLabel: 'Tue', spendUsd: 40, tokens: 55_000_000 },
      { date: '2026-11-25', dayLabel: 'Wed', spendUsd: 84, tokens: 120_000_000 },
    ],
    spendIsEstimated: true,
  },
};

const meta: Meta = {
  title: 'Domain/HarnessUsageHoverCard',
};
export default meta;

export const ClaudeUsage: StoryObj = {
  render: () => (
    <div className="min-h-[480px] relative">
      <HarnessUsageHoverCard
        target="claude"
        usage={MOCK_USAGE}
        anchorRect={{ left: 24, bottom: 16, width: 80 }}
        onMouseEnter={() => {}}
        onMouseLeave={() => {}}
      />
    </div>
  ),
};

export const AntigravityUsage: StoryObj = {
  render: () => (
    <div className="min-h-[480px] relative">
      <HarnessUsageHoverCard
        target="antigravity"
        usage={MOCK_USAGE}
        anchorRect={{ left: 24, bottom: 16, width: 80 }}
        onMouseEnter={() => {}}
        onMouseLeave={() => {}}
      />
    </div>
  ),
};

export const AllHarnessesUsage: StoryObj = {
  render: () => (
    <div className="min-h-[440px] relative">
      <HarnessUsageHoverCard
        target="all"
        usage={MOCK_USAGE}
        anchorRect={{ left: 24, bottom: 16, width: 80 }}
        onMouseEnter={() => {}}
        onMouseLeave={() => {}}
      />
    </div>
  ),
};
