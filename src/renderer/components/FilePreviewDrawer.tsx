import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpLeft,
  Check,
  Code2,
  Copy,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  Terminal,
  X,
} from 'lucide-react';
import type { FilePreviewData } from '../../shared/types';
import { Badge, Button, IconButton } from '../ui';
import { mediaUrlForPath, renderMarkdownHtml } from '../utils/format';

export interface PreviewTarget {
  path: string;
  startLine?: number;
  endLine?: number;
}

interface Props {
  target: PreviewTarget;
  onClose: () => void;
  onNavigate: (next: PreviewTarget) => void;
  onLaunchExternal: (
    path: string,
    mode: 'editor' | 'file-manager' | 'terminal',
    line?: number
  ) => void;
}

export const FilePreviewDrawer: React.FC<Props> = ({
  target,
  onClose,
  onNavigate,
  onLaunchExternal,
}) => {
  const [data, setData] = useState<FilePreviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [mdMode, setMdMode] = useState<'rendered' | 'source'>('rendered');
  const [copied, setCopied] = useState(false);
  const highlightRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setMdMode('rendered');
    void window.superHarness
      .readFilePreview(target.path, target.startLine, target.endLine)
      .then((res) => {
        if (!active) return;
        setData(res);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [target.path, target.startLine, target.endLine]);

  useEffect(() => {
    if (!loading && highlightRef.current) {
      highlightRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [loading, data?.path, target.startLine]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const renderedMd = useMemo(() => {
    if (data?.kind === 'markdown' && data.content) {
      return renderMarkdownHtml(data.content);
    }
    return '';
  }, [data]);

  const lines = useMemo(() => {
    if (!data?.content) return [];
    return data.content.split('\n');
  }, [data?.content]);

  const parentDir = useMemo(() => {
    const cleaned = target.path.replace(/\/+$/, '');
    const idx = cleaned.lastIndexOf('/');
    return idx > 0 ? cleaned.slice(0, idx) : '/';
  }, [target.path]);

  const handleCopy = () => {
    void navigator.clipboard.writeText(target.path);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <aside className="w-[520px] max-w-[50vw] shrink-0 h-full flex flex-col border-l border-line-subtle bg-surface-rail">
      <div className="sh-drag-region h-12 px-4 border-b border-line-hairline flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {data?.isDirectory ? (
            <Folder className="w-4 h-4 text-ink-secondary shrink-0" />
          ) : (
            <FileCode2 className="w-4 h-4 text-ink-muted shrink-0" />
          )}
          <span className="text-label font-medium text-ink-primary truncate">
            {data?.name || target.path.split('/').pop()}
          </span>
          {target.startLine && (
            <Badge mono>
              L{target.startLine}
              {target.endLine && target.endLine !== target.startLine ? `–${target.endLine}` : ''}
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          {data?.kind === 'markdown' && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setMdMode((m) => (m === 'rendered' ? 'source' : 'rendered'))}
              title={mdMode === 'rendered' ? 'View raw markdown' : 'View rendered markdown'}
            >
              {mdMode === 'rendered' ? 'Source' : 'Preview'}
            </Button>
          )}
          <IconButton
            label="Open in Default Editor"
            onClick={() => onLaunchExternal(target.path, 'editor', target.startLine)}
          >
            <Code2 className="w-3.5 h-3.5" />
          </IconButton>
          <IconButton
            label="Open in Default File Viewer"
            onClick={() =>
              onLaunchExternal(data?.isDirectory ? target.path : parentDir, 'file-manager')
            }
          >
            <FolderOpen className="w-3.5 h-3.5" />
          </IconButton>
          <IconButton
            label="Open in Default Terminal"
            onClick={() =>
              onLaunchExternal(data?.isDirectory ? target.path : parentDir, 'terminal')
            }
          >
            <Terminal className="w-3.5 h-3.5" />
          </IconButton>
          <IconButton label="Copy path" onClick={handleCopy}>
            {copied ? (
              <Check className="w-3.5 h-3.5 text-status-success" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </IconButton>
          <IconButton label="Close preview (Esc)" onClick={onClose}>
            <X className="w-4 h-4" />
          </IconButton>
        </div>
      </div>

      <div className="px-3.5 py-1.5 border-b border-line-hairline bg-surface-code flex items-center justify-between gap-2 text-micro font-mono text-ink-faint">
        <span className="truncate" title={target.path}>
          {target.path}
        </span>
        {data && !data.isDirectory && (
          <span className="shrink-0">
            {data.lineCount ? `${data.lineCount} lines · ` : ''}
            {data.sizeBytes >= 1024
              ? `${(data.sizeBytes / 1024).toFixed(1)} KB`
              : `${data.sizeBytes} B`}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-auto bg-surface-canvas/40">
        {loading ? (
          <div className="py-16 flex items-center justify-center gap-2 text-caption text-ink-faint">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading preview…
          </div>
        ) : data?.error ? (
          <div className="p-5 text-caption text-status-danger font-mono">{data.error}</div>
        ) : data?.kind === 'image' ? (
          <div className="p-5 flex items-center justify-center min-h-[260px]">
            <img
              src={mediaUrlForPath(data.path)}
              alt={data.name}
              className="max-w-full max-h-[75vh] rounded-xl border border-line-subtle object-contain bg-black/30"
            />
          </div>
        ) : data?.kind === 'directory' ? (
          <div className="p-2.5 space-y-0.5">
            {target.path !== '/' && (
              <button
                type="button"
                onClick={() => onNavigate({ path: parentDir })}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-caption text-ink-muted hover:text-ink-primary hover:bg-white/[0.05] cursor-pointer"
              >
                <ArrowUpLeft className="w-3.5 h-3.5" />
                <span>..</span>
              </button>
            )}
            {(data.entries ?? []).map((entry) => (
              <button
                key={entry.path}
                type="button"
                onClick={() => onNavigate({ path: entry.path })}
                className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-label text-ink-secondary hover:text-ink-primary hover:bg-white/[0.05] text-left cursor-pointer"
              >
                {entry.isDirectory ? (
                  <Folder className="w-3.5 h-3.5 text-ink-muted shrink-0" />
                ) : (
                  <FileText className="w-3.5 h-3.5 text-ink-faint shrink-0" />
                )}
                <span className="truncate flex-1">{entry.name}</span>
                {entry.sizeBytes !== undefined && (
                  <span className="text-micro font-mono text-ink-faint shrink-0">
                    {entry.sizeBytes >= 1024
                      ? `${(entry.sizeBytes / 1024).toFixed(1)} KB`
                      : `${entry.sizeBytes} B`}
                  </span>
                )}
              </button>
            ))}
          </div>
        ) : data?.kind === 'markdown' && mdMode === 'rendered' ? (
          <div className="sh-markdown p-5" dangerouslySetInnerHTML={{ __html: renderedMd }} />
        ) : data?.kind === 'binary' ? (
          <div className="p-8 text-center space-y-3">
            <div className="text-body text-ink-secondary">Binary file preview not available</div>
            <Button variant="secondary" onClick={() => onLaunchExternal(target.path, 'editor')}>
              Open in Default Editor
            </Button>
          </div>
        ) : (
          <div className="py-3 font-mono text-caption leading-6">
            {lines.map((line, idx) => {
              const lineNum = idx + 1;
              const isHighlighted =
                target.startLine !== undefined &&
                lineNum >= target.startLine &&
                lineNum <= (target.endLine ?? target.startLine);
              return (
                <div
                  key={lineNum}
                  ref={lineNum === target.startLine ? highlightRef : undefined}
                  className={`flex px-3 ${
                    isHighlighted
                      ? 'bg-indigo-500/20 text-ink-primary'
                      : 'text-ink-secondary hover:bg-white/[0.02]'
                  }`}
                >
                  <span className="w-11 pr-3 text-right select-none text-ink-faint shrink-0">
                    {lineNum}
                  </span>
                  <span className="whitespace-pre-wrap break-all flex-1">{line || ' '}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
};
