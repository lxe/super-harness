import { describe, expect, it } from 'vitest';
import {
  codexTurnPolicy,
  normalizeClaudePermissionMode,
  normalizeCodexPermissionMode,
  normalizeEffort,
  CLAUDE_EFFORTS,
} from '../src/main/adapters/sessionConfig';
import { createClaudeDriver, detectClaudeTuiMode } from '../src/main/adapters/claudeAdapter';
import { createCodexDriver } from '../src/main/adapters/codexAdapter';
import { createMuseDriver } from '../src/main/adapters/museAdapter';
import { createAntigravityDriver } from '../src/main/adapters/antigravityAdapter';
import type { UnifiedSession } from '../src/shared/types';
import type { DispatchContext } from '../src/main/adapters/types';

const ctx = { triggerRefresh: () => {} } as unknown as DispatchContext;
const session = (over: Partial<UnifiedSession>): UnifiedSession =>
  ({ id: 'x:1', nativeId: '1', harness: 'claude-desktop', harnessGroup: 'claude', title: 't', cwd: '/tmp', tags: [], status: 'idle', ...over }) as UnifiedSession;

describe('session config vocabulary', () => {
  it('maps spoken aliases to harness-native permission modes', () => {
    expect(normalizeClaudePermissionMode('bypass')).toBe('bypassPermissions');
    expect(normalizeClaudePermissionMode('Default')).toBe('manual');
    expect(normalizeClaudePermissionMode('accept edits')).toBe('acceptEdits');
    expect(normalizeClaudePermissionMode('sideways')).toBeUndefined();
    expect(normalizeCodexPermissionMode('full-auto')).toBe('auto');
    expect(normalizeCodexPermissionMode('yolo')).toBe('full-access');
    expect(normalizeCodexPermissionMode('read only')).toBe('read-only');
  });
  it('normalizes effort spellings', () => {
    expect(normalizeEffort('Extra High', CLAUDE_EFFORTS)).toBe('xhigh');
    expect(normalizeEffort('ultra', CLAUDE_EFFORTS)).toBeUndefined();
  });
  it('turns Codex presets into turn/start overrides with escalation off', () => {
    expect(codexTurnPolicy(undefined)).toEqual({});
    expect(codexTurnPolicy('full-access')).toEqual({ approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } });
    expect(codexTurnPolicy('auto')).toMatchObject({ approvalPolicy: 'never', sandboxPolicy: { type: 'workspaceWrite' } });
    expect(codexTurnPolicy('read-only')).toMatchObject({ sandboxPolicy: { type: 'readOnly' } });
  });
  it('reads the Claude TUI mode from the pane footer', () => {
    expect(detectClaudeTuiMode('...\n❯ \n  ⏵⏵ bypass permissions on (shift+tab to cycle)')).toBe('bypassPermissions');
    expect(detectClaudeTuiMode('  ⏸ manual mode on · ? for shortcuts')).toBe('manual');
    expect(detectClaudeTuiMode('nothing here')).toBeUndefined();
  });
});

describe('per-harness applySessionConfig', () => {
  it('Claude non-tmux: all three apply on the next message; bad values are invalid', async () => {
    const r = await createClaudeDriver().applySessionConfig!(
      session({}),
      { model: 'sonnet', reasoningEffort: 'HIGH', permissionMode: 'nope' },
      ctx
    );
    expect(r.map((x) => [x.field, x.status, x.value])).toEqual([
      ['model', 'next_message', 'sonnet'],
      ['reasoningEffort', 'next_message', 'high'],
      ['permissionMode', 'invalid', undefined],
    ]);
  });
  it('Claude live tmux: model/effort need a restart unless restart:true', async () => {
    const r = await createClaudeDriver().applySessionConfig!(
      session({ harness: 'claude-tmux', dispatchMode: 'tmux-send', tmuxTarget: 'none:0.0' }),
      { model: 'opus' },
      ctx
    );
    expect(r[0]).toMatchObject({ field: 'model', status: 'needs_restart', value: 'opus' });
  });
  it('Claude on another machine is unsupported', async () => {
    const r = await createClaudeDriver().applySessionConfig!(session({ tags: ['remote-host'], hostLabel: 'mac' }), { model: 'x' }, ctx);
    expect(r[0].status).toBe('unsupported');
  });
  it('Codex: preset stored for the next turn; default clears the override', async () => {
    const r = await createCodexDriver().applySessionConfig!(
      session({ harness: 'codex', harnessGroup: 'codex' }),
      { permissionMode: 'bypass', reasoningEffort: 'minimal' },
      ctx
    );
    expect(r.map((x) => [x.field, x.status, x.value])).toEqual([
      ['reasoningEffort', 'next_message', 'minimal'],
      ['permissionMode', 'next_message', 'full-access'],
    ]);
    const d = await createCodexDriver().applySessionConfig!(session({ harnessGroup: 'codex' }), { permissionMode: 'default' }, ctx);
    expect(d[0]).toMatchObject({ status: 'next_message', value: '' });
  });
  it('Muse and Antigravity report what they cannot do', async () => {
    const m = await createMuseDriver().applySessionConfig!(session({ harnessGroup: 'muse' }), { permissionMode: 'plan', reasoningEffort: 'ultra' }, ctx);
    expect(m.map((x) => x.status)).toEqual(['next_message', 'unsupported']);
    const a = await createAntigravityDriver().applySessionConfig!(session({ harnessGroup: 'antigravity' }), { model: 'gemini-3-pro', reasoningEffort: 'high' }, ctx);
    expect(a.map((x) => x.status)).toEqual(['next_message', 'unsupported']);
  });
});
