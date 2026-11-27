import React, { useEffect, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import type { DictationSettings, DictationStatus, SuperHarnessSettings } from '../../shared/types';
import { Button, IconButton, Input, SettingsGroup, SettingsRow } from '../ui';

interface Props {
  settings: SuperHarnessSettings;
  onUpdateSettings: (patch: Partial<SuperHarnessSettings>) => void;
  /** Extra rows for the Desktop group (the shortcut recorder). */
  extraRows?: React.ReactNode;
}

type TestState = { kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; status: DictationStatus };

/** Settings → Dictation: the desktop's one OpenAI-compatible transcription server. */
export const DictationSettingsPane: React.FC<Props> = ({ settings, onUpdateSettings, extraRows }) => {
  const saved: DictationSettings = settings.dictation ?? { baseUrl: '' };
  const [draft, setDraft] = useState({
    baseUrl: saved.baseUrl ?? '',
    apiKey: saved.apiKey ?? '',
    model: saved.model ?? '',
    language: saved.language ?? '',
  });
  const [showKey, setShowKey] = useState(false);
  const [test, setTest] = useState<TestState>({ kind: 'idle' });

  // Follow changes made elsewhere (another window, the one-time YapYap prefill).
  useEffect(() => {
    setDraft({
      baseUrl: saved.baseUrl ?? '',
      apiKey: saved.apiKey ?? '',
      model: saved.model ?? '',
      language: saved.language ?? '',
    });
  }, [saved.baseUrl, saved.apiKey, saved.model, saved.language]);

  const commit = (key: keyof typeof draft) => {
    const value = draft[key].trim();
    if ((saved[key] ?? '') === value) return;
    onUpdateSettings({ dictation: { ...saved, [key]: value } });
    setTest({ kind: 'idle' });
  };

  const field = (key: keyof typeof draft) => ({
    value: draft[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft((d) => ({ ...d, [key]: e.target.value })),
    onBlur: () => commit(key),
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
    },
  });

  const runTest = async () => {
    setTest({ kind: 'busy' });
    const status = await window.superHarness.getDictationStatus({
      baseUrl: draft.baseUrl.trim(),
      apiKey: draft.apiKey.trim(),
      model: draft.model.trim(),
      language: draft.language.trim(),
    });
    setTest({ kind: 'done', status });
  };

  let testLine: React.ReactNode = null;
  if (test.kind === 'done') {
    const st = test.status;
    testLine = !st.configured ? (
      <span className="text-ink-muted">Enter a server URL first</span>
    ) : st.healthy ? (
      <span className="inline-flex items-center gap-1.5 text-ink-secondary">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
        <span className="truncate">Connected{st.model ? ` · ${st.model}` : ''}</span>
      </span>
    ) : (
      <span className="text-rose-300/90 break-words">{st.error || 'Not reachable'}</span>
    );
  }

  return (
    <div className="space-y-7">
      <SettingsGroup
        title="Server"
        description="Any OpenAI-compatible transcription server (POST /v1/audio/transcriptions). Your phone sends audio through this desktop, so it uses the same server."
      >
        <SettingsRow
          label="Server URL"
          description="For example http://192.168.0.10:8122"
          control={
            <Input inputSize="sm" mono className="w-72" placeholder="http://host:port" {...field('baseUrl')} />
          }
        />
        <SettingsRow
          label="API key"
          description="Optional. Sent as a Bearer token"
          control={
            <div className="flex items-center gap-1.5">
              <Input
                inputSize="sm"
                mono
                className="w-60"
                type={showKey ? 'text' : 'password'}
                placeholder="None"
                autoComplete="off"
                spellCheck={false}
                {...field('apiKey')}
              />
              <IconButton label={showKey ? 'Hide API key' : 'Show API key'} onClick={() => setShowKey((v) => !v)}>
                {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </IconButton>
            </div>
          }
        />
        <SettingsRow
          label="Model"
          description="Optional. Leave blank for the server default"
          control={<Input inputSize="sm" className="w-56" placeholder="Server default" {...field('model')} />}
        />
        <SettingsRow
          label="Language"
          description="Optional ISO code such as en. Leave blank to auto-detect"
          control={<Input inputSize="sm" className="w-28" placeholder="Auto" {...field('language')} />}
        />
        <SettingsRow
          label="Connection"
          description={testLine ?? 'Checks the server and the API key'}
          control={
            <Button
              size="sm"
              variant="secondary"
              loading={test.kind === 'busy'}
              disabled={test.kind === 'busy'}
              onClick={() => void runTest()}
            >
              Test
            </Button>
          }
        />
      </SettingsGroup>
      {extraRows && <SettingsGroup title="Desktop">{extraRows}</SettingsGroup>}
    </div>
  );
};
