import { beforeEach, describe, expect, it, vi } from 'vitest';

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    data,
  };
}

describe('composerDraftStore', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('persists every change synchronously and restores it on reload (crash recovery)', async () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    const store = await import('../src/renderer/utils/composerDraftStore');
    store.setComposerDraft('s1', (p) => ({ ...p, text: 'hello' }));
    expect(JSON.parse(storage.data.get('sh:composerDrafts:v1')!)).toEqual({
      s1: { text: 'hello', attachments: [] },
    });

    vi.resetModules();
    const reloaded = await import('../src/renderer/utils/composerDraftStore');
    expect(reloaded.getComposerDraft('s1').text).toBe('hello');
  });

  it('notifies only the session whose draft changed, and drops empty drafts', async () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    const store = await import('../src/renderer/utils/composerDraftStore');
    const before = store.getComposerDraft('s2');
    store.setComposerDraft('s1', { text: 'a', attachments: [] });
    // s2's snapshot is the same object, so its subscribers have nothing to re-render
    expect(store.getComposerDraft('s2')).toBe(before);
    store.setComposerDraft('s1', { text: '', attachments: [] });
    expect(store.getComposerDraft('s1')).toBe(store.EMPTY_DRAFT);
    expect(storage.data.has('sh:composerDrafts:v1')).toBe(false);
  });

  it('strips inline previews before saving', async () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    const store = await import('../src/renderer/utils/composerDraftStore');
    store.setComposerDraft('s1', {
      text: '',
      attachments: [{ id: 'a', name: 'a.png', path: '/tmp/a.png', mimeType: 'image/png', previewDataUrl: 'data:…' }],
    });
    const saved = JSON.parse(storage.data.get('sh:composerDrafts:v1')!);
    expect(saved.s1.attachments[0].previewDataUrl).toBeUndefined();
    expect(store.getComposerDraft('s1').attachments[0].previewDataUrl).toBe('data:…');
  });
});
