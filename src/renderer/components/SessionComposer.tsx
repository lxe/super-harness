import React, { useEffect, useState } from 'react';
import { ArrowUp, ImagePlus, Loader2, Square, X } from 'lucide-react';
import type { ImageAttachment, UnifiedSession } from '../../shared/types';
import { IconButton } from '../ui';
import { getHarnessVisual, mediaUrlForPath } from '../utils/format';
import { HarnessLogo } from './HarnessLogo';
import type { PreviewImageItem } from './ImageLightbox';

export interface SessionComposerProps {
  session: UnifiedSession;
  isMaster: boolean;
  input: string;
  attachments: ImageAttachment[];
  sending: boolean;
  isStreaming: boolean;
  isAgentBusy: boolean;
  dispatchNote: string | null;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onInputChange: (next: string) => void;
  onRemoveAttachment: (id: string) => void;
  onPreviewImage?: (images: PreviewImageItem[], index: number) => void;
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  onDropFiles: (files: FileList) => void;
  onPickImages: () => void;
  onSend: () => void;
  onAbort: () => void;
}

/**
 * Borderless obsidian chat composer with auto-grow textarea, drag/paste image
 * attachments, harness/model metadata, stop control, and queue-aware send button.
 */
export const SessionComposer: React.FC<SessionComposerProps> = React.memo(
  ({
    session,
    isMaster,
    input,
    attachments,
    sending,
    isStreaming,
    isAgentBusy,
    dispatchNote,
    textareaRef,
    onInputChange,
    onRemoveAttachment,
    onPreviewImage,
    onPaste,
    onDropFiles,
    onPickImages,
    onSend,
    onAbort,
  }) => {
    const [dragOver, setDragOver] = useState(false);

    // Auto-grow composer textarea smoothly up to 240px
    useEffect(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = `${Math.min(Math.max(el.scrollHeight, 44), 240)}px`;
    }, [input, session.id, textareaRef]);

    const vis = getHarnessVisual(session.harness);

    return (
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer?.files?.length) {
            onDropFiles(e.dataTransfer.files);
          }
        }}
        className={`rounded-2xl border bg-surface-subtle transition-colors overflow-hidden ${
          dragOver
            ? 'border-line-strong bg-surface-raised'
            : 'border-line-subtle focus-within:border-line-strong'
        }`}
      >
        {attachments.length > 0 && (
          <div className="px-3.5 pt-3 pb-1 flex items-center gap-2 flex-wrap">
            {attachments.map((att, idx) => (
              <div
                key={att.id}
                className="relative group w-14 h-14 rounded-xl overflow-hidden border border-line-subtle hover:border-line-strong bg-black/40 transition-colors"
              >
                <button
                  type="button"
                  onClick={() =>
                    onPreviewImage?.(
                      attachments.map((a) => ({
                        src: a.previewDataUrl || mediaUrlForPath(a.path),
                        name: a.name,
                        path: a.path,
                      })),
                      idx
                    )
                  }
                  title={`Preview ${att.name}`}
                  className="w-full h-full block cursor-pointer"
                >
                  <img
                    src={att.previewDataUrl}
                    alt={att.name}
                    className="w-full h-full object-cover hover:brightness-110 transition-all"
                  />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveAttachment(att.id);
                  }}
                  title="Remove image"
                  aria-label="Remove image"
                  className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/80 text-ink-primary flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={textareaRef}
          rows={2}
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          placeholder={
            isMaster
              ? 'Ask Master Orchestrator anything, or type /status, /auto-organize…'
              : 'Ask anything, paste screenshots (Ctrl+V)…'
          }
          className="w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-body text-ink-primary placeholder:text-ink-faint focus:outline-none focus-visible:shadow-none max-h-60 overflow-y-auto leading-relaxed"
        />

        <div className="px-3 pb-2.5 pt-0.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <IconButton label="Attach image (or Ctrl+V to paste)" onClick={onPickImages}>
              <ImagePlus className="w-4 h-4" />
            </IconButton>
            <HarnessLogo harness={session.harness} size={14} />
            <span className="text-caption text-ink-muted truncate">
              {session.model || vis.label}
              {dispatchNote ? ` · ${dispatchNote}` : ''}
            </span>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {(isStreaming || isAgentBusy) && (isMaster || (!input.trim() && attachments.length === 0)) ? (
              <button
                type="button"
                onClick={onAbort}
                title="Stop"
                aria-label="Stop"
                className="w-7 h-7 rounded-full bg-ink-primary text-surface-rail flex items-center justify-center hover:bg-white transition-all cursor-pointer"
              >
                <Square className="w-3 h-3 fill-current" />
              </button>
            ) : (
              <button
                type="button"
                disabled={sending || (!input.trim() && attachments.length === 0)}
                onClick={onSend}
                title={isAgentBusy ? 'Queue message (sends after agent finishes)' : 'Send (Enter)'}
                aria-label={isAgentBusy ? 'Queue message' : 'Send'}
                className="w-7 h-7 rounded-full bg-ink-primary text-surface-rail flex items-center justify-center hover:bg-white disabled:opacity-25 disabled:cursor-not-allowed transition-all cursor-pointer"
              >
                {sending ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <ArrowUp className="w-4 h-4" />
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
);
