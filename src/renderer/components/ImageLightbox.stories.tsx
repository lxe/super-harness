import type { Meta, StoryObj } from '@storybook/react';
import React, { useState } from 'react';
import { Button } from '../ui';
import { ImageLightbox, type PreviewImageItem } from './ImageLightbox';

const SAMPLE_SVG_1 =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><rect width="640" height="400" fill="#16181e"/><rect x="40" y="40" width="560" height="320" rx="16" fill="#20232c" stroke="#343844"/><text x="320" y="210" fill="#e8eaef" font-family="sans-serif" font-size="24" text-anchor="middle">Screenshot 1 — Lightbox Test</text></svg>'
  );

const SAMPLE_SVG_2 =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><rect width="640" height="400" fill="#121722"/><rect x="40" y="40" width="560" height="320" rx="16" fill="#1c2436" stroke="#364663"/><text x="320" y="210" fill="#93b4ff" font-family="sans-serif" font-size="24" text-anchor="middle">Screenshot 2 — Gallery Navigation</text></svg>'
  );

const SAMPLE_IMAGES: PreviewImageItem[] = [
  { src: SAMPLE_SVG_1, name: 'screenshot-1.png' },
  { src: SAMPLE_SVG_2, name: 'screenshot-2.png' },
];

const meta: Meta = {
  title: 'Domain/ImageLightbox',
};
export default meta;

export const InteractiveLightbox: StoryObj = {
  render: () => {
    const [openIdx, setOpenIdx] = useState<number | null>(null);
    return (
      <div className="space-y-3 p-4">
        <p className="text-caption text-ink-muted">
          Click any thumbnail to open the lightbox. Verify closing via the top-right × button,
          clicking empty backdrop around the image, or pressing Esc.
        </p>
        <div className="flex items-center gap-3">
          {SAMPLE_IMAGES.map((img, idx) => (
            <button
              key={img.name}
              type="button"
              onClick={() => setOpenIdx(idx)}
              className="w-[72px] h-[72px] rounded-xl overflow-hidden border border-line-subtle hover:border-line-strong cursor-pointer"
            >
              <img src={img.src} alt={img.name} className="w-full h-full object-cover" />
            </button>
          ))}
          <Button size="sm" variant="secondary" onClick={() => setOpenIdx(0)}>
            Open Lightbox
          </Button>
        </div>

        {openIdx !== null && (
          <ImageLightbox
            images={SAMPLE_IMAGES}
            initialIndex={openIdx}
            onClose={() => setOpenIdx(null)}
          />
        )}
      </div>
    );
  },
};
