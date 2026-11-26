import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  Bell,
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  FileCode2,
  FileText,
  Globe,
  HelpCircle,
  History,
  ImageOff,
  Play,
  RotateCcw,
  Terminal,
  Wrench,
  X,
} from 'lucide-react';
import type { MessageSourceKind, UnifiedBlock, UnifiedMessage } from '../../shared/types';
import { Badge, Button, CollapsibleCard, DisclosureRow, WorkingIndicator } from '../ui';
import {
  embedUrlForPath,
  mediaUrlForPath,
  parseTaskNotification,
  renderMarkdownHtml,
  splitAgentEmbeds,
  unwrapSystemEnvelope,
} from '../utils/format';
import type { PreviewImageItem } from './ImageLightbox';

export type TraceBlock = Extract<
  UnifiedBlock,
  { type: 'thinking' | 'command' | 'file_change' | 'tool_call' | 'web_search' | 'notice' }
>;

export function isTraceBlock(b: UnifiedBlock): b is TraceBlock {
  return b.type !== 'text' && b.type !== 'image' && b.type !== 'video' && b.type !== 'question';
}

export type BlockSegment =
  | { kind: 'single'; block: UnifiedBlock }
  | { kind: 'trace'; blocks: TraceBlock[] };

/**
 * Groups consecutive trace blocks (thinking / commands / file_changes / tool_calls)
 * into a single collapsible summary while leaving prose, images, and questions
 * directly visible.
 */
export function segmentBlocks(blocks: UnifiedBlock[]): BlockSegment[] {
  const segments: BlockSegment[] = [];
  for (const b of blocks) {
    if (isTraceBlock(b)) {
      const last = segments[segments.length - 1];
      if (last && last.kind === 'trace') {
        last.blocks.push(b);
      } else {
        segments.push({ kind: 'trace', blocks: [b] });
      }
    } else {
      segments.push({ kind: 'single', block: b });
    }
  }
  return segments;
}

interface TraceGroupProps {
  blocks: TraceBlock[];
  onOpenPath?: (filePath: string, opts?: { startLine?: number; endLine?: number }) => void;
}

export const CollapsedTraceGroup: React.FC<TraceGroupProps> = React.memo(({ blocks, onOpenPath }) => {
  const summary = useMemo(() => {
    let thinkCount = 0;
    let cmdCount = 0;
    let fileCount = 0;
    let toolCount = 0;
    let searchCount = 0;

    for (const b of blocks) {
      if (b.type === 'thinking') thinkCount++;
      else if (b.type === 'command') cmdCount++;
      else if (b.type === 'file_change') fileCount += b.changes.length;
      else if (b.type === 'web_search') searchCount++;
      else if (b.type === 'tool_call') toolCount++;
    }

    const parts: string[] = [];
    if (cmdCount > 0) parts.push(cmdCount === 1 ? 'Ran command' : `Ran ${cmdCount} commands`);
    if (fileCount > 0) parts.push(fileCount === 1 ? 'Edited file' : `Edited ${fileCount} files`);
    if (searchCount > 0) parts.push(searchCount === 1 ? 'Searched web' : `${searchCount} searches`);
    if (toolCount > 0) parts.push(toolCount === 1 ? 'Used tool' : `${toolCount} tool calls`);
    if (parts.length === 0 && thinkCount > 0) parts.push('Thought');
    if (parts.length === 0) parts.push(`${blocks.length} steps`);
    return parts.join(' · ');
  }, [blocks]);

  return (
    <DisclosureRow label={summary}>
      {blocks.map((b, i) => (
        <CoalescedBlockView key={i} block={b} onOpenPath={onOpenPath} />
      ))}
    </DisclosureRow>
  );
});

