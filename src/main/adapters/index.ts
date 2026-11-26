import { createAntigravityDriver } from './antigravityAdapter';
import { createClaudeDriver } from './claudeAdapter';
import { createCodexDriver } from './codexAdapter';
import { createMuseDriver } from './museAdapter';
import type { HarnessDriver } from './types';

export * from './types';

/**
 * Single registration point for all built-in AI coding harness drivers.
 * Adding a new harness only requires implementing HarnessDriver and adding it here.
 */
export function createDefaultDrivers(): HarnessDriver[] {
  return [
    createCodexDriver(),
    createClaudeDriver(),
    createAntigravityDriver(),
    createMuseDriver(),
  ];
}
