import { describe, expect, it } from 'vitest';
import {
  computeAntigravitySessionStats,
  computeClaudeSessionStats,
  computeCodexSessionStats,
} from '../src/main/utils/sessionStats';

describe('sessionStats', () => {
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
