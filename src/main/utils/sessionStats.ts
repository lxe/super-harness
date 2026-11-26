import type { SessionStats } from '../../shared/types';
import {
  priceAntigravityTokens,
  priceClaudeTokens,
  priceCodexTokens,
} from '../services/usageService';

/**
 * Best-effort model context window capacity in tokens.
 */
export function inferContextWindowTokens(model?: string, harnessGroup?: string): number {
  const m = (model || '').toLowerCase();
  if (m.includes('1m') || m.includes('gemini')) return 1_000_000;
  if (m.includes('gpt-5') || m.includes('codex')) return 400_000;
  if (m.includes('opus-4') || m.includes('sonnet-4') || m.includes('claude')) return 200_000;
  if (harnessGroup === 'antigravity') return 1_000_000;
  if (harnessGroup === 'codex') return 400_000;
  if (harnessGroup === 'claude') return 200_000;
  return 200_000;
}

/**
 * Extracts per-session token totals, latest context window fill, and estimated API cost
 * from Antigravity `transcript.jsonl` lines (`PLANNER_RESPONSE` entries).
 */
export function computeAntigravitySessionStats(lines: string[]): SessionStats | undefined {
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let contextUsedTokens = 0;
  let estimatedCostUsd = 0;
  let turnCount = 0;
  let lastModel: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('input_tokens') && !line.includes('output_tokens')) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const hasUsage =
      typeof obj.input_tokens === 'number' ||
      typeof obj.cache_read_tokens === 'number' ||
      typeof obj.output_tokens === 'number';
    if (!hasUsage) continue;

    const uncachedIn = Math.max(0, Number(obj.input_tokens || 0));
    const cacheRead = Math.max(0, Number(obj.cache_read_tokens || 0));
    const output = Math.max(0, Number(obj.output_tokens || 0));
    const model = typeof obj.model === 'string' && obj.model ? obj.model : 'gemini-pro';
    lastModel = model;

    inputTokens += uncachedIn;
    cacheReadTokens += cacheRead;
    outputTokens += output;
    contextUsedTokens = uncachedIn + cacheRead;
    estimatedCostUsd += priceAntigravityTokens(model, uncachedIn, cacheRead, output);
    turnCount++;
  }

  if (turnCount === 0) return undefined;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens: 0,
    totalTokens: inputTokens + cacheReadTokens + outputTokens,
    contextUsedTokens,
    contextWindowTokens: inferContextWindowTokens(lastModel, 'antigravity'),
    estimatedCostUsd: Number(estimatedCostUsd.toFixed(4)),
    turnCount,
  };
}

/**
 * Extracts per-session token totals, latest context window fill, and estimated API cost
 * from Claude JSONL lines (`assistant` messages with `message.usage`, deduplicated by message id).
 */
export function computeClaudeSessionStats(lines: string[]): SessionStats | undefined {
  const seenMsgIds = new Map<
    string,
    { model: string; input: number; cacheWrite: number; cacheRead: number; output: number }
  >();
  let fallbackIdx = 0;
  let lastContextUsed = 0;
  let lastModel: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('"usage"')) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.type !== 'assistant') continue;
    const msg = obj.message as Record<string, unknown> | undefined;
    const usage = msg?.usage as Record<string, unknown> | undefined;
    if (!usage) continue;

    const input = Math.max(0, Number(usage.input_tokens || 0));
    const cacheWrite = Math.max(0, Number(usage.cache_creation_input_tokens || 0));
    const cacheRead = Math.max(0, Number(usage.cache_read_input_tokens || 0));
    const output = Math.max(0, Number(usage.output_tokens || 0));
    if (input === 0 && cacheWrite === 0 && cacheRead === 0 && output === 0) continue;

    const model = typeof msg?.model === 'string' && msg.model ? msg.model : 'claude-sonnet';
    const msgId =
      typeof msg?.id === 'string' && msg.id ? msg.id : `anon-${fallbackIdx++}`;
    seenMsgIds.set(msgId, { model, input, cacheWrite, cacheRead, output });
    lastContextUsed = input + cacheWrite + cacheRead;
    lastModel = model;
  }

  if (seenMsgIds.size === 0) return undefined;
  let inputTokens = 0;
  let cacheWriteTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let estimatedCostUsd = 0;

  for (const row of seenMsgIds.values()) {
    inputTokens += row.input;
    cacheWriteTokens += row.cacheWrite;
    cacheReadTokens += row.cacheRead;
    outputTokens += row.output;
    estimatedCostUsd += priceClaudeTokens(
      row.model,
      row.input,
      row.cacheWrite,
      row.cacheRead,
      row.output
    );
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + cacheWriteTokens + cacheReadTokens + outputTokens,
    contextUsedTokens: lastContextUsed,
    contextWindowTokens: inferContextWindowTokens(lastModel, 'claude'),
    estimatedCostUsd: Number(estimatedCostUsd.toFixed(4)),
    turnCount: seenMsgIds.size,
  };
}

/**
 * Extracts per-session token totals, latest context window fill, and estimated API cost
 * from Codex rollout JSONL lines (`event_msg` `token_count` records).
 */
export function computeCodexSessionStats(lines: string[]): SessionStats | undefined {
  let totalInput = 0;
  let totalCached = 0;
  let totalOutput = 0;
  let contextUsedTokens = 0;
  let contextWindowTokens: number | undefined;
  let turnCount = 0;
  let lastModel: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('token_count') && !line.includes('turn_context')) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = obj.payload as Record<string, unknown> | undefined;
    if (!payload) continue;
    if (obj.type === 'turn_context' && typeof payload.model === 'string' && payload.model) {
      lastModel = payload.model;
      continue;
    }
    if (payload.type !== 'token_count') continue;
    const info = payload.info as Record<string, unknown> | undefined;
    if (!info) continue;

    if (typeof info.model_context_window === 'number' && info.model_context_window > 0) {
      contextWindowTokens = info.model_context_window;
    }
    const total = info.total_token_usage as Record<string, unknown> | undefined;
    if (total) {
      const inp = Math.max(0, Number(total.input_tokens || 0));
      const cached = Math.max(0, Number(total.cached_input_tokens || 0));
      const out = Math.max(0, Number(total.output_tokens || 0));
      if (inp + cached + out >= totalInput + totalCached + totalOutput) {
        totalInput = inp;
        totalCached = cached;
        totalOutput = out;
      }
    }
    const last = info.last_token_usage as Record<string, unknown> | undefined;
    if (last) {
      const lin = Math.max(0, Number(last.input_tokens || 0));
      const lcached = Math.max(0, Number(last.cached_input_tokens || 0));
      if (lin + lcached > 0) {
        contextUsedTokens = lin + lcached;
        turnCount++;
      }
    }
  }

  if (totalInput === 0 && totalCached === 0 && totalOutput === 0) return undefined;
  const uncachedIn = Math.max(0, totalInput - totalCached);
  const estimatedCostUsd = priceCodexTokens(
    lastModel || 'gpt-5',
    uncachedIn,
    totalCached,
    totalOutput
  );
  return {
    inputTokens: uncachedIn,
    outputTokens: totalOutput,
    cacheReadTokens: totalCached,
    cacheWriteTokens: 0,
    totalTokens: uncachedIn + totalCached + totalOutput,
    contextUsedTokens: contextUsedTokens || totalInput,
    contextWindowTokens: contextWindowTokens ?? inferContextWindowTokens(lastModel, 'codex'),
    estimatedCostUsd: Number(estimatedCostUsd.toFixed(4)),
    turnCount: Math.max(1, turnCount),
  };
}
