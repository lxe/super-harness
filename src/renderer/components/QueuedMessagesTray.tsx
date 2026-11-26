import React, { useState } from 'react';
import { ArrowRight, ChevronDown, ChevronUp, Pencil, Trash2 } from 'lucide-react';
import type { QueuedMessageItem } from '../../shared/types';
import { Badge, IconButton } from '../ui';
import { mediaUrlForPath } from '../utils/format';
import type { PreviewImageItem } from './ImageLightbox';

interface Props {
  items: QueuedMessageItem[];
  isAgentBusy?: boolean;
  harnessLabel?: string;
  onSendNow: (id: string) => void;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
  onPreviewImage?: (images: PreviewImageItem[], index: number) => void;
}

export const QueuedMessagesTray: React.FC<Props> = ({
  items,
  isAgentBusy = true,
  harnessLabel,
  onSendNow,
  onEdit,
  onRemove,
  onPreviewImage,
}) => {
  const [collapsed, setCollapsed] = useState(false);

  if (items.length === 0) return null;

  const allNative = items.every((i) => i.source === 'native');
  const subtitle =
    !isAgentBusy && allNative && harnessLabel
      ? `Held in ${harnessLabel} queue · active in ${harnessLabel} app`
      : 'Sends after agent finishes working';

  return (
    <div className="rounded-2xl border border-line-subtle bg-surface-subtle overflow-hidden">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
        className="w-full px-3.5 py-2.5 flex items-center justify-between gap-2 text-left hover:bg-white/[0.03] transition-colors cursor-pointer select-none"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-caption font-semibold text-ink-secondary leading-[1.35] pt-[1px]">
            Queued Messages
          </span>
          <Badge tone="neutral" mono>
            {items.length}
          </Badge>
          <span className="text-micro text-ink-faint leading-[1.35] pt-[1px] truncate">
            {subtitle}
          </span>
        </div>
        {collapsed ? (
          <ChevronUp className="w-3.5 h-3.5 text-ink-faint shrink-0" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5 text-ink-faint shrink-0" />
        )}
      </button>

      {!collapsed && (
        <div className="border-t border-line-hairline divide-y divide-line-hairline max-h-48 overflow-y-auto">
          {items.map((item) => {
            const itemImages: PreviewImageItem[] = (item.attachments ?? []).map((att) => ({
              src: att.previewDataUrl || mediaUrlForPath(att.path),
              name: att.name,
              path: att.path,
            }));
            return (
              <div
                key={item.id}
                className="px-3.5 py-2.5 flex items-center gap-3 hover:bg-white/[0.02] transition-colors"
              >
                {item.attachments && item.attachments.length > 0 && (
                  <div className="flex items-center gap-1 shrink-0">
                    {item.attachments.slice(0, 3).map((att, idx) => (
                      <button
                        key={att.id}
                        type="button"
                        onClick={() => onPreviewImage?.(itemImages, idx)}
                        className="rounded-md overflow-hidden border border-line-subtle bg-black/40 hover:border-white/30 transition-colors cursor-pointer"
                        title={att.name}
                      >
                        <img
                          src={att.previewDataUrl || mediaUrlForPath(att.path)}
                          alt={att.name}
                          className="w-8 h-8 object-cover block"
                        />
                      </button>
                    ))}
                  </div>
                )}

                <div className="flex-1 min-w-0">
                  <p className="text-body text-ink-primary line-clamp-2 leading-snug break-words">
                    {item.text || '(attached image)'}
                  </p>
                </div>

                {item.source === 'super-harness' ? (
                  <div className="flex items-center gap-0.5 shrink-0">
                    <IconButton
                      size="xs"
                      label="Send now"
                      onClick={() => onSendNow(item.id)}
                    >
                      <ArrowRight className="w-3.5 h-3.5" />
                    </IconButton>
                    <IconButton
                      size="xs"
                      label="Edit queued message"
                      onClick={() => onEdit(item.id)}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </IconButton>
                    <IconButton
                      size="xs"
                      tone="danger"
                      label="Delete queued message"
                      onClick={() => onRemove(item.id)}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </IconButton>
                  </div>
                ) : (
                  <Badge tone="neutral">
                    {harnessLabel ? `${harnessLabel} queue` : 'Harness queue'}
                  </Badge>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
