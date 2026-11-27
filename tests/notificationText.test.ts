import { describe, expect, it } from 'vitest';
import { notificationTextFromMarkdown } from '../src/main/utils/notificationText';

describe('notificationTextFromMarkdown', () => {
  it('turns links, code and emphasis into plain text', () => {
    expect(
      notificationTextFromMarkdown(
        'Updated the sidebar search box in [Sidebar.tsx](file:///home/lxe/x/Sidebar.tsx) with **bold** and `code`.'
      )
    ).toBe('Updated the sidebar search box in Sidebar.tsx with bold and code.');
  });

  it('drops headings, list markers and fences, and cuts on a word', () => {
    const out = notificationTextFromMarkdown('## Done\n\n- first item\n- second item\n```ts\nconst x = 1;\n```\n' + 'word '.repeat(60), 60);
    expect(out.startsWith('Done first item second item word')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(61);
  });
});
