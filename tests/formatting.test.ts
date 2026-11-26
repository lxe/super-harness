import { describe, expect, it } from 'vitest';
import {
  embedUrlForPath,
  parseSessionLinkHref,
  parseTaskNotification,
  resolveSessionLink,
  splitAgentEmbeds,
  unwrapSystemEnvelope,
} from '../src/renderer/utils/format';
import type { UnifiedSession } from '../src/shared/types';

describe('Task notification & system card formatting', () => {
  it('parses Claude <task-notification> XML cleanly and strips internal __orphan_summary__ markers', () => {
    const raw = `<task-notification>
<task-id>bfs5h856w bvrfaeh09 __orphan_summary__:shell</task-id>
<status>stopped</status>
<summary>__orphan_summary__:shell</summary>
<result>
- 2 background shell command tasks didn't finish before the previous session ended. Task ids: bfs5h856w, bvrfaeh09.
No completion record was found for them in the previous session.
</result>
</task-notification>`;

    const parsed = parseTaskNotification(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.status).toBe('stopped');
    expect(parsed!.taskIds).toEqual(['bfs5h856w', 'bvrfaeh09']);
    expect(parsed!.summary).toBeUndefined();
    expect(parsed!.result).toContain("2 background shell command tasks didn't finish");
  });

  it('unwraps XML system envelopes so nested markdown lists render properly', () => {
    const raw = `<cross-session-message sender="worker-1">
- First item
- Second item
</cross-session-message>`;
    expect(unwrapSystemEnvelope(raw)).toBe('- First item\n- Second item');
  });

  it('extracts inline <agent-embed> HTML previews while ignoring code spans and fenced blocks', () => {
    const raw = [
      'Here are the options:',
      '',
      '<agent-embed src="file:///tmp/my%20preview/widget.html"></agent-embed>',
      '',
      'Inline code example: `<agent-embed src="file:///tmp/ignored.html"></agent-embed>`',
      '```html',
      '<agent-embed src="file:///tmp/ignored2.html"></agent-embed>',
      '```',
    ].join('\n');

    const segs = splitAgentEmbeds(raw);
    expect(segs).toHaveLength(3);
    expect(segs[0]).toEqual({ kind: 'markdown', text: 'Here are the options:\n\n' });
    expect(segs[1]).toEqual({
      kind: 'embed',
      filePath: '/tmp/my preview/widget.html',
      title: 'widget.html',
    });
    expect(segs[2].kind).toBe('markdown');
    if (segs[2].kind === 'markdown') {
      expect(segs[2].text).toContain('ignored.html');
      expect(segs[2].text).toContain('ignored2.html');
    }
    expect(embedUrlForPath('/tmp/widget.html', 'tok1')).toBe(
      'sh-media://local?path=%2Ftmp%2Fwidget.html&embed=1&token=tok1'
    );
  });

  it('parses and resolves session links across all harnesses', () => {
    expect(parseSessionLinkHref('conversation://dc969a3b-736f-45e1-b1af-60d2fe972418')).toEqual({
      harnessHint: undefined,
      nativeId: 'dc969a3b-736f-45e1-b1af-60d2fe972418',
    });
    expect(parseSessionLinkHref('codex://thread/01a21648-e508-7b92-b976-b7178386e78a')).toEqual({
      harnessHint: 'codex',
      nativeId: '01a21648-e508-7b92-b976-b7178386e78a',
    });
    expect(parseSessionLinkHref('claude://session/3d88042c-caee-4c5c-863e-dcccc4b2ff38')).toEqual({
      harnessHint: 'claude',
      nativeId: '3d88042c-caee-4c5c-863e-dcccc4b2ff38',
    });
    expect(parseSessionLinkHref('muse://session/01a21669-b977-70b3-87cd-7614665f0529')).toEqual({
      harnessHint: 'muse',
      nativeId: '01a21669-b977-70b3-87cd-7614665f0529',
    });
    expect(
      parseSessionLinkHref('super-harness://session/claude:3d88042c-caee-4c5c-863e-dcccc4b2ff38')
    ).toEqual({
      unifiedId: 'claude:3d88042c-caee-4c5c-863e-dcccc4b2ff38',
      harnessHint: 'claude',
      nativeId: '3d88042c-caee-4c5c-863e-dcccc4b2ff38',
    });
    expect(parseSessionLinkHref('https://example.com/chat')).toBeNull();
    expect(parseSessionLinkHref('file:///tmp/foo.ts')).toBeNull();

    const makeSess = (id: string, harnessGroup: UnifiedSession['harnessGroup'], nativeId: string) =>
      ({
        id,
        harnessGroup,
        nativeId,
        harness: harnessGroup === 'claude' ? 'claude-desktop' : harnessGroup,
        title: id,
        cwd: '/tmp',
        projectName: 'tmp',
        updatedAt: Date.now(),
        createdAt: Date.now(),
        status: 'idle',
        dispatchMode: 'agy-resume',
        preview: '',
        tags: [],
        isLive: false,
      }) as UnifiedSession;

    const sessions = [
      makeSess('antigravity:dc969a3b-736f-45e1-b1af-60d2fe972418', 'antigravity', 'dc969a3b-736f-45e1-b1af-60d2fe972418'),
      makeSess('claude:3d88042c-caee-4c5c-863e-dcccc4b2ff38', 'claude', '3d88042c-caee-4c5c-863e-dcccc4b2ff38'),
      makeSess('codex:01a21648-e508-7b92-b976-b7178386e78a', 'codex', '01a21648-e508-7b92-b976-b7178386e78a'),
      makeSess('muse:01a21669-b977-70b3-87cd-7614665f0529', 'muse', '01a21669-b977-70b3-87cd-7614665f0529'),
    ];

    expect(
      resolveSessionLink('conversation://dc969a3b-736f-45e1-b1af-60d2fe972418', sessions)?.id
    ).toBe('antigravity:dc969a3b-736f-45e1-b1af-60d2fe972418');
    expect(resolveSessionLink('conversation://dc969a3b', sessions)?.id).toBe(
      'antigravity:dc969a3b-736f-45e1-b1af-60d2fe972418'
    );
    expect(
      resolveSessionLink('claude://session/3d88042c-caee-4c5c-863e-dcccc4b2ff38', sessions)?.id
    ).toBe('claude:3d88042c-caee-4c5c-863e-dcccc4b2ff38');
    expect(
      resolveSessionLink('codex://thread/01a21648-e508-7b92-b976-b7178386e78a', sessions)?.id
    ).toBe('codex:01a21648-e508-7b92-b976-b7178386e78a');
    expect(
      resolveSessionLink('muse://session/01a21669-b977-70b3-87cd-7614665f0529', sessions)?.id
    ).toBe('muse:01a21669-b977-70b3-87cd-7614665f0529');
  });
});
