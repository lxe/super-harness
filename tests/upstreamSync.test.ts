import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseClaudeJsonlLines } from '../src/main/adapters/claudeAdapter';
import {
  buildClaudeStreamUserMessage,
  buildClaudeStreamWorkerArgs,
} from '../src/main/services/claudeStreamClient';
import {
  CodexAppServerClient,
  encodeWsClientFrame,
  WsFrameDecoder,
} from '../src/main/services/codexAppServerClient';

describe('Codex app-server WebSocket RFC 6455 framing & UserInput builder', () => {
  it('encodes and decodes small, medium (>125B), and chunked/coalesced frames', () => {
    const dec = new WsFrameDecoder();
    const small = Buffer.from('{"id":1,"result":{}}', 'utf8');
    const medium = Buffer.from('x'.repeat(2400), 'utf8');

    const f1 = encodeWsClientFrame(small, 0x1);
    const f2 = encodeWsClientFrame(medium, 0x1);
    const combined = Buffer.concat([f1, f2]);

    // Push in arbitrary small slices to verify streaming reassembly
    const out: string[] = [];
    for (let i = 0; i < combined.length; i += 17) {
      const frames = dec.push(combined.subarray(i, Math.min(combined.length, i + 17)));
      for (const f of frames) {
        expect(f.opcode).toBe(0x1);
        out.push(f.payload.toString('utf8'));
      }
    }

    expect(out).toEqual([small.toString('utf8'), medium.toString('utf8')]);
  });

  it('builds native localImage + text UserInput payloads for Codex app-server', () => {
    const inputs = CodexAppServerClient.buildUserInputs('Describe this', [
      { id: '1', name: 'shot.png', path: '/tmp/shot.png', mimeType: 'image/png' },
    ]);
    expect(inputs).toEqual([
      { type: 'localImage', path: '/tmp/shot.png' },
      { type: 'text', text: 'Describe this', text_elements: [] },
    ]);
  });
});

describe('Claude persistent stream-json worker message & args builders', () => {
  it('builds native multimodal base64 image + text NDJSON payloads', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-claude-img-'));
    const imgPath = path.join(dir, 'pixel.png');
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    );
    fs.writeFileSync(imgPath, bytes);

    const payload = buildClaudeStreamUserMessage('What color is this pixel?', [
      { id: 'a1', name: 'pixel.png', path: imgPath, mimeType: 'image/png' },
    ]);

    expect(payload).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: bytes.toString('base64'),
            },
          },
          { type: 'text', text: 'What color is this pixel?' },
        ],
      },
    });
  });

  it('constructs persistent --input-format stream-json --output-format stream-json worker args', () => {
    const args = buildClaudeStreamWorkerArgs({
      nativeSessionId: 'abc-123',
      model: 'claude-opus-5-5',
      reasoningEffort: 'high',
      permissionMode: 'auto',
    });
    expect(args).toEqual([
      '--resume',
      'abc-123',
      '--print',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'claude-opus-5-5',
      '--effort',
      'high',
      '--permission-mode',
      'auto',
    ]);
  });

  it('clears stale unresolved Bash tool_use on assistant end_turn so Working · Running Bash never sticks', () => {
    const now = Date.now();
    const lines = [
      JSON.stringify({
        type: 'assistant',
        timestamp: now - 5000,
        message: {
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'toolu_orphan_bash', name: 'Bash', input: { command: 'ls' } }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: now - 1000,
        message: {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: "I'm not running anything now." }],
        },
      }),
    ];

    const res = parseClaudeJsonlLines(lines, 'claude:test-stale', now, 50);
    expect(res.liveActivity?.isWorking).toBe(false);
    expect(res.liveActivity?.focus).toBeUndefined();
  });
});
