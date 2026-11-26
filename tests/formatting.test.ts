import { describe, expect, it } from 'vitest';
import {
  embedUrlForPath,
  parseTaskNotification,
  splitAgentEmbeds,
  unwrapSystemEnvelope,
} from '../src/renderer/utils/format';

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
});
