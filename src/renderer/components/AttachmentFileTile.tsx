import React from 'react';
import { FileText } from 'lucide-react';
import type { ImageAttachment } from '../../shared/types';
import { fileExtensionLabel } from '../utils/attachments';

/** Square tile for a non-image attachment: file icon, type label, full path on hover. */
export const AttachmentFileTile: React.FC<{ attachment: ImageAttachment; className?: string }> = ({
  attachment,
  className,
}) => (
  <div
    title={attachment.path}
    className={`w-full h-full flex flex-col items-center justify-center gap-0.5 bg-surface-code text-ink-muted ${className ?? ''}`}
  >
    <FileText className="w-4 h-4 shrink-0" strokeWidth={1.75} />
    <span className="text-[9px] font-semibold tracking-wide leading-none">
      {fileExtensionLabel(attachment.name)}
    </span>
  </div>
);
