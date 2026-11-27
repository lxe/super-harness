import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildClaudeControlRequest,
  buildClaudeControlResponse,
  buildClaudeStreamUserMessage,
  buildClaudeStreamWorkerArgs,
} from '../src/main/services/claudeStreamClient';
import {
  parseClaudeStreamLine,
  shouldUseTmuxPasteBuffer,
  waitForClaudeTranscriptDelivery,
} from '../src/main/adapters/claudeAdapter';
import type { StreamEvent } from '../src/shared/types';

describe('Claude Desktop stream-json worker args', () => {
  it('includes the native permission prompt tool and partial messages', () => {
    const args = buildClaudeStreamWorkerArgs({ nativeSessionId: 'sess-1' });
    expect(args).toContain('--include-partial-messages');
    const idx = args.indexOf('--permission-prompt-tool');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('stdio');
  });
});

describe('buildClaudeStreamUserMessage (no synthesized text)', () => {
  it('image-only turns send only image blocks', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-img-'));
    const img = path.join(dir, 'x.png');
    fs.writeFileSync(img, Buffer.from([0x89, 0x50]));
    const msg = buildClaudeStreamUserMessage('', [
      { id: 'a', name: 'x.png', path: img, mimeType: 'image/png' },
    ]) as { message: { content: Array<Record<string, unknown>> } };
    expect(msg.message.content).toHaveLength(1);
    expect(msg.message.content[0].type).toBe('image');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('buildClaudeControlResponse (Desktop SDK shapes, verified in app.asar)', () => {
  const req = (subtype: string, extra: Record<string, unknown> = {}) => ({
    type: 'control_request',
    request_id: 'req-1',
    request: { subtype, ...extra },
  });

  it('allows can_use_tool under permissive modes, denies under manual/plan', () => {
    expect(buildClaudeControlResponse(req('can_use_tool'), 'bypassPermissions')).toEqual({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'req-1', response: { behavior: 'allow' } },
    });
    const denied = buildClaudeControlResponse(req('can_use_tool'), 'manual') as {
      response: { response: { behavior: string } };
    };
    expect(denied.response.response.behavior).toBe('deny');
    const plan = buildClaudeControlResponse(req('can_use_tool'), 'plan') as {
      response: { response: { behavior: string } };
    };
    expect(plan.response.response.behavior).toBe('deny');
  });

  it('declines elicitation like the Desktop no-handler fallback', () => {
    expect(buildClaudeControlResponse(req('elicitation'), 'bypassPermissions')).toEqual({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'req-1', response: { action: 'decline' } },
    });
  });

  it('stays silent for request_user_dialog (Desktop parks it for a capable client)', () => {
    expect(buildClaudeControlResponse(req('request_user_dialog'), 'bypassPermissions')).toBeNull();
  });

  it('answers unknown subtypes with the native error envelope', () => {
    expect(buildClaudeControlResponse(req('hook_callback'), undefined)).toEqual({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: 'req-1',
        error: 'Superharness does not handle hook_callback',
      },
    });
  });
});

describe('buildClaudeControlRequest (host -> CLI)', () => {
  it('builds initialize / interrupt / set_model / set_permission_mode envelopes', () => {
    expect(buildClaudeControlRequest('r1', { subtype: 'initialize' })).toEqual({
      type: 'control_request',
      request_id: 'r1',
      request: { subtype: 'initialize' },
    });
    expect(buildClaudeControlRequest('r2', { subtype: 'interrupt' }).request).toEqual({
      subtype: 'interrupt',
    });
    expect(buildClaudeControlRequest('r3', { subtype: 'set_model', model: 'opus' }).request).toEqual({
      subtype: 'set_model',
      model: 'opus',
    });
    expect(
      buildClaudeControlRequest('r4', { subtype: 'set_permission_mode', mode: 'plan' }).request
    ).toEqual({ subtype: 'set_permission_mode', mode: 'plan' });
  });
});

describe('parseClaudeStreamLine partial streaming', () => {
  it('streams stream_event text deltas and suppresses the duplicated final text', () => {
    const events: StreamEvent[] = [];
    const emit = (ev: StreamEvent) => events.push(ev);
    const deltaLine = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hel' },
      },
    });
    expect(parseClaudeStreamLine('claude:s', 'r1', deltaLine, false, emit, true)).toBe(true);
    const finalLine = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello' }] },
    });
    // gotAnyDelta=true (partials streamed this segment) -> final text not re-emitted
    expect(parseClaudeStreamLine('claude:s', 'r1', finalLine, true, emit, true)).toBe(false);
    // Without partials the final assistant text still streams.
    expect(parseClaudeStreamLine('claude:s', 'r1', finalLine, false, emit, true)).toBe(true);
    // Legacy one-shot path (partials=false) never suppresses assistant text.
    expect(parseClaudeStreamLine('claude:s', 'r1', finalLine, true, emit)).toBe(true);
    expect(events.filter((e) => e.kind === 'delta').map((e) => e.text)).toEqual([
      'Hel',
      'Hello',
      'Hello',
    ]);
  });

  it('routes long/multiline tmux typing through paste-buffer', () => {
    expect(shouldUseTmuxPasteBuffer('short')).toBe(false);
    expect(shouldUseTmuxPasteBuffer('line one\nline two')).toBe(true);
    expect(shouldUseTmuxPasteBuffer('x'.repeat(501))).toBe(true);
  });

  it('acks tmux delivery when the prompt lands in the transcript tail', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ack-'));
    const file = path.join(dir, 's.jsonl');
    fs.writeFileSync(file, '{"type":"user","message":{"content":"old"}}\n');
    setTimeout(() => {
      fs.appendFileSync(
        file,
        `${JSON.stringify({ type: 'queue-operation', content: 'hello tmux ack' })}\n`
      );
    }, 250);
    await expect(waitForClaudeTranscriptDelivery(file, 'hello tmux ack', 3000)).resolves.toBe(true);
    await expect(waitForClaudeTranscriptDelivery(file, 'never sent text', 350)).resolves.toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ignores thinking deltas (final thinking block arrives with the assistant line)', () => {
    const events: StreamEvent[] = [];
    const line = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'hmm' },
      },
    });
    expect(parseClaudeStreamLine('claude:s', 'r1', line, false, (ev) => events.push(ev))).toBe(false);
    expect(events).toEqual([]);
  });
});
