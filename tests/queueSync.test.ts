import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapCodexQueuedSubmission } from '../src/main/services/codexAppServerClient';
import { isExternalAntigravityTurnActive } from '../src/main/services/agyAcpClient';
import {
  isBusyDispatchError,
  parseQueuedBySession,
  serializeQueuedBySession,
} from '../src/renderer/utils/queueStorage';
import type { QueuedMessageItem } from '../src/shared/types';

function makeTempTranscript(lines: string[], ageMs = 0): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-agy-guard-'));
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  if (ageMs > 0) {
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(file, t, t);
  }
  return file;
}

describe('Antigravity active external turn guard', () => {
  it('detects active external turns on fresh USER_INPUT, GENERIC, RUNNING, and tool_calls steps', () => {
    const userInput = makeTempTranscript([
      JSON.stringify({ step_index: 1, type: 'USER_INPUT', status: 'DONE', content: 'hi' }),
    ]);
    const toolCallPlanner = makeTempTranscript([
      JSON.stringify({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ name: 'read_file' }],
      }),
    ]);
    const runningStep = makeTempTranscript([
      JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', status: 'RUNNING', content: '' }),
    ]);

    expect(isExternalAntigravityTurnActive(userInput)).toBe(true);
    expect(isExternalAntigravityTurnActive(toolCallPlanner)).toBe(true);
    expect(isExternalAntigravityTurnActive(runningStep)).toBe(true);
  });

  it('returns false for completed text-only PLANNER_RESPONSE, stale transcripts, or missing files', () => {
    const completed = makeTempTranscript([
      JSON.stringify({ step_index: 1, type: 'USER_INPUT', status: 'DONE', content: 'hi' }),
      JSON.stringify({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'All done!',
      }),
    ]);
    const stale = makeTempTranscript(
      [JSON.stringify({ step_index: 1, type: 'USER_INPUT', status: 'DONE', content: 'hi' })],
      60_000
    );

    expect(isExternalAntigravityTurnActive(completed)).toBe(false);
    expect(isExternalAntigravityTurnActive(stale)).toBe(false);
    expect(isExternalAntigravityTurnActive('/nonexistent/path/transcript.jsonl')).toBe(false);
  });
});

describe('Codex native queue (app-server thread/queue/*)', () => {
  it('maps native queued submissions into the queue tray', () => {
    const mapped = mapCodexQueuedSubmission({
      id: 'sub-1',
      clientUserMessageId: 'cum-1',
      input: [{ type: 'text', text: 'Follow up', text_elements: [] }],
    });
    expect(mapped).toMatchObject({ id: 'codex-q-sub-1', text: 'Follow up', source: 'native' });
  });
});

