/**
 * Keyboard shortcuts stored as strings like "Ctrl+Shift+Space": modifiers in the fixed order
 * Ctrl, Alt, Shift, Meta, then one key named from `KeyboardEvent.code` so the layout and the
 * Shift state don't change the name ("KeyA" → "A", "Digit1" → "1", "Space", "F5").
 */

export const DEFAULT_DICTATION_SHORTCUT = 'Ctrl+Shift+Space';

const MODIFIER_CODES = new Set([
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'ShiftLeft',
  'ShiftRight',
  'MetaLeft',
  'MetaRight',
  'OSLeft',
  'OSRight',
]);

export interface ShortcutEventLike {
  code: string;
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export function keyNameFromCode(code: string, key: string): string | null {
  if (!code || MODIFIER_CODES.has(code)) return null;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  const named: Record<string, string> = {
    Space: 'Space',
    Enter: 'Enter',
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Insert: 'Insert',
    Delete: 'Delete',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
  };
  if (named[code]) return named[code];
  if (/^Numpad/.test(code)) return code;
  return key && key.length === 1 ? key.toUpperCase() : null;
}

/** The shortcut string for a key event, or null for a lone modifier press. */
export function shortcutFromEvent(e: ShortcutEventLike): string | null {
  const keyName = keyNameFromCode(e.code, e.key);
  if (!keyName) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');
  parts.push(keyName);
  return parts.join('+');
}

/**
 * Whether a recorded combination is acceptable as a global in-window shortcut: it needs a
 * modifier (other than Shift alone) so typing in a composer can't trigger it; F-keys may stand alone.
 */
export function isUsableShortcut(shortcut: string): boolean {
  const parts = shortcut.split('+');
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if (/^F\d+$/.test(key)) return true;
  return mods.some((m) => m === 'Ctrl' || m === 'Alt' || m === 'Meta');
}

export function matchesShortcut(e: ShortcutEventLike, shortcut: string | undefined): boolean {
  if (!shortcut) return false;
  return shortcutFromEvent(e) === shortcut;
}
