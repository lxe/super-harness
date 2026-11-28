import { marked } from 'marked';
import type { HarnessGroup, HarnessKind, UnifiedSession } from '../../shared/types';

marked.setOptions({
  breaks: true,
  gfm: true,
});

const MARKDOWN_CACHE_MAX = 600;
const MARKDOWN_CACHE_MAX_INPUT = 120_000;
const markdownHtmlCache = new Map<string, string>();

export function clearMarkdownCache(): void {
  markdownHtmlCache.clear();
}

export function getMarkdownCacheSize(): number {
  return markdownHtmlCache.size;
}

export function renderMarkdownHtml(md: string): string {
  const cacheable = md.length <= MARKDOWN_CACHE_MAX_INPUT;
  if (cacheable) {
    const cached = markdownHtmlCache.get(md);
    if (cached !== undefined) {
      // Promote to MRU
      markdownHtmlCache.delete(md);
      markdownHtmlCache.set(md, cached);
      return cached;
    }
  }
  try {
    const safe = md.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    const html = marked.parse(safe, { async: false }) as string;
    if (cacheable) {
      markdownHtmlCache.set(md, html);
      if (markdownHtmlCache.size > MARKDOWN_CACHE_MAX) {
        const oldest = markdownHtmlCache.keys().next().value;
        if (oldest !== undefined) markdownHtmlCache.delete(oldest);
      }
    }
    return html;
  } catch {
    return md;
  }
}

/** Web mode (see webServer.ts) serves local files at `media?…` instead of the `sh-media:` protocol. */
const MEDIA_BASE =
  typeof window !== 'undefined' && (window as { __SH_WEB__?: boolean }).__SH_WEB__ ? 'media' : 'sh-media://local';

export function mediaUrlForPath(filePath: string): string {
  return `${MEDIA_BASE}?path=${encodeURIComponent(filePath)}`;
}

export interface ParsedSessionLink {
  unifiedId?: string;
  harnessHint?: HarnessGroup;
  nativeId: string;
}

const SESSION_LINK_SCHEMES: Record<string, HarnessGroup | undefined> = {
  conversation: undefined,
  session: undefined,
  sh: undefined,
  'super-harness': undefined,
  superharness: undefined,
  antigravity: 'antigravity',
  agy: 'antigravity',
  codex: 'codex',
  claude: 'claude',
  muse: 'muse',
  pi: 'pi',
};

const KNOWN_HARNESS_PREFIXES = new Set<HarnessGroup>(['antigravity', 'codex', 'claude', 'muse', 'pi']);

/**
 * Parses deep links to sessions/conversations across all supported harnesses
 * (e.g. `conversation://<uuid>`, `session://<id>`, `codex://thread/<uuid>`,
 * `claude://session/<uuid>`, `muse://session/<uuid>`, `super-harness://session/<id>`).
 */
