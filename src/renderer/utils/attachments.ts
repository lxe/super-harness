import type { ImageAttachment } from '../../shared/types';

export function isImageAttachment(a: Pick<ImageAttachment, 'mimeType'>): boolean {
  return (a.mimeType || '').toLowerCase().startsWith('image/');
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => resolve('');
    reader.readAsDataURL(file);
  });
}

/**
 * Turns a dropped, pasted or picked File into an attachment. A non-image file
 * that lives on disk is referenced in place by its path; images, and files
 * with no path (e.g. dragged from a browser), are copied into the attachments
 * folder so the agent has a path to read.
 */
export async function fileToAttachment(file: File): Promise<ImageAttachment | null> {
  const isImage = file.type.startsWith('image/');
  const diskPath = isImage ? null : window.superHarness.getPathForFile(file);
  if (diskPath) {
    return {
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
      name: file.name || diskPath.split('/').pop() || 'file',
      path: diskPath,
      mimeType: file.type || 'application/octet-stream',
    };
  }
  const dataUrl = await readAsDataUrl(file);
  if (!dataUrl) return null;
  const withType = dataUrl.startsWith('data:;')
    ? dataUrl.replace('data:;', 'data:application/octet-stream;')
    : dataUrl;
  return window.superHarness.saveAttachment(withType, file.name || undefined);
}

export async function filesToAttachments(files: FileList | File[]): Promise<ImageAttachment[]> {
  const out: ImageAttachment[] = [];
  for (const f of Array.from(files)) {
    const att = await fileToAttachment(f);
    if (att) out.push(att);
  }
  return out;
}

/** Short uppercase type label for a file tile, e.g. "PDF", "ZIP". */
export function fileExtensionLabel(name: string): string {
  const ext = name.includes('.') ? name.split('.').pop() || '' : '';
  return ext ? ext.slice(0, 4).toUpperCase() : 'FILE';
}
