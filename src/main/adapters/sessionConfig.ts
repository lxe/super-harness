import type {
  SessionConfigChange,
  SessionConfigFieldResult,
  SessionConfigStatus,
} from '../../shared/types';

/**
 * Per-harness vocabulary for session config changes (model, reasoning effort, permission
 * mode). Drivers use these to validate a request and to report each field honestly.
 */

export type ConfigField = SessionConfigFieldResult['field'];

/** Claude CLI `--permission-mode` choices ("manual" is the ordinary ask-before-acting mode). */
export const CLAUDE_PERMISSION_MODES = ['manual', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions'] as const;
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Codex presets, applied per turn as approvalPolicy + sandboxPolicy (see codexTurnPolicy). */
export const CODEX_PERMISSION_MODES = ['default', 'read-only', 'auto', 'full-access'] as const;
export const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;

const key = (s: string) => s.trim().toLowerCase().replace(/[\s_]+/g, '-');

const CLAUDE_PERMISSION_ALIASES: Record<string, string> = {
  default: 'manual',
  manual: 'manual',
  normal: 'manual',
  ask: 'manual',
  'dont-ask': 'dontAsk',
  dontask: 'dontAsk',
  'accept-edits': 'acceptEdits',
  acceptedits: 'acceptEdits',
  auto: 'auto',
  'auto-mode': 'auto',
  plan: 'plan',
  'plan-mode': 'plan',
  bypass: 'bypassPermissions',
  bypasspermissions: 'bypassPermissions',
  'bypass-permissions': 'bypassPermissions',
  yolo: 'bypassPermissions',
  'full-access': 'bypassPermissions',
  'full-auto': 'bypassPermissions',
  'dangerously-skip-permissions': 'bypassPermissions',
};

const CODEX_PERMISSION_ALIASES: Record<string, string> = {
  default: 'default',
  'read-only': 'read-only',
  readonly: 'read-only',
  plan: 'read-only',
  auto: 'auto',
  'full-auto': 'auto',
  'workspace-write': 'auto',
  acceptedits: 'auto',
  'accept-edits': 'auto',
  'full-access': 'full-access',
  bypass: 'full-access',
  bypasspermissions: 'full-access',
  'bypass-permissions': 'full-access',
  yolo: 'full-access',
  'danger-full-access': 'full-access',
  'dangerously-bypass-approvals-and-sandbox': 'full-access',
};

export function normalizeClaudePermissionMode(v: string): string | undefined {
  return CLAUDE_PERMISSION_ALIASES[key(v)];
}

export function normalizeCodexPermissionMode(v: string): string | undefined {
  return CODEX_PERMISSION_ALIASES[key(v)];
}

export function normalizeEffort(v: string, allowed: readonly string[]): string | undefined {
  const k = v.trim().toLowerCase().replace(/[\s_-]+/g, '');
  const map: Record<string, string> = { extrahigh: 'xhigh', veryhigh: 'xhigh', maximum: 'max' };
  const val = map[k] ?? k;
  return allowed.includes(val) ? val : undefined;
}

/**
 * Codex turn/start overrides for a preset. Superharness auto-accepts Codex approval
 * requests (it has no approval UI), so the sandbox is the real boundary and escalation is
 * turned off ("never") for every preset; otherwise a sandboxed turn could ask to escape
 * and be approved automatically. `default` sends nothing (the user's Codex config rules).
 */
export function codexTurnPolicy(mode: string | undefined): Record<string, unknown> {
  switch (mode) {
    case 'read-only':
      return { approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false } };
    case 'auto':
      return {
        approvalPolicy: 'never',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: [],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      };
    case 'full-access':
      return { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } };
    default:
      return {};
  }
}

/** Builds results for a change, one per requested field. */
export function resultsFor(
  change: SessionConfigChange,
  decide: (field: ConfigField, requested: string) => { status: SessionConfigStatus; value?: string; detail?: string }
): SessionConfigFieldResult[] {
  const out: SessionConfigFieldResult[] = [];
  for (const field of ['model', 'reasoningEffort', 'permissionMode'] as const) {
    const requested = change[field];
    if (requested === undefined) continue;
    out.push({ field, requested, ...decide(field, requested) });
  }
  return out;
}

export const invalid = (allowed: readonly string[]) => ({
  status: 'invalid' as const,
  detail: `Valid values: ${allowed.join(', ')} (empty string clears the override).`,
});