export function parseSessionLinkHref(href: string): ParsedSessionLink | null {
  const trimmed = href.trim();
  const schemeMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):\/\/(.+)$/i);
  if (!schemeMatch) return null;

  const scheme = schemeMatch[1].toLowerCase();
  if (!(scheme in SESSION_LINK_SCHEMES)) return null;

  const harnessHint = SESSION_LINK_SCHEMES[scheme];
  // Strip query string / fragment and split path segments
  const cleanRest = schemeMatch[2].split(/[?#]/)[0].replace(/^\/+|\/+$/g, '');
  if (!cleanRest) return null;

  let rawTarget: string;
  try {
    rawTarget = decodeURIComponent(cleanRest);
  } catch {
    rawTarget = cleanRest;
  }

  const segments = rawTarget.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  // Allow optional path prefixes like `session/<id>`, `thread/<id>`, `conversation/<id>`, `chat/<id>`
  let idPart = segments[0];
  if (
    segments.length >= 2 &&
    /^(?:session|sessions|thread|threads|conversation|conversations|chat|chats)$/i.test(segments[0])
  ) {
    idPart = segments[1];
  } else if (segments.length > 1) {
    idPart = segments[segments.length - 1];
  }
  idPart = idPart.trim();
  if (!idPart) return null;

  // Check if idPart is already a unified session id (`claude:<uuid>`, `antigravity:<uuid>`, etc.)
  const colonIdx = idPart.indexOf(':');
  if (colonIdx > 0) {
    const prefix = idPart.slice(0, colonIdx).toLowerCase() as HarnessGroup;
    const nativeId = idPart.slice(colonIdx + 1).trim();
    if (KNOWN_HARNESS_PREFIXES.has(prefix) && nativeId) {
      return {
        unifiedId: `${prefix}:${nativeId}`,
        harnessHint: prefix,
        nativeId,
      };
    }
  }

  return {
    harnessHint,
    nativeId: idPart,
  };
}

/**
 * Resolves a parsed session link against the live list of UnifiedSessions.
 */
export function resolveSessionLink(
  href: string,
  sessions: UnifiedSession[]
): UnifiedSession | null {
  const parsed = parseSessionLinkHref(href);
  if (!parsed) return null;

  const targetUnified = parsed.unifiedId?.toLowerCase();
  const targetNative = parsed.nativeId.toLowerCase();

  if (targetUnified) {
    const exact = sessions.find((s) => s.id.toLowerCase() === targetUnified);
    if (exact) return exact;
  }

  if (parsed.harnessHint) {
    const hinted = sessions.find(
      (s) => s.harnessGroup === parsed.harnessHint && s.nativeId.toLowerCase() === targetNative
    );
    if (hinted) return hinted;
  }

  const byNative = sessions.find((s) => s.nativeId.toLowerCase() === targetNative);
  if (byNative) return byNative;

  if (targetNative.length >= 8) {
    const prefixMatches = sessions.filter(
      (s) =>
        (!parsed.harnessHint || s.harnessGroup === parsed.harnessHint) &&
        s.nativeId.toLowerCase().startsWith(targetNative)
    );
    if (prefixMatches.length === 1) return prefixMatches[0];
  }

  return null;
}

export function embedUrlForPath(filePath: string, token: string): string {
  return `${MEDIA_BASE}?path=${encodeURIComponent(filePath)}&embed=1&token=${encodeURIComponent(token)}`;
}

export type TextEmbedSegment =
  | { kind: 'markdown'; text: string }
  | { kind: 'embed'; filePath: string; title: string };

function decodeEmbedFilePath(src: string): string | null {
  const trimmed = src.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('file://')) {
    try {
      const u = new URL(trimmed);
      return decodeURIComponent(u.pathname);
    } catch {
      return null;
    }
  }
  if (trimmed.startsWith('/')) return trimmed;
  return null;
}

/**
 * Splits markdown text containing `<agent-embed src="file:///...html">` tags
 * into alternating markdown and inline HTML preview segments while ignoring
 * examples inside fenced code blocks or inline code spans.
 */
