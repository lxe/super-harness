import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadClaudeTranscript } from '../src/main/adapters/claudeAdapter';
import { OffloadPool } from '../src/main/workers/offloadPool';

describe('OffloadPool', () => {
  it('falls back to running the task inline when no compiled worker exists', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offload-'));
    const file = path.join(dir, 's.jsonl');
    fs.writeFileSync(
      file,
      JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'hi' } }) + '\n'
    );
    const pool = new OffloadPool(2, path.join(dir, 'missing-worker.js'));
    const viaPool = await pool.run('loadClaudeTranscript', 'claude:x', 'x', file, undefined, 10);
    const inline = await loadClaudeTranscript('claude:x', 'x', file, undefined, 10);
    expect({ ...viaPool, sourceMtimeMs: 0 }).toEqual({ ...inline, sourceMtimeMs: 0 });
    expect(viaPool.messages.length).toBe(1);
    pool.close();
  });
});
