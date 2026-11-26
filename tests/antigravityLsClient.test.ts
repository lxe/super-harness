import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AgentStateSignalGate,
  buildSendUserCascadeMessageRequest,
  buildStartCascadeRequest,
  ConnectEnvelopeDecoder,
  encodeConnectEnvelope,
  extractAgentStateSignals,
  parseAntigravityHubFile,
  pickPlanModelEnum,
} from '../src/main/services/antigravityLsClient';

describe('parseAntigravityHubFile', () => {
  it('parses live hub coordinates and rejects malformed files', () => {
    expect(
      parseAntigravityHubFile(
        JSON.stringify({ pid: 123, httpsPort: 46545, httpPort: 37871, lsVersion: '2.34.0', csrfToken: 'tok' })
      )
    ).toEqual({ pid: 123, httpsPort: 46545, httpPort: 37871, lsVersion: '2.34.0', csrfToken: 'tok' });
    expect(parseAntigravityHubFile('not json')).toBeNull();
    expect(parseAntigravityHubFile(JSON.stringify({ pid: 1 }))).toBeNull();
  });
});

describe('Connect streaming envelopes (5-byte framing)', () => {
  it('round-trips split/coalesced envelopes and end-stream trailers', () => {
    const a = encodeConnectEnvelope({ hello: 'world' });
    const b = encodeConnectEnvelope({ error: { code: 'unknown' } }, true);
    const dec = new ConnectEnvelopeDecoder();
    const joined = Buffer.concat([a, b]);
    const frames = [...dec.push(joined.subarray(0, 7)), ...dec.push(joined.subarray(7))];
    expect(frames).toEqual([
      { endStream: false, body: '{"hello":"world"}' },
      { endStream: true, body: '{"error":{"code":"unknown"}}' },
    ]);
  });
});

describe('LS request builders (shapes verified against the live hub LS)', () => {
  it('StartCascade needs only cascadeId + CASCADE_CLIENT source', () => {
    expect(buildStartCascadeRequest('cid-1')).toEqual({ cascadeId: 'cid-1', source: 1 });
  });

  it('SendUserCascadeMessage carries text items, media, and plan model', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-media-'));
    const img = path.join(dir, 'x.png');
    fs.writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e]));
    const req = buildSendUserCascadeMessageRequest({
      cascadeId: 'cid-1',
      text: 'look',
      planModel: 'MODEL_PLACEHOLDER_M527',
      attachments: [{ id: 'a', name: 'x.png', path: img, mimeType: 'image/png' }],
    });
    expect(req.items).toEqual([{ text: 'look' }]);
    expect(req.cascadeConfig).toEqual({ plannerConfig: { planModel: 'MODEL_PLACEHOLDER_M527' } });
    expect(req.media).toEqual([
      { mediaId: 'x.png', mimeType: 'image/png', inlineData: Buffer.from([0x89, 0x50, 0x4e]).toString('base64') },
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('AgentStateSignalGate (CPU-safe stream gating)', () => {
  const frame = (status: string, step: number) =>
    `{"update":{"status":"${status}","executorMetadata":{"lastStepIdx":${step}},"big":"${'x'.repeat(5000)}"}}`;

  it('extracts status + lastStepIdx without a full JSON parse', () => {
    expect(extractAgentStateSignals(frame('CASCADE_RUN_STATUS_RUNNING', 7))).toEqual({
      status: 'CASCADE_RUN_STATUS_RUNNING',
      lastStepIdx: 7,
    });
    expect(extractAgentStateSignals('not json')).toEqual({ status: null, lastStepIdx: null });
  });

  it('notifies only on signal change and never faster than the interval', () => {
    const gate = new AgentStateSignalGate(1000);
    expect(gate.offer(frame('CASCADE_RUN_STATUS_IDLE', 3), 0)).toBe(true); // first
    expect(gate.offer(frame('CASCADE_RUN_STATUS_IDLE', 3), 100)).toBe(false); // unchanged
    expect(gate.offer(frame('CASCADE_RUN_STATUS_RUNNING', 4), 200)).toBe(false); // changed but throttled
    expect(gate.hasPending()).toBe(true);
    expect(gate.offer(frame('CASCADE_RUN_STATUS_RUNNING', 4), 1100)).toBe(true); // trailing window opens
    expect(gate.hasPending()).toBe(false);
    // A 270KB snapshot flood at 10ms intervals yields at most 1 notify/sec.
    let notifies = 0;
    for (let t = 1200; t < 1200 + 5000; t += 10) {
      if (gate.offer(frame('CASCADE_RUN_STATUS_RUNNING', 4 + Math.floor(t / 100)), t)) notifies++;
    }
    expect(notifies).toBeLessThanOrEqual(6);
  });
});

describe('pickPlanModelEnum (GetAvailableModels slug -> enum)', () => {
  const models = {
    response: {
      models: {
        'gemini-4-hydrogen-low': { model: 'MODEL_PLACEHOLDER_M527', recommended: true },
        'claude-opus-5-5-high': { model: 'MODEL_PLACEHOLDER_M402', recommended: true },
      },
    },
  };
  it('maps slug exactly with deterministic recommended fallback', () => {
    expect(pickPlanModelEnum(models, 'claude-opus-5-5-high')).toBe('MODEL_PLACEHOLDER_M402');
    expect(pickPlanModelEnum(models, undefined)).toBe('MODEL_PLACEHOLDER_M402');
    expect(pickPlanModelEnum({}, 'x')).toBeNull();
  });
});
