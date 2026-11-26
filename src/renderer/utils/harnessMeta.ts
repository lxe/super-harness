import type { HarnessGroup } from '../../shared/types';

/** Short harness names for labels, menus and headers. */
export const HARNESS_TITLES: Record<HarnessGroup, string> = {
  antigravity: 'Antigravity',
  codex: 'Codex',
  claude: 'Claude',
  muse: 'Muse',
  pi: 'Pi',
};

/** Harnesses that run on API keys: their gauge shows spend instead of a quota percentage. */
export const SPEND_GAUGE_HARNESSES: ReadonlySet<HarnessGroup> = new Set<HarnessGroup>(['pi']);

export function isHarnessGroup(v: unknown): v is HarnessGroup {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(HARNESS_TITLES, v);
}

/** Compact gauge caption for a spend amount: `$0`, `$.42`, `$3.1`, `$27`. */
export function formatSpendCaption(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0';
  if (usd < 1) return `$${usd.toFixed(2).replace(/^0/, '')}`;
  if (usd < 10) return `$${usd.toFixed(1)}`;
  return `$${Math.round(usd)}`;
}
