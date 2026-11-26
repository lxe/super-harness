import type { HarnessGroup } from '../../shared/types';

/** Short harness names for labels, menus and headers. */
export const HARNESS_TITLES: Record<HarnessGroup, string> = {
  antigravity: 'Antigravity',
  codex: 'Codex',
  claude: 'Claude',
  muse: 'Muse',
  pi: 'Pi',
};

export function isHarnessGroup(v: unknown): v is HarnessGroup {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(HARNESS_TITLES, v);
}
