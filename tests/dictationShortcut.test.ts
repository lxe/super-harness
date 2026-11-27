import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DICTATION_SHORTCUT,
  isUsableShortcut,
  matchesShortcut,
  shortcutFromEvent,
} from '../src/renderer/utils/shortcut';
import { insertAtSelection } from '../src/renderer/components/DictationButton';

const ev = (code: string, key: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}) => ({
  code,
  key,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

describe('dictation shortcut', () => {
  it('formats key events with modifiers in a fixed order and layout-independent key names', () => {
    expect(shortcutFromEvent(ev('Space', ' ', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+Space');
    expect(shortcutFromEvent(ev('KeyD', 'D', { shiftKey: true, altKey: true }))).toBe('Alt+Shift+D');
    expect(shortcutFromEvent(ev('Digit1', '!', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+1');
    expect(shortcutFromEvent(ev('F8', 'F8'))).toBe('F8');
    expect(shortcutFromEvent(ev('ShiftLeft', 'Shift', { shiftKey: true }))).toBeNull();
  });

  it('matches the default shortcut', () => {
    expect(DEFAULT_DICTATION_SHORTCUT).toBe('Ctrl+Shift+Space');
    expect(matchesShortcut(ev('Space', ' ', { ctrlKey: true, shiftKey: true }), DEFAULT_DICTATION_SHORTCUT)).toBe(true);
    expect(matchesShortcut(ev('Space', ' ', { ctrlKey: true }), DEFAULT_DICTATION_SHORTCUT)).toBe(false);
    expect(matchesShortcut(ev('Space', ' ', { ctrlKey: true, shiftKey: true, altKey: true }), DEFAULT_DICTATION_SHORTCUT)).toBe(false);
  });

  it('rejects shortcuts that plain typing could trigger', () => {
    expect(isUsableShortcut('Shift+A')).toBe(false);
    expect(isUsableShortcut('A')).toBe(false);
    expect(isUsableShortcut('Ctrl+Shift+Space')).toBe(true);
    expect(isUsableShortcut('Alt+D')).toBe(true);
    expect(isUsableShortcut('F9')).toBe(true);
  });
});

describe('insertAtSelection', () => {
  it('inserts at the cursor with spaces where words would touch', () => {
    expect(insertAtSelection('', 0, 0, 'hello')).toEqual({ next: 'hello', caret: 5 });
    expect(insertAtSelection('fix the', 7, 7, 'bug')).toEqual({ next: 'fix the bug', caret: 11 });
    expect(insertAtSelection('fix  bug', 4, 4, 'the')).toEqual({ next: 'fix the bug', caret: 7 });
    expect(insertAtSelection('helloworld', 5, 5, 'big')).toEqual({ next: 'hello big world', caret: 9 });
    expect(insertAtSelection('see.', 3, 3, 'this')).toEqual({ next: 'see this.', caret: 8 });
    expect(insertAtSelection('replace ME now', 8, 10, 'this')).toEqual({ next: 'replace this now', caret: 12 });
  });
});
