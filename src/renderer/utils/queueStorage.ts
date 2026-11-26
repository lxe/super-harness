import type { ImageAttachment, QueuedMessageItem } from '../../shared/types';

export const QUEUED_STORAGE_KEY = 'sh:queuedBySession';

const MAX_STORED_SESSIONS = 40;
const MAX_ITEMS_PER_SESSION = 30;

function stripAttachmentPreview(att: ImageAttachment): ImageAttachment {
  return {
    id: att.id,
    name: att.name,
    path: att.path,
    mimeType: att.mimeType,
  };
}

export function serializeQueuedBySession(
  map: Record<string, QueuedMessageItem[]>
): string {
  const entries: Array<[string, QueuedMessageItem[]]> = [];
  for (const [sessionId, items] of Object.entries(map)) {
    if (!sessionId || !Array.isArray(items) || items.length === 0) continue;
    const cleaned = items
      .filter((item) => item && item.source === 'super-harness')
      .slice(0, MAX_ITEMS_PER_SESSION)
      .map((item) => ({
        id: item.id,
        text: item.text,
        attachments:
          item.attachments && item.attachments.length > 0
            ? item.attachments.map(stripAttachmentPreview)
            : undefined,
        createdAt: item.createdAt,
        source: 'super-harness' as const,
      }));
    if (cleaned.length > 0) {
      entries.push([sessionId, cleaned]);
    }
  }
  const trimmed = entries.slice(-MAX_STORED_SESSIONS);
  return JSON.stringify(Object.fromEntries(trimmed));
}

export function parseQueuedBySession(
  raw: string | null
): Record<string, QueuedMessageItem[]> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, QueuedMessageItem[]> = {};
    for (const [sessionId, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (!sessionId || !Array.isArray(list)) continue;
      const valid: QueuedMessageItem[] = [];
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const rec = item as Record<string, unknown>;
        const id = typeof rec.id === 'string' ? rec.id : '';
        const text = typeof rec.text === 'string' ? rec.text : '';
        const createdAt = typeof rec.createdAt === 'number' ? rec.createdAt : Date.now();
        const rawAtts = Array.isArray(rec.attachments) ? rec.attachments : [];
        const attachments: ImageAttachment[] = rawAtts
          .filter((a): a is Record<string, unknown> => Boolean(a && typeof a === 'object'))
          .map((a) => ({
            id: typeof a.id === 'string' ? a.id : `att-${Date.now()}`,
            name: typeof a.name === 'string' ? a.name : 'image',
            path: typeof a.path === 'string' ? a.path : '',
            mimeType: typeof a.mimeType === 'string' ? a.mimeType : 'image/png',
          }))
          .filter((a) => Boolean(a.path));

        if (!id || (!text.trim() && attachments.length === 0)) continue;
        valid.push({
          id,
          text,
          attachments: attachments.length > 0 ? attachments : undefined,
          createdAt,
          source: 'super-harness',
        });
      }
      if (valid.length > 0) {
        out[sessionId] = valid.slice(0, MAX_ITEMS_PER_SESSION);
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function loadStoredQueues(): Record<string, QueuedMessageItem[]> {
  try {
    return parseQueuedBySession(localStorage.getItem(QUEUED_STORAGE_KEY));
  } catch {
    return {};
  }
}

export function saveStoredQueues(map: Record<string, QueuedMessageItem[]>): void {
  try {
    const serialized = serializeQueuedBySession(map);
    if (serialized === '{}') {
      localStorage.removeItem(QUEUED_STORAGE_KEY);
    } else {
      localStorage.setItem(QUEUED_STORAGE_KEY, serialized);
    }
  } catch {
    // ignore storage quota errors
  }
}

export function isBusyDispatchError(errorText: string | undefined): boolean {
  if (!errorText) return false;
  return /currently running|already running|active turn|active writer|running a turn|busy/i.test(
    errorText
  );
}
