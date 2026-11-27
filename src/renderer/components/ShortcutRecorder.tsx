import React, { useEffect, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { IconButton } from '../ui';
import { isUsableShortcut, shortcutFromEvent } from '../utils/shortcut';

interface Props {
  value: string;
  defaultValue: string;
  onChange: (next: string) => void;
}

/** Click, then press a key combination; Esc cancels. Renders like the app's other kbd chips. */
export const ShortcutRecorder: React.FC<Props> = ({ value, defaultValue, onChange }) => {
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        setRecording(false);
        setHint(null);
        return;
      }
      const combo = shortcutFromEvent(e);
      if (!combo) return; // modifiers only so far
      if (!isUsableShortcut(combo)) {
        setHint('Include Ctrl, Alt or Meta');
        return;
      }
      onChange(combo);
      setRecording(false);
      setHint(null);
    };
    const onDown = (e: MouseEvent) => {
      if (!btnRef.current?.contains(e.target as Node)) {
        setRecording(false);
        setHint(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown, true);
    };
  }, [recording, onChange]);

  return (
    <div className="flex items-center gap-1.5" data-shortcut-recorder="">
      {hint && <span className="text-micro text-ink-faint">{hint}</span>}
      <button
        ref={btnRef}
        type="button"
        onClick={() => setRecording((v) => !v)}
        aria-label="Record dictation shortcut"
        className={`h-8 min-w-[140px] px-2.5 rounded-lg border font-mono text-caption transition-colors cursor-pointer ${
          recording
            ? 'border-line-strong bg-white/[0.1] text-ink-primary'
            : 'border-line-hairline bg-white/[0.04] text-ink-secondary hover:text-ink-primary hover:bg-white/[0.07]'
        }`}
      >
        {recording ? 'Press keys…' : value}
      </button>
      <IconButton
        label="Reset to default"
        disabled={value === defaultValue}
        onClick={() => onChange(defaultValue)}
      >
        <RotateCcw className="w-3.5 h-3.5" />
      </IconButton>
    </div>
  );
};
