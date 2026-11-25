import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readJsonlTailLines, readProgressiveJsonlTail } from '../src/main/utils/tailReader';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-tail-test-'));

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('tailReader', () => {
  it('returns null for missing files and empty result for 0-byte files', () => {
    expect(readJsonlTailLines(path.join(tmpDir, 'nope.jsonl'), 4096)).toBeNull();

    const emptyPath = path.join(tmpDir, 'empty.jsonl');
    fs.writeFileSync(emptyPath, '');
    const res = readJsonlTailLines(emptyPath, 4096);
    expect(res).not.toBeNull();
    expect(res!.lines).toEqual([]);
    expect(res!.truncated).toBe(false);
    expect(res!.fileSize).toBe(0);
  });

  it('reads entire small file without truncation', () => {
    const file = path.join(tmpDir, 'small.jsonl');
    const records = [
      JSON.stringify({ i: 1, text: 'hello' }),
      JSON.stringify({ i: 2, text: 'world' }),
      JSON.stringify({ i: 3, text: 'done' }),
    ];
    fs.writeFileSync(file, records.join('\n') + '\n');

    const res = readJsonlTailLines(file, 64 * 1024);
    expect(res).not.toBeNull();
    expect(res!.truncated).toBe(false);
    expect(res!.startOffset).toBe(0);
    const nonEmpty = res!.lines.filter((l) => l.trim());
    expect(nonEmpty).toHaveLength(3);
    expect(JSON.parse(nonEmpty[0]).i).toBe(1);
    expect(JSON.parse(nonEmpty[2]).i).toBe(3);
  });

  it('skips partial leading line and never corrupts multi-byte UTF-8 across chunk boundary', () => {
    const file = path.join(tmpDir, 'utf8-boundary.jsonl');
    const lines: string[] = [];
    for (let i = 0; i < 400; i++) {
      // Heavy multi-byte UTF-8 (4-byte emoji + 3-byte CJK + box drawing)
      lines.push(
        JSON.stringify({
          idx: i,
          text: `🚀日本語テスト─━│┃ item ${i} ${'é漢字🔥'.repeat(12)}`,
        })
      );
    }
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');

    // Try several awkward non-aligned byte window sizes to force mid-codepoint cuts
    for (const windowSize of [4097, 4098, 4099, 4100, 8191]) {
      const res = readJsonlTailLines(file, windowSize);
      expect(res).not.toBeNull();
      expect(res!.truncated).toBe(true);
      expect(res!.startOffset).toBeGreaterThan(0);

      const nonEmpty = res!.lines.filter((l) => l.trim());
      expect(nonEmpty.length).toBeGreaterThan(5);

      for (const l of nonEmpty) {
        expect(l).not.toContain('\uFFFD');
        const parsed = JSON.parse(l) as { idx: number; text: string };
        expect(parsed.text).toContain('🚀日本語テスト');
      }

      // Last record must always be the true final line
      const last = JSON.parse(nonEmpty[nonEmpty.length - 1]) as { idx: number };
      expect(last.idx).toBe(399);
    }
  });

  it('progressively expands tail window until isEnough is satisfied', () => {
    const file = path.join(tmpDir, 'progressive.jsonl');
    const lines: string[] = [];
    for (let i = 0; i < 600; i++) {
      lines.push(JSON.stringify({ idx: i, pad: 'x'.repeat(200) }));
    }
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');

    let attempts = 0;
    const outcome = readProgressiveJsonlTail(
      file,
      (chunkLines) => {
        attempts++;
        return chunkLines
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l) as { idx: number });
      },
      (parsed) => parsed.length >= 120,
      { initialBytes: 4096, maxBytes: 512 * 1024, growthFactor: 4 }
    );

    expect(outcome).not.toBeNull();
    expect(attempts).toBeGreaterThan(1);
    expect(outcome!.parsed.length).toBeGreaterThanOrEqual(120);
    expect(outcome!.parsed[outcome!.parsed.length - 1].idx).toBe(599);
  });

  it('stops cleanly at maxBytes cap without throwing on large files', () => {
    const file = path.join(tmpDir, 'capped.jsonl');
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) {
      lines.push(JSON.stringify({ idx: i, pad: 'z'.repeat(250) }));
    }
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');

    const outcome = readProgressiveJsonlTail(
      file,
      (chunkLines) => chunkLines.filter((l) => l.trim()),
      () => false, // intentionally never satisfied
      { initialBytes: 4096, maxBytes: 16384, growthFactor: 2 }
    );

    expect(outcome).not.toBeNull();
    expect(outcome!.truncated).toBe(true);
    expect(outcome!.bytesRead).toBeLessThanOrEqual(16384);
  });
});