function parseFileLinkHref(
  href: string
): { filePath: string; startLine?: number; endLine?: number } | null {
  if (!href.startsWith('file://')) return null;
  try {
    const u = new URL(href);
    const filePath = decodeURIComponent(u.pathname);
    let startLine: number | undefined;
    let endLine: number | undefined;
    const hash = u.hash.replace(/^#/, '');
    const m = hash.match(/^L(\d+)(?:-L?(\d+))?$/i);
    if (m) {
      startLine = Number(m[1]);
      endLine = m[2] ? Number(m[2]) : startLine;
    }
    return { filePath, startLine, endLine };
  } catch {
    return null;
  }
}

interface AgentEmbedFrameProps {
  filePath: string;
  title: string;
  onOpenPath?: (filePath: string) => void;
}

const AgentEmbedFrame: React.FC<AgentEmbedFrameProps> = React.memo(
  ({ filePath, title, onOpenPath }) => {
    const token = useMemo(
      () => `emb-${Math.random().toString(36).slice(2, 10)}`,
      [filePath]
    );
    const [height, setHeight] = useState(340);
    const [reloadKey, setReloadKey] = useState(0);

    useEffect(() => {
      const onMessage = (ev: MessageEvent) => {
        const data = ev.data as
          | { type?: string; token?: string; height?: number; text?: string }
          | null;
        if (!data || data.token !== token) return;
        if (data.type === 'sh-embed-resize' && typeof data.height === 'number') {
          const clamped = Math.max(96, Math.min(760, Math.ceil(data.height) + 4));
          setHeight(clamped);
        } else if (data.type === 'sh-embed-copy' && typeof data.text === 'string') {
          void navigator.clipboard?.writeText(data.text).catch(() => {});
        }
      };
      window.addEventListener('message', onMessage);
      return () => window.removeEventListener('message', onMessage);
    }, [token]);

    const src = useMemo(
      () => `${embedUrlForPath(filePath, token)}&r=${reloadKey}`,
      [filePath, token, reloadKey]
    );

    return (
      <div className="my-2.5 rounded-xl border border-line-hairline bg-surface-subtle/40 overflow-hidden">
        <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-line-hairline bg-surface-subtle/60 text-micro text-ink-faint">
          <div className="flex items-center gap-1.5 min-w-0">
            <Globe className="w-3 h-3 shrink-0 text-ink-muted" />
            <span className="truncate font-mono">{title}</span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              title="Reload preview"
              className="p-1 rounded hover:bg-white/5 hover:text-ink-primary transition-colors cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" />
            </button>
            {onOpenPath && (
              <button
                type="button"
                onClick={() => onOpenPath(filePath)}
                title="Open HTML source"
                className="px-1.5 py-0.5 rounded hover:bg-white/5 hover:text-ink-primary transition-colors cursor-pointer"
              >
                Source
              </button>
            )}
          </div>
        </div>
        <iframe
          key={reloadKey}
          src={src}
          title={title}
          sandbox="allow-scripts"
          style={{ height }}
          className="w-full border-0 block bg-transparent"
        />
      </div>
    );
  }
);

interface Props {
  block: UnifiedBlock;
  onQuickReply?: (text: string) => void;
  onOpenPath?: (filePath: string, opts?: { startLine?: number; endLine?: number }) => void;
  onPreviewImage?: (images: PreviewImageItem[], index: number) => void;
}

export const CoalescedBlockView: React.FC<Props> = React.memo(
  ({ block, onQuickReply, onOpenPath, onPreviewImage }) => {
  const [imageBroken, setImageBroken] = useState(false);
  const textContent = block.type === 'text' ? block.text : '';
  const textSegments = useMemo(() => {
    if (!textContent) return [];
    return splitAgentEmbeds(textContent);
  }, [textContent]);
  const renderedHtml = useMemo(() => {
    if (!textContent) return '';
    if (textSegments.length === 1 && textSegments[0].kind === 'markdown') {
      return renderMarkdownHtml(textSegments[0].text);
    }
    return '';
  }, [textContent, textSegments]);

  const handleMarkdownClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement | null)?.closest('a');
    if (!anchor) return;
    const href = anchor.getAttribute('href') || '';
    if (!href) return;
    e.preventDefault();
    e.stopPropagation();

    const parsedFile = parseFileLinkHref(href);
    if (parsedFile) {
      onOpenPath?.(parsedFile.filePath, {
        startLine: parsedFile.startLine,
        endLine: parsedFile.endLine,
      });
      return;
    }
    if (href.startsWith('http://') || href.startsWith('https://')) {
      void window.superHarness.openExternalUrl(href);
    }
  };

  if (block.type === 'text') {
    if (textSegments.length === 1 && textSegments[0].kind === 'markdown') {
      return (
        <div
          className="sh-markdown"
          onClick={handleMarkdownClick}
          dangerouslySetInnerHTML={{ __html: renderedHtml }}
        />
      );
    }
    return (
      <div className="space-y-2">
        {textSegments.map((seg, i) =>
          seg.kind === 'embed' ? (
            <AgentEmbedFrame
              key={`${seg.filePath}-${i}`}
              filePath={seg.filePath}
              title={seg.title}
              onOpenPath={onOpenPath}
            />
          ) : (
            <div
              key={i}
              className="sh-markdown"
              onClick={handleMarkdownClick}
              dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(seg.text) }}
            />
          )
        )}
      </div>
    );
  }

  if (block.type === 'image') {
    const src = block.dataUrl || mediaUrlForPath(block.path);
    if (imageBroken) {
      return (
        <div className="my-1.5 inline-flex items-center gap-2 rounded-xl border border-line-hairline bg-surface-subtle/60 px-3 py-2 text-caption text-ink-faint">
          <ImageOff className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate max-w-[260px]">{block.name || 'Image unavailable'}</span>
        </div>
      );
    }
    return (
      <div className="my-1.5">
        <button
          type="button"
          onClick={() =>
            onPreviewImage?.([{ src, name: block.name, path: block.path }], 0)
          }
          title={block.name ? `Preview ${block.name}` : 'Preview image'}
          className="inline-block rounded-xl overflow-hidden border border-line-subtle hover:border-line-strong hover:brightness-110 transition-all cursor-pointer bg-black/40"
        >
          <img
            src={src}
            alt={block.name || 'Attached image'}
            loading="lazy"
            decoding="async"
            onError={() => setImageBroken(true)}
            className="h-20 w-auto max-w-[144px] object-cover block"
          />
        </button>
      </div>
    );
  }

  if (block.type === 'video') {
    const src = mediaUrlForPath(block.path);
    const label = block.name || block.path.split('/').pop() || 'Video attachment';
    return (
      <div className="my-2 max-w-md rounded-xl overflow-hidden border border-line-subtle bg-black/50">
        <video
          src={src}
          controls
          preload="metadata"
          playsInline
          className="w-full max-h-72 block bg-black"
        />
        <div className="px-3 py-1.5 text-micro text-ink-muted truncate border-t border-line-hairline">
          {label}
        </div>
      </div>
    );
  }

  if (block.type === 'question') {
    const isAnswered =
      Boolean(block.answered) || block.questions.some((q) => Boolean(q.answer));

    if (isAnswered) {
      return (
        <div className="my-3 rounded-xl border border-line-hairline bg-surface-subtle/60 overflow-hidden">
          <div className="px-4 py-2.5 flex items-center justify-between gap-2 border-b border-line-hairline">
            <div className="flex items-center gap-1.5 text-caption text-ink-muted">
              <HelpCircle className="w-3.5 h-3.5 text-ink-faint shrink-0" />
              <span>
                {block.questions.length} {block.questions.length === 1 ? 'question' : 'questions'}
              </span>
            </div>
            <Badge tone="success" icon={<Check className="w-2.5 h-2.5" />}>
              Answered
            </Badge>
          </div>
          <div className="divide-y divide-line-hairline">
            {block.questions.map((q, qi) => (
              <div key={qi} className="px-4 py-3 space-y-1">
                <div className="text-label font-medium text-ink-primary">{q.question}</div>
                <div className="text-body text-ink-secondary">
                  {q.answer || <span className="text-ink-faint italic">Answered</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      );
    }

    return (
      <div className="my-3 rounded-xl border border-line-subtle bg-surface-subtle/60 p-4 space-y-3.5">
        <div className="flex items-center gap-1.5 text-caption text-ink-muted">
          <HelpCircle className="w-3.5 h-3.5 text-ink-faint shrink-0" />
          <span>
            {block.questions.length} {block.questions.length === 1 ? 'question' : 'questions'}
          </span>
        </div>
        <div className="space-y-3.5">
          {block.questions.map((q, qi) => (
            <div key={qi} className="space-y-1.5">
              <div className="text-label font-medium text-ink-primary">{q.question}</div>
              {q.options.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-0.5">
                  {q.options.map((opt, oi) => (
                    <Button
                      key={oi}
                      size="sm"
                      variant="secondary"
                      onClick={() => onQuickReply?.(`${q.question}: ${opt}`)}
                      className="text-left font-normal"
                    >
                      {opt}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (block.type === 'thinking') {
    const preview = (block.summary || block.text).replace(/\s+/g, ' ').slice(0, 90);
    return (
      <CollapsibleCard
        variant="subtle"
        title="Thought"
        preview={preview}
        bodyClassName="max-h-72 overflow-y-auto"
      >
        <div className="text-caption text-ink-muted whitespace-pre-wrap font-mono leading-relaxed">
          {block.text}
        </div>
      </CollapsibleCard>
    );
  }

  if (block.type === 'command') {
    return (
      <CollapsibleCard
        variant="recessed"
        icon={<Terminal className="w-3 h-3 text-ink-faint" />}
        title={<code className="font-mono font-normal text-ink-secondary">{block.command}</code>}
        meta={
          block.exitCode !== undefined && block.exitCode !== null && block.exitCode !== 0 ? (
            <Badge tone="danger" mono>
              exit {block.exitCode}
            </Badge>
          ) : undefined
        }
        bodyClassName="max-h-64 overflow-y-auto"
      >
        <pre className="text-micro text-ink-muted font-mono whitespace-pre-wrap break-all">
          {block.output?.trim() || '(no output)'}
        </pre>
      </CollapsibleCard>
    );
  }

  if (block.type === 'file_change') {
    const label =
      block.changes.length === 1
        ? block.changes[0].path
        : `${block.changes.length} files modified`;
    return (
      <CollapsibleCard
        variant="recessed"
        icon={<FileCode2 className="w-3 h-3 text-ink-faint" />}
        title={<span className="font-mono font-normal text-ink-secondary">{label}</span>}
        bodyClassName="space-y-2 max-h-72 overflow-y-auto"
      >
        {block.changes.map((ch, idx) => (
          <div key={idx} className="space-y-1">
            <button
              type="button"
              onClick={() => onOpenPath?.(ch.path)}
              className="text-micro font-mono text-ink-secondary hover:text-brand-antigravity hover:underline truncate block text-left cursor-pointer"
            >
              {ch.path}
            </button>
            {ch.diff && (
              <pre className="text-micro font-mono bg-black/30 p-2 rounded overflow-x-auto leading-relaxed">
                {ch.diff.split('\n').map((line, i) => {
                  const cls = line.startsWith('+')
                    ? 'text-emerald-300/90 block'
                    : line.startsWith('-')
                      ? 'text-rose-300/90 block'
                      : 'text-ink-faint block';
                  return (
                    <span key={i} className={cls}>
                      {line}
                    </span>
                  );
                })}
              </pre>
            )}
          </div>
        ))}
      </CollapsibleCard>
    );
  }

  if (block.type === 'tool_call') {
    return (
      <CollapsibleCard
        variant="recessed"
        icon={<Wrench className="w-3 h-3 text-ink-faint" />}
        title={
          <span className="font-mono font-normal text-ink-secondary">
            {block.server ? `${block.server}.` : ''}
            {block.name}
          </span>
        }
        bodyClassName="space-y-2 max-h-64 overflow-y-auto"
      >
        {block.args && (
          <pre className="text-micro font-mono text-ink-muted whitespace-pre-wrap break-all">
            {block.args}
          </pre>
        )}
        {block.output && (
          <pre className="text-micro font-mono text-ink-secondary border-t border-line-hairline pt-2 whitespace-pre-wrap break-all">
            {block.output}
          </pre>
        )}
      </CollapsibleCard>
    );
  }

  if (block.type === 'web_search') {
    return (
      <div className="inline-flex items-center gap-1.5 text-caption text-ink-muted px-1 py-0.5">
        <Globe className="w-3 h-3 text-ink-faint shrink-0" />
        <span className="truncate max-w-md">{block.query}</span>
      </div>
    );
  }

  return (
    <div className="text-caption text-ink-faint px-1 py-0.5">
      {block.title}
      {block.detail ? ` — ${block.detail}` : ''}
    </div>
  );
});

interface UserMessageClassification {
  kind: MessageSourceKind | 'long_human';
  label: string;
  preview: string;
  sizeLabel: string;
  senderName?: string;
}

function formatSizeBadge(charCount: number, lineCount: number): string {
  if (charCount >= 1000) return `${(charCount / 1000).toFixed(1)}k chars`;
  if (lineCount > 1) return `${lineCount} lines`;
  return `${charCount} chars`;
}

function extractReadablePreview(text: string): string {
  const summaryTag = text.match(/<summary>([\s\S]*?)<\/summary>/i);
  if (summaryTag?.[1]) {
    return summaryTag[1].replace(/\s+/g, ' ').trim().slice(0, 120);
  }
  const stripped = text
    .replace(/^Another Claude session sent a message:\s*/i, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.slice(0, 120);
}

function classifyUserMessage(msg: UnifiedMessage): UserMessageClassification {
  const fullText = msg.blocks
    .filter((b): b is Extract<UnifiedBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  const charCount = fullText.length;
  const lineCount = fullText ? fullText.split('\n').length : 0;
  const sizeLabel = formatSizeBadge(charCount, lineCount);
  const preview = extractReadablePreview(fullText);
  const metaKind = msg.harnessMeta?.sourceKind;
  let senderName = msg.harnessMeta?.senderName;

  if (!senderName) {
    const m =
      fullText.match(/<cross-session-message[^>]*\bname="([^"]+)"/i) ||
      fullText.match(/<teammate-message[^>]*\bteammate_id="([^"]+)"/i) ||
      fullText.match(/\bsender=([^\s\]]+)/i);
    if (m?.[1]) senderName = m[1];
  }

  if (
    metaKind === 'compaction' ||
    /^This session is being continued from a previous conversation/i.test(fullText) ||
    /^<CONTEXT_SUMMARY>/i.test(fullText) ||
    /^Continuing .* conversation "/i.test(fullText)
  ) {
    return { kind: 'compaction', label: 'Compacted conversation summary', preview, sizeLabel };
  }

  if (
    metaKind === 'agent' ||
    /<cross-session-message\b/i.test(fullText) ||
    /<teammate-message\b/i.test(fullText) ||
    /<subagent[_-]notification\b/i.test(fullText) ||
    /^Another (?:Claude|Codex|agent|session)\b.*sent a message:/i.test(fullText) ||
    (/^\[Message\]/i.test(fullText) && /\bsender=/i.test(fullText)) ||
    (/<SYSTEM_MESSAGE>/i.test(fullText) && /\bsender=/i.test(fullText)) ||
    (charCount > 450 &&
      /^(?:You are (?:"[^"]+"|the |an? )|Human Interface\s*\()/i.test(fullText))
  ) {
    return {
      kind: 'agent',
      label: senderName ? `From agent · ${senderName}` : 'Message from another agent',
      preview,
      sizeLabel,
      senderName,
    };
  }

  if (
    metaKind === 'task' ||
    /^<task-notification\b/i.test(fullText) ||
    (/<SYSTEM_MESSAGE>/i.test(fullText) && /Task id/i.test(fullText))
  ) {
    return { kind: 'task', label: 'Task notification', preview, sizeLabel };
  }

  if (
    metaKind === 'system_meta' ||
    /^# AGENTS\.md instructions/i.test(fullText) ||
    /^<(?:INSTRUCTIONS|environment_context|local-command-caveat|turn_aborted|system-reminder)\b/i.test(
      fullText
    ) ||
    /^\[Image:\s*(?:source:|original )/i.test(fullText)
  ) {
    const label = /^# AGENTS\.md instructions/i.test(fullText)
      ? 'AGENTS.md instructions'
      : /^<environment_context/i.test(fullText)
        ? 'Environment context'
        : 'Context note';
    return { kind: 'system_meta', label, preview, sizeLabel };
  }

  if (charCount > 480 || lineCount > 8) {
    return { kind: 'long_human', label: 'Long message', preview, sizeLabel };
  }

  return { kind: 'human', label: '', preview, sizeLabel };
}

interface UserMessageViewProps {
  msg: UnifiedMessage;
  onOpenPath?: (filePath: string, opts?: { startLine?: number; endLine?: number }) => void;
  onPreviewImage?: (images: PreviewImageItem[], index: number) => void;
  onRetryFailed?: (msg: UnifiedMessage) => void;
  onDismissFailed?: (msgId: string) => void;
}

export const UserMessageView: React.FC<UserMessageViewProps> = React.memo(
  ({ msg, onOpenPath, onPreviewImage, onRetryFailed, onDismissFailed }) => {
    const [expanded, setExpanded] = useState(false);
    const [showErrorDetail, setShowErrorDetail] = useState(true);
    const [brokenThumbs, setBrokenThumbs] = useState<Record<string, boolean>>({});
    const [activeVideo, setActiveVideo] = useState<{ src: string; name: string } | null>(null);
    const info = useMemo(() => classifyUserMessage(msg), [msg]);

    useEffect(() => {
      if (!activeVideo) return;
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') setActiveVideo(null);
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [activeVideo]);

    const imageBlocks = useMemo(
      () =>
        msg.blocks.filter(
          (b): b is Extract<UnifiedBlock, { type: 'image' }> => b.type === 'image'
        ),
      [msg.blocks]
    );
    const videoBlocks = useMemo(
      () =>
        msg.blocks.filter(
          (b): b is Extract<UnifiedBlock, { type: 'video' }> => b.type === 'video'
        ),
      [msg.blocks]
    );
    const nonImageBlocks = useMemo(
      () => msg.blocks.filter((b) => b.type !== 'image' && b.type !== 'video'),
      [msg.blocks]
    );
    const previewItems = useMemo<PreviewImageItem[]>(
      () =>
        imageBlocks.map((b) => ({
          src: b.dataUrl || mediaUrlForPath(b.path),
          name: b.name,
          path: b.path,
        })),
      [imageBlocks]
    );

    const renderThumbnailStrip = () =>
      previewItems.length > 0 || videoBlocks.length > 0 ? (
        <div className="flex flex-wrap justify-end items-center gap-2 max-w-[82%]">
          {videoBlocks.map((vb, idx) => {
            const name = vb.name || vb.path.split('/').pop() || 'Recording.mp4';
            const extMatch = name.match(/\.([a-z0-9]+)$/i);
            const extTag = (extMatch ? extMatch[1] : 'MP4').toUpperCase().slice(0, 4);
            const src = mediaUrlForPath(vb.path);
            return (
              <button
                key={`${vb.path}-${idx}`}
                type="button"
                onClick={() => setActiveVideo({ src, name })}
                title={`Play ${name}`}
                className="group inline-flex items-center gap-2.5 h-12 max-w-[260px] px-3 rounded-xl border border-line-subtle bg-surface-subtle hover:bg-surface-overlay hover:border-line-strong transition-colors shrink-0 cursor-pointer focus:outline-none focus-visible:shadow-none"
              >
                <span className="inline-flex items-center justify-center px-1.5 h-6 min-w-[34px] rounded-md bg-slate-500/25 border border-slate-400/25 text-[10px] font-bold tracking-wide text-slate-200 shrink-0">
                  {extTag}
                </span>
                <span className="text-caption font-medium text-ink-primary truncate leading-[1.35] pt-[1px]">
                  {name}
                </span>
                <Play className="w-3.5 h-3.5 text-ink-muted group-hover:text-ink-primary shrink-0 transition-colors" />
              </button>
            );
          })}
          {previewItems.map((img, idx) => {
            const thumbKey = `${img.src}-${idx}`;
            if (brokenThumbs[thumbKey]) {
              return (
                <div
                  key={thumbKey}
                  title={img.name ? `${img.name} (file moved or removed)` : 'Image unavailable'}
                  className="w-[72px] h-[72px] rounded-xl border border-line-hairline bg-surface-subtle/60 flex flex-col items-center justify-center gap-1 px-1.5 text-ink-faint shrink-0"
                >
                  <ImageOff className="w-4 h-4 shrink-0" />
                  <span className="text-[10px] leading-tight truncate max-w-full">
                    {img.name || 'Missing'}
                  </span>
                </div>
              );
            }
            return (
              <button
                key={thumbKey}
                type="button"
                onClick={() => onPreviewImage?.(previewItems, idx)}
                title={img.name ? `Preview ${img.name}` : 'Preview image'}
                className="group relative w-[72px] h-[72px] rounded-xl overflow-hidden border border-line-subtle bg-black/40 hover:border-line-strong hover:brightness-110 transition-all shrink-0 cursor-pointer"
              >
                <img
                  src={img.src}
                  alt={img.name || `Attachment ${idx + 1}`}
                  loading="lazy"
                  decoding="async"
                  onError={() =>
                    setBrokenThumbs((prev) => (prev[thumbKey] ? prev : { ...prev, [thumbKey]: true }))
                  }
                  className="w-full h-full object-cover"
                />
              </button>
            );
          })}
          {activeVideo &&
            createPortal(
              <div
                role="dialog"
                aria-modal="true"
                aria-label={activeVideo.name}
                onClick={() => setActiveVideo(null)}
                className="sh-no-drag fixed inset-0 z-[100] bg-black/88 backdrop-blur-md flex flex-col items-center justify-center p-6 select-none"
              >
                <div
                  onClick={(e) => e.stopPropagation()}
                  className="w-full max-w-4xl rounded-2xl border border-line-subtle bg-surface-canvas overflow-hidden shadow-2xl"
                >
                  <div className="h-12 px-4 border-b border-line-hairline flex items-center justify-between gap-3">
                    <span className="text-label font-medium text-ink-primary truncate">
                      {activeVideo.name}
                    </span>
                    <button
                      type="button"
                      onClick={() => setActiveVideo(null)}
                      aria-label="Close video preview"
                      className="w-8 h-8 rounded-lg flex items-center justify-center text-ink-muted hover:text-ink-primary hover:bg-white/[0.08] cursor-pointer focus:outline-none focus-visible:shadow-none"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  <video
                    src={activeVideo.src}
                    controls
                    autoPlay
                    playsInline
                    className="w-full max-h-[78vh] bg-black block"
                  />
                </div>
              </div>,
              document.body
            )}
        </div>
      ) : null;

    if (
      info.kind === 'agent' ||
      info.kind === 'compaction' ||
      info.kind === 'task' ||
      info.kind === 'system_meta'
    ) {
      const Icon =
        info.kind === 'agent'
          ? Bot
          : info.kind === 'compaction'
            ? History
            : info.kind === 'task'
              ? Bell
              : FileText;

      const iconClass =
        info.kind === 'agent'
          ? 'text-indigo-300/80'
          : info.kind === 'compaction'
            ? 'text-status-warning/80'
            : 'text-ink-faint';

      const fullRawText = msg.blocks
        .filter((b): b is Extract<UnifiedBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();

      const parsedTask = info.kind === 'task' ? parseTaskNotification(fullRawText) : null;
      const nonTextBlocks = msg.blocks.filter((b) => b.type !== 'text');

      const taskStatusTone =
        parsedTask?.status === 'completed' || parsedTask?.status === 'done'
          ? 'success'
          : parsedTask?.status === 'failed' || parsedTask?.status === 'error'
            ? 'danger'
            : parsedTask?.status === 'stopped' || parsedTask?.status === 'killed'
              ? 'warning'
              : 'neutral';

      const handleSystemMarkdownClick = (e: React.MouseEvent<HTMLDivElement>) => {
        const anchor = (e.target as HTMLElement | null)?.closest('a');
        if (!anchor) return;
        const href = anchor.getAttribute('href') || '';
        if (!href) return;
        e.preventDefault();
        e.stopPropagation();
        const parsedFile = parseFileLinkHref(href);
        if (parsedFile) {
          onOpenPath?.(parsedFile.filePath, {
            startLine: parsedFile.startLine,
            endLine: parsedFile.endLine,
          });
          return;
        }
        if (href.startsWith('http://') || href.startsWith('https://')) {
          void window.superHarness.openExternalUrl(href);
        }
      };

      return (
        <CollapsibleCard
          icon={<Icon className={`w-3.5 h-3.5 ${iconClass}`} />}
          title={info.label}
          preview={
            parsedTask
              ? (parsedTask.summary || parsedTask.result || info.preview)
                  .replace(/^[-*•]\s+/, '')
                  .replace(/\s+/g, ' ')
                  .slice(0, 96)
              : info.preview
          }
          meta={info.sizeLabel}
          bodyClassName="text-caption text-ink-secondary space-y-2.5 max-h-[520px] overflow-y-auto px-4 py-3"
        >
          {parsedTask ? (
            <div className="space-y-2.5" onClick={handleSystemMarkdownClick}>
              {(parsedTask.status || parsedTask.taskIds.length > 0 || parsedTask.outputFile) && (
                <div className="flex flex-wrap items-center gap-1.5 pb-1.5 border-b border-line-hairline/70">
                  {parsedTask.status && (
                    <Badge tone={taskStatusTone}>{parsedTask.status}</Badge>
                  )}
                  {parsedTask.taskIds.map((tid) => (
                    <span
                      key={tid}
                      className="inline-flex items-center px-1.5 py-0.5 rounded bg-white/[0.05] border border-line-hairline text-micro font-mono text-ink-muted"
                    >
                      {tid}
                    </span>
                  ))}
                  {parsedTask.outputFile && (
                    <button
                      type="button"
                      onClick={() => onOpenPath?.(parsedTask.outputFile!)}
                      className="ml-auto inline-flex items-center gap-1 text-micro font-mono text-ink-muted hover:text-ink-primary transition-colors cursor-pointer truncate max-w-[260px]"
                      title={parsedTask.outputFile}
                    >
                      <FileText className="w-3 h-3 shrink-0" />
                      <span className="truncate">
                        {parsedTask.outputFile.split('/').pop() || parsedTask.outputFile}
                      </span>
                    </button>
                  )}
                </div>
              )}

              {parsedTask.summary && (
                <div
                  className="sh-markdown sh-markdown-compact"
                  dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(parsedTask.summary) }}
                />
              )}

              {parsedTask.result && (
                <div
                  className="sh-markdown sh-markdown-compact"
                  dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(parsedTask.result) }}
                />
              )}

              {parsedTask.extraText && (
                <div
                  className="sh-markdown sh-markdown-compact text-ink-muted"
                  dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(parsedTask.extraText) }}
                />
              )}

              {nonTextBlocks.map((b, i) => (
                <CoalescedBlockView
                  key={i}
                  block={b}
                  onOpenPath={onOpenPath}
                  onPreviewImage={onPreviewImage}
                />
              ))}
            </div>
          ) : (
            <div className="space-y-2" onClick={handleSystemMarkdownClick}>
              {msg.blocks.map((b, i) =>
                b.type === 'text' ? (
                  <div
                    key={i}
                    className="sh-markdown sh-markdown-compact"
                    dangerouslySetInnerHTML={{
                      __html: renderMarkdownHtml(unwrapSystemEnvelope(b.text)),
                    }}
                  />
                ) : (
                  <CoalescedBlockView
                    key={i}
                    block={b}
                    onOpenPath={onOpenPath}
                    onPreviewImage={onPreviewImage}
                  />
                )
              )}
            </div>
          )}
        </CollapsibleCard>
      );
    }

    const renderFailedBadge = () =>
      msg.error ? (
        <button
          type="button"
          onClick={() => setShowErrorDetail((v) => !v)}
          title={msg.error}
          aria-label={`Message failed to send: ${msg.error}`}
          className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-rose-400 hover:text-rose-300 hover:bg-rose-500/15 transition-colors cursor-pointer"
        >
          <AlertCircle className="w-4 h-4" />
        </button>
      ) : null;

    const renderFailedFooter = () =>
      msg.error ? (
        <div className="flex flex-col items-end gap-1 max-w-[82%]">
          <div className="flex items-center gap-2 text-micro text-rose-300/90">
            <button
              type="button"
              onClick={() => setShowErrorDetail((v) => !v)}
              className="hover:text-rose-200 transition-colors cursor-pointer"
            >
              Not delivered
            </button>
            {onRetryFailed && (
              <>
                <span className="text-ink-faint">·</span>
                <button
                  type="button"
                  onClick={() => onRetryFailed(msg)}
                  className="inline-flex items-center gap-1 text-ink-secondary hover:text-ink-primary transition-colors cursor-pointer"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>Retry</span>
                </button>
              </>
            )}
            {onDismissFailed && (
              <>
                <span className="text-ink-faint">·</span>
                <button
                  type="button"
                  onClick={() => onDismissFailed(msg.id)}
                  className="text-ink-faint hover:text-ink-secondary transition-colors cursor-pointer"
                >
                  Dismiss
                </button>
              </>
            )}
          </div>
          {showErrorDetail && (
            <div className="rounded-lg border border-rose-500/25 bg-rose-500/[0.06] px-3 py-1.5 text-micro font-mono text-rose-300/90 break-words max-w-full">
              {msg.error}
            </div>
          )}
        </div>
      ) : null;

    if (info.kind === 'long_human') {
      const previewSnippet = nonImageBlocks
        .filter((b): b is Extract<UnifiedBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim()
        .slice(0, 420);

      return (
        <div className="flex flex-col items-end gap-1.5">
          {renderThumbnailStrip()}
          {nonImageBlocks.length > 0 && (
            <div className="flex items-center justify-end gap-2 w-full">
              {renderFailedBadge()}
              <div
                className={`max-w-[82%] rounded-2xl bg-surface-bubble px-4 py-3 text-body text-ink-primary space-y-2 ${
                  msg.error ? 'ring-1 ring-rose-500/35' : ''
                }`}
              >
                {expanded ? (
                  <>
                    <div className="space-y-2">
                      {nonImageBlocks.map((b, i) => (
                        <CoalescedBlockView
                          key={i}
                          block={b}
                          onOpenPath={onOpenPath}
                          onPreviewImage={onPreviewImage}
                        />
                      ))}
                    </div>
                    <div className="pt-1 flex justify-end border-t border-line-hairline">
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => setExpanded(false)}
                        iconLeft={<ChevronUp className="w-3.5 h-3.5" />}
                      >
                        Collapse
                      </Button>
                    </div>
                  </>
                ) : (
                  <div className="space-y-2">
                    <div className="relative max-h-20 overflow-hidden">
                      <div className="whitespace-pre-wrap text-body leading-relaxed text-ink-secondary">
                        {previewSnippet}
                      </div>
                      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-surface-bubble to-transparent" />
                    </div>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => setExpanded(true)}
                      iconLeft={<ChevronDown className="w-3.5 h-3.5" />}
                      className="-ml-2"
                    >
                      Show full message ({info.sizeLabel})
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}
          {renderFailedFooter()}
        </div>
      );
    }

    return (
      <div className="flex flex-col items-end gap-1.5">
        {renderThumbnailStrip()}
        {nonImageBlocks.length > 0 && (
          <div className="flex items-center justify-end gap-2 w-full">
            {renderFailedBadge()}
            <div
              className={`max-w-[82%] rounded-2xl bg-surface-bubble px-4 py-3 text-body text-ink-primary space-y-2 ${
                msg.error ? 'ring-1 ring-rose-500/35' : ''
              }`}
            >
              {nonImageBlocks.map((b, i) => (
                <CoalescedBlockView
                  key={i}
                  block={b}
                  onOpenPath={onOpenPath}
                  onPreviewImage={onPreviewImage}
                />
              ))}
            </div>
          </div>
        )}
        {nonImageBlocks.length === 0 && msg.error && renderFailedBadge()}
        {renderFailedFooter()}
      </div>
    );
  }
);

interface AssistantMessageViewProps {
  msg: UnifiedMessage;
  onOpenPath?: (filePath: string, opts?: { startLine?: number; endLine?: number }) => void;
  onQuickReply?: (text: string) => void;
  onPreviewImage?: (images: PreviewImageItem[], index: number) => void;
}

export const AssistantMessageView: React.FC<AssistantMessageViewProps> = React.memo(
  ({ msg, onOpenPath, onQuickReply, onPreviewImage }) => {
    const segments = useMemo(() => segmentBlocks(msg.blocks), [msg.blocks]);
    return (
      <div className="space-y-2.5">
        {segments.map((seg, idx) =>
          seg.kind === 'trace' ? (
            <CollapsedTraceGroup key={idx} blocks={seg.blocks} onOpenPath={onOpenPath} />
          ) : (
            <CoalescedBlockView
              key={idx}
              block={seg.block}
              onOpenPath={onOpenPath}
              onQuickReply={onQuickReply}
              onPreviewImage={onPreviewImage}
            />
          )
        )}
        {msg.streaming && <WorkingIndicator tone="master" />}
        {msg.error && (
          <div className="rounded-xl border border-rose-500/25 bg-rose-500/[0.06] px-3.5 py-2.5 text-caption text-rose-300 font-mono">
            {msg.error}
          </div>
        )}
      </div>
    );
  }
);
