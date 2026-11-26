import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readJsonFileCached } from '../src/main/utils/jsonFileCache';

describe('readJsonFileCached', () => {
  it('returns the cached object until the file changes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jfc-'));
    const f = path.join(dir, 'a.json');
    fs.writeFileSync(f, '{"v":1}');
    const a = readJsonFileCached<{ v: number }>(f);
    expect(a).toEqual({ v: 1 });
    expect(readJsonFileCached(f)).toBe(a);
    fs.writeFileSync(f, '{"v":22}');
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(f, t, t);
    expect(readJsonFileCached(f)).toEqual({ v: 22 });
  });

  it('throws like JSON.parse/readFileSync on bad or missing files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jfc-'));
    const f = path.join(dir, 'bad.json');
    fs.writeFileSync(f, '{nope');
    expect(() => readJsonFileCached(f)).toThrow();
    expect(() => readJsonFileCached(path.join(dir, 'missing.json'))).toThrow();
  });
});
