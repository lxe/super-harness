import fs from 'node:fs';

/**
 * The start of the last message the person sent in a session, for one-line list previews.
 *
 * Reads only the tail of the session's transcript file (each harness appends) and walks
 * it backwards to the newest user-authored record. Cached by path, size and mtime, so an
 * unchanged session costs one stat per discovery pass.
 */

type Extractor = (obj: Record<string, unknown>) => string | undefined;

interface HarnessFormat {
  /** Byte substrings a matching line must contain (cheap pre-filter before JSON.parse). */
  needles: string[];
  extract: Extractor;
}

const TAIL_BYTES = 512 * 1024;
const WIDE_TAIL_BYTES = 4 * 1024 * 1024;
const MAX_LEN = 160;

const isInjected = (t: string): boolean =>
  /^<(?:task-notification|cross-session-message|teammate-message|system-reminder|local-command-|command-name|environment_context|user_instructions|permissions)/i.test(
    t.trim()
  ) || t.trim().startsWith('# AGENTS.md');

const textOfBlocks = (blocks: unknown): string =>
  Array.isArray(blocks)
    ? blocks
        .map((b) => {
          const r = b as Record<string, unknown>;
          return typeof r?.text === 'string' ? r.text : '';
        })
        .filter(Boolean)
        .join(' ')
    : '';

const FORMATS: Record<string, HarnessFormat> = {
  // Claude Code rewrites a `last-prompt` record after each submitted prompt; messages typed
  // mid-turn appear as `queued_command` attachments when Claude delivers them.
  claude: {
    needles: ['"last-prompt"', '"queued_command"'],
    extract: (o) => {
      if (o.type === 'last-prompt' && typeof o.lastPrompt === 'string') return o.lastPrompt;
      const att = o.attachment as Record<string, unknown> | undefined;
      if (o.type === 'attachment' && att?.type === 'queued_command' && att.commandMode === 'prompt') {
        return typeof att.prompt === 'string' ? att.prompt : undefined;
      }
      return undefined;
    },
  },
  // Codex rollout: response_item payloads with role "user" (context injections start with "<").
  codex: {
    needles: ['"role":"user"'],
    extract: (o) => {
      const p = o.payload as Record<string, unknown> | undefined;
      if (o.type !== 'response_item' || p?.type !== 'message' || p.role !== 'user') return undefined;
      return textOfBlocks(p.content);
    },
  },
  antigravity: {
    needles: ['USER_INPUT'],
    extract: (o) => (o.type === 'USER_INPUT' && typeof o.content === 'string' ? o.content : undefined),
  },
  // Muse event log: chat intents on the main surface are what the person typed.
  muse: {
    needles: ['runtime.user_intent.accepted'],
    extract: (o) => {
      if (o.payload_type !== 'runtime.user_intent.accepted') return undefined;
      const p = o.payload as Record<string, unknown> | undefined;
      const kind = (p?.semantic_kind as Record<string, unknown> | undefined)?.kind;
      if (kind !== 'chat' || (p?.surface && p.surface !== 'main')) return undefined;
      return textOfBlocks(p?.refill_blocks);
    },
  },
};

/** One line: no attachment markers, collapsed whitespace, capped length. */
export function cleanUserPreview(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const cleaned = text
    .replace(/<pasted_content\b[^>]*>|<\/pasted_content\b[^>]*>/g, ' ')
    .replace(/\[(?:Attached|Image|File)[^\]]*\]/gi, ' ')
    .replace(/<\/?[A-Z][A-Z_]{2,}>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return undefined;
  return cleaned.length > MAX_LEN ? `${cleaned.slice(0, MAX_LEN - 1)}…` : cleaned;
}

const cache = new Map<string, { size: number; mtimeMs: number; text: string | undefined }>();

export function readLastUserText(filePath: string | undefined, harnessGroup: string): string | undefined {
  const fmt = FORMATS[harnessGroup];
  if (!filePath || !fmt) return undefined;
  let st: fs.Stats;
  try {
    st = fs.statSync(filePath);
  } catch {
    return undefined;
  }
  const hit = cache.get(filePath);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.text;

  let text = scanTail(filePath, st.size, TAIL_BYTES, fmt);
  // Long agent turns can push the last prompt far from the end; look further once.
  if (text === undefined && st.size > TAIL_BYTES) text = scanTail(filePath, st.size, WIDE_TAIL_BYTES, fmt);
  cache.set(filePath, { size: st.size, mtimeMs: st.mtimeMs, text });
  return text;
}

function scanTail(filePath: string, size: number, maxBytes: number, fmt: HarnessFormat): string | undefined {
  let text: string | undefined;
  try {
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(filePath, 'r');
    try {
      fs.readSync(fd, buf, 0, len, size - len);
    } finally {
      fs.closeSync(fd);
    }
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0 && !text; i--) {
      const line = lines[i];
      if (!fmt.needles.some((n) => line.includes(n))) continue;
      try {
        const raw = fmt.extract(JSON.parse(line) as Record<string, unknown>);
        if (raw && !isInjected(raw)) text = cleanUserPreview(raw);
      } catch {
        // partial first line of the window
      }
    }
  } catch {
    text = undefined;
  }
  return text;
}
