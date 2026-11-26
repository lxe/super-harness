import { describe, expect, it } from 'vitest';
import {
  parseTaskNotification,
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
});