export function splitAgentEmbeds(raw: string): TextEmbedSegment[] {
  if (!raw || !raw.toLowerCase().includes('<agent-embed')) {
    return [{ kind: 'markdown', text: raw }];
  }

  // Match fenced code blocks, inline code spans, or <agent-embed ...> tags in one pass
  const tokenRe =
    /(```[\s\S]*?```|`[^`\n]+`|<agent-embed\b([^>]*?)(?:\/>|>\s*<\/agent-embed>))/gi;

  const segments: TextEmbedSegment[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  const pushMarkdown = (chunk: string) => {
    if (!chunk) return;
    const prev = segments[segments.length - 1];
    if (prev && prev.kind === 'markdown') {
      prev.text += chunk;
    } else {
      segments.push({ kind: 'markdown', text: chunk });
    }
  };

  while ((match = tokenRe.exec(raw)) !== null) {
    const full = match[0];
    const attrs = match[2];
    if (attrs === undefined) {
      // Code block or inline code — keep untouched
      pushMarkdown(raw.slice(cursor, match.index + full.length));
      cursor = match.index + full.length;
      continue;
    }

    const srcMatch = attrs.match(/\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
    const rawSrc = srcMatch?.[1] || srcMatch?.[2] || srcMatch?.[3] || '';
    const filePath = decodeEmbedFilePath(rawSrc);
    if (!filePath || !/\.html?$/i.test(filePath)) {
      pushMarkdown(raw.slice(cursor, match.index + full.length));
      cursor = match.index + full.length;
      continue;
    }

    const before = raw.slice(cursor, match.index);
    if (before.trim()) pushMarkdown(before);
    const title = filePath.split('/').pop() || 'Interactive preview';
    segments.push({ kind: 'embed', filePath, title });
    cursor = match.index + full.length;
  }

  const tail = raw.slice(cursor);
  if (tail.trim() || segments.length === 0) {
    pushMarkdown(tail);
  }

  return segments;
}

export interface HarnessVisual {
  label: string;
  glyph: string;
  subtleColor: string;
}

export function getHarnessVisual(harness: HarnessKind): HarnessVisual {
  switch (harness) {
    case 'master':
      return { label: 'Master', glyph: '✦', subtleColor: 'text-zinc-300' };
    case 'codex':
      return { label: 'Codex', glyph: '⌘', subtleColor: 'text-zinc-400' };
    case 'claude-tmux':
      return { label: 'Claude · tmux', glyph: '❯', subtleColor: 'text-zinc-400' };
    case 'claude-desktop':
      return { label: 'Claude', glyph: '✳', subtleColor: 'text-zinc-400' };
    case 'claude-cli':
      return { label: 'Claude CLI', glyph: '✳', subtleColor: 'text-zinc-500' };
    case 'antigravity':
      return { label: 'Antigravity', glyph: '▲', subtleColor: 'text-zinc-400' };
    case 'muse':
      return { label: 'Muse', glyph: 'μ', subtleColor: 'text-zinc-400' };
    case 'pi':
      return { label: 'Pi', glyph: 'π', subtleColor: 'text-zinc-400' };
  }
}

export function formatRelativeTime(ts: number): string {
  if (!ts || !Number.isFinite(ts)) return '';
  const diff = Math.max(0, Date.now() - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return 'now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}

export function formatClock(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export interface ParsedTaskNotification {
  status?: string;
  taskIds: string[];
  summary?: string;
  result?: string;
  outputFile?: string;
  extraText?: string;
}

function extractXmlTag(src: string, tag: string): string | undefined {
  const m = src.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m?.[1]?.trim() || undefined;
}

/**
 * Parses Claude's XML `<task-notification>` envelopes into clean structured fields
 * so they never collapse into smashed single-line raw tags or misaligned bullets.
 */
export function parseTaskNotification(raw: string): ParsedTaskNotification | null {
  const match = raw.match(/<task-notification\b[^>]*>([\s\S]*?)<\/task-notification>/i);
  if (!match) return null;

  const inner = match[1];
  const status = extractXmlTag(inner, 'status');
  const rawTaskId = extractXmlTag(inner, 'task-id');
  const rawSummary = extractXmlTag(inner, 'summary');
  const rawResult = extractXmlTag(inner, 'result');
  const outputFile = extractXmlTag(inner, 'output-file');

  const taskIds = (rawTaskId || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => Boolean(s) && !s.startsWith('__orphan_summary__'));

  const summary =
    rawSummary && !rawSummary.startsWith('__orphan_summary__') ? rawSummary : undefined;

  // Preserve any plain prose outside the XML envelope
  const remainder = raw
    .replace(/<task-notification\b[^>]*>[\s\S]*?<\/task-notification>/gi, '')
    .trim();

  // If neither summary nor result was in named tags, strip remaining tags cleanly
  const fallbackBody =
    !summary && !rawResult
      ? inner
          .replace(/<(?:task-id|tool-use-id|status|output-file)[^>]*>[\s\S]*?<\/(?:task-id|tool-use-id|status|output-file)>/gi, '')
          .replace(/<\/?[a-z0-9_-]+[^>]*>/gi, '')
          .trim()
      : undefined;

  return {
    status,
    taskIds,
    summary,
    result: rawResult || fallbackBody || undefined,
    outputFile,
    extraText: remainder || undefined,
  };
}

/**
 * Strips known XML system/agent envelope tags so markdown lists and paragraphs
 * inside collapsible system cards parse and indent cleanly.
 */
export function unwrapSystemEnvelope(raw: string): string {
  return raw
    .replace(
      /<\/?(?:task-notification|cross-session-message|teammate-message|subagent[_-]notification|system-reminder|environment_context|local-command-caveat|turn_aborted|INSTRUCTIONS|SYSTEM_MESSAGE)\b[^>]*>/gi,
      '\n'
    )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
