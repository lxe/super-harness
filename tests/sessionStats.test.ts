import { describe, expect, it } from 'vitest';
import {
  computeAntigravitySessionStats,
  computeClaudeSessionStats,
  computeCodexSessionStats,
} from '../src/main/utils/sessionStats';

describe('sessionStats', () => {
  it('raises the Claude window to the smallest known size that holds the peak usage', () => {
    const turn = (id: string, cacheRead: number) =>
      JSON.stringify({
        type: 'assistant',
        message: {
          id,
          model: 'claude-opus-5-5',
          usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: cacheRead, output_tokens: 50 },
        },
      });
    // 684k in context on a model name with no "1m": the window must be 1M, not 200k,
    // and stay 1M after a compaction brings usage back down.
    const noDefault = { longContextFamily: null };
    const stats = computeClaudeSessionStats([turn('a', 150_000), turn('b', 684_000), turn('c', 40_000)], noDefault);
    expect(stats?.contextUsedTokens).toBe(40_010);
    expect(stats?.contextWindowTokens).toBe(1_000_000);
    const small = computeClaudeSessionStats([turn('a', 150_000)], noDefault);
    expect(small?.contextWindowTokens).toBe(200_000);
  });

  it('uses the 1M window for a fresh session when the Claude default asks for it (e.g. opus[1m])', () => {
    const turn = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'a',
        model: 'claude-opus-5-5',
        usage: { input_tokens: 2, cache_creation_input_tokens: 21_000, cache_read_input_tokens: 27_000, output_tokens: 77 },
      },
    });
    // The transcript logs a bare model name; only the default says the 1M window is on.
    expect(computeClaudeSessionStats([turn], { longContextFamily: 'opus' })?.contextWindowTokens).toBe(1_000_000);
    // A default for another family doesn't apply to this Opus session.
    expect(computeClaudeSessionStats([turn], { longContextFamily: 'sonnet' })?.contextWindowTokens).toBe(200_000);
  });

  it('reads the 1M default family from Claude settings', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { claudeLongContextDefaultFamily } = await import('../src/main/utils/sessionStats');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-claude-settings-'));
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ model: 'opus[1m]' }));
    expect(claudeLongContextDefaultFamily(file)).toBe('opus');
    const other = path.join(dir, 'other.json');
    fs.writeFileSync(other, JSON.stringify({ model: 'claude-sonnet-5-5' }));
    expect(claudeLongContextDefaultFamily(other)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('computes Antigravity token totals, latest context usage, and estimated cost', () => {
    const lines = [
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        model: 'gemini-4-neon-high',
        input_tokens: 10_000,
        cache_read_tokens: 40_000,
        output_tokens: 1_000,
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        model: 'gemini-4-neon-high',
        input_tokens: 12_000,
        cache_read_tokens: 88_000,
        output_tokens: 2_000,
      }),
    ];
    const stats = computeAntigravitySessionStats(lines);
    expect(stats).toBeDefined();
    expect(stats?.inputTokens).toBe(22_000);
    expect(stats?.cacheReadTokens).toBe(128_000);
    expect(stats?.outputTokens).toBe(3_000);
    expect(stats?.contextUsedTokens).toBe(100_000);
    expect(stats?.contextWindowTokens).toBe(1_000_000);
    expect(stats?.turnCount).toBe(2);
    expect(stats?.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('computes Claude stats deduplicating repeated assistant message IDs', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_1',
          model: 'claude-opus-4-6',
          usage: {
            input_tokens: 500,
            cache_creation_input_tokens: 2000,
            cache_read_input_tokens: 10000,
            output_tokens: 100,
          },
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_1',
          model: 'claude-opus-4-6',
          usage: {
            input_tokens: 500,
            cache_creation_input_tokens: 2000,
            cache_read_input_tokens: 10000,
            output_tokens: 450,
          },
        },
      }),
    ];
    const stats = computeClaudeSessionStats(lines);
    expect(stats).toBeDefined();
    expect(stats?.turnCount).toBe(1);
    expect(stats?.outputTokens).toBe(450);
    expect(stats?.contextUsedTokens).toBe(12_500);
    expect(stats?.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('computes Codex stats from token_count rollout records', () => {
    const lines = [
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.4-codex' } }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 400_000,
            total_token_usage: { input_tokens: 60_000, cached_input_tokens: 45_000, output_tokens: 4_000 },
            last_token_usage: { input_tokens: 5_000, cached_input_tokens: 25_000, output_tokens: 800 },
          },
        },
      }),
    ];
    const stats = computeCodexSessionStats(lines);
    expect(stats).toBeDefined();
    expect(stats?.inputTokens).toBe(15_000);
    expect(stats?.cacheReadTokens).toBe(45_000);
    expect(stats?.outputTokens).toBe(4_000);
    expect(stats?.contextUsedTokens).toBe(30_000);
    expect(stats?.contextWindowTokens).toBe(400_000);
    expect(stats?.estimatedCostUsd).toBeGreaterThan(0);
  });
});
