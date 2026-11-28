import React, { useCallback, useEffect, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import type { AcpAgentDefinition, AcpAgentStatus, AcpAgentTestResult } from '../../shared/types';
import { Button, Field, IconButton, Input } from '../ui';

/** Ready-made entries for agents that speak ACP. Users can edit any field after adding one. */
const PRESETS: AcpAgentDefinition[] = [
  { id: 'opencode', name: 'OpenCode', command: 'opencode', args: ['acp'] },
  { id: 'gemini', name: 'Gemini CLI', command: 'gemini', args: ['--experimental-acp'] },
];

interface Draft {
  id: string;
  name: string;
  command: string;
  args: string;
  env: string;
}

const toDraft = (a?: AcpAgentDefinition): Draft => ({
  id: a?.id ?? '',
  name: a?.name ?? '',
  command: a?.command ?? '',
  args: (a?.args ?? []).join(' '),
  env: Object.entries(a?.env ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n'),
});

/** Splits an argument line on spaces, keeping "quoted strings" together. */
function splitArgs(line: string): string[] {
  return (line.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((a) => a.replace(/^(["'])(.*)\1$/, '$2'));
}

function fromDraft(d: Draft): AcpAgentDefinition {
  const env: Record<string, string> = {};
  for (const line of d.env.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return {
    id: d.id.trim(),
    name: d.name.trim() || undefined,
    command: d.command.trim(),
    args: splitArgs(d.args),
    env: Object.keys(env).length ? env : undefined,
  };
}

const plain = ({ resolvedPath: _r, liveSessions: _l, totalSessions: _t, ...def }: AcpAgentStatus): AcpAgentDefinition => def;

/** Settings → Harnesses: the agents in acp-agents.json, with add, edit, remove and test. */
export const AcpAgentsEditor: React.FC<{ onChanged?: () => void }> = ({ onChanged }) => {
  const [agents, setAgents] = useState<AcpAgentStatus[]>([]);
  const [configPath, setConfigPath] = useState('');
  const [editing, setEditing] = useState<{ index: number | null; draft: Draft } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, AcpAgentTestResult | 'running'>>({});

  const load = useCallback(async () => {
    const res = await window.superHarness.getAcpAgents();
    setAgents(res.agents);
    setConfigPath(res.configPath);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (next: AcpAgentDefinition[]): Promise<boolean> => {
    const res = await window.superHarness.saveAcpAgents(next);
    if (!res.ok) {
      setError(res.error ?? 'Could not save.');
      return false;
    }
    setError(null);
    await load();
    onChanged?.();
    return true;
  };

  const commitEdit = async () => {
    if (!editing) return;
    const def = fromDraft(editing.draft);
    const list = agents.map(plain);
    if (editing.index === null) list.push(def);
    else list[editing.index] = def;
    if (await save(list)) setEditing(null);
  };

  const runTest = async (key: string, def: AcpAgentDefinition) => {
    setTests((t) => ({ ...t, [key]: 'running' }));
    const res = await window.superHarness.testAcpAgent(def);
    setTests((t) => ({ ...t, [key]: res }));
  };

  const testLine = (key: string) => {
    const t = tests[key];
    if (!t) return null;
    if (t === 'running') return <span className="text-ink-faint">Testing…</span>;
    if (!t.ok) return <span className="text-status-danger break-all">Failed: {t.error}</span>;
    const who = [t.agentName, t.agentVersion].filter(Boolean).join(' ');
    return (
      <span className="text-status-success">
        Speaks ACP{who ? ` (${who})` : ''} · {t.canLoadSession ? 'can resume' : 'cannot resume'} ·{' '}
        {t.modelCount ? `${t.modelCount} models` : 'no model list'} · {t.ms} ms
      </span>
    );
  };

  const usedIds = new Set(agents.map((a) => a.id));

  return (
    <div className="pl-[52px] pb-4 space-y-3 text-caption" data-testid="acp-agents-editor">
      {agents.length === 0 && !editing && (
        <p className="text-ink-muted">No ACP agents yet. Add one below or pick a preset.</p>
      )}
      {agents.map((a, i) => {
        const key = `saved:${a.id}`;
        const status = !a.resolvedPath
          ? { dot: 'bg-status-danger', text: 'command not found' }
          : a.liveSessions > 0
            ? { dot: 'bg-emerald-400', text: `${a.liveSessions} running` }
            : { dot: 'bg-zinc-500', text: 'idle' };
        return (
          <div key={a.id} className="rounded-lg border border-line-hairline bg-surface-subtle px-3 py-2.5 space-y-1">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${status.dot}`} />
                <span className="text-body font-medium text-ink-primary truncate">{a.name ?? a.id}</span>
                <span className="text-micro text-ink-faint shrink-0">
                  {status.text} · {a.totalSessions} {a.totalSessions === 1 ? 'session' : 'sessions'}
                </span>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button size="xs" variant="subtle" onClick={() => void runTest(key, plain(a))} loading={tests[key] === 'running'}>
                  Test
                </Button>
                <IconButton size="xs" label={`Edit ${a.name ?? a.id}`} onClick={() => setEditing({ index: i, draft: toDraft(a) })}>
                  <Pencil className="w-3 h-3" />
                </IconButton>
                <IconButton
                  size="xs"
                  label={`Remove ${a.name ?? a.id}`}
                  onClick={() => void save(agents.filter((_, j) => j !== i).map(plain))}
                >
                  <Trash2 className="w-3 h-3" />
                </IconButton>
              </div>
            </div>
            <div className="font-mono text-micro text-ink-secondary truncate" title={a.resolvedPath ?? a.command}>
              {[a.command, ...(a.args ?? [])].join(' ')}
            </div>
            <div>{testLine(key)}</div>
          </div>
        );
      })}

      {editing ? (
        <div className="rounded-lg border border-line-hairline px-3 py-3 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="ID" hint="letters, digits, . - _">
              <Input
                inputSize="sm"
                mono
                value={editing.draft.id}
                onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, id: e.target.value } })}
                placeholder="gemini"
              />
            </Field>
            <Field label="Name">
              <Input
                inputSize="sm"
                value={editing.draft.name}
                onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, name: e.target.value } })}
                placeholder="Gemini CLI"
              />
            </Field>
          </div>
          <Field label="Command" hint="on PATH, or an absolute path">
            <Input
              inputSize="sm"
              mono
              value={editing.draft.command}
              onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, command: e.target.value } })}
              placeholder="gemini"
            />
          </Field>
          <Field label="Arguments" hint='space-separated; "quote" to keep spaces'>
            <Input
              inputSize="sm"
              mono
              value={editing.draft.args}
              onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, args: e.target.value } })}
              placeholder="--experimental-acp"
            />
          </Field>
          <Field label="Environment" hint="KEY=value, one per line">
            <textarea
              rows={2}
              className="w-full bg-surface-rail rounded-lg px-2.5 py-1.5 font-mono text-micro text-ink-primary focus:outline-none focus:ring-1 focus:ring-white/15"
              value={editing.draft.env}
              onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, env: e.target.value } })}
            />
          </Field>
          <div>{testLine('draft')}</div>
          <div className="flex items-center justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => { setEditing(null); setError(null); }}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="secondary"
              loading={tests.draft === 'running'}
              disabled={!editing.draft.command.trim()}
              onClick={() => void runTest('draft', fromDraft(editing.draft))}
            >
              Test
            </Button>
            <Button size="sm" variant="primary" onClick={() => void commitEdit()}>
              Save
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" iconLeft={<Plus className="w-3.5 h-3.5" />} onClick={() => setEditing({ index: null, draft: toDraft() })}>
            Add agent
          </Button>
          {PRESETS.filter((p) => !usedIds.has(p.id)).map((p) => (
            <Button key={p.id} size="xs" variant="subtle" onClick={() => setEditing({ index: null, draft: toDraft(p) })}>
              + {p.name}
            </Button>
          ))}
        </div>
      )}
      {error && <p className="text-status-danger">{error}</p>}
      {configPath && <p className="text-micro text-ink-faint font-mono">Saved to {configPath}</p>}
    </div>
  );
};