describe('Persistent Super Harness queue storage', () => {
  it('round-trips queued items while stripping inline previewDataUrl blobs', () => {
    const input: Record<string, QueuedMessageItem[]> = {
      'antigravity:abc': [
        {
          id: 'q-1',
          text: 'Check screenshot',
          createdAt: 1700000000000,
          source: 'super-harness',
          attachments: [
            {
              id: 'att-1',
              name: 'shot.png',
              path: '/tmp/shot.png',
              mimeType: 'image/png',
              previewDataUrl: 'data:image/png;base64,AAAA',
            },
          ],
        },
        {
          id: 'native-1',
          text: 'Should not persist native item',
          createdAt: 1700000000001,
          source: 'native',
        },
      ],
      'claude:empty': [],
    };

    const raw = serializeQueuedBySession(input);
    expect(raw).not.toContain('data:image/png');
    expect(raw).not.toContain('native-1');
    expect(raw).not.toContain('claude:empty');

    const restored = parseQueuedBySession(raw);
    expect(Object.keys(restored)).toEqual(['antigravity:abc']);
    expect(restored['antigravity:abc']).toHaveLength(1);
    expect(restored['antigravity:abc'][0]).toEqual({
      id: 'q-1',
      text: 'Check screenshot',
      createdAt: 1700000000000,
      source: 'super-harness',
      attachments: [
        {
          id: 'att-1',
          name: 'shot.png',
          path: '/tmp/shot.png',
          mimeType: 'image/png',
        },
      ],
    });
  });

  it('handles corrupt JSON gracefully and recognizes busy dispatch errors', () => {
    expect(parseQueuedBySession('{not-json')).toEqual({});
    expect(parseQueuedBySession(null)).toEqual({});
    expect(
      isBusyDispatchError('Antigravity Desktop is currently running a turn on this conversation.')
    ).toBe(true);
    expect(
      isBusyDispatchError(
        'This Antigravity conversation is already running a turn in Super Harness. Wait for it to finish or queue your message.'
      )
    ).toBe(true);
    expect(isBusyDispatchError('thread already has an active writer')).toBe(true);
    expect(isBusyDispatchError('Session not found')).toBe(false);
  });

  it('guards against stale ACP child exit races and keeps toast/WorkingIndicator clear of the composer', () => {
    const acpSrc = fs.readFileSync(
      path.resolve(__dirname, '../src/main/services/agyAcpClient.ts'),
      'utf8'
    );
    const appSrc = fs.readFileSync(
      path.resolve(__dirname, '../src/renderer/App.tsx'),
      'utf8'
    );
    const paneSrc = fs.readFileSync(
      path.resolve(__dirname, '../src/renderer/components/SessionPane.tsx'),
      'utf8'
    );

    expect(acpSrc).toContain('if (this.proc !== child) return;');
    expect(appSrc).toContain('fixed top-14 right-5 z-50');
    expect(appSrc).not.toContain('fixed bottom-5 right-5 z-50');
    expect(paneSrc).toContain('isStreamingGlobal');
    expect(paneSrc).toContain('requestAnimationFrame');
  });

  it('supports immediate force-send ("Send now") on queued messages across all harnesses', () => {
    const paneSrc = fs.readFileSync(
      path.resolve(__dirname, '../src/renderer/components/SessionPane.tsx'),
      'utf8'
    );
    const acpSrc = fs.readFileSync(
      path.resolve(__dirname, '../src/main/services/agyAcpClient.ts'),
      'utf8'
    );
    const codexClientSrc = fs.readFileSync(
      path.resolve(__dirname, '../src/main/services/codexAppServerClient.ts'),
      'utf8'
    );
    const codexAdapterSrc = fs.readFileSync(
      path.resolve(__dirname, '../src/main/adapters/codexAdapter.ts'),
      'utf8'
    );
    const claudeAdapterSrc = fs.readFileSync(
      path.resolve(__dirname, '../src/main/adapters/claudeAdapter.ts'),
      'utf8'
    );

    expect(paneSrc).toContain(
      'void dispatchMessageNow(item.text, item.attachments ?? [], { force: true });'
    );
    expect(paneSrc).toContain('if (!opts?.force && isBusyDispatchError(errText))');
    expect(acpSrc).toContain('if (!force && isExternalAntigravityTurnActive(transcriptPath))');
    expect(codexClientSrc).toContain("'turn/steer'");
    expect(codexAdapterSrc).toContain('appServer.steerTurn(session.nativeId, prompt, attachments)');
    expect(claudeAdapterSrc).toContain("if (decision.action === 'block' && !opts?.force)");
  });

  it('clears canceled Antigravity background tasks and avoids stale transcript-cache queue deadlocks', () => {
    const agySrc = fs.readFileSync(
      path.resolve(__dirname, '../src/main/adapters/antigravityAdapter.ts'),
      'utf8'
    );
    const appSrc = fs.readFileSync(
      path.resolve(__dirname, '../src/renderer/App.tsx'),
      'utf8'
    );
    const paneSrc = fs.readFileSync(
      path.resolve(__dirname, '../src/renderer/components/SessionPane.tsx'),
      'utf8'
    );

    expect(agySrc).toContain('was canceled');
    expect(appSrc).toContain('Date.now() - cachedEntry.cachedAt < 20_000');
    expect(paneSrc).toContain('outline-none focus:outline-none');
  });

  it('defaults Enter to immediate steer/send while busy and binds Ctrl/Alt+Enter to queue', () => {
    const composerSrc = fs.readFileSync(
      path.resolve(__dirname, '../src/renderer/components/SessionComposer.tsx'),
      'utf8'
    );
    const paneSrc = fs.readFileSync(
      path.resolve(__dirname, '../src/renderer/components/SessionPane.tsx'),
      'utf8'
    );

    expect(composerSrc).toContain('if ((e.ctrlKey || e.altKey || e.metaKey) && onQueue && !isMaster)');
    expect(paneSrc).toContain('isAgentBusy ? { force: true } : undefined');
    expect(paneSrc).toContain('onQueue={() => void handleQueue()}');
  });

  it('supports image paste, drop, and picker in DraftSessionPane and forwards attachments on startSession', () => {
    const draftSrc = fs.readFileSync(
      path.resolve(__dirname, '../src/renderer/components/DraftSessionPane.tsx'),
      'utf8'
    );
    const agySrc = fs.readFileSync(
      path.resolve(__dirname, '../src/main/adapters/antigravityAdapter.ts'),
      'utf8'
    );
    const claudeSrc = fs.readFileSync(
      path.resolve(__dirname, '../src/main/adapters/claudeAdapter.ts'),
      'utf8'
    );

    expect(draftSrc).toContain('onPaste={(e) => void handlePaste(e)}');
    expect(draftSrc).toContain('window.superHarness.readClipboardImage()');
    expect(draftSrc).toContain('window.superHarness.pickAttachmentFiles()');
    expect(draftSrc).toContain('attachments: attachments.length > 0 ? attachments : undefined');
    expect(agySrc).toContain('req.attachments');
    expect(claudeSrc).toContain("formatPromptWithImagePaths(req.prompt?.trim() || '', req.attachments)");
  });
});
