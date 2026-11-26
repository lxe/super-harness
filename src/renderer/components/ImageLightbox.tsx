import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';

export interface PreviewImageItem {
  src: string;
  name?: string;
  path?: string;
}

export interface ImageLightboxProps {
  images: PreviewImageItem[];
  initialIndex: number;
  onClose: () => void;
}

/**
 * Full-screen obsidian image preview lightbox rendered in a document.body portal
 * with explicit `sh-no-drag` so Electron's top window drag region can never steal
 * clicks on the close button or controls.
 */
export const ImageLightbox: React.FC<ImageLightboxProps> = ({
  images,
  initialIndex,
  onClose,
}) => {
  const [index, setIndex] = useState(
    Math.max(0, Math.min(initialIndex, Math.max(0, images.length - 1)))
  );

  useEffect(() => {
    setIndex(Math.max(0, Math.min(initialIndex, Math.max(0, images.length - 1))));
  }, [initialIndex, images.length]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowLeft' && images.length > 1) {
        e.preventDefault();
        setIndex((i) => (i - 1 + images.length) % images.length);
      } else if (e.key === 'ArrowRight' && images.length > 1) {
        e.preventDefault();
        setIndex((i) => (i + 1) % images.length);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [images.length, onClose]);

  const current = images[index];
  if (!current) return null;

  const overlay = (
    <div
      className="sh-no-drag fixed inset-0 z-[100] bg-black/82 backdrop-blur-sm flex flex-col items-center justify-center p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={current.name || 'Image preview'}
    >
      {/* Top bar */}
      <div className="w-full max-w-5xl flex items-center justify-between gap-4 pb-4 text-caption text-ink-secondary shrink-0">
        <div
          className="flex items-center gap-2 min-w-0"
          onClick={(e) => e.stopPropagation()}
        >
          <span className="truncate font-medium text-ink-primary">
            {current.name || 'Image'}
          </span>
          {images.length > 1 && (
            <span className="text-micro tabular-nums text-ink-faint shrink-0">
              {index + 1} / {images.length}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          title="Close preview (Esc)"
          aria-label="Close preview (Esc)"
          className="sh-no-drag w-9 h-9 rounded-full bg-surface-popover/90 border border-line-subtle text-ink-secondary hover:text-ink-primary hover:bg-surface-raised hover:border-line-strong flex items-center justify-center transition-colors cursor-pointer shrink-0 focus:outline-none focus-visible:shadow-none"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Main image canvas — clicking empty space around the image closes cleanly */}
      <div className="relative flex-1 w-full max-w-5xl flex items-center justify-center min-h-0">
        {images.length > 1 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setIndex((i) => (i - 1 + images.length) % images.length);
            }}
            aria-label="Previous image"
            className="sh-no-drag absolute left-2 z-10 w-9 h-9 rounded-full bg-surface-popover/90 border border-line-subtle text-ink-secondary hover:text-ink-primary hover:bg-surface-raised flex items-center justify-center transition-colors cursor-pointer focus:outline-none focus-visible:shadow-none"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
        )}

        <img
          src={current.src}
          alt={current.name || 'Preview'}
          onClick={(e) => e.stopPropagation()}
          className="max-w-full max-h-[78vh] rounded-xl border border-line-subtle bg-black/50 object-contain shadow-2xl select-none"
        />

        {images.length > 1 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setIndex((i) => (i + 1) % images.length);
            }}
            aria-label="Next image"
            className="sh-no-drag absolute right-2 z-10 w-9 h-9 rounded-full bg-surface-popover/90 border border-line-subtle text-ink-secondary hover:text-ink-primary hover:bg-surface-raised flex items-center justify-center transition-colors cursor-pointer focus:outline-none focus-visible:shadow-none"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Thumbnail strip when multiple images */}
      {images.length > 1 && (
        <div
          className="pt-4 flex items-center gap-2 overflow-x-auto max-w-full shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
          {images.map((img, i) => (
            <button
              key={`${img.src}-${i}`}
              type="button"
              onClick={() => setIndex(i)}
              aria-label={`View image ${i + 1}`}
              className={`w-12 h-12 rounded-lg overflow-hidden border transition-all shrink-0 cursor-pointer focus:outline-none focus-visible:shadow-none ${
                i === index
                  ? 'border-ink-primary ring-1 ring-ink-primary/40 opacity-100'
                  : 'border-line-subtle opacity-55 hover:opacity-90'
              }`}
            >
              <img
                src={img.src}
                alt={img.name || `Image ${i + 1}`}
                className="w-full h-full object-cover"
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );

  if (typeof document !== 'undefined' && document.body) {
    return createPortal(overlay, document.body);
  }
  return overlay;
};
