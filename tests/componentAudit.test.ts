import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

function readRel(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

describe('Component-level UI & Electron overlay contract audit', () => {
  it('ensures every full-screen overlay and popover opts out of Electron drag regions (sh-no-drag)', () => {
    const overlayFiles = [
      'src/renderer/components/ImageLightbox.tsx',
      'src/renderer/components/SettingsModal.tsx',
      'src/renderer/ui/Modal.tsx',
      'src/renderer/ui/Menu.tsx',
    ];
    for (const file of overlayFiles) {
      const src = readRel(file);
      expect(src, `${file} must declare sh-no-drag so Electron drag regions cannot steal clicks`).toContain(
        'sh-no-drag'
      );
    }
    const css = readRel('src/renderer/styles.css');
    expect(css).toContain('[role="dialog"]');
    expect(css).toContain('-webkit-app-region: no-drag');
  });

  it('ensures all main window top bars share an identical h-12 seam height', () => {
    const headerFiles = [
      'src/renderer/components/Sidebar.tsx',
      'src/renderer/components/SessionHeader.tsx',
      'src/renderer/components/DraftSessionPane.tsx',
      'src/renderer/components/FilePreviewDrawer.tsx',
    ];
    for (const file of headerFiles) {
      const src = readRel(file);
      expect(src, `${file} top bar must use h-12 to align seamlessly across panes`).toMatch(
        /sh-drag-region h-12\b/
      );
    }
  });

  it('ensures ImageLightbox renders via portal and does not block empty-backdrop clicks', () => {
    const src = readRel('src/renderer/components/ImageLightbox.tsx');
    expect(src).toContain('createPortal');
    expect(src).toContain('Close preview (Esc)');
    // The full-width main image canvas wrapper must not swallow backdrop clicks
    expect(src).not.toMatch(/flex-1 w-full max-w-5xl[\s\S]{0,120}stopPropagation/);
  });

  it('ensures interactive popovers in Sidebar, SessionHeader, and DraftSessionPane wire onClose dismissal', () => {
    for (const file of [
      'src/renderer/components/Sidebar.tsx',
      'src/renderer/components/SessionHeader.tsx',
      'src/renderer/components/DraftSessionPane.tsx',
    ]) {
      const src = readRel(file);
      const popoverCount = (src.match(/<PopoverSurface\b/g) || []).length;
      const onCloseCount = (src.match(/<PopoverSurface[\s\S]{0,240}onClose=/g) || []).length;
      expect(
        onCloseCount,
        `Every PopoverSurface in ${file} must pass onClose for outside-click/Escape dismissal`
      ).toBe(popoverCount);
    }
  });

  it('prevents layout-shifting display toggles (group-hover:hidden / group-hover:flex) in SettingsModal rows', () => {
    const src = readRel('src/renderer/components/SettingsModal.tsx');
    expect(src).not.toMatch(/\bgroup-hover:(?:hidden|flex|block)\b/);
  });

  it('gates Settings remote Start/Stop controls on the canControlDaemon capability', () => {
    const src = readRel('src/renderer/components/SettingsModal.tsx');
    expect(
      src,
      'Harnesses without a controllable daemon (e.g. Muse) must not render Remote on/off or Start/Stop'
    ).toContain('canControlDaemon');
  });

  it('uses appearance-none with an inset Lucide ChevronDown on Select primitives', () => {
    const src = readRel('src/renderer/ui/Input.tsx');
    expect(src).toContain('appearance-none');
    expect(src).toContain('ChevronDown');
  });
});
