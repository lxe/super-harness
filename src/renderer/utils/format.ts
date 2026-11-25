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
