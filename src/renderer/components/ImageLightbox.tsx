import React, { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { IconButton } from '../ui';

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
 * Full-screen obsidian image preview lightbox with keyboard navigation
 * (Escape / ArrowLeft / ArrowRight) and multi-image switcher.
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

  return (
    <div
      className="fixed inset-0 z-50 bg-black/82 backdrop-blur-sm flex flex-col items-center justify-center p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={current.name || 'Image preview'}
    >
      {/* Top bar */}
      <div
        className="w-full max-w-5xl flex items-center justify-between gap-3 pb-3 text-caption text-ink-secondary"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="truncate font-medium text-ink-primary">
            {current.name || 'Image'}
          </span>
          {images.length > 1 && (
            <span className="text-micro font-mono text-ink-faint shrink-0">
              {index + 1} / {images.length}
            </span>
          )}
        </div>
        <IconButton size="md" label="Close preview (Esc)" onClick={onClose}>
          <X className="w-4 h-4" />
        </IconButton>
      </div>

      {/* Main image canvas */}
      <div
        className="relative flex-1 w-full max-w-5xl flex items-center justify-center min-h-0"
        onClick={(e) => e.stopPropagation()}
      >
        {images.length > 1 && (
          <button
            type="button"
            onClick={() => setIndex((i) => (i - 1 + images.length) % images.length)}
            aria-label="Previous image"
            className="absolute left-2 z-10 w-9 h-9 rounded-full bg-surface-popover/90 border border-line-subtle text-ink-secondary hover:text-ink-primary hover:bg-surface-raised flex items-center justify-center transition-colors cursor-pointer"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
        )}

        <img
          src={current.src}
          alt={current.name || 'Preview'}
          className="max-w-full max-h-[78vh] rounded-xl border border-line-subtle bg-black/50 object-contain shadow-2xl select-none"
        />

        {images.length > 1 && (
          <button
            type="button"
            onClick={() => setIndex((i) => (i + 1) % images.length)}
            aria-label="Next image"
            className="absolute right-2 z-10 w-9 h-9 rounded-full bg-surface-popover/90 border border-line-subtle text-ink-secondary hover:text-ink-primary hover:bg-surface-raised flex items-center justify-center transition-colors cursor-pointer"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Thumbnail strip when multiple images */}
      {images.length > 1 && (
        <div
          className="pt-3 flex items-center gap-2 overflow-x-auto max-w-full"
          onClick={(e) => e.stopPropagation()}
        >
          {images.map((img, i) => (
            <button
              key={`${img.src}-${i}`}
              type="button"
              onClick={() => setIndex(i)}
              className={`w-12 h-12 rounded-lg overflow-hidden border transition-all shrink-0 cursor-pointer ${
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
};
