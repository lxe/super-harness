import { describe, expect, it } from 'vitest';
import {
  formatPromptWithImagePaths,
  moveFileAttachmentsIntoPrompt,
} from '../src/main/adapters/types';
import type { ImageAttachment } from '../src/shared/types';

const img: ImageAttachment = { id: '1', name: 'a.png', path: '/tmp/a.png', mimeType: 'image/png' };
const pdf: ImageAttachment = {
  id: '2',
  name: 'spec.pdf',
  path: '/home/u/spec.pdf',
  mimeType: 'application/pdf',
};

describe('file attachments', () => {
  it('leaves image-only sends untouched', () => {
    const out = moveFileAttachmentsIntoPrompt('hi', [img]);
    expect(out).toEqual({ prompt: 'hi', attachments: [img] });
  });

  it('moves non-image files into the prompt and keeps images as attachments', () => {
    const out = moveFileAttachmentsIntoPrompt('summarize', [img, pdf]);
    expect(out.prompt).toBe('[Attached file: /home/u/spec.pdf]\n\nsummarize');
    expect(out.attachments).toEqual([img]);
  });

  it('drops the attachment list when only files were attached', () => {
    const out = moveFileAttachmentsIntoPrompt('', [pdf]);
    expect(out.prompt).toBe('[Attached file: /home/u/spec.pdf]\n\nPlease look at the attached file(s).');
    expect(out.attachments).toBeUndefined();
  });

  it('labels each path by type when formatting refs', () => {
    expect(formatPromptWithImagePaths('x', [img, pdf])).toBe(
      '[Attached image: /tmp/a.png]\n[Attached file: /home/u/spec.pdf]\n\nx'
    );
  });
});
