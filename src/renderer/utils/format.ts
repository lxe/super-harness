import { marked } from 'marked';
import type { HarnessKind } from '../../shared/types';

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

export function mediaUrlForPath(filePath: string): string {
  return `sh-media://local?path=${encodeURIComponent(filePath)}`;
}

export function embedUrlForPath(filePath: string, token: string): string {
  return `sh-media://local?path=${encodeURIComponent(filePath)}&embed=1&token=${encodeURIComponent(token)}`;
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
