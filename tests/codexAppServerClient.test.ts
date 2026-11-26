import { describe, expect, it } from 'vitest';
import {
  buildCodexServerRequestResponse,
  CodexAppServerClient,
  encodeWsClientFrame,
  mapCodexQueuedSubmission,
  WsFrameDecoder,
} from '../src/main/services/codexAppServerClient';

describe('WsFrameDecoder', () => {
  it('decodes fragmented and coalesced frames', () => {
    const dec = new WsFrameDecoder();
    // Server frames are unmasked; build one manually (FIN=0 then continuation).
    const part1 = Buffer.from([0x01, 0x03, 0x61, 0x62, 0x63]); // "abc", not final
    const part2 = Buffer.from([0x80, 0x02, 0x64, 0x65]); // continuation "de", final
    const whole = Buffer.from([0x81, 0x02, 0x68, 0x69]); // "hi"
    expect(dec.push(part1)).toEqual([]);
    const frames = dec.push(Buffer.concat([part2, whole]));
    expect(frames.map((f) => f.payload.toString())).toEqual(['abcde', 'hi']);
  });

  it('encodeWsClientFrame masks client frames', () => {
    const frame = encodeWsClientFrame(Buffer.from('x'));
    expect(frame[0]).toBe(0x81);
    expect(frame[1] & 0x80).toBe(0x80);
    expect(frame[1] & 0x7f).toBe(1);
  });
});

describe('buildUserInputs (native Desktop order, no synthesized text)', () => {
  it('puts text before localImage parts', () => {
    expect(
      CodexAppServerClient.buildUserInputs('look', [
        { id: 'a', name: 'x.png', path: '/tmp/x.png', mimeType: 'image/png' },
      ])
    ).toEqual([
      { type: 'text', text: 'look', text_elements: [] },
      { type: 'localImage', path: '/tmp/x.png' },
    ]);
  });

  it('never synthesizes an Inspect prompt for image-only turns', () => {
    expect(
      CodexAppServerClient.buildUserInputs('', [
        { id: 'a', name: 'x.png', path: '/tmp/x.png', mimeType: 'image/png' },
      ])
    ).toEqual([{ type: 'localImage', path: '/tmp/x.png' }]);
    expect(CodexAppServerClient.buildUserInputs('  ')).toEqual([]);
  });
});

describe('buildCodexServerRequestResponse (native ServerRequest replies)', () => {
  it('accepts command/file approvals with native decision shapes', () => {
    expect(buildCodexServerRequestResponse('item/commandExecution/requestApproval', {})).toEqual({
      result: { decision: 'accept' },
    });
    expect(buildCodexServerRequestResponse('item/fileChange/requestApproval', {})).toEqual({
      result: { decision: 'accept' },
    });
    expect(buildCodexServerRequestResponse('applyPatchApproval', {})).toEqual({
      result: { decision: 'approved' },
    });
    expect(buildCodexServerRequestResponse('execCommandApproval', {})).toEqual({
      result: { decision: 'approved' },
    });
  });

  it('grants no extra permissions, declines elicitation, answers no user-input', () => {
    expect(buildCodexServerRequestResponse('item/permissions/requestApproval', {})).toEqual({
      result: { permissions: {}, scope: 'session' },
    });
    expect(buildCodexServerRequestResponse('mcpServer/elicitation/request', {})).toEqual({
      result: { action: 'decline', content: null, _meta: null },
    });
    expect(buildCodexServerRequestResponse('item/tool/requestUserInput', {})).toEqual({
      result: { answers: {} },
    });
  });

  it('errors on dynamic tool calls and unknown methods instead of stalling', () => {
    const tool = buildCodexServerRequestResponse('item/tool/call', {});
    expect(tool.error?.code).toBe(-32601);
    const unknown = buildCodexServerRequestResponse('account/chatgptAuthTokens/refresh', {});
    expect(unknown.error?.code).toBe(-32601);
  });
});

describe('mapCodexQueuedSubmission (thread/queue/list -> queue tray)', () => {
  it('extracts text + localImage attachments from native UserInput parts', () => {
    const mapped = mapCodexQueuedSubmission({
      id: 'q1',
      clientUserMessageId: 'cum-1',
      input: [
        { type: 'text', text: 'follow up', text_elements: [] },
        { type: 'localImage', path: '/tmp/shot.png' },
      ],
    });
    expect(mapped).toMatchObject({ id: 'codex-q-q1', text: 'follow up', source: 'native' });
    expect(mapped?.attachments).toEqual([
      { id: 'codex-q-att-1', name: 'shot.png', path: '/tmp/shot.png', mimeType: 'image/png' },
    ]);
  });

  it('returns null for empty submissions', () => {
    expect(mapCodexQueuedSubmission({ id: 'q2', input: [] })).toBeNull();
    expect(mapCodexQueuedSubmission(null)).toBeNull();
  });
});

describe('CodexAppServerClient.handleMessage routing', () => {
  it('answers server requests and reports foreign-thread activity', () => {
    const activity: string[] = [];
    const client = new CodexAppServerClient('/tmp/nonexistent.sock', undefined, (tid) =>
      activity.push(tid)
    );
    const sent: Array<Record<string, unknown>> = [];
    // Capture outbound JSON without a live socket.
    (client as unknown as { sendJson: (o: Record<string, unknown>) => void }).sendJson = (o) =>
      sent.push(o);
    const handle = (
      client as unknown as { handleMessage: (m: Record<string, unknown>) => void }
    ).handleMessage.bind(client);

    handle({
      jsonrpc: '2.0',
      id: 99,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 't-foreign' },
    });
    expect(sent).toEqual([{ jsonrpc: '2.0', id: 99, result: { decision: 'accept' } }]);

    // A turn started by Codex Desktop (no own run) must surface as activity,
    // and its turn id is tracked for steer/interrupt discovery.
    handle({
      method: 'turn/started',
      params: { threadId: 't-foreign', turn: { id: 'turn-7', status: 'inProgress' } },
    });
    handle({
      method: 'thread/status/changed',
      params: { threadId: 't-foreign', status: 'running' },
    });
    expect(activity).toContain('t-foreign');
    expect(
      (client as unknown as { foreignTurnIds: Map<string, string> }).foreignTurnIds.get('t-foreign')
    ).toBe('turn-7');

    handle({ method: 'turn/completed', params: { threadId: 't-foreign', turn: { id: 'turn-7' } } });
    expect(
      (client as unknown as { foreignTurnIds: Map<string, string> }).foreignTurnIds.has('t-foreign')
    ).toBe(false);
  });
});
